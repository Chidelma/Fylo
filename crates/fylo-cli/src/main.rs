//! FYLO Rust preview CLI.

use std::env;
use std::fs;
use std::io::{self, BufReader, Cursor, Read};
use std::path::Path;
use std::path::PathBuf;
use std::process::ExitCode;

use fylo_engine::{AccessContext, ReadOnlyEngine};
use fylo_format::decode_ttid;
use fylo_machine::{FrameLimits, serve, serve_exclusive, serve_once};
use fylo_query::{QueryLimits, ScanQuery, StructuredQuery, prepare_sql};
use serde_json::{Map, Value, json};

const VERSION: &str = include_str!("../../../VERSION");

fn main() -> ExitCode {
    let arguments: Vec<String> = env::args().skip(1).collect();
    if arguments.is_empty()
        || arguments.first().is_some_and(|command| command == "help")
        || arguments
            .iter()
            .any(|argument| argument == "--help" || argument == "-h")
    {
        println!("{}", usage());
        return ExitCode::SUCCESS;
    }
    if arguments.first().is_some_and(|command| command == "exec") {
        return run_machine(&arguments);
    }
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
    if command == "version" || arguments.iter().any(|argument| argument == "--version") {
        if arguments.iter().any(|argument| argument == "--json")
            || option(arguments, "--output") == Some("json")
        {
            return pretty(&machine_result(&json!({ "op": "handshake" }), None)?);
        }
        return Ok(VERSION.trim().to_owned());
    }
    if uses_compat_cli(arguments) {
        return run_compat_cli(arguments);
    }
    let root = required_option(arguments, "--root")?;
    let engine = open_engine(root)?;
    match command {
        "log" => history_output(&engine, arguments),
        "verify-history" => version_verification_output(&engine, arguments),
        "inspect" => inspect_output(&engine, arguments),
        "get" => {
            let collection = required_option(arguments, "--collection")?;
            let identifier = required_option(arguments, "--id")?;
            let actor = access_context(arguments)?;
            let record = match actor.as_ref() {
                Some(actor) => engine.get_as(collection, identifier, actor),
                None => engine.get(collection, identifier),
            };
            serde_json::to_string_pretty(&record.map_err(|error| error.to_string())?)
                .map_err(|error| error.to_string())
        }
        "get-file" => get_file_output(&engine, arguments),
        "get-deleted" => {
            let collection = required_option(arguments, "--collection")?;
            let identifier = required_option(arguments, "--id")?;
            let actor = access_context(arguments)?;
            let record = match actor.as_ref() {
                Some(actor) => engine.get_deleted_as(collection, identifier, actor),
                None => engine.get_deleted(collection, identifier),
            };
            serde_json::to_string_pretty(&record.map_err(|error| error.to_string())?)
                .map_err(|error| error.to_string())
        }
        "get-deleted-file" => get_deleted_file_output(&engine, arguments),
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
        "verify-index" => {
            let collection = required_option(arguments, "--collection")?;
            serde_json::to_string_pretty(
                &engine
                    .verify_index(collection)
                    .map_err(|error| error.to_string())?,
            )
            .map_err(|error| error.to_string())
        }
        "find" => {
            let collection = required_option(arguments, "--collection")?;
            let encoded = required_option(arguments, "--query")?;
            let query = StructuredQuery::parse(encoded.as_bytes(), QueryLimits::default())
                .map_err(|error| error.to_string())?;
            let actor = access_context(arguments)?;
            let records = match actor.as_ref() {
                Some(actor) => engine.find_as(collection, &query, actor),
                None => engine.find(collection, &query),
            };
            serde_json::to_string_pretty(&records.map_err(|error| error.to_string())?)
                .map_err(|error| error.to_string())
        }
        "sql" => {
            let statement = required_option(arguments, "--statement")?;
            let plan = prepare_sql(statement, QueryLimits::default())
                .map_err(|error| error.to_string())?;
            let actor = access_context(arguments)?;
            let result = match actor.as_ref() {
                Some(actor) => engine.select_sql_as(&plan, actor),
                None => engine.select_sql(&plan),
            };
            serde_json::to_string_pretty(&result.map_err(|error| error.to_string())?)
                .map_err(|error| error.to_string())
        }
        _ => Err(usage()),
    }
}

