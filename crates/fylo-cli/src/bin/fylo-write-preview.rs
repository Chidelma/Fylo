//! Experimental native write CLI used by crash and interoperability gates.

use std::env;
use std::path::Path;
use std::process::ExitCode;

use fylo_engine::{AccessContext, WriteEngine};
use fylo_storage_native::{
    NativeWriteRoot, PutDocumentOptions, PutRawFileOptions, WriteAccess, WriteActor,
};
use serde_json::{Value, json};

fn main() -> ExitCode {
    let arguments: Vec<String> = env::args().skip(1).collect();
    match run(&arguments) {
        Ok(output) => {
            println!("{output}");
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
}

fn run(arguments: &[String]) -> Result<String, String> {
    let command = arguments.first().map(String::as_str).ok_or_else(usage)?;
    if command == "failpoints" {
        // The crash matrix enumerates this rather than keeping its own list.
        return serde_json::to_string(&json!({ "failpoints": fylo_storage_native::FAILPOINTS }))
            .map_err(|error| error.to_string());
    }
    let root = required_option(arguments, "--root")?;
    let writer = NativeWriteRoot::open(root).map_err(|error| error.to_string())?;
    let mut result = Value::Null;
    let recovered = match command {
        "recover" => writer
            .recover_collection(required_option(arguments, "--collection")?)
            .map_err(|error| error.to_string())?,
        "put-document" | "put-file" => {
            run_put(command, arguments, &writer)?;
            false
        }
        "patch-document" => {
            run_patch(arguments, &writer)?;
            false
        }
        "patch-fields" => {
            let collection = required_option(arguments, "--collection")?;
            let identifier = required_option(arguments, "--id")?;
            let changes = serde_json::from_str(required_option(arguments, "--changes")?)
                .map_err(|error| format!("invalid --changes: {error}"))?;
            let actor = actor(arguments)?;
            writer
                .patch_document_fields(collection, identifier, &changes, actor.as_ref())
                .map_err(|error| error.to_string())?;
            false
        }
        "commit" => {
            result = writer
                .commit_if_dirty(required_option(arguments, "--message")?)
                .map_err(|error| error.to_string())?
                .map_or(Value::Null, Value::String);
            false
        }
        "set-metadata" | "set-access" => {
            run_metadata(command, arguments, &writer)?;
            false
        }
        "reshard" => {
            let width = required_option(arguments, "--width")?
                .parse::<u32>()
                .map_err(|error| format!("invalid --width: {error}"))?;
            let moved = writer
                .reshard_collection(required_option(arguments, "--collection")?, width)
                .map_err(|error| error.to_string())?;
            result = Value::from(moved);
            false
        }
        "restore-document" => {
            let collection = required_option(arguments, "--collection")?;
            let identifier = required_option(arguments, "--id")?;
            let actor = actor(arguments)?;
            writer
                .restore_document(collection, identifier, actor.as_ref())
                .map_err(|error| error.to_string())?;
            false
        }
        "delete-document" => {
            let collection = required_option(arguments, "--collection")?;
            let identifier = required_option(arguments, "--id")?;
            let actor = actor(arguments)?;
            writer
                .delete_document(collection, identifier, actor.as_ref())
                .map_err(|error| error.to_string())?;
            false
        }
        "sql" => {
            let actor = actor(arguments)?;
            let mutation = writer
                .execute_sql_mutation(
                    required_option(arguments, "--statement")?,
                    actor.as_ref(),
                    WriteAccess {
                        uid: optional_u32(arguments, "--uid")?,
                        gid: optional_u32(arguments, "--gid")?,
                        mode: optional_mode(arguments, "--mode")?,
                    },
                )
                .map_err(|error| error.to_string())?;
            result = serde_json::to_value(mutation).map_err(|error| error.to_string())?;
            false
        }
        _ => return Err(usage()),
    };
    serde_json::to_string(&json!({
        "ok": true,
        "command": command,
        "recovered": recovered,
        "result": result,
        "root": writer.path()
    }))
    .map_err(|error| error.to_string())
}

fn run_patch(arguments: &[String], writer: &NativeWriteRoot) -> Result<(), String> {
    let collection = required_option(arguments, "--collection")?;
    let identifier = required_option(arguments, "--id")?;
    let document = required_option(arguments, "--document")?;
    let actor = actor(arguments)?;
    if let Some(engine) = write_engine(writer.path())? {
        let fields = serde_json::from_str(document)
            .map_err(|error| format!("invalid --document: {error}"))?;
        let context = access_context(arguments)?;
        return engine
            .patch_document(collection, identifier, fields, context.as_ref())
            .map_err(|error| error.to_string());
    }
    writer
        .patch_document(collection, identifier, document.as_bytes(), actor.as_ref())
        .map_err(|error| error.to_string())
}

fn access_context(arguments: &[String]) -> Result<Option<AccessContext>, String> {
    let Some(uid) = optional_u32(arguments, "--actor-uid")? else {
        return Ok(None);
    };
    let groups = option(arguments, "--actor-groups")
        .map(|encoded| {
            encoded
                .split(',')
                .filter(|value| !value.is_empty())
                .map(|value| {
                    value
                        .parse::<u32>()
                        .map_err(|error| format!("invalid --actor-groups: {error}"))
                })
                .collect::<Result<Vec<_>, _>>()
        })
        .transpose()?
        .unwrap_or_default();
    Ok(Some(AccessContext::new(uid, groups)))
}

/// Route document bodies through the engine only when a usable schema root and
/// both credentials are present, matching the read-only preview CLI.
fn write_engine(root: &Path) -> Result<Option<WriteEngine>, String> {
    let Some(schema_root) = configured("FYLO_SCHEMA") else {
        return Ok(None);
    };
    if !Path::new(&schema_root).is_dir() {
        return Ok(None);
    }
    let Some((secret, salt)) =
        configured("FYLO_ENCRYPTION_KEY").zip(configured("FYLO_CIPHER_SALT"))
    else {
        return WriteEngine::open_with_schema(root, schema_root)
            .map(Some)
            .map_err(|error| error.to_string());
    };
    WriteEngine::open_with_encryption(root, schema_root, &secret, &salt)
        .map(Some)
        .map_err(|error| error.to_string())
}

/// An empty environment variable is falsy in JavaScript, and a repository
/// `.env` commonly declares these names with empty values.
fn configured(name: &str) -> Option<String> {
    env::var(name).ok().filter(|value| !value.is_empty())
}

fn run_metadata(
    command: &str,
    arguments: &[String],
    writer: &NativeWriteRoot,
) -> Result<(), String> {
    let collection = required_option(arguments, "--collection")?;
    let identifier = required_option(arguments, "--id")?;
    let actor = actor(arguments)?;
    if command == "set-metadata" {
        let record = serde_json::from_str(required_option(arguments, "--record")?)
            .map_err(|error| format!("invalid --record: {error}"))?;
        return writer
            .set_record_metadata(collection, identifier, &record, actor.as_ref())
            .map_err(|error| error.to_string());
    }
    writer
        .set_record_access(
            collection,
            identifier,
            WriteAccess {
                uid: optional_u32(arguments, "--uid")?,
                gid: optional_u32(arguments, "--gid")?,
                mode: optional_mode(arguments, "--mode")?,
            },
            actor.as_ref(),
        )
        .map_err(|error| error.to_string())
}

fn run_put(command: &str, arguments: &[String], writer: &NativeWriteRoot) -> Result<(), String> {
    let collection = required_option(arguments, "--collection")?;
    let identifier = required_option(arguments, "--id")?;
    let access = WriteAccess {
        uid: optional_u32(arguments, "--uid")?,
        gid: optional_u32(arguments, "--gid")?,
        mode: optional_mode(arguments, "--mode")?,
    };
    if command == "put-document" {
        let document = required_option(arguments, "--document")?;
        if let Some(engine) = write_engine(writer.path())? {
            let fields = serde_json::from_str(document)
                .map_err(|error| format!("invalid --document: {error}"))?;
            return engine
                .put_document(collection, identifier, fields, access)
                .map_err(|error| error.to_string());
        }
        return writer
            .put_document(
                collection,
                identifier,
                document.as_bytes(),
                PutDocumentOptions { access },
            )
            .map_err(|error| error.to_string());
    }
    let bytes = decode_hex(required_option(arguments, "--bytes-hex")?)?;
    let metadata = option(arguments, "--metadata")
        .map(|encoded| {
            serde_json::from_str(encoded).map_err(|error| format!("invalid --metadata: {error}"))
        })
        .transpose()?
        .unwrap_or_default();
    writer
        .put_raw_file(
            collection,
            identifier,
            &bytes,
            &PutRawFileOptions {
                key: required_option(arguments, "--key")?.into(),
                extension: required_option(arguments, "--extension")?.into(),
                metadata,
                access,
            },
        )
        .map_err(|error| error.to_string())
}

fn actor(arguments: &[String]) -> Result<Option<WriteActor>, String> {
    let Some(uid) = optional_u32(arguments, "--actor-uid")? else {
        if arguments
            .iter()
            .any(|argument| argument == "--actor-groups")
        {
            return Err("--actor-groups requires --actor-uid".into());
        }
        return Ok(None);
    };
    let groups = option(arguments, "--actor-groups")
        .map(|encoded| {
            encoded
                .split(',')
                .filter(|value| !value.is_empty())
                .map(|value| {
                    value
                        .parse::<u32>()
                        .map_err(|error| format!("invalid --actor-groups: {error}"))
                })
                .collect::<Result<Vec<_>, _>>()
        })
        .transpose()?
        .unwrap_or_default();
    Ok(Some(WriteActor::new(uid, groups)))
}

fn optional_u32(arguments: &[String], name: &str) -> Result<Option<u32>, String> {
    option(arguments, name)
        .map(|value| {
            value
                .parse::<u32>()
                .map_err(|error| format!("invalid {name}: {error}"))
        })
        .transpose()
}

fn optional_mode(arguments: &[String], name: &str) -> Result<Option<u32>, String> {
    option(arguments, name)
        .map(|value| {
            let value = value.strip_prefix("0o").unwrap_or(value);
            u32::from_str_radix(value, 8).map_err(|error| format!("invalid {name}: {error}"))
        })
        .transpose()
}

fn option<'a>(arguments: &'a [String], name: &str) -> Option<&'a str> {
    arguments
        .iter()
        .position(|argument| argument == name)
        .and_then(|index| arguments.get(index + 1))
        .map(String::as_str)
}

