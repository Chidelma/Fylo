//! Experimental native write CLI used by crash and interoperability gates.

use std::env;
use std::process::ExitCode;

use fylo_storage_native::{NativeWriteRoot, PutDocumentOptions, WriteAccess, WriteActor};
use serde_json::json;

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
    let root = required_option(arguments, "--root")?;
    let writer = NativeWriteRoot::open(root).map_err(|error| error.to_string())?;
    let recovered = match command {
        "recover" => writer
            .recover_collection(required_option(arguments, "--collection")?)
            .map_err(|error| error.to_string())?,
        "put-document" => {
            let collection = required_option(arguments, "--collection")?;
            let identifier = required_option(arguments, "--id")?;
            let document = required_option(arguments, "--document")?;
            writer
                .put_document(
                    collection,
                    identifier,
                    document.as_bytes(),
                    PutDocumentOptions {
                        access: WriteAccess {
                            uid: optional_u32(arguments, "--uid")?,
                            gid: optional_u32(arguments, "--gid")?,
                            mode: optional_mode(arguments, "--mode")?,
                        },
                    },
                )
                .map_err(|error| error.to_string())?;
            false
        }
        "patch-document" => {
            let collection = required_option(arguments, "--collection")?;
            let identifier = required_option(arguments, "--id")?;
            let document = required_option(arguments, "--document")?;
            let actor = actor(arguments)?;
            writer
                .patch_document(collection, identifier, document.as_bytes(), actor.as_ref())
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
        _ => return Err(usage()),
    };
    serde_json::to_string(&json!({
        "ok": true,
        "command": command,
        "recovered": recovered,
        "root": writer.path()
    }))
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

fn usage() -> String {
    "Usage:\n  fylo-write-preview recover --root <path> --collection <name>\n  \
     fylo-write-preview put-document --root <path> --collection <name> --id <ttid> --document \
     <json> [--uid <uid>] [--gid <gid>] [--mode <octal>]\n  fylo-write-preview patch-document \
     --root <path> --collection <name> --id <ttid> --document <json> [--actor-uid <uid> \
     [--actor-groups <gid,...>]]\n  fylo-write-preview delete-document --root <path> --collection \
     <name> --id <ttid> [--actor-uid <uid> [--actor-groups <gid,...>]]"
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