fn run_machine(arguments: &[String]) -> ExitCode {
    if arguments.iter().any(|argument| argument == "--worm") {
        eprintln!("fylo-rust exec does not support process-local WORM mode");
        return ExitCode::FAILURE;
    }
    if arguments.iter().any(|argument| argument == "--loop") {
        return run_machine_loop(arguments);
    }
    let source = match required_option(arguments, "--request") {
        Ok(source) => source,
        Err(error) => {
            eprintln!("{error}");
            return ExitCode::FAILURE;
        }
    };
    let request = match read_json_source(source).and_then(|text| {
        serde_json::from_str::<Value>(&text)
            .map_err(|error| format!("invalid request JSON: {error}"))
    }) {
        Ok(request) if request.is_object() => request,
        Ok(_) => {
            eprintln!("machine request body must be a JSON object");
            return ExitCode::FAILURE;
        }
        Err(error) => {
            eprintln!("{error}");
            return ExitCode::FAILURE;
        }
    };
    let root = option(arguments, "--root").map(PathBuf::from);
    let limits = match machine_limits(arguments) {
        Ok(limits) => limits,
        Err(error) => {
            eprintln!("{error}");
            return ExitCode::FAILURE;
        }
    };
    match machine_frame(&request, root, limits) {
        Ok(frame) => {
            println!("{}", serde_json::to_string(&frame).unwrap_or_default());
            if frame.get("ok") == Some(&Value::Bool(true)) {
                ExitCode::SUCCESS
            } else {
                ExitCode::FAILURE
            }
        }
        Err(error) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
}

fn run_machine_loop(arguments: &[String]) -> ExitCode {
    let root = option(arguments, "--root").map(PathBuf::from);
    let limits = match machine_limits(arguments) {
        Ok(limits) => limits,
        Err(error) => {
            eprintln!("{error}");
            return ExitCode::FAILURE;
        }
    };
    let mut input = BufReader::new(io::stdin().lock());
    let mut output = io::stdout().lock();
    let result = if arguments
        .iter()
        .any(|argument| argument == "--exclusive-root")
    {
        serve_exclusive(&mut input, &mut output, root, limits)
    } else {
        serve(&mut input, &mut output, root, limits)
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
}

fn machine_frame(
    request: &Value,
    root: Option<PathBuf>,
    limits: FrameLimits,
) -> Result<Value, String> {
    let mut input = serde_json::to_vec(&request).map_err(|error| error.to_string())?;
    input.push(b'\n');
    let mut reader = Cursor::new(input);
    let mut output = Vec::new();
    serve_once(&mut reader, &mut output, root, limits).map_err(|error| error.to_string())?;
    let text = std::str::from_utf8(&output).map_err(|error| error.to_string())?;
    serde_json::from_str(text.trim_end()).map_err(|error| error.to_string())
}

fn machine_result(request: &Value, root: Option<PathBuf>) -> Result<Value, String> {
    let frame = machine_frame(request, root, FrameLimits::default())?;
    if frame.get("ok") == Some(&Value::Bool(true)) {
        return Ok(frame.get("result").cloned().unwrap_or(Value::Null));
    }
    let error = frame.get("error").cloned().unwrap_or(Value::Null);
    let code = error
        .get("code")
        .and_then(Value::as_str)
        .unwrap_or("EUNKNOWN");
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("machine operation failed");
    Err(format!("{code}: {message}"))
}

fn machine_limits(arguments: &[String]) -> Result<FrameLimits, String> {
    Ok(FrameLimits {
        max_request_bytes: optional_usize(arguments, "--max-request-bytes")?
            .unwrap_or(fylo_machine::DEFAULT_MAX_REQUEST_BYTES),
        max_response_bytes: optional_usize(arguments, "--max-response-bytes")?
            .unwrap_or(fylo_machine::DEFAULT_MAX_RESPONSE_BYTES),
    })
}

fn optional_usize(arguments: &[String], name: &str) -> Result<Option<usize>, String> {
    option(arguments, name)
        .map(|value| {
            value
                .parse::<usize>()
                .map_err(|error| format!("invalid {name}: {error}"))
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

fn uses_compat_cli(arguments: &[String]) -> bool {
    let command = arguments.first().map(String::as_str).unwrap_or_default();
    match command {
        "checkout" | "branch" | "commit" | "status" | "diff" | "restore-commit" | "merge"
        | "latest" | "rebuild" | "verify" | "deleted" | "restore" | "schema" => true,
        "inspect" | "get" => positionals(arguments).len() > 1,
        "log" => option(arguments, "--limit").is_none(),
        "sql" => option(arguments, "--statement").is_none(),
        _ => is_sql_command(&arguments.join(" ")),
    }
}

// The compatibility surface is deliberately visible in one exhaustive match;
// splitting it across registries would make command-to-protocol drift harder
// to review against the JavaScript CLI.
#[allow(clippy::too_many_lines)]
fn run_compat_cli(arguments: &[String]) -> Result<String, String> {
    if arguments.iter().any(|argument| argument == "--worm") {
        return Err("process-local WORM mode was retired; use UID/GID/mode permissions".into());
    }
    let values = positionals(arguments);
    let command = values.first().map(String::as_str).unwrap_or_default();
    let root = compat_root(arguments)?;
    fs::create_dir_all(&root).map_err(|error| format!("cannot create FYLO root: {error}"))?;
    let mut request = Map::new();
    let mut sql = None;
    match command {
        "checkout" => {
            request.insert("op".into(), json!("checkout"));
            request.insert(
                "branch".into(),
                json!(required_positional(&values, 1, "branch name for checkout")?),
            );
            request.insert(
                "create".into(),
                json!(arguments.iter().any(|argument| argument == "-b")),
            );
        }
        "branch" => insert_op(&mut request, "branch"),
        "commit" => {
            insert_op(&mut request, "commit");
            request.insert("message".into(), json!(required_message(arguments)?));
        }
        "log" => insert_op(&mut request, "log"),
        "status" => insert_op(&mut request, "status"),
        "diff" => {
            insert_op(&mut request, "diff");
            if let Some(from) = values.get(1) {
                request.insert("from".into(), json!(from));
            }
            if let Some(to) = values.get(2) {
                request.insert("to".into(), json!(to));
            }
        }
        "restore-commit" => {
            insert_op(&mut request, "restoreCommit");
            request.insert(
                "id".into(),
                json!(required_positional(
                    &values,
                    1,
                    "commit id for restore-commit"
                )?),
            );
            request.insert(
                "force".into(),
                json!(arguments.iter().any(|argument| argument == "--force")),
            );
        }
        "merge" => {
            insert_op(&mut request, "merge");
            request.insert(
                "source".into(),
                json!(required_positional(&values, 1, "ref for merge")?),
            );
            if let Some(message) =
                option(arguments, "-m").or_else(|| option(arguments, "--message"))
            {
                request.insert("message".into(), json!(message));
            }
        }
        "inspect" => collection_request(
            &mut request,
            "inspectCollection",
            &values,
            1,
            "collection name for inspect",
        )?,
        "get" => record_request(&mut request, "getDoc", &values, "get")?,
        "latest" => {
            record_request(&mut request, "getLatest", &values, "latest")?;
            request.insert(
                "onlyId".into(),
                json!(arguments.iter().any(|argument| argument == "--id-only")),
            );
        }
        "rebuild" => collection_request(
            &mut request,
            "rebuildCollection",
            &values,
            1,
            "collection name for rebuild",
        )?,
        "verify" => collection_request(
            &mut request,
            "verifyCollection",
            &values,
            1,
            "collection name for verify",
        )?,
        "deleted" => {
            collection_request(
                &mut request,
                "findDeletedDocs",
                &values,
                1,
                "collection name for deleted",
            )?;
            request.insert("query".into(), json!({}));
        }
        "restore" => record_request(&mut request, "restoreDoc", &values, "restore")?,
        "schema" => schema_request(&mut request, arguments, &values)?,
        "sql" => {
            let statement = values.get(1..).unwrap_or_default().join(" ");
            if statement.trim().is_empty() {
                return Err("missing SQL statement".into());
            }
            insert_op(&mut request, "executeSQL");
            request.insert("sql".into(), json!(statement));
            sql = request
                .get("sql")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned);
        }
        _ if is_sql_command(&values.join(" ")) => {
            let statement = values.join(" ");
            insert_op(&mut request, "executeSQL");
            request.insert("sql".into(), json!(statement));
            sql = request
                .get("sql")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned);
        }
        _ => return Err(format!("unknown command: {command}\n{}", usage())),
    }
    let result = machine_result(&Value::Object(request), Some(root))?;
    if arguments.iter().any(|argument| argument == "--json") {
        if command == "latest" && arguments.iter().any(|argument| argument == "--id-only") {
            return pretty(&json!({ "id": result }));
        }
        return compat_json_result(command, values.get(1).map(String::as_str), &result);
    }
    render_compat_result(command, &values, &result, sql.as_deref(), arguments)
}

fn compat_json_result(
    command: &str,
    action: Option<&str>,
    result: &Value,
) -> Result<String, String> {
    if command == "schema" && action == Some("history") {
        // The historical direct CLI exposes only the version array for
        // `schema history`; the machine protocol intentionally carries context.
        if let Some(versions) = result.get("versions") {
            return pretty(versions);
        }
    }
    pretty(result)
}

fn insert_op(request: &mut Map<String, Value>, operation: &str) {
    request.insert("op".into(), json!(operation));
}

fn collection_request(
    request: &mut Map<String, Value>,
    operation: &str,
    values: &[String],
    index: usize,
    description: &str,
) -> Result<(), String> {
    insert_op(request, operation);
    request.insert(
        "collection".into(),
        json!(required_positional(values, index, description)?),
    );
    Ok(())
}

fn record_request(
    request: &mut Map<String, Value>,
    operation: &str,
    values: &[String],
    command: &str,
) -> Result<(), String> {
    collection_request(
        request,
        operation,
        values,
        1,
        &format!("collection name for {command}"),
    )?;
    request.insert(
        "id".into(),
        json!(required_positional(
            values,
            2,
            &format!("document id for {command}")
        )?),
    );
    Ok(())
}

fn schema_request(
    request: &mut Map<String, Value>,
    arguments: &[String],
    values: &[String],
) -> Result<(), String> {
    let action = required_positional(values, 1, "schema command")?;
    let operation = match action {
        "inspect" => "schemaInspect",
        "current" => "schemaCurrent",
        "history" => "schemaHistory",
        "doctor" => "schemaDoctor",
        "validate" => "schemaValidate",
        "materialize" => "schemaMaterialize",
        _ => return Err("missing or invalid schema command".into()),
    };
    insert_op(request, operation);
    request.insert(
        "collection".into(),
        json!(required_positional(
            values,
            2,
            "collection name for schema command"
        )?),
    );
    if let Some(schema_dir) = option(arguments, "--schema-dir") {
        request.insert("schemaDir".into(), json!(schema_dir));
    }
    if matches!(action, "validate" | "materialize") {
        let source = required_positional(values, 3, "JSON document input")?;
        let text = read_json_source(source)?;
        let document: Value = serde_json::from_str(&text)
            .map_err(|error| format!("invalid JSON document: {error}"))?;
        if !document.is_object() {
            return Err("JSON document input must be an object".into());
        }
        request.insert("document".into(), document);
    }
    Ok(())
}

fn render_compat_result(
    command: &str,
    values: &[String],
    result: &Value,
    sql: Option<&str>,
    arguments: &[String],
) -> Result<String, String> {
    if let Some(statement) = sql {
        return render_sql(statement, result, arguments);
    }
    match command {
        "checkout" => Ok(format!(
            "Switched to branch {}",
            result["branch"].as_str().unwrap_or_default()
        )),
        "branch" => Ok(result["branches"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|branch| {
                let name = branch
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let marker = if result["current"] == json!(name) {
                    '*'
                } else {
                    ' '
                };
                format!("{marker} {name}")
            })
            .collect::<Vec<_>>()
            .join("\n")),
        "commit" => {
            if result.is_null() {
                Ok("Nothing to commit".into())
            } else {
                Ok(format!(
                    "[{} {}] {}",
                    result["branch"].as_str().unwrap_or_default(),
                    result["id"].as_str().unwrap_or_default(),
                    result["message"].as_str().unwrap_or_default()
                ))
            }
        }
        "log" => render_log(result),
        "status" => Ok(format!(
            "On branch {}\nHEAD {}\n{}",
            result["branch"].as_str().unwrap_or_default(),
            result["head"].as_str().unwrap_or("none"),
            if result["clean"] == Value::Bool(true) {
                "Working tree clean".into()
            } else {
                format!(
                    "Working tree has {} change(s)",
                    result["diff"]["counts"]["total"]
                )
            }
        )),
        "restore-commit" => Ok(format!(
            "Restored branch {} to commit {}",
            result["branch"].as_str().unwrap_or_default(),
            result["restored"].as_str().unwrap_or_default()
        )),
        "merge" => Ok(render_merge(
            values.get(1).map(String::as_str).unwrap_or_default(),
            result,
        )),
        "inspect" => Ok(format!(
            "Collection {}\nExists: {}\nWORM mode: {}\nStored documents: {}\nDeleted documents: {}\nIndexed documents: {}",
            result["collection"].as_str().unwrap_or_default(),
            yes_no(result["exists"].as_bool().unwrap_or(false)),
            if result["worm"].as_bool().unwrap_or(false) {
                "enabled"
            } else {
                "disabled"
            },
            result["docsStored"],
            result["deletedDocs"],
            result["indexedDocs"]
        )),
        "get" | "latest" | "deleted" => {
            if result.as_object().is_some_and(Map::is_empty) {
                return Err(format!(
                    "no document found for {}",
                    values.last().map(String::as_str).unwrap_or_default()
                ));
            }
            pretty(result)
        }
        "restore" => Ok(format!(
            "Restored document {}",
            result["id"].as_str().unwrap_or_default()
        )),
        "schema" => render_schema(
            values.get(1).map(String::as_str).unwrap_or_default(),
            result,
        ),
        _ => pretty(result),
    }
}

fn render_log(result: &Value) -> Result<String, String> {
    let commits = result
        .as_array()
        .ok_or_else(|| "invalid log result".to_owned())?;
    if commits.is_empty() {
        return Ok("No commits yet".into());
    }
    Ok(commits
        .iter()
        .map(|commit| {
            format!(
                "commit {}\nBranch: {}\nDate: {}\n\n    {}",
                commit["id"].as_str().unwrap_or_default(),
                commit["branch"].as_str().unwrap_or_default(),
                commit["createdAt"].as_str().unwrap_or_default(),
                commit["message"].as_str().unwrap_or_default()
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n"))
}

fn render_merge(source: &str, result: &Value) -> String {
    if result["merged"] == Value::Bool(false) {
        return format!(
            "Merge conflict while merging {source} into {}",
            result["branch"].as_str().unwrap_or_default()
        );
    }
    match result["mode"].as_str().unwrap_or_default() {
        "already-up-to-date" => format!("Already up to date with {source}"),
        "fast-forward" => format!(
            "Fast-forwarded {} to {}",
            result["branch"].as_str().unwrap_or_default(),
            result["head"].as_str().unwrap_or_default()
        ),
        _ => format!(
            "Merged {source} into {} as {}",
            result["branch"].as_str().unwrap_or_default(),
            result["commit"].as_str().unwrap_or_default()
        ),
    }
}

fn render_schema(action: &str, result: &Value) -> Result<String, String> {
    match action {
        "current" => Ok(result["current"].as_str().unwrap_or_default().to_owned()),
        "validate" => Ok(format!(
            "Schema validation passed for {} at {}",
            result["collection"].as_str().unwrap_or_default(),
            result["current"].as_str().unwrap_or("unversioned")
        )),
        "materialize" => pretty(&result["document"]),
        "inspect" => Ok(format!(
            "Schema {}\nSchema dir: {}\nVersioned: {}\nCurrent: {}\nVersions: {}",
            result["collection"].as_str().unwrap_or_default(),
            result["schemaDir"].as_str().unwrap_or_default(),
            yes_no(result["versioned"].as_bool().unwrap_or(false)),
            result["current"].as_str().unwrap_or("none"),
            result["versions"].as_array().map_or(0, Vec::len)
        )),
        "history" => pretty(&result["versions"]),
        "doctor" => Ok(format!(
            "Schema doctor {}: {}\nSchema dir: {}",
            result["collection"].as_str().unwrap_or_default(),
            if result["ok"].as_bool().unwrap_or(false) {
                "ok"
            } else {
                "failed"
            },
            result["schemaDir"].as_str().unwrap_or_default()
        )),
        _ => pretty(result),
    }
}

fn render_sql(statement: &str, result: &Value, arguments: &[String]) -> Result<String, String> {
    let operation = statement
        .split_whitespace()
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    match operation.as_str() {
        "CREATE" => Ok("Successfully created schema".into()),
        "DROP" => Ok("Successfully dropped schema".into()),
        "INSERT" => Ok(result
            .as_str()
            .map_or_else(|| result.to_string(), ToOwned::to_owned)),
        "UPDATE" => Ok(format!("Successfully updated {result} document(s)")),
        "DELETE" => Ok(format!("Successfully deleted {result} document(s)")),
        "SELECT" => render_table(result, arguments),
        _ => pretty(result),
    }
}

#[derive(Clone, Copy)]
enum TableAlignment {
    Left,
    Center,
    Right,
    Auto,
}

struct TableColumn {
    key: String,
    width: usize,
    min_width: usize,
}

struct TableRow {
    key: String,
    values: Map<String, Value>,
}

fn render_table(result: &Value, arguments: &[String]) -> Result<String, String> {
    let documents = result
        .as_object()
        .ok_or_else(|| "SELECT result must be an object".to_owned())?;
    if documents.is_empty() {
        return Ok("(no rows)".into());
    }
    let alignment = table_alignment(option(arguments, "--align"))?;
    let page_size = table_page_size(option(arguments, "--page-size"))?;
    let row_key_label = if documents.keys().any(|key| decode_ttid(key).is_ok()) {
        "_id"
    } else {
        "_key"
    };
    let rows = documents
        .iter()
        .map(|(key, value)| {
            let mut values = Map::new();
            flatten_table_value(value, "", &mut values);
            TableRow {
                key: key.clone(),
                values,
            }
        })
        .collect::<Vec<_>>();
    let mut columns = build_table_columns(&rows);
    let key_width = rows
        .iter()
        .fold(display_width(row_key_label), |width, row| {
            width.max(display_width(&row.key).min(72))
        });
    columns.insert(
        0,
        TableColumn {
            key: row_key_label.into(),
            width: key_width + 2,
            min_width: 6,
        },
    );
    fit_table_columns(&mut columns);

    let page_size = page_size.unwrap_or(rows.len());
    let pages = rows
        .chunks(page_size)
        .map(|page| render_table_page(page, &columns, row_key_label, alignment))
        .collect::<Vec<_>>();
    Ok(pages.join("\n\n"))
}

fn table_alignment(value: Option<&str>) -> Result<TableAlignment, String> {
    match value.unwrap_or("auto") {
        "left" => Ok(TableAlignment::Left),
        "center" => Ok(TableAlignment::Center),
        "right" => Ok(TableAlignment::Right),
        "auto" => Ok(TableAlignment::Auto),
        value => Err(format!(
            "invalid --align value {value:?}; expected left, center, right, or auto"
        )),
    }
}

fn table_page_size(value: Option<&str>) -> Result<Option<usize>, String> {
    value
        .map(|value| {
            value
                .parse::<usize>()
                .ok()
                .filter(|size| *size > 0)
                .ok_or_else(|| "--page-size must be a positive integer".to_owned())
        })
        .transpose()
}

fn flatten_table_value(value: &Value, path: &str, output: &mut Map<String, Value>) {
    if let Some(object) = value.as_object()
        && !object.is_empty()
    {
        for (key, child) in object {
            let child_path = if path.is_empty() {
                key.clone()
            } else {
                format!("{path}.{key}")
            };
            flatten_table_value(child, &child_path, output);
        }
        return;
    }
    output.insert(
        if path.is_empty() { "value" } else { path }.into(),
        value.clone(),
    );
}

fn build_table_columns(rows: &[TableRow]) -> Vec<TableColumn> {
    let mut columns = Vec::<TableColumn>::new();
    for row in rows {
        for (key, value) in &row.values {
            let content_width =
                display_width(key).max(display_width(&format_table_value(value)).min(48));
            if let Some(column) = columns.iter_mut().find(|column| column.key == *key) {
                column.width = column.width.max(content_width + 2);
            } else {
                columns.push(TableColumn {
                    key: key.clone(),
                    width: content_width + 2,
                    min_width: 5,
                });
            }
        }
    }
    columns
}

fn fit_table_columns(columns: &mut [TableColumn]) {
    let terminal_width = env::var("COLUMNS")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|width| *width > 0);
    let Some(terminal_width) = terminal_width else {
        return;
    };
    while table_width(columns) > terminal_width {
        let candidate = columns
            .iter()
            .enumerate()
            .filter(|(_, column)| column.width > column.min_width)
            .max_by_key(|(_, column)| column.width)
            .map(|(index, _)| index);
        let Some(candidate) = candidate else {
            break;
        };
        columns[candidate].width -= 1;
    }
}

fn table_width(columns: &[TableColumn]) -> usize {
    columns.iter().map(|column| column.width).sum::<usize>() + columns.len() + 1
}

fn render_table_page(
    rows: &[TableRow],
    columns: &[TableColumn],
    row_key_label: &str,
    alignment: TableAlignment,
) -> String {
    let mut lines = vec![render_table_border(columns, '┌', '┬', '┐')];
    let headers = columns
        .iter()
        .map(|column| {
            (
                Some(Value::String(column.key.clone())),
                TableAlignment::Center,
            )
        })
        .collect::<Vec<_>>();
    lines.push(render_table_row(columns, &headers));
    lines.push(render_table_border(columns, '├', '┼', '┤'));
    for (index, row) in rows.iter().enumerate() {
        let mut values = Vec::with_capacity(columns.len());
        values.push((Some(Value::String(row.key.clone())), TableAlignment::Left));
        values.extend(
            columns
                .iter()
                .skip(1)
                .map(|column| (row.values.get(&column.key).cloned(), alignment)),
        );
        lines.push(render_table_row(columns, &values));
        if index + 1 < rows.len() {
            lines.push(render_table_border(columns, '├', '┼', '┤'));
        }
    }
    lines.push(render_table_border(columns, '└', '┴', '┘'));
    debug_assert_eq!(columns[0].key, row_key_label);
    lines.join("\n")
}

fn render_table_border(columns: &[TableColumn], left: char, middle: char, right: char) -> String {
    let segments = columns
        .iter()
        .map(|column| "─".repeat(column.width))
        .collect::<Vec<_>>()
        .join(&middle.to_string());
    format!("{left}{segments}{right}")
}

fn render_table_row(columns: &[TableColumn], values: &[(Option<Value>, TableAlignment)]) -> String {
    let cells = columns
        .iter()
        .zip(values)
        .map(|(column, (value, alignment))| {
            let content_width = column.width.saturating_sub(2);
            let text = value.as_ref().map_or_else(String::new, format_table_value);
            let text = truncate_table_value(&text, content_width);
            let alignment = resolve_table_alignment(value.as_ref(), *alignment);
            format!(" {} ", align_table_value(&text, content_width, alignment))
        })
        .collect::<Vec<_>>()
        .join("│");
    format!("│{cells}│")
}

fn resolve_table_alignment(value: Option<&Value>, requested: TableAlignment) -> TableAlignment {
    if !matches!(requested, TableAlignment::Auto) {
        return requested;
    }
    match value {
        Some(Value::Number(_)) => TableAlignment::Right,
        Some(Value::Bool(_)) => TableAlignment::Center,
        _ => TableAlignment::Left,
    }
}

fn align_table_value(value: &str, width: usize, alignment: TableAlignment) -> String {
    let padding = width.saturating_sub(display_width(value));
    match alignment {
        TableAlignment::Right => format!("{}{value}", " ".repeat(padding)),
        TableAlignment::Center => {
            let left = padding / 2;
            format!("{}{value}{}", " ".repeat(left), " ".repeat(padding - left))
        }
        TableAlignment::Left | TableAlignment::Auto => {
            format!("{value}{}", " ".repeat(padding))
        }
    }
}

fn format_table_value(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::String(value) => value.clone(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::Array(_) | Value::Object(_) => value.to_string(),
    }
}

fn truncate_table_value(value: &str, max_width: usize) -> String {
    if display_width(value) <= max_width {
        return value.into();
    }
    if max_width <= 3 {
        return ".".repeat(max_width);
    }
    let mut output = String::new();
    let mut width = 0;
    for character in value.chars() {
        let character_width = character_display_width(character);
        if width + character_width > max_width - 3 {
            break;
        }
        output.push(character);
        width += character_width;
    }
    format!("{output}...")
}

fn display_width(value: &str) -> usize {
    value.chars().map(character_display_width).sum()
}

fn character_display_width(character: char) -> usize {
    let point = u32::from(character);
    if character.is_control() || (0x300..=0x36f).contains(&point) {
        return 0;
    }
    if matches!(
        point,
        0x1100..=0x115f
            | 0x2329..=0x232a
            | 0x2e80..=0xa4cf
            | 0xac00..=0xd7a3
            | 0xf900..=0xfaff
            | 0xfe10..=0xfe19
            | 0xfe30..=0xfe6f
            | 0xff00..=0xff60
            | 0xffe0..=0xffe6
            | 0x1f300..=0x1faff
    ) && point != 0x303f
    {
        2
    } else {
        1
    }
}

fn compat_root(arguments: &[String]) -> Result<PathBuf, String> {
    if let Some(root) = option(arguments, "--root") {
        return Ok(PathBuf::from(root));
    }
    if let Some(root) = env::var_os("FYLO_ROOT") {
        return Ok(PathBuf::from(root));
    }
    env::current_dir()
        .map(|directory| directory.join(".fylo-data"))
        .map_err(|error| error.to_string())
}

fn required_message(arguments: &[String]) -> Result<&str, String> {
    option(arguments, "-m")
        .or_else(|| option(arguments, "--message"))
        .ok_or_else(|| "missing commit message; pass -m <message>".into())
}

fn required_positional<'a>(
    values: &'a [String],
    index: usize,
    description: &str,
) -> Result<&'a str, String> {
    values
        .get(index)
        .map(String::as_str)
        .ok_or_else(|| format!("missing {description}"))
}

fn positionals(arguments: &[String]) -> Vec<String> {
    const VALUE_FLAGS: &[&str] = &[
        "--root",
        "--schema-dir",
        "--request",
        "-m",
        "--message",
        "--page-size",
        "--align",
        "--output",
        "--max-request-bytes",
        "--max-response-bytes",
        "--collection",
        "--id",
        "--query",
        "--queries",
        "--statement",
        "--uid",
        "--groups",
        "--limit",
    ];
    let mut values = Vec::new();
    let mut index = 0;
    while index < arguments.len() {
        let argument = &arguments[index];
        if VALUE_FLAGS.contains(&argument.as_str()) {
            index += 2;
        } else if argument.starts_with('-') && argument != "-" {
            index += 1;
        } else {
            values.push(argument.clone());
            index += 1;
        }
    }
    values
}

fn read_json_source(source: &str) -> Result<String, String> {
    if source == "-" {
        let mut text = String::new();
        io::stdin()
            .read_to_string(&mut text)
            .map_err(|error| error.to_string())?;
        return Ok(text);
    }
    if let Some(path) = source.strip_prefix('@') {
        return fs::read_to_string(path).map_err(|error| error.to_string());
    }
    Ok(source.to_owned())
}

fn is_sql_command(input: &str) -> bool {
    let first = input
        .split_whitespace()
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    matches!(
        first.as_str(),
        "SELECT" | "INSERT" | "UPDATE" | "DELETE" | "CREATE" | "DROP" | "EXPLAIN"
    )
}

fn pretty(value: &Value) -> Result<String, String> {
    serde_json::to_string_pretty(value).map_err(|error| error.to_string())
}

const fn yes_no(value: bool) -> &'static str {
    if value { "yes" } else { "no" }
}

fn inspect_output(engine: &ReadOnlyEngine, arguments: &[String]) -> Result<String, String> {
    let collection = required_option(arguments, "--collection")?;
    serde_json::to_string_pretty(
        &engine
            .inspect(collection)
            .map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())
}

fn history_output(engine: &ReadOnlyEngine, arguments: &[String]) -> Result<String, String> {
    let limit = history_limit(arguments)?;
    serde_json::to_string_pretty(&engine.history(limit).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())
}

fn version_verification_output(
    engine: &ReadOnlyEngine,
    arguments: &[String],
) -> Result<String, String> {
    let limit = history_limit(arguments)?;
    serde_json::to_string_pretty(
        &engine
            .verify_history(limit)
            .map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())
}

fn history_limit(arguments: &[String]) -> Result<usize, String> {
    if !arguments.iter().any(|argument| argument == "--limit") {
        return Ok(50);
    }
    required_option(arguments, "--limit")?
        .parse()
        .map_err(|error| format!("invalid --limit: {error}"))
}

fn open_engine(root: &str) -> Result<ReadOnlyEngine, String> {
    let Ok(schema_root) = env::var("FYLO_SCHEMA") else {
        return ReadOnlyEngine::open(root).map_err(|error| error.to_string());
    };
    if !Path::new(&schema_root).is_dir() {
        return ReadOnlyEngine::open(root).map_err(|error| error.to_string());
    }
    let credentials = env::var("FYLO_ENCRYPTION_KEY")
        .ok()
        .zip(env::var("FYLO_CIPHER_SALT").ok());
    match credentials {
        Some((secret, salt)) => {
            ReadOnlyEngine::open_with_encryption(root, schema_root, &secret, &salt)
                .map_err(|error| error.to_string())
        }
        None => {
            ReadOnlyEngine::open_with_schema(root, schema_root).map_err(|error| error.to_string())
        }
    }
}

fn get_file_output(engine: &ReadOnlyEngine, arguments: &[String]) -> Result<String, String> {
    let collection = required_option(arguments, "--collection")?;
    let identifier = required_option(arguments, "--id")?;
    let actor = access_context(arguments)?;
    let file = match actor.as_ref() {
        Some(actor) => engine.get_file_as(collection, identifier, actor),
        None => engine.get_file(collection, identifier),
    }
    .map_err(|error| error.to_string())?;
    let mut output = serde_json::to_value(&file).map_err(|error| error.to_string())?;
    output
        .as_object_mut()
        .expect("ReadFile serializes as an object")
        .insert("bytesHex".into(), json!(hex(&file.bytes)));
    serde_json::to_string_pretty(&output).map_err(|error| error.to_string())
}

fn get_deleted_file_output(
    engine: &ReadOnlyEngine,
    arguments: &[String],
) -> Result<String, String> {
    let collection = required_option(arguments, "--collection")?;
    let identifier = required_option(arguments, "--id")?;
    let actor = access_context(arguments)?;
    let file = match actor.as_ref() {
        Some(actor) => engine.get_deleted_file_as(collection, identifier, actor),
        None => engine.get_deleted_file(collection, identifier),
    }
    .map_err(|error| error.to_string())?;
    let mut output = serde_json::to_value(&file).map_err(|error| error.to_string())?;
    output
        .as_object_mut()
        .expect("ReadDeletedFile serializes as an object")
        .insert("bytesHex".into(), json!(hex(&file.file.bytes)));
    serde_json::to_string_pretty(&output).map_err(|error| error.to_string())
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

fn access_context(arguments: &[String]) -> Result<Option<AccessContext>, String> {
    if !arguments.iter().any(|argument| argument == "--uid") {
        if arguments.iter().any(|argument| argument == "--groups") {
            return Err("--groups requires --uid".into());
        }
        return Ok(None);
    }
    let uid = required_option(arguments, "--uid")?
        .parse::<u32>()
        .map_err(|error| format!("invalid --uid: {error}"))?;
    let groups = if arguments.iter().any(|argument| argument == "--groups") {
        required_option(arguments, "--groups")?
            .split(',')
            .filter(|value| !value.is_empty())
            .map(|value| {
                value
                    .parse::<u32>()
                    .map_err(|error| format!("invalid --groups: {error}"))
            })
            .collect::<Result<Vec<_>, _>>()?
    } else {
        Vec::new()
    };
    Ok(Some(AccessContext::new(uid, groups)))
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
    "Usage:\n  fylo checkout [-b] <branch> [--root <path>] [--json]\n  fylo branch [--root <path>] [--json]\n  fylo commit -m <message> [--root <path>] [--json]\n  fylo log [--root <path>] [--json]\n  fylo status [--root <path>] [--json]\n  fylo diff [<from>] [<to>] [--root <path>] [--json]\n  fylo restore-commit <commit-id> [--root <path>] [--force] [--json]\n  fylo merge <ref> [-m <message>] [--root <path>] [--json]\n  fylo version [--output json]\n  fylo \"<SQL>\"\n  fylo sql \"<SQL>\"\n  fylo exec --request <json|@path|-> [--root <path>]\n  fylo exec --loop [--root <path>] [--exclusive-root]\n  fylo inspect <collection> [--root <path>] [--json]\n  fylo get <collection> <doc-id> [--root <path>] [--json]\n  fylo latest <collection> <doc-id> [--root <path>] [--json] [--id-only]\n  fylo rebuild <collection> [--root <path>] [--json]\n  fylo verify <collection> [--root <path>] [--json]\n  fylo deleted <collection> [--root <path>] [--json]\n  fylo restore <collection> <doc-id> [--root <path>] [--json]\n  fylo schema inspect <collection> [--schema-dir <path>] [--json]\n  fylo schema current <collection> [--schema-dir <path>] [--json]\n  fylo schema history <collection> [--schema-dir <path>] [--json]\n  fylo schema doctor <collection> [--schema-dir <path>] [--json]\n  fylo schema validate <collection> <json|@path|-> [--schema-dir <path>] [--json]\n  fylo schema materialize <collection> <json|@path|-> [--schema-dir <path>] [--json]\n\nOptions:\n  --root <path>   Override FYLO_ROOT for this command\n  --schema-dir <path> Override FYLO_SCHEMA for schema admin commands\n  --json          Emit machine-readable JSON output\n  --id-only       Return only the resolved document id for latest\n  -b              Create a new branch during checkout\n  -m, --message <v> Commit message\n  --force         Allow restore-commit to overwrite uncommitted changes\n  --request <v>   Machine request payload, @file path, or - for stdin\n  --exclusive-root Acquire an exclusive crash-safe root lease for exec --loop\n  --max-request-bytes <n> Maximum NDJSON request bytes, excluding LF\n  --max-response-bytes <n> Maximum NDJSON response bytes, excluding LF\n  --output <mode> Output mode for version: text or json\n  --version       Print the FYLO runtime version\n  --help          Show this message"
        .replace(
            "  --request <v>   Machine request payload, @file path, or - for stdin",
            "  --page-size <n> Repeat headers every n rows in text output\n  --align <mode>  Cell alignment: left, center, right, or auto\n  --request <v>   Machine request payload, @file path, or - for stdin",
        )
        .replace(
            "  --help          Show this message",
            "  --no-pager      Disable interactive paging even on large text output\n  --help          Show this message",
        )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_reports_compatibility_identity() {
        assert_eq!(run(&["version".into()]).unwrap(), VERSION.trim());
        let output = run(&["version".into(), "--output".into(), "json".into()]).unwrap();
        let identity: serde_json::Value = serde_json::from_str(&output).unwrap();
        assert_eq!(identity["runtimeVersion"], VERSION.trim());
        assert_eq!(
            identity["commit"],
            option_env!("FYLO_BUILD_COMMIT").unwrap_or("unknown")
        );
        assert_eq!(
            identity["buildKind"],
            option_env!("FYLO_BUILD_KIND").unwrap_or("development-compiled")
        );
        assert_eq!(identity["protocolVersion"], 1);
        assert_eq!(identity["capabilities"]["handshake"], true);
        assert!(identity["capabilities"].get("wholeRootBackup").is_none());
    }

    #[test]
    fn unknown_commands_are_rejected() {
        let error = run(&["put".into()]).unwrap_err();
        assert!(error.contains("Usage:"));
    }

    #[test]
    fn help_is_a_compatible_command_and_uses_the_published_binary_name() {
        let output = usage();
        assert!(output.starts_with("Usage:\n  fylo checkout"));
        assert!(output.contains("fylo exec --loop"));
        assert!(!output.contains("fylo-rust"));
    }

    #[test]
    fn machine_limits_reject_non_numeric_values() {
        let error = machine_limits(&["exec".into(), "--max-request-bytes".into(), "many".into()])
            .unwrap_err();
        assert!(error.contains("invalid --max-request-bytes"));
    }
}
