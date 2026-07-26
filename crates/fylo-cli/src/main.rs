//! Read-only FYLO Rust preview CLI.

use std::env;
use std::process::ExitCode;

use fylo_engine::ReadOnlyEngine;
use fylo_format::DOCUMENT_FORMAT_V1;
use fylo_query::{QUERY_FORMAT_V1, QueryLimits, ScanQuery, StructuredQuery, prepare_sql};
use serde_json::json;

const VERSION: &str = include_str!("../../../VERSION");
const STORAGE_FORMAT_VERSION: u32 = 1;
const MACHINE_PROTOCOL_VERSION: u32 = 1;
const WASM_ABI_VERSION: u32 = 1;

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
    let Some(command) = arguments.first().map(String::as_str) else {
        return Err(usage());
    };
    if command == "version" {
        return serde_json::to_string_pretty(&json!({
            "version": VERSION.trim(),
            "engine": "rust-read-only-preview",
            "readOnly": true,
            "documentFormat": DOCUMENT_FORMAT_V1,
            "queryFormat": QUERY_FORMAT_V1,
            "storageFormatVersion": STORAGE_FORMAT_VERSION,
            "machineProtocolVersion": MACHINE_PROTOCOL_VERSION,
            "wasmAbiVersion": WASM_ABI_VERSION
        }))
        .map_err(|error| error.to_string());
    }
    let root = required_option(arguments, "--root")?;
    let engine = ReadOnlyEngine::open(root).map_err(|error| error.to_string())?;
    match command {
        "inspect" => {
            let collection = required_option(arguments, "--collection")?;
            serde_json::to_string_pretty(
                &engine
                    .inspect(collection)
                    .map_err(|error| error.to_string())?,
            )
            .map_err(|error| error.to_string())
        }
        "get" => {
            let collection = required_option(arguments, "--collection")?;
            let identifier = required_option(arguments, "--id")?;
            serde_json::to_string_pretty(
                &engine
                    .get(collection, identifier)
                    .map_err(|error| error.to_string())?,
            )
            .map_err(|error| error.to_string())
        }
        "get-file" => {
            let collection = required_option(arguments, "--collection")?;
            let identifier = required_option(arguments, "--id")?;
            let file = engine
                .get_file(collection, identifier)
                .map_err(|error| error.to_string())?;
            let mut output = serde_json::to_value(&file).map_err(|error| error.to_string())?;
            output
                .as_object_mut()
                .expect("ReadFile serializes as an object")
                .insert("bytesHex".into(), json!(hex(&file.bytes)));
            serde_json::to_string_pretty(&output).map_err(|error| error.to_string())
        }
        "scan-index" => {
            let collection = required_option(arguments, "--collection")?;
            let encoded = required_option(arguments, "--queries")?;
            if encoded.len() > 1024 * 1024 {
                return Err("query JSON exceeds 1048576 bytes".into());
            }
            let queries: Vec<ScanQuery> = serde_json::from_str(encoded)
                .map_err(|error| format!("invalid queries: {error}"))?;
            serde_json::to_string_pretty(
                &engine
                    .scan_index(collection, &queries)
                    .map_err(|error| error.to_string())?,
            )
            .map_err(|error| error.to_string())
        }
        "find" => {
            let collection = required_option(arguments, "--collection")?;
            let encoded = required_option(arguments, "--query")?;
            let query = StructuredQuery::parse(encoded.as_bytes(), QueryLimits::default())
                .map_err(|error| error.to_string())?;
            serde_json::to_string_pretty(
                &engine
                    .find(collection, &query)
                    .map_err(|error| error.to_string())?,
            )
            .map_err(|error| error.to_string())
        }
        "sql" => {
            let statement = required_option(arguments, "--statement")?;
            let plan = prepare_sql(statement, QueryLimits::default())
                .map_err(|error| error.to_string())?;
            serde_json::to_string_pretty(
                &engine
                    .select_sql(&plan)
                    .map_err(|error| error.to_string())?,
            )
            .map_err(|error| error.to_string())
        }
        _ => Err(usage()),
    }
}

fn required_option<'a>(arguments: &'a [String], name: &str) -> Result<&'a str, String> {
    let Some(index) = arguments.iter().position(|argument| argument == name) else {
        return Err(format!("missing required option {name}\n{}", usage()));
    };
    arguments
        .get(index + 1)
        .map(String::as_str)
        .filter(|value| !value.is_empty() && !value.starts_with("--"))
        .ok_or_else(|| format!("missing value for {name}\n{}", usage()))
}

fn hex(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write;
        write!(&mut output, "{byte:02x}").expect("writing to a string cannot fail");
    }
    output
}

fn usage() -> String {
    "Usage:\n  fylo-rust version\n  fylo-rust inspect --root <path> --collection <name>\n  \
     fylo-rust get --root <path> --collection <name> --id <ttid>\n  fylo-rust scan-index --root \
     <path> --collection <name> --queries <json>\n  fylo-rust get-file --root <path> --collection \
     <name> --id <ttid>\n  fylo-rust find --root <path> --collection <name> --query <json>\n  \
     fylo-rust sql --root <path> --statement <select-sql>\n\nThis preview is strictly read-only."
        .into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_reports_compatibility_identity() {
        let output = run(&["version".into()]).unwrap();
        let identity: serde_json::Value = serde_json::from_str(&output).unwrap();
        assert_eq!(identity["version"], VERSION.trim());
        assert_eq!(identity["readOnly"], true);
        assert_eq!(identity["machineProtocolVersion"], 1);
    }

    #[test]
    fn mutating_commands_are_not_part_of_the_preview() {
        let error = run(&["put".into()]).unwrap_err();
        assert!(error.contains("strictly read-only"));
    }
}