fn required_option<'a>(arguments: &'a [String], name: &str) -> Result<&'a str, String> {
    option(arguments, name)
        .filter(|value| !value.is_empty() && !value.starts_with("--"))
        .ok_or_else(|| format!("missing {name}\n{}", usage()))
}

fn decode_hex(value: &str) -> Result<Vec<u8>, String> {
    if !value.len().is_multiple_of(2) {
        return Err("--bytes-hex must contain an even number of digits".into());
    }
    value
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            std::str::from_utf8(pair)
                .map_err(|error| format!("invalid --bytes-hex: {error}"))
                .and_then(|pair| {
                    u8::from_str_radix(pair, 16)
                        .map_err(|error| format!("invalid --bytes-hex: {error}"))
                })
        })
        .collect()
}

fn usage() -> String {
    "Usage:\n  fylo-write-preview recover --root <path> --collection <name>\n  \
     fylo-write-preview put-document --root <path> --collection <name> --id <ttid> --document \
     <json> [--uid <uid>] [--gid <gid>] [--mode <octal>]\n  fylo-write-preview put-file --root \
     <path> --collection <name> --id <ttid> --bytes-hex \
     <hex> --key <key> --extension <ext> [--metadata <json>]\n  fylo-write-preview patch-document \
     --root <path> --collection <name> --id <ttid> --document <json> [--actor-uid <uid> \
     [--actor-groups <gid,...>]]\n  fylo-write-preview patch-fields --root <path> --collection \
     <name> --id <ttid> --changes <json> [--actor-uid <uid> [--actor-groups <gid,...>]]\n  \
     fylo-write-preview delete-document --root <path> --collection <name> --id <ttid> \
     [--actor-uid <uid> [--actor-groups <gid,...>]]\n  fylo-write-preview sql --root <path> \
     --statement <sql> [--actor-uid <uid> [--actor-groups <gid,...>]] [--uid <uid>] [--gid \
     <gid>] [--mode <octal>]\n  fylo-write-preview set-metadata --root <path> --collection \
     <name> --id <ttid> --record <json> [--actor-uid <uid> [--actor-groups <gid,...>]]\n  \
     fylo-write-preview set-access --root <path> --collection <name> --id <ttid> [--uid <uid>] \
     [--gid <gid>] [--mode <octal>] [--actor-uid <uid> [--actor-groups <gid,...>]]\n  \
     fylo-write-preview commit --root <path> --message <message>\n  fylo-write-preview \
     restore-document --root <path> --collection <name> --id <ttid> [--actor-uid <uid> \
     [--actor-groups <gid,...>]]\n  fylo-write-preview reshard --root <path> \
     --collection <name> --width <0-4>\n  fylo-write-preview failpoints"
        .into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_groups_without_a_trusted_actor_uid() {
        let arguments = ["--actor-groups".into(), "100,200".into()];
        assert_eq!(
            actor(&arguments).unwrap_err(),
            "--actor-groups requires --actor-uid"
        );
    }

    #[test]
    fn parses_octal_modes_without_decimal_ambiguity() {
        let arguments = ["--mode".into(), "0o660".into()];
        assert_eq!(optional_mode(&arguments, "--mode").unwrap(), Some(0o660));
    }
}
