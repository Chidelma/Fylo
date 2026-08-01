//! Bounded NDJSON machine protocol v1 over the native Rust engine.
//!
//! The canonical contract lives in `api/machine/v1`. This crate owns framing,
//! limits, and stable error mapping; it does not reimplement query,
//! permission, or transaction semantics.

mod strict;

use std::io::{BufRead, Read, Write};
use std::net::{IpAddr, SocketAddr, ToSocketAddrs};
use std::path::PathBuf;
use std::time::Duration;
use std::time::Instant;

use base64::Engine as _;
use fylo_engine::{AccessContext, EngineError, ReadOnlyEngine, WriteEngine};
use fylo_query::{JoinSpec, QueryLimits, SqlOperation, StructuredQuery, prepare_sql};
use fylo_storage_native::{
    CollectionKind, NativeStorageError, NativeStorageErrorCode, NativeWriteRoot, PutRawFileOptions,
    RootLease, SqlMutationResultKind, WriteAccess, WriteActor,
};
use serde::Serialize;
use serde_json::{Value, json};

pub use strict::StrictValue;

/// Protocol major version implemented by this crate.
pub const PROTOCOL_VERSION: u32 = 1;
/// Default maximum request frame, excluding the LF delimiter.
pub const DEFAULT_MAX_REQUEST_BYTES: usize = 1024 * 1024;
/// Default maximum response frame, excluding the LF delimiter.
pub const DEFAULT_MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
/// Largest frame limit an operator may configure.
pub const MAX_CONFIGURED_FRAME_BYTES: usize = 64 * 1024 * 1024;
/// Published default page size for `findDocs`/`findDeletedDocs`.
pub const DEFAULT_QUERY_PAGE_ITEMS: usize = 256;
/// Published maximum page size.
pub const MAX_QUERY_PAGE_ITEMS: usize = 4096;
/// Published cursor lifetime.
pub const QUERY_CURSOR_TTL_MS: u64 = 15 * 60 * 1000;
/// Published maximum materialized query snapshot size.
pub const MAX_QUERY_SNAPSHOT_BYTES: usize = 1024 * 1024 * 1024;
const MAX_MACHINE_FILE_BYTES: u64 = 512 * 1024 * 1024;

const RUNTIME_VERSION: &str = include_str!("../../../VERSION");
const BUILD_COMMIT: &str = match option_env!("FYLO_BUILD_COMMIT") {
    Some(commit) => commit,
    None => "unknown",
};
const BUILD_KIND: &str = match option_env!("FYLO_BUILD_KIND") {
    Some(kind) => kind,
    None => "development-compiled",
};
const BUILD_TARGET: Option<&str> = option_env!("FYLO_BUILD_TARGET");
const REQUIRED_CHEX_VERSION: &str = "26.28.02";
const REQUIRED_TTID_VERSION: &str = "26.28.02";
#[cfg(any(target_os = "macos", target_os = "linux"))]
const MACHINE_ACCESS_OPERATIONS: &[&str] = &[
    "executeSQL",
    "getDoc",
    "getLatest",
    "getMeta",
    "setMeta",
    "findDocs",
    "findDeletedDocs",
    "restoreDoc",
    "joinDocs",
    "putData",
    "batchPutData",
    "patchDoc",
    "patchDocs",
    "delDoc",
    "delDocs",
    "importBulkData",
];
const DOCUMENT_BUCKET_OPERATIONS: &[&str] = &[
    "createCollection",
    "dropCollection",
    "inspectCollection",
    "rebuildCollection",
    "verifyCollection",
    "getDoc",
    "getLatest",
    "getMeta",
    "setMeta",
    "findDocs",
    "findDeletedDocs",
    "restoreDoc",
    "putData",
    "patchDoc",
    "patchDocs",
    "delDoc",
    "delDocs",
];

/// Frame size limits for one machine session.
#[derive(Clone, Copy, Debug)]
pub struct FrameLimits {
    /// Maximum request frame bytes, excluding the delimiter.
    pub max_request_bytes: usize,
    /// Maximum response frame bytes, excluding the delimiter.
    pub max_response_bytes: usize,
}

impl Default for FrameLimits {
    fn default() -> Self {
        Self {
            max_request_bytes: DEFAULT_MAX_REQUEST_BYTES,
            max_response_bytes: DEFAULT_MAX_RESPONSE_BYTES,
        }
    }
}

impl FrameLimits {
    /// Clamp operator-supplied limits into the published range.
    #[must_use]
    pub fn clamped(self) -> Self {
        Self {
            max_request_bytes: self.max_request_bytes.clamp(1, MAX_CONFIGURED_FRAME_BYTES),
            max_response_bytes: self.max_response_bytes.clamp(1, MAX_CONFIGURED_FRAME_BYTES),
        }
    }
}

/// Stable machine error carried in a failure frame.
#[derive(Clone, Debug, Serialize)]
struct MachineError {
    name: &'static str,
    message: String,
    code: String,
}

impl MachineError {
    fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            name: "FyloMachineError",
            message: message.into(),
            code: code.to_owned(),
        }
    }
}

/// Outcome of one frame, so the caller can honour terminate-versus-resume.
enum FrameOutcome {
    Handled,
    Terminate,
    Eof,
}

/// Serve one bounded NDJSON session until EOF or a terminating frame error.
///
/// The default `root` comes from the session; a request may override it.
///
/// # Errors
///
/// Returns an error only when the transport itself fails. Protocol problems
/// are reported as failure frames.
pub fn serve<R: BufRead, W: Write>(
    input: &mut R,
    output: &mut W,
    default_root: Option<PathBuf>,
    limits: FrameLimits,
) -> std::io::Result<()> {
    serve_session(input, output, default_root, limits, false, true)
}

/// Execute exactly one bounded request without retaining process-scoped state.
///
/// Paged queries require [`serve`] or [`serve_exclusive`] because their cursor
/// snapshots must survive across request frames.
///
/// # Errors
///
/// Returns an error only when the bounded transport cannot be read or written.
pub fn serve_once<R: BufRead, W: Write>(
    input: &mut R,
    output: &mut W,
    default_root: Option<PathBuf>,
    limits: FrameLimits,
) -> std::io::Result<()> {
    serve_session(input, output, default_root, limits, false, false)
}

/// Serve one bounded session after acquiring the default root before the
/// handshake is answered.
///
/// This is the public `exec --loop --exclusive-root` contract: successful
/// readiness means the caller already owns the root, while a contender gets a
/// structured `EROOTLOCKED` response to its first frame.
///
/// # Errors
///
/// Returns an error only when the transport itself fails.
pub fn serve_exclusive<R: BufRead, W: Write>(
    input: &mut R,
    output: &mut W,
    default_root: Option<PathBuf>,
    limits: FrameLimits,
) -> std::io::Result<()> {
    serve_session(input, output, default_root, limits, true, true)
}

fn serve_session<R: BufRead, W: Write>(
    input: &mut R,
    output: &mut W,
    default_root: Option<PathBuf>,
    limits: FrameLimits,
    exclusive_root: bool,
    persistent: bool,
) -> std::io::Result<()> {
    let limits = limits.clamped();
    let mut leases = std::collections::BTreeMap::new();
    let startup_error = if exclusive_root {
        match default_root.as_ref() {
            None => Some(MachineError::new(
                "EBADREQUEST",
                "--exclusive-root requires a default FYLO root",
            )),
            Some(root) => match RootLease::acquire(root) {
                Err(error) => Some(storage_error(&error)),
                Ok(lease) => {
                    let recovery = NativeWriteRoot::open(root)
                        .and_then(|writer| writer.recover_repository_materialization());
                    match recovery {
                        Ok(()) => {
                            leases.insert(root.clone(), lease);
                            None
                        }
                        Err(error) => Some(storage_error(&error)),
                    }
                }
            },
        }
    } else {
        None
    };
    let mut session = Session {
        default_root,
        limits,
        leases: std::cell::RefCell::new(leases),
        cursors: std::cell::RefCell::new(std::collections::BTreeMap::new()),
        cursor_sequence: std::cell::Cell::new(0),
        startup_error,
        persistent,
    };
    loop {
        match session.handle_frame(input, output)? {
            FrameOutcome::Handled => {}
            FrameOutcome::Terminate | FrameOutcome::Eof => return Ok(()),
        }
    }
}

struct Session {
    default_root: Option<PathBuf>,
    limits: FrameLimits,
    leases: std::cell::RefCell<std::collections::BTreeMap<PathBuf, RootLease>>,
    cursors: std::cell::RefCell<std::collections::BTreeMap<String, CursorState>>,
    cursor_sequence: std::cell::Cell<u64>,
    startup_error: Option<MachineError>,
    persistent: bool,
}

/// One paginated query snapshot, held for the life of the session.
struct CursorState {
    scope: String,
    rows: Vec<(String, Value)>,
    position: usize,
    expires_at: u64,
}

impl Session {
    fn handle_frame<R: BufRead, W: Write>(
        &mut self,
        input: &mut R,
        output: &mut W,
    ) -> std::io::Result<FrameOutcome> {
        let started = Instant::now();
        let (frame, read, oversized, delimited) = self.read_request_frame(input)?;
        if read == 0 && frame.is_empty() {
            return Ok(FrameOutcome::Eof);
        }
        if oversized {
            Self::write_failure(
                output,
                None,
                None,
                started,
                &MachineError::new(
                    "EFRAME_REQUEST_TOO_LARGE",
                    format!(
                        "machine request frame exceeds {} bytes",
                        self.limits.max_request_bytes
                    ),
                ),
            )?;
            return Ok(FrameOutcome::Handled);
        }
        if !delimited {
            // A truncated final frame is unrecoverable: the remainder of the
            // request may never arrive, so the session ends.
            Self::write_failure(
                output,
                None,
                None,
                started,
                &MachineError::new(
                    "EFRAME_TRUNCATED",
                    "machine request frame ended without a delimiter",
                ),
            )?;
            return Ok(FrameOutcome::Terminate);
        }
        if frame.is_empty() {
            return Ok(FrameOutcome::Handled);
        }
        let Ok(text) = std::str::from_utf8(&frame) else {
            Self::write_failure(
                output,
                None,
                None,
                started,
                &MachineError::new("EFRAME_UTF8", "machine request frame is not valid UTF-8"),
            )?;
            return Ok(FrameOutcome::Handled);
        };
        let request = match serde_json::from_str::<StrictValue>(text) {
            Ok(request) => request.into_inner(),
            Err(error) => {
                let duplicate = error.to_string().contains("duplicate key");
                let code = if duplicate {
                    "EFRAME_DUPLICATE_KEY"
                } else {
                    "EFRAME_JSON"
                };
                Self::write_failure(
                    output,
                    None,
                    None,
                    started,
                    &MachineError::new(code, error.to_string()),
                )?;
                return Ok(FrameOutcome::Handled);
            }
        };
        let request_id = optional_string(&request, "requestId");
        let operation = optional_string(&request, "op");
        if let Some(error) = self.startup_error.take() {
            Self::write_failure(
                output,
                operation.as_deref(),
                request_id.as_deref(),
                started,
                &error,
            )?;
            return Ok(FrameOutcome::Terminate);
        }
        match self.dispatch(&request) {
            Ok(result) => self.write_success(
                output,
                operation.as_deref(),
                request_id.as_deref(),
                started,
                &result,
            ),
            Err(error) => Self::write_failure(
                output,
                operation.as_deref(),
                request_id.as_deref(),
                started,
                &error,
            ),
        }?;
        Ok(FrameOutcome::Handled)
    }

    fn read_request_frame<R: BufRead>(
        &self,
        input: &mut R,
    ) -> std::io::Result<(Vec<u8>, usize, bool, bool)> {
        let mut frame = Vec::new();
        let (read, oversized, delimited) =
            read_frame(input, self.limits.max_request_bytes, &mut frame)?;
        Ok((frame, read, oversized, delimited))
    }

    fn dispatch(&self, request: &Value) -> Result<Value, MachineError> {
        let Some(operation) = request.get("op").and_then(Value::as_str) else {
            return Err(MachineError::new(
                "EBADREQUEST",
                "machine request field \"op\" must be a string",
            ));
        };
        match operation {
            "handshake" => Ok(self.handshake()),
            "getDoc" => self.get_document(request),
            "findDocs" => self.find_documents(request),
            "inspectCollection" => self.inspect_collection(request),
            "verifyCollection" => self.verify_collection(request),
            "log" => self.history(request),
            "getMeta" => self.get_metadata(request),
            "executeSQL" => self.execute_sql(request),
            "joinDocs" => self.join_documents(request),
            "createCollection" => self.create_collection(request),
            "dropCollection" => self.drop_collection(request),
            "rebuildCollection" => self.rebuild_collection(request),
            "putData" => self.put_data(request),
            "patchDoc" => self.patch_document(request),
            "delDoc" => self.delete_document(request),
            "setMeta" => self.set_metadata(request),
            "commit" => self.commit(request),
            "getLatest" => self.get_latest(request),
            "findDeletedDocs" => self.find_deleted_documents(request),
            "restoreDoc" => self.restore_document(request),
            "batchPutData" => self.batch_put_data(request),
            "patchDocs" => self.patch_documents(request),
            "delDocs" => self.delete_documents(request),
            "checkout" => self.checkout(request),
            "branch" => self.branches(request),
            "status" => self.status(request),
            "diff" => self.diff(request),
            "restoreCommit" => self.restore_commit(request),
            "merge" => self.merge(request),
            "schemaInspect" => self.schema_inspect(request),
            "schemaCurrent" => self.schema_current(request),
            "schemaHistory" => self.schema_history(request),
            "schemaDoctor" => self.schema_doctor(request),
            "schemaValidate" => self.schema_validate(request),
            "schemaMaterialize" => self.schema_materialize(request),
            "importBulkData" => self.import_bulk_data(request),
            _ => Err(MachineError::new(
                "EUNSUPPORTEDOP",
                format!("unknown machine operation {operation}"),
            )),
        }
    }

    fn handshake(&self) -> Value {
        let capabilities = serde_json::Map::from_iter([
            ("handshake".into(), Value::Bool(true)),
            ("exclusiveRoot".into(), Value::Bool(true)),
            (
                "queryPagination".into(),
                json!({
                    "version": 1,
                    "operations": ["findDocs", "findDeletedDocs"],
                    "defaultItems": DEFAULT_QUERY_PAGE_ITEMS,
                    "maxItems": MAX_QUERY_PAGE_ITEMS,
                    "maxSnapshotBytes": MAX_QUERY_SNAPSHOT_BYTES,
                    "cursorTtlMs": QUERY_CURSOR_TTL_MS,
                    "ordering": "ttid-binary-ascending",
                    "scope": "persistent-process",
                    "restartPolicy": "restart-from-first-page",
                    "mutationPolicy": "snapshot-at-first-page"
                }),
            ),
            (
                "documentBuckets".into(),
                json!({
                    "version": 1,
                    "collectionKind": "file",
                    "operations": DOCUMENT_BUCKET_OPERATIONS,
                    "putInputs": ["path", "url"],
                    "integrity": "sha256-full-content"
                }),
            ),
        ]);
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        let capabilities = {
            let mut capabilities = capabilities;
            capabilities.insert(
                "machineAccess".into(),
                json!({
                    "version": 1,
                    "operations": MACHINE_ACCESS_OPERATIONS,
                    "writeDescriptorFields": ["uid", "gid", "mode"],
                    "actorFields": ["uid", "groups"],
                    "directDenial": "EACCES",
                    "queryDenial": "omit"
                }),
            );
            capabilities
        };
        json!({
            "protocolVersion": PROTOCOL_VERSION,
            "runtimeVersion": RUNTIME_VERSION.trim(),
            "commit": BUILD_COMMIT,
            "buildKind": BUILD_KIND,
            "buildTarget": runtime_target(),
            "dependencies": {
                "chex": {
                    "requiredVersion": REQUIRED_CHEX_VERSION,
                    "available": executable_on_path("chex"),
                },
                "ttid": {
                    "requiredVersion": REQUIRED_TTID_VERSION,
                    "available": executable_on_path("ttid"),
                },
            },
            "machine": {
                "framing": "ndjson",
                "encoding": "utf-8",
                "delimiter": "LF",
                "delimiterCountsTowardLimit": false,
                "maxRequestBytes": self.limits.max_request_bytes,
                "maxResponseBytes": self.limits.max_response_bytes,
                "duplicateKeys": "rejected",
                "truncatedFrame": "error-and-terminate",
                "malformedFrame": "error-and-resume-at-next-LF"
            },
            "capabilities": capabilities
        })
    }

    /// Resolve the request's root, taking an exclusive kernel lease the first
    /// time this session touches it.
    ///
    /// The lease is held for the life of the session, so a JavaScript owner
    /// cannot open the root underneath us and we cannot open one it holds. The
    /// recorded generation is re-checked per frame, which is a cheap read of a
    /// resident file.
    fn root(&self, request: &Value) -> Result<PathBuf, MachineError> {
        let root = request
            .get("root")
            .and_then(Value::as_str)
            .map(PathBuf::from)
            .or_else(|| self.default_root.clone())
            .ok_or_else(|| {
                MachineError::new("EBADREQUEST", "machine request requires a FYLO root")
            })?;
        let mut leases = self.leases.borrow_mut();
        if let Some(lease) = leases.get(&root) {
            lease
                .assert_owned()
                .map_err(|error| storage_error(&error))?;
            return Ok(root);
        }
        let lease = RootLease::acquire(&root).map_err(|error| storage_error(&error))?;
        NativeWriteRoot::open(&root)
            .and_then(|writer| writer.recover_repository_materialization())
            .map_err(|error| storage_error(&error))?;
        leases.insert(root.clone(), lease);
        Ok(root)
    }

    fn engine(&self, request: &Value) -> Result<ReadOnlyEngine, MachineError> {
        let repository_root = self.root(request)?;
        let active_root = active_worktree(&repository_root)?;
        ReadOnlyEngine::open_with_repository(active_root, repository_root)
            .map_err(|error| engine_error(&error))
    }

    fn get_document(&self, request: &Value) -> Result<Value, MachineError> {
        let engine = self.engine(request)?;
        let collection = require_string(request, "collection")?;
        let identifier = require_string(request, "id")?;
        let actor = actor(request)?;
        let kind = engine
            .inspect(collection)
            .map_err(|error| engine_error(&error))?
            .kind;
        if kind == CollectionKind::File {
            let file = match actor.as_ref() {
                Some(actor) => engine.get_file_as(collection, identifier, actor),
                None => engine.get_file(collection, identifier),
            };
            let file = match file {
                Ok(file) => file,
                Err(error) if error.storage_code() == Some(NativeStorageErrorCode::NotFound) => {
                    return Ok(json!({}));
                }
                Err(error) => return Err(engine_error(&error)),
            };
            let mut manifest = serde_json::to_value(file.file)
                .map_err(|error| serialization_error(&error))?
                .as_object()
                .cloned()
                .unwrap_or_default();
            if !file.custom_metadata.is_empty() {
                manifest.insert("meta".into(), Value::Object(file.custom_metadata));
            }
            return Ok(json!({ identifier: manifest }));
        }
        let record = match actor.as_ref() {
            Some(actor) => engine.get_as(collection, identifier, actor),
            None => engine.get(collection, identifier),
        };
        let record = match record {
            Ok(record) => record,
            Err(error) if error.storage_code() == Some(NativeStorageErrorCode::NotFound) => {
                return Ok(json!({}));
            }
            Err(error) => return Err(engine_error(&error)),
        };
        let document =
            serde_json::to_value(record.document).map_err(|error| serialization_error(&error))?;
        Ok(json!({ identifier: document }))
    }

    fn find_documents(&self, request: &Value) -> Result<Value, MachineError> {
        let engine = self.engine(request)?;
        let collection = require_string(request, "collection")?;
        let query = structured_query(request)?;
        let actor = actor(request)?;
        if engine
            .inspect(collection)
            .map_err(|error| engine_error(&error))?
            .kind
            == CollectionKind::File
        {
            let pairs = engine
                .find_files(collection, &query, actor.as_ref())
                .map_err(|error| engine_error(&error))?
                .into_iter()
                .map(|(identifier, fields)| (identifier, Value::Object(fields)))
                .collect();
            return self.shape_query_result(request, pairs);
        }
        let rows = match actor.as_ref() {
            Some(actor) => engine.find_as(collection, &query, actor),
            None => engine.find(collection, &query),
        }
        .map_err(|error| engine_error(&error))?;
        let mut pairs = Vec::with_capacity(rows.len());
        for record in rows {
            let identifier = record.metadata.id.clone();
            let document = serde_json::to_value(record.document)
                .map_err(|error| serialization_error(&error))?;
            pairs.push((identifier, document));
        }
        self.shape_query_result(request, pairs)
    }

    fn shape_query_result(
        &self,
        request: &Value,
        pairs: Vec<(String, Value)>,
    ) -> Result<Value, MachineError> {
        if request.get("page").is_none() {
            if request.get("query").and_then(|query| query.get("$onlyIds"))
                == Some(&Value::Bool(true))
            {
                return Ok(Value::Array(
                    pairs
                        .into_iter()
                        .map(|(identifier, _)| Value::String(identifier))
                        .collect(),
                ));
            }
            return Ok(Value::Object(pairs.into_iter().collect()));
        }
        self.paginate(request, pairs)
    }

    /// Reshaped into the published `inspectCollection` result so an existing
    /// client sees the same field names both engines have always emitted.
    fn inspect_collection(&self, request: &Value) -> Result<Value, MachineError> {
        let engine = self.engine(request)?;
        let collection = require_string(request, "collection")?;
        let inspection = engine
            .inspect(collection)
            .map_err(|error| engine_error(&error))?;
        let kind =
            serde_json::to_value(inspection.kind).map_err(|error| serialization_error(&error))?;
        let indexed = engine
            .verify_index(collection)
            .map_err(|error| engine_error(&error))?
            .indexed_documents;
        Ok(json!({
            "collection": inspection.collection,
            "kind": kind,
            "exists": true,
            "worm": false,
            "docsStored": inspection.document_count + inspection.file_count,
            "deletedDocs": inspection.deleted_count,
            "indexedDocs": indexed,
        }))
    }

    fn verify_collection(&self, request: &Value) -> Result<Value, MachineError> {
        let collection = require_string(request, "collection")?;
        self.writer(request)?
            .verify_file_collection(collection)
            .map_err(|error| storage_error(&error))
    }

    fn history(&self, request: &Value) -> Result<Value, MachineError> {
        let engine = self.engine(request)?;
        let limit = request
            .get("limit")
            .and_then(Value::as_u64)
            .and_then(|limit| usize::try_from(limit).ok())
            .unwrap_or(50);
        let history = engine
            .history(limit)
            .map_err(|error| engine_error(&error))?;
        serde_json::to_value(history.commits).map_err(|error| serialization_error(&error))
    }

    fn get_metadata(&self, request: &Value) -> Result<Value, MachineError> {
        let engine = self.engine(request)?;
        let collection = require_string(request, "collection")?;
        let identifier = require_string(request, "id")?;
        let actor = actor(request)?;
        match actor.as_ref() {
            Some(actor) => engine.metadata_as(collection, identifier, actor),
            None => engine.metadata(collection, identifier),
        }
        .map_err(|error| engine_error(&error))
    }

    fn writer(&self, request: &Value) -> Result<NativeWriteRoot, MachineError> {
        let repository_root = self.root(request)?;
        let active_root = active_worktree(&repository_root)?;
        NativeWriteRoot::open_with_repository(active_root, repository_root)
            .map_err(|error| storage_error(&error))
    }

    fn write_engine(&self, request: &Value) -> Result<WriteEngine, MachineError> {
        let repository_root = self.root(request)?;
        let root = active_worktree(&repository_root)?;
        let schema = request
            .get("schemaDir")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
            .or_else(|| configured("FYLO_SCHEMA"))
            .filter(|schema| std::path::Path::new(schema).is_dir());
        let credentials = configured("FYLO_ENCRYPTION_KEY").zip(configured("FYLO_CIPHER_SALT"));
        match (schema, credentials) {
            (Some(schema), Some((secret, salt))) => {
                WriteEngine::open_with_repository_and_encryption(
                    root,
                    repository_root,
                    schema,
                    &secret,
                    &salt,
                )
            }
            (Some(schema), None) => {
                WriteEngine::open_with_repository_and_schema(root, repository_root, schema)
            }
            (None, _) => WriteEngine::open_with_repository(root, repository_root),
        }
        .map_err(|error| engine_error(&error))
    }

    /// `SELECT` is answered by the read engine; every mutation goes through the
    /// native transaction writer, so both share the published SQL contract.
    fn execute_sql(&self, request: &Value) -> Result<Value, MachineError> {
        let statement = require_string(request, "sql")?;
        let plan = prepare_sql(statement, QueryLimits::default())
            .map_err(|error| MachineError::new("EQUERY_INVALID", error.to_string()))?;
        if plan.operation == SqlOperation::Select {
            let engine = self.engine(request)?;
            let actor = actor(request)?;
            return match actor.as_ref() {
                Some(actor) => engine.select_sql_as(&plan, actor),
                None => engine.select_sql(&plan),
            }
            .map_err(|error| engine_error(&error));
        }
        let writer = self.writer(request)?;
        let actor = write_actor(request)?;
        let mutation = writer
            .execute_sql_mutation(statement, actor.as_ref(), access(request)?)
            .map_err(|error| storage_error(&error))?;
        match mutation.kind {
            SqlMutationResultKind::Insert => mutation
                .identifiers
                .into_iter()
                .next()
                .map(Value::String)
                .ok_or_else(|| {
                    MachineError::new("EUNKNOWN", "native SQL INSERT returned no identifier")
                }),
            SqlMutationResultKind::Update | SqlMutationResultKind::Delete => {
                Ok(Value::from(mutation.affected))
            }
        }
    }

    fn join_documents(&self, request: &Value) -> Result<Value, MachineError> {
        let Some(join) = request.get("join") else {
            return Err(MachineError::new(
                "EBADREQUEST",
                "machine request field \"join\" must be an object",
            ));
        };
        let join = JoinSpec::from_value(join, QueryLimits::default())
            .map_err(|error| MachineError::new("EBADREQUEST", error.to_string()))?;
        let engine = self.engine(request)?;
        let actor = actor(request)?;
        let result = engine
            .join(&join, actor.as_ref())
            .map_err(|error| engine_error(&error))?;
        serde_json::to_value(result).map_err(|error| serialization_error(&error))
    }

    fn create_collection(&self, request: &Value) -> Result<Value, MachineError> {
        let collection = require_string(request, "collection")?;
        let kind = match request.get("kind").and_then(Value::as_str) {
            None | Some("document") => CollectionKind::Document,
            Some("file") => CollectionKind::File,
            Some(_) => {
                return Err(MachineError::new(
                    "EBADREQUEST",
                    "machine request field \"kind\" must be \"document\" or \"file\"",
                ));
            }
        };
        self.writer(request)?
            .create_collection(collection, kind, None)
            .map_err(|error| storage_error(&error))?;
        Ok(json!({
            "collection": collection,
            "kind": match kind {
                CollectionKind::Document => "document",
                CollectionKind::File => "file",
            }
        }))
    }

    fn drop_collection(&self, request: &Value) -> Result<Value, MachineError> {
        let collection = require_string(request, "collection")?;
        self.writer(request)?
            .drop_collection(collection)
            .map_err(|error| storage_error(&error))?;
        Ok(json!({ "collection": collection }))
    }

    fn rebuild_collection(&self, request: &Value) -> Result<Value, MachineError> {
        let collection = require_string(request, "collection")?;
        self.writer(request)?
            .rebuild_collection(collection)
            .map_err(|error| storage_error(&error))?;
        let engine = self.engine(request)?;
        let inspection = engine
            .inspect(collection)
            .map_err(|error| engine_error(&error))?;
        let kind =
            serde_json::to_value(inspection.kind).map_err(|error| serialization_error(&error))?;
        let indexed = engine
            .verify_index(collection)
            .map_err(|error| engine_error(&error))?
            .indexed_documents;
        Ok(json!({
            "collection": collection,
            "kind": kind,
            "worm": false,
            "docsScanned": inspection.document_count + inspection.file_count,
            "indexedDocs": indexed,
        }))
    }

    fn put_data(&self, request: &Value) -> Result<Value, MachineError> {
        let collection = require_string(request, "collection")?;
        if request.get("file").is_some() {
            return self.put_file_data(request, collection);
        }
        let Some(data) = request.get("data").and_then(Value::as_object) else {
            return Err(MachineError::new(
                "EBADREQUEST",
                "machine request field \"data\" must be an object",
            ));
        };
        let identifier = match request.get("id").and_then(Value::as_str) {
            Some(identifier) => identifier.to_owned(),
            None => self
                .writer(request)?
                .allocate_identifier()
                .map_err(|error| storage_error(&error))?,
        };
        let metadata = request
            .get("meta")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .collect();
        self.write_engine(request)?
            .put_document_with_metadata(
                collection,
                &identifier,
                data.clone(),
                metadata,
                access(request)?,
            )
            .map_err(|error| engine_error(&error))?;
        Ok(Value::String(identifier))
    }

    fn put_file_data(&self, request: &Value, collection: &str) -> Result<Value, MachineError> {
        let file = request
            .get("file")
            .and_then(Value::as_object)
            .ok_or_else(|| {
                MachineError::new(
                    "EBADREQUEST",
                    "machine request field \"file\" must be an object",
                )
            })?;
        let path = file.get("path").and_then(Value::as_str);
        let url = file.get("url").and_then(Value::as_str);
        if path.is_some() == url.is_some() {
            return Err(MachineError::new(
                "EBADREQUEST",
                "machine file input requires exactly one of \"path\" or \"url\"",
            ));
        }
        let (bytes, filename) = if let Some(path) = path {
            read_machine_file(path)?
        } else {
            fetch_machine_file(url.unwrap_or_default())?
        };
        let options = request.get("fileOptions").and_then(Value::as_object);
        let key = file
            .get("key")
            .and_then(Value::as_str)
            .or_else(|| {
                options
                    .and_then(|options| options.get("key"))
                    .and_then(Value::as_str)
            })
            .map_or_else(|| format!("/{filename}"), ToOwned::to_owned);
        let metadata = request
            .get("meta")
            .and_then(Value::as_object)
            .or_else(|| {
                options
                    .and_then(|options| options.get("meta"))
                    .and_then(Value::as_object)
            })
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .collect();
        let extension = std::path::Path::new(&filename)
            .extension()
            .and_then(|extension| extension.to_str())
            .map(|extension| format!(".{}", extension.to_ascii_lowercase()))
            .unwrap_or_default();
        let identifier = request
            .get("id")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
            .map_or_else(
                || {
                    self.writer(request)?
                        .allocate_identifier()
                        .map_err(|error| storage_error(&error))
                },
                Ok,
            )?;
        self.writer(request)?
            .put_raw_file(
                collection,
                &identifier,
                &bytes,
                &PutRawFileOptions {
                    key,
                    extension,
                    metadata,
                    access: access(request)?,
                },
            )
            .map_err(|error| storage_error(&error))?;
        Ok(Value::String(identifier))
    }

    fn patch_document(&self, request: &Value) -> Result<Value, MachineError> {
        let collection = require_string(request, "collection")?;
        let identifier = require_string(request, "id")?;
        let Some(changes) = request.get("newDoc").and_then(Value::as_object) else {
            return Err(MachineError::new(
                "EBADREQUEST",
                "machine request field \"newDoc\" must be an object",
            ));
        };
        let actor = write_actor(request)?;
        self.writer(request)?
            .patch_document_fields(collection, identifier, changes, actor.as_ref())
            .map_err(|error| storage_error(&error))?;
        Ok(Value::String(identifier.to_owned()))
    }

    fn delete_document(&self, request: &Value) -> Result<Value, MachineError> {
        let collection = require_string(request, "collection")?;
        let identifier = require_string(request, "id")?;
        let actor = write_actor(request)?;
        self.writer(request)?
            .delete_document(collection, identifier, actor.as_ref())
            .map_err(|error| storage_error(&error))?;
        Ok(json!({ "deleted": true }))
    }

    fn set_metadata(&self, request: &Value) -> Result<Value, MachineError> {
        let collection = require_string(request, "collection")?;
        let identifier = require_string(request, "id")?;
        let Some(record) = request.get("meta").and_then(Value::as_object) else {
            return Err(MachineError::new(
                "EBADREQUEST",
                "machine request field \"meta\" must be an object",
            ));
        };
        let actor = write_actor(request)?;
        self.writer(request)?
            .set_record_metadata(collection, identifier, record, actor.as_ref())
            .map_err(|error| storage_error(&error))?;
        self.get_metadata(request)
    }

    /// Returns the JavaScript commit manifest shape by reading back the commit
    /// the writer just published, or `null` when nothing changed.
    fn commit(&self, request: &Value) -> Result<Value, MachineError> {
        let message = require_string(request, "message")?;
        let created = self
            .writer(request)?
            .commit_if_dirty(message)
            .map_err(|error| storage_error(&error))?;
        if created.is_none() {
            return Ok(Value::Null);
        }
        let history = self
            .engine(request)?
            .history(1)
            .map_err(|error| engine_error(&error))?;
        serde_json::to_value(history.commits.first()).map_err(|error| serialization_error(&error))
    }

    /// `getLatest` differs from `getDoc` only in its absent-record contract:
    /// an empty object, or `null` when the caller asked for the identifier.
    fn get_latest(&self, request: &Value) -> Result<Value, MachineError> {
        let only_id = request.get("onlyId") == Some(&Value::Bool(true));
        match self.get_document(request) {
            Ok(document) => {
                if document.as_object().is_some_and(serde_json::Map::is_empty) {
                    return if only_id {
                        Ok(Value::Null)
                    } else {
                        Ok(json!({}))
                    };
                }
                if only_id {
                    Ok(Value::String(require_string(request, "id")?.to_owned()))
                } else {
                    Ok(document)
                }
            }
            Err(error) if error.code == "ENATIVE_NOT_FOUND" || error.code == "EENGINE_STORAGE" => {
                if only_id {
                    Ok(Value::Null)
                } else {
                    Ok(json!({}))
                }
            }
            Err(error) => Err(error),
        }
    }

    fn find_deleted_documents(&self, request: &Value) -> Result<Value, MachineError> {
        let engine = self.engine(request)?;
        let collection = require_string(request, "collection")?;
        let query = structured_query(request)?;
        let actor = actor(request)?;
        if engine
            .inspect(collection)
            .map_err(|error| engine_error(&error))?
            .kind
            == CollectionKind::File
        {
            let pairs = engine
                .find_deleted_files(collection, &query, actor.as_ref())
                .map_err(|error| engine_error(&error))?
                .into_iter()
                .map(|(identifier, fields)| (identifier, Value::Object(fields)))
                .collect();
            return self.shape_query_result(request, pairs);
        }
        let rows = engine
            .find_deleted(collection, &query, actor.as_ref())
            .map_err(|error| engine_error(&error))?;
        let mut pairs = Vec::with_capacity(rows.len());
        for record in rows {
            let identifier = record.id.clone();
            let encoded = serde_json::to_value(record.document)
                .map_err(|error| serialization_error(&error))?;
            pairs.push((identifier, encoded));
        }
        self.shape_query_result(request, pairs)
    }

    /// Serve one page of a query snapshot.
    ///
    /// The snapshot is taken once and held under an opaque token, so a client
    /// paging through a mutating collection sees a consistent result set rather
    /// than a shifting window. Cursors are process-scoped: a restarted server
    /// reports `EINVALIDCURSOR` and the client restarts from the first page.
    fn paginate(&self, request: &Value, rows: Vec<(String, Value)>) -> Result<Value, MachineError> {
        if !self.persistent {
            return Err(MachineError::new(
                "EQUERYLOOPREQUIRED",
                "paged machine queries require exec --loop",
            ));
        }
        let page = request
            .get("page")
            .and_then(Value::as_object)
            .ok_or_else(|| {
                MachineError::new(
                    "EBADREQUEST",
                    "machine request field \"page\" must be an object",
                )
            })?;
        let limit = page
            .get("limit")
            .and_then(Value::as_u64)
            .map_or(Ok(DEFAULT_QUERY_PAGE_ITEMS), |limit| {
                usize::try_from(limit)
                    .ok()
                    .filter(|limit| (1..=MAX_QUERY_PAGE_ITEMS).contains(limit))
                    .ok_or_else(|| {
                        MachineError::new(
                            "EBADREQUEST",
                            format!(
                                "machine query page.limit must be an integer from 1 to {MAX_QUERY_PAGE_ITEMS}"
                            ),
                        )
                    })
            })?;
        let scope = cursor_scope(request);
        let now = unix_millis();
        let mut cursors = self.cursors.borrow_mut();
        cursors.retain(|_, state| state.expires_at > now);
        let token = if let Some(token) = page.get("cursor").and_then(Value::as_str) {
            let state = cursors.get(token).ok_or_else(|| {
                MachineError::new(
                    "EINVALIDCURSOR",
                    "machine query cursor is unknown or expired; restart from the first page",
                )
            })?;
            if state.scope != scope {
                return Err(MachineError::new(
                    "EINVALIDCURSOR",
                    "machine query cursor belongs to a different query",
                ));
            }
            token.to_owned()
        } else {
            let sequence = self.cursor_sequence.get().wrapping_add(1);
            self.cursor_sequence.set(sequence);
            let token = format!("fqc1.{}.{sequence}", std::process::id());
            let sorted = bounded_query_snapshot(rows)?;
            cursors.insert(
                token.clone(),
                CursorState {
                    scope,
                    rows: sorted,
                    position: 0,
                    expires_at: now.saturating_add(QUERY_CURSOR_TTL_MS),
                },
            );
            token
        };
        let only_ids = request.get("query").and_then(|query| query.get("$onlyIds"))
            == Some(&Value::Bool(true));
        let budget = self.limits.max_response_bytes.saturating_sub(768).max(256);
        let state = cursors
            .get_mut(&token)
            .ok_or_else(|| MachineError::new("EUNKNOWN", "machine query cursor vanished"))?;
        let Page {
            identifiers,
            items,
            count,
            oversized,
        } = fill_page(state, &token, limit, only_ids, budget);
        if let Some(identifier) = oversized {
            cursors.remove(&token);
            return Err(MachineError::new(
                "EQUERYITEMTOOLARGE",
                format!("machine query item {identifier} exceeds the response frame"),
            ));
        }
        let has_more = cursors
            .get(&token)
            .is_some_and(|state| state.position < state.rows.len());
        if !has_more {
            cursors.remove(&token);
        }
        let items = if only_ids {
            Value::Array(identifiers)
        } else {
            Value::Object(items)
        };
        Ok(json!({
            "items": items,
            "nextCursor": if has_more { Value::String(token) } else { Value::Null },
            "page": { "count": count, "limit": limit },
        }))
    }

    fn restore_document(&self, request: &Value) -> Result<Value, MachineError> {
        let collection = require_string(request, "collection")?;
        let identifier = require_string(request, "id")?;
        let actor = write_actor(request)?;
        self.writer(request)?
            .restore_document(collection, identifier, actor.as_ref())
            .map_err(|error| storage_error(&error))?;
        Ok(json!({ "restored": true, "id": identifier }))
    }

    /// A batch is a loop over the same journalled single-record path, so it is
    /// not atomic across records. The registry already classifies it as
    /// retry-unsafe for exactly that reason.
    fn batch_put_data(&self, request: &Value) -> Result<Value, MachineError> {
        let collection = require_string(request, "collection")?;
        let Some(batch) = request.get("batch").and_then(Value::as_array) else {
            return Err(MachineError::new(
                "EBADREQUEST",
                "machine request field \"batch\" must be an array of objects",
            ));
        };
        let engine = self.write_engine(request)?;
        let writer = self.writer(request)?;
        let access = access(request)?;
        let mut identifiers = Vec::with_capacity(batch.len());
        for entry in batch {
            let Some(fields) = entry.as_object() else {
                return Err(MachineError::new(
                    "EBADREQUEST",
                    "machine batch entries must be objects",
                ));
            };
            let identifier = writer
                .allocate_identifier()
                .map_err(|error| storage_error(&error))?;
            engine
                .put_document(collection, &identifier, fields.clone(), access)
                .map_err(|error| engine_error(&error))?;
            identifiers.push(Value::String(identifier));
        }
        Ok(Value::Array(identifiers))
    }

    fn import_bulk_data(&self, request: &Value) -> Result<Value, MachineError> {
        let collection = require_string(request, "collection")?;
        // Match the JavaScript order: a missing collection fails before any
        // outbound request is attempted.
        self.engine(request)?
            .inspect(collection)
            .map_err(|error| engine_error(&error))?;
        let options = ImportOptions::from_request(request.get("limitOrOptions"))?;
        if options.limit == Some(0) {
            return Ok(Value::from(0));
        }
        let url = require_string(request, "url")?;
        let body = fetch_import(url, &options)?;
        let documents = parse_import_documents(&body)?;
        let engine = self.write_engine(request)?;
        let writer = self.writer(request)?;
        let access = access(request)?;
        let count = options.limit.unwrap_or(usize::MAX).min(documents.len());
        for fields in documents.into_iter().take(count) {
            let identifier = writer
                .allocate_identifier()
                .map_err(|error| storage_error(&error))?;
            engine
                .put_document(collection, &identifier, fields, access)
                .map_err(|error| engine_error(&error))?;
        }
        Ok(Value::from(count))
    }

    fn patch_documents(&self, request: &Value) -> Result<Value, MachineError> {
        let collection = require_string(request, "collection")?;
        let Some(update) = request.get("update").and_then(Value::as_object) else {
            return Err(MachineError::new(
                "EBADREQUEST",
                "machine request field \"update\" must be an object",
            ));
        };
        let Some(changes) = update.get("$set").and_then(Value::as_object) else {
            return Err(MachineError::new(
                "EBADREQUEST",
                "machine patchDocs requires an update with \"$set\"",
            ));
        };
        let matched = self.matching_identifiers(request, collection, update)?;
        let writer = self.writer(request)?;
        let actor = write_actor(request)?;
        for identifier in &matched {
            writer
                .patch_document_fields(collection, identifier, changes, actor.as_ref())
                .map_err(|error| storage_error(&error))?;
        }
        Ok(Value::from(matched.len()))
    }

    fn delete_documents(&self, request: &Value) -> Result<Value, MachineError> {
        let collection = require_string(request, "collection")?;
        let Some(filter) = request.get("delete").and_then(Value::as_object) else {
            return Err(MachineError::new(
                "EBADREQUEST",
                "machine request field \"delete\" must be an object",
            ));
        };
        let matched = self.matching_identifiers(request, collection, filter)?;
        let writer = self.writer(request)?;
        let actor = write_actor(request)?;
        for identifier in &matched {
            writer
                .delete_document(collection, identifier, actor.as_ref())
                .map_err(|error| storage_error(&error))?;
        }
        Ok(Value::from(matched.len()))
    }

    /// Resolve the rows a bulk mutation targets before any of them is written,
    /// so the selection cannot drift while the batch runs.
    fn matching_identifiers(
        &self,
        request: &Value,
        collection: &str,
        filter: &serde_json::Map<String, Value>,
    ) -> Result<Vec<String>, MachineError> {
        let query = filter
            .get("$where")
            .cloned()
            .unwrap_or_else(|| Value::Object(filter.clone()));
        let query = StructuredQuery::from_value(&query, QueryLimits::default())
            .map_err(|error| MachineError::new("EQUERY_INVALID", error.to_string()))?;
        let engine = self.engine(request)?;
        let actor = actor(request)?;
        if engine
            .inspect(collection)
            .map_err(|error| engine_error(&error))?
            .kind
            == CollectionKind::File
        {
            return engine
                .find_files(collection, &query, actor.as_ref())
                .map(|rows| rows.into_iter().map(|(identifier, _)| identifier).collect())
                .map_err(|error| engine_error(&error));
        }
        let rows = match actor.as_ref() {
            Some(actor) => engine.find_as(collection, &query, actor),
            None => engine.find(collection, &query),
        }
        .map_err(|error| engine_error(&error))?;
        Ok(rows.into_iter().map(|row| row.metadata.id).collect())
    }

    fn branches(&self, request: &Value) -> Result<Value, MachineError> {
        self.writer(request)?
            .repository_branches()
            .map_err(|error| storage_error(&error))
    }

    fn checkout(&self, request: &Value) -> Result<Value, MachineError> {
        let branch = require_string(request, "branch")?;
        self.writer(request)?
            .checkout_repository(branch, request.get("create") == Some(&Value::Bool(true)))
            .map_err(|error| storage_error(&error))
    }

    fn restore_commit(&self, request: &Value) -> Result<Value, MachineError> {
        let identifier = require_string(request, "id")?;
        self.writer(request)?
            .restore_repository_commit(identifier, request.get("force") == Some(&Value::Bool(true)))
            .map_err(|error| storage_error(&error))
    }

    fn merge(&self, request: &Value) -> Result<Value, MachineError> {
        let source = require_string(request, "source")?;
        let message = request.get("message").and_then(Value::as_str);
        self.writer(request)?
            .merge_repository(source, message)
            .map_err(|error| storage_error(&error))
    }

    fn diff(&self, request: &Value) -> Result<Value, MachineError> {
        // The published defaults: what HEAD holds versus what is on disk now.
        let from = request
            .get("from")
            .and_then(Value::as_str)
            .unwrap_or("HEAD");
        let to = request
            .get("to")
            .and_then(Value::as_str)
            .unwrap_or("WORKTREE");
        let writer = self.writer(request)?;
        // The JavaScript VersionRepository initializes repository metadata on
        // first use, including read-like `status` and `diff` commands.
        if !writer
            .repository_status()
            .map_err(|error| storage_error(&error))?
            .enabled
        {
            writer
                .repository_branches()
                .map_err(|error| storage_error(&error))?;
        }
        let diff = writer
            .repository_diff(from, to)
            .map_err(|error| storage_error(&error))?;
        serde_json::to_value(diff).map_err(|error| serialization_error(&error))
    }

    fn status(&self, request: &Value) -> Result<Value, MachineError> {
        let writer = self.writer(request)?;
        let mut status = writer
            .repository_status()
            .map_err(|error| storage_error(&error))?;
        if !status.enabled {
            writer
                .repository_branches()
                .map_err(|error| storage_error(&error))?;
            status = writer
                .repository_status()
                .map_err(|error| storage_error(&error))?;
        }
        Ok(json!({
            "branch": status.branch,
            "head": status.head,
            "clean": status.clean,
            "diff": writer.repository_diff("HEAD", "WORKTREE")
                .map_err(|error| storage_error(&error))?,
        }))
    }

    fn schema_inspect(&self, request: &Value) -> Result<Value, MachineError> {
        self.write_engine(request)?
            .schema_inspect(require_string(request, "collection")?)
            .map_err(|error| engine_error(&error))
    }

    fn schema_doctor(&self, request: &Value) -> Result<Value, MachineError> {
        self.write_engine(request)?
            .schema_doctor(require_string(request, "collection")?)
            .map_err(|error| engine_error(&error))
    }

    fn schema_current(&self, request: &Value) -> Result<Value, MachineError> {
        let inspect = self.schema_inspect(request)?;
        Ok(json!({
            "collection": inspect["collection"],
            "schemaDir": inspect["schemaDir"],
            "current": inspect["current"],
        }))
    }

    fn schema_history(&self, request: &Value) -> Result<Value, MachineError> {
        let inspect = self.schema_inspect(request)?;
        Ok(json!({
            "collection": inspect["collection"],
            "schemaDir": inspect["schemaDir"],
            "versions": inspect["versions"],
        }))
    }

    fn schema_validate(&self, request: &Value) -> Result<Value, MachineError> {
        let collection = require_string(request, "collection")?;
        let Some(document) = request.get("document").and_then(Value::as_object) else {
            return Err(MachineError::new(
                "EBADREQUEST",
                "machine request field \"document\" must be an object",
            ));
        };
        let engine = self.write_engine(request)?;
        let validated = engine
            .schema_validate(collection, document)
            .map_err(|error| engine_error(&error))?;
        let current = engine
            .schema_current(collection)
            .map_err(|error| engine_error(&error))?;
        Ok(json!({
            "collection": collection,
            "schemaDir": engine.schema_dir().map_err(|error| engine_error(&error))?,
            "current": current,
            "valid": true,
            "document": validated,
        }))
    }

    fn schema_materialize(&self, request: &Value) -> Result<Value, MachineError> {
        let collection = require_string(request, "collection")?;
        let document = request
            .get("document")
            .and_then(Value::as_object)
            .ok_or_else(|| {
                MachineError::new(
                    "EBADREQUEST",
                    "machine request field \"document\" must be an object",
                )
            })?;
        let engine = self.write_engine(request)?;
        let materialized = engine
            .schema_materialize(collection, document)
            .map_err(|error| engine_error(&error))?;
        let current = engine
            .schema_current(collection)
            .map_err(|error| engine_error(&error))?;
        Ok(json!({
            "collection": collection,
            "schemaDir": engine.schema_dir().map_err(|error| engine_error(&error))?,
            "current": current,
            "document": materialized,
        }))
    }

    fn write_success<W: Write>(
        &self,
        output: &mut W,
        operation: Option<&str>,
        request_id: Option<&str>,
        started: Instant,
        result: &Value,
    ) -> std::io::Result<()> {
        let frame = json!({
            "protocolVersion": PROTOCOL_VERSION,
            "ok": true,
            "op": operation,
            "requestId": request_id,
            "durationMs": started.elapsed().as_secs_f64() * 1000.0,
            "result": result,
        });
        let encoded = serde_json::to_string(&frame).unwrap_or_default();
        if encoded.len() > self.limits.max_response_bytes {
            return Self::write_failure(
                output,
                operation,
                request_id,
                started,
                &MachineError::new(
                    "EFRAME_RESPONSE_TOO_LARGE",
                    format!(
                        "machine response frame exceeds {} bytes",
                        self.limits.max_response_bytes
                    ),
                ),
            );
        }
        writeln!(output, "{encoded}")?;
        output.flush()
    }

    fn write_failure<W: Write>(
        output: &mut W,
        operation: Option<&str>,
        request_id: Option<&str>,
        started: Instant,
        error: &MachineError,
    ) -> std::io::Result<()> {
        let frame = json!({
            "protocolVersion": PROTOCOL_VERSION,
            "ok": false,
            "op": operation,
            "requestId": request_id,
            "durationMs": started.elapsed().as_secs_f64() * 1000.0,
            "error": error,
        });
        writeln!(
            output,
            "{}",
            serde_json::to_string(&frame).unwrap_or_default()
        )?;
        output.flush()
    }
}

fn active_worktree(repository_root: &std::path::Path) -> Result<PathBuf, MachineError> {
    let head_path = repository_root.join(".fylo-vcs").join("HEAD");
    let head_metadata = match std::fs::symlink_metadata(&head_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(repository_root.to_path_buf());
        }
        Err(error) => {
            return Err(MachineError::new(
                "ECORRUPTMETADATA",
                format!("cannot inspect FYLO HEAD: {error}"),
            ));
        }
    };
    if head_metadata.file_type().is_symlink() || !head_metadata.is_file() {
        return Err(MachineError::new(
            "ECORRUPTMETADATA",
            "FYLO repository HEAD is not a regular file",
        ));
    }
    let head = std::fs::read_to_string(&head_path).map_err(|error| {
        MachineError::new(
            "ECORRUPTMETADATA",
            format!("cannot read FYLO HEAD: {error}"),
        )
    })?;
    let branch = head
        .trim()
        .strip_prefix("ref: refs/heads/")
        .ok_or_else(|| MachineError::new("ECORRUPTMETADATA", "FYLO repository HEAD is corrupt"))?;
    if branch == "main" {
        return Ok(repository_root.to_path_buf());
    }
    let branch_path = std::path::Path::new(branch);
    if branch.is_empty()
        || branch_path.is_absolute()
        || branch_path
            .components()
            .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        return Err(MachineError::new(
            "ECORRUPTMETADATA",
            "FYLO repository HEAD names an unsafe branch",
        ));
    }
    let reference = repository_root
        .join(".fylo-vcs")
        .join("refs")
        .join("heads")
        .join(format!("{branch}.json"));
    let reference_metadata = std::fs::symlink_metadata(&reference).map_err(|_| {
        MachineError::new(
            "ECORRUPTMETADATA",
            format!("active FYLO branch is missing its ref: {branch}"),
        )
    })?;
    if reference_metadata.file_type().is_symlink() || !reference_metadata.is_file() {
        return Err(MachineError::new(
            "ECORRUPTMETADATA",
            format!("active FYLO branch has an unsafe ref: {branch}"),
        ));
    }
    let target = repository_root
        .join(".fylo-vcs")
        .join("branches")
        .join(branch_path);
    let target_metadata = std::fs::symlink_metadata(&target).map_err(|_| {
        MachineError::new(
            "ECORRUPTMETADATA",
            format!("active FYLO branch is missing its worktree: {branch}"),
        )
    })?;
    let canonical_repository = std::fs::canonicalize(repository_root).map_err(|error| {
        MachineError::new(
            "ECORRUPTMETADATA",
            format!("cannot resolve FYLO root: {error}"),
        )
    })?;
    let canonical_target = std::fs::canonicalize(&target).map_err(|error| {
        MachineError::new(
            "ECORRUPTMETADATA",
            format!("cannot resolve active FYLO worktree: {error}"),
        )
    })?;
    if target_metadata.file_type().is_symlink()
        || !target_metadata.is_dir()
        || !canonical_target.starts_with(canonical_repository.join(".fylo-vcs").join("branches"))
    {
        return Err(MachineError::new(
            "ECORRUPTMETADATA",
            format!("active FYLO branch has an unsafe worktree: {branch}"),
        ));
    }
    Ok(canonical_target)
}

/// Read one LF-delimited frame, discarding an oversized frame's remainder.
///
/// Returns the byte count consumed and whether the limit was exceeded.
fn read_frame<R: BufRead>(
    input: &mut R,
    limit: usize,
    frame: &mut Vec<u8>,
) -> std::io::Result<(usize, bool, bool)> {
    let mut consumed = 0_usize;
    let mut oversized = false;
    loop {
        let available = input.fill_buf()?;
        if available.is_empty() {
            return Ok((consumed, oversized, false));
        }
        if let Some(index) = available.iter().position(|byte| *byte == b'\n') {
            if !oversized {
                if frame.len() + index > limit {
                    oversized = true;
                    frame.clear();
                } else {
                    frame.extend_from_slice(&available[..index]);
                }
            }
            input.consume(index + 1);
            return Ok((consumed + index + 1, oversized, true));
        }
        let length = available.len();
        if !oversized {
            if frame.len() + length > limit {
                oversized = true;
                frame.clear();
            } else {
                frame.extend_from_slice(available);
            }
        }
        input.consume(length);
        consumed += length;
    }
}

const DEFAULT_IMPORT_MAX_BYTES: usize = 50 * 1024 * 1024;
const IMPORT_TIMEOUT: Duration = Duration::from_secs(30);

struct ImportOptions {
    limit: Option<usize>,
    max_bytes: usize,
    allowed_protocols: Vec<String>,
    allowed_hosts: Option<Vec<String>>,
    allow_private_network: bool,
}

impl ImportOptions {
    fn from_request(value: Option<&Value>) -> Result<Self, MachineError> {
        let mut options = Self {
            limit: None,
            max_bytes: DEFAULT_IMPORT_MAX_BYTES,
            allowed_protocols: vec!["https:".into(), "http:".into(), "data:".into()],
            allowed_hosts: None,
            allow_private_network: false,
        };
        let Some(value) = value else {
            return Ok(options);
        };
        if let Some(limit) = value.as_u64() {
            options.limit = Some(usize::try_from(limit).map_err(|_| {
                MachineError::new("EBADREQUEST", "import limit exceeds this platform")
            })?);
            return Ok(options);
        }
        let object = value.as_object().ok_or_else(|| {
            MachineError::new(
                "EBADREQUEST",
                "limitOrOptions must be a non-negative integer or an object",
            )
        })?;
        if let Some(value) = object.get("limit") {
            let limit = value.as_u64().ok_or_else(|| {
                MachineError::new("EBADREQUEST", "import limit must be a non-negative integer")
            })?;
            options.limit = Some(usize::try_from(limit).map_err(|_| {
                MachineError::new("EBADREQUEST", "import limit exceeds this platform")
            })?);
        }
        if let Some(value) = object.get("maxBytes") {
            let max_bytes = value.as_u64().filter(|value| *value > 0).ok_or_else(|| {
                MachineError::new("EBADREQUEST", "import maxBytes must be a positive integer")
            })?;
            options.max_bytes = usize::try_from(max_bytes).map_err(|_| {
                MachineError::new("EBADREQUEST", "import maxBytes exceeds this platform")
            })?;
        }
        if let Some(value) = object.get("allowedProtocols") {
            options.allowed_protocols = string_array(value, "allowedProtocols")?;
        }
        if let Some(value) = object.get("allowedHosts") {
            options.allowed_hosts = Some(string_array(value, "allowedHosts")?);
        }
        if let Some(value) = object.get("allowPrivateNetwork") {
            options.allow_private_network = value.as_bool().ok_or_else(|| {
                MachineError::new("EBADREQUEST", "allowPrivateNetwork must be a boolean")
            })?;
        }
        Ok(options)
    }
}

fn string_array(value: &Value, name: &str) -> Result<Vec<String>, MachineError> {
    value
        .as_array()
        .ok_or_else(|| MachineError::new("EBADREQUEST", format!("{name} must be an array")))?
        .iter()
        .map(|entry| {
            entry.as_str().map(ToOwned::to_owned).ok_or_else(|| {
                MachineError::new("EBADREQUEST", format!("{name} entries must be strings"))
            })
        })
        .collect()
}

fn read_machine_file(path: &str) -> Result<(Vec<u8>, String), MachineError> {
    let path = std::path::Path::new(path);
    if !path.is_absolute() {
        return Err(MachineError::new(
            "EBADREQUEST",
            "machine file path must be an absolute path",
        ));
    }
    let metadata = std::fs::metadata(path).map_err(|error| {
        MachineError::new("EUNKNOWN", format!("cannot read machine file: {error}"))
    })?;
    if !metadata.is_file() {
        return Err(MachineError::new(
            "EBADREQUEST",
            "machine file path must name a regular file",
        ));
    }
    if metadata.len() > MAX_MACHINE_FILE_BYTES {
        return Err(MachineError::new(
            "EFRAME_REQUEST_TOO_LARGE",
            "machine file exceeds the 512 MiB input limit",
        ));
    }
    let filename = path
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .ok_or_else(|| MachineError::new("EBADREQUEST", "machine file has no UTF-8 filename"))?
        .to_owned();
    let mut file = std::fs::File::open(path).map_err(|error| {
        MachineError::new("EUNKNOWN", format!("cannot open machine file: {error}"))
    })?;
    let mut bytes = Vec::with_capacity(usize::try_from(metadata.len()).unwrap_or(0));
    (&mut file)
        .take(MAX_MACHINE_FILE_BYTES.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|error| {
            MachineError::new("EUNKNOWN", format!("cannot read machine file: {error}"))
        })?;
    if bytes.len() as u64 > MAX_MACHINE_FILE_BYTES {
        return Err(MachineError::new(
            "EFRAME_REQUEST_TOO_LARGE",
            "machine file exceeds the 512 MiB input limit",
        ));
    }
    Ok((bytes, filename))
}

fn fetch_machine_file(url: &str) -> Result<(Vec<u8>, String), MachineError> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let parsed = reqwest::Url::parse(url).map_err(|error| {
        MachineError::new("EBADREQUEST", format!("invalid machine file URL: {error}"))
    })?;
    if parsed.scheme() == "file" {
        let path = parsed.to_file_path().map_err(|()| {
            MachineError::new("EBADREQUEST", "machine file URL is not a local path")
        })?;
        return read_machine_file(path.to_str().ok_or_else(|| {
            MachineError::new("EBADREQUEST", "machine file URL path is not UTF-8")
        })?);
    }
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(MachineError::new(
            "EBADREQUEST",
            "machine file URL must use file, http, or https",
        ));
    }
    let filename = parsed
        .path_segments()
        .and_then(Iterator::last)
        .filter(|name| !name.is_empty())
        .unwrap_or("file")
        .to_owned();
    let mut response = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| {
            MachineError::new("EUNKNOWN", format!("machine file client failed: {error}"))
        })?
        .get(parsed)
        .send()
        .map_err(|error| {
            MachineError::new("EUNKNOWN", format!("machine file request failed: {error}"))
        })?
        .error_for_status()
        .map_err(|error| {
            MachineError::new("EUNKNOWN", format!("machine file request failed: {error}"))
        })?;
    if response
        .content_length()
        .is_some_and(|size| size > MAX_MACHINE_FILE_BYTES)
    {
        return Err(MachineError::new(
            "EFRAME_REQUEST_TOO_LARGE",
            "machine file exceeds the 512 MiB input limit",
        ));
    }
    let mut bytes = Vec::new();
    (&mut response)
        .take(MAX_MACHINE_FILE_BYTES.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|error| {
            MachineError::new("EUNKNOWN", format!("machine file body failed: {error}"))
        })?;
    if bytes.len() as u64 > MAX_MACHINE_FILE_BYTES {
        return Err(MachineError::new(
            "EFRAME_REQUEST_TOO_LARGE",
            "machine file exceeds the 512 MiB input limit",
        ));
    }
    Ok((bytes, filename))
}

fn fetch_import(url: &str, options: &ImportOptions) -> Result<Vec<u8>, MachineError> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let parsed = reqwest::Url::parse(url)
        .map_err(|error| MachineError::new("EUNKNOWN", format!("Invalid import URL: {error}")))?;
    let protocol = format!("{}:", parsed.scheme());
    if !options.allowed_protocols.contains(&protocol) {
        return Err(MachineError::new(
            "EUNKNOWN",
            format!("Import URL protocol is not allowed: {protocol}"),
        ));
    }
    if parsed.scheme() == "data" {
        return decode_data_import(url, options.max_bytes);
    }
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err(MachineError::new(
            "EUNKNOWN",
            format!("Import URL protocol is not supported: {protocol}"),
        ));
    }
    let hostname = parsed
        .host_str()
        .ok_or_else(|| MachineError::new("EUNKNOWN", "Import URL must include a hostname"))?;
    if !host_allowed(hostname, options.allowed_hosts.as_deref()) {
        return Err(MachineError::new(
            "EUNKNOWN",
            format!("Import URL host is not allowed: {hostname}"),
        ));
    }
    if !options.allow_private_network
        && (hostname.eq_ignore_ascii_case("localhost")
            || hostname.to_ascii_lowercase().ends_with(".localhost"))
    {
        return Err(private_import_error(hostname));
    }
    let port = parsed
        .port_or_known_default()
        .ok_or_else(|| MachineError::new("EUNKNOWN", "Import URL has no usable port"))?;
    let addresses = if let Ok(address) = hostname.parse::<IpAddr>() {
        vec![SocketAddr::new(address, port)]
    } else {
        (hostname, port)
            .to_socket_addrs()
            .map_err(|error| {
                MachineError::new(
                    "EUNKNOWN",
                    format!("Import hostname lookup failed: {error}"),
                )
            })?
            .collect::<Vec<_>>()
    };
    if addresses.is_empty() {
        return Err(MachineError::new(
            "EUNKNOWN",
            "Import hostname resolved to no addresses",
        ));
    }
    if !options.allow_private_network && addresses.iter().any(|address| is_private(address.ip())) {
        return Err(private_import_error(hostname));
    }
    let mut builder = reqwest::blocking::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(IMPORT_TIMEOUT)
        .connect_timeout(IMPORT_TIMEOUT);
    if !options.allow_private_network && hostname.parse::<IpAddr>().is_err() {
        // Resolve once, validate every answer, then pin the client to that
        // immutable set while preserving the original hostname for TLS/SNI.
        for address in &addresses {
            builder = builder.resolve(hostname, *address);
        }
    }
    let client = builder
        .build()
        .map_err(|error| MachineError::new("EUNKNOWN", format!("Import client failed: {error}")))?;
    let response = client.get(parsed).send().map_err(|error| {
        MachineError::new("EUNKNOWN", format!("Import request failed: {error}"))
    })?;
    if response.status().is_redirection() {
        return Err(MachineError::new(
            "EUNKNOWN",
            "Import request redirected; redirects are not followed",
        ));
    }
    if !response.status().is_success() {
        return Err(MachineError::new(
            "EUNKNOWN",
            format!("Import request failed with status {}", response.status()),
        ));
    }
    if !response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.to_ascii_lowercase().contains("application/json"))
    {
        return Err(MachineError::new("EUNKNOWN", "Response is not JSON"));
    }
    read_import_body(response, options.max_bytes)
}

fn read_import_body(
    response: reqwest::blocking::Response,
    max_bytes: usize,
) -> Result<Vec<u8>, MachineError> {
    if response
        .content_length()
        .is_some_and(|length| length > max_bytes as u64)
    {
        return Err(import_size_error(max_bytes));
    }
    let limit = u64::try_from(max_bytes)
        .unwrap_or(u64::MAX)
        .saturating_add(1);
    let mut body = Vec::with_capacity(max_bytes.min(1024 * 1024));
    response
        .take(limit)
        .read_to_end(&mut body)
        .map_err(|error| MachineError::new("EUNKNOWN", format!("Import body failed: {error}")))?;
    if body.len() > max_bytes {
        return Err(import_size_error(max_bytes));
    }
    Ok(body)
}

fn decode_data_import(url: &str, max_bytes: usize) -> Result<Vec<u8>, MachineError> {
    let encoded = url
        .strip_prefix("data:")
        .ok_or_else(|| MachineError::new("EUNKNOWN", "Invalid data import URL"))?;
    let (metadata, payload) = encoded
        .split_once(',')
        .ok_or_else(|| MachineError::new("EUNKNOWN", "Invalid data import URL"))?;
    if !metadata
        .split(';')
        .next()
        .is_some_and(|kind| kind.eq_ignore_ascii_case("application/json"))
    {
        return Err(MachineError::new("EUNKNOWN", "Response is not JSON"));
    }
    let body = if metadata
        .split(';')
        .any(|part| part.eq_ignore_ascii_case("base64"))
    {
        base64::engine::general_purpose::STANDARD
            .decode(payload)
            .map_err(|error| {
                MachineError::new(
                    "EUNKNOWN",
                    format!("Invalid base64 import response: {error}"),
                )
            })?
    } else {
        percent_decode(payload)?
    };
    if body.len() > max_bytes {
        return Err(import_size_error(max_bytes));
    }
    Ok(body)
}

fn percent_decode(value: &str) -> Result<Vec<u8>, MachineError> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len() {
                return Err(MachineError::new(
                    "EUNKNOWN",
                    "Invalid percent escape in import URL",
                ));
            }
            let text = std::str::from_utf8(&bytes[index + 1..index + 3]).map_err(|_| {
                MachineError::new("EUNKNOWN", "Invalid percent escape in import URL")
            })?;
            decoded.push(u8::from_str_radix(text, 16).map_err(|_| {
                MachineError::new("EUNKNOWN", "Invalid percent escape in import URL")
            })?);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    Ok(decoded)
}

fn parse_import_documents(
    body: &[u8],
) -> Result<Vec<serde_json::Map<String, Value>>, MachineError> {
    let values = if body
        .iter()
        .copied()
        .find(|byte| !byte.is_ascii_whitespace())
        == Some(b'[')
    {
        serde_json::from_slice::<Vec<Value>>(body).map_err(|error| {
            MachineError::new(
                "EUNKNOWN",
                format!("Invalid JSON in import response: {error}"),
            )
        })?
    } else {
        serde_json::Deserializer::from_slice(body)
            .into_iter::<Value>()
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| {
                MachineError::new(
                    "EUNKNOWN",
                    format!("Invalid JSON in import response: {error}"),
                )
            })?
    };
    values
        .into_iter()
        .map(|value| {
            value.as_object().cloned().ok_or_else(|| {
                MachineError::new("EUNKNOWN", "Import response entries must be JSON objects")
            })
        })
        .collect()
}

fn host_allowed(hostname: &str, allowed: Option<&[String]>) -> bool {
    let Some(allowed) = allowed.filter(|values| !values.is_empty()) else {
        return true;
    };
    let hostname = hostname.to_ascii_lowercase();
    allowed.iter().any(|candidate| {
        let candidate = candidate.to_ascii_lowercase();
        hostname == candidate || hostname.ends_with(&format!(".{candidate}"))
    })
}

fn is_private(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => {
            let [first, second, ..] = address.octets();
            first == 0
                || first == 10
                || first == 127
                || (first == 169 && second == 254)
                || (first == 172 && (16..=31).contains(&second))
                || (first == 192 && second == 168)
                || (first == 100 && (64..=127).contains(&second))
        }
        IpAddr::V6(address) => address.to_ipv4_mapped().map_or_else(
            || {
                address.is_unspecified()
                    || address.is_loopback()
                    || (address.segments()[0] & 0xfe00) == 0xfc00
                    || (address.segments()[0] & 0xffc0) == 0xfe80
            },
            |address| is_private(IpAddr::V4(address)),
        ),
    }
}

fn private_import_error(hostname: &str) -> MachineError {
    MachineError::new(
        "EUNKNOWN",
        format!("Import URL resolves to a private address: {hostname}"),
    )
}

fn import_size_error(max_bytes: usize) -> MachineError {
    MachineError::new(
        "EUNKNOWN",
        format!("Import response exceeded {max_bytes} bytes"),
    )
}

/// Cursor identity: the same op, collection, query, and actor must resume the
/// same snapshot, and anything else must be rejected rather than silently
/// paged against the wrong result set.
/// One page's worth of rows, plus the first row that could not fit.
struct Page {
    identifiers: Vec<Value>,
    items: serde_json::Map<String, Value>,
    count: usize,
    oversized: Option<String>,
}

struct LimitedCounter {
    bytes: usize,
    limit: usize,
    exceeded: bool,
}

impl Write for LimitedCounter {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        let Some(total) = self.bytes.checked_add(buffer.len()) else {
            self.exceeded = true;
            return Err(std::io::Error::other("query snapshot size overflow"));
        };
        if total > self.limit {
            self.exceeded = true;
            return Err(std::io::Error::other("query snapshot exceeds limit"));
        }
        self.bytes = total;
        Ok(buffer.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn snapshot_exceeds_limit(rows: &[(String, Value)]) -> Result<bool, MachineError> {
    let mut counter = LimitedCounter {
        bytes: 0,
        limit: MAX_QUERY_SNAPSHOT_BYTES,
        exceeded: false,
    };
    match serde_json::to_writer(&mut counter, rows) {
        Ok(()) => Ok(false),
        Err(_) if counter.exceeded => Ok(true),
        Err(error) => Err(serialization_error(&error)),
    }
}

fn bounded_query_snapshot(
    mut rows: Vec<(String, Value)>,
) -> Result<Vec<(String, Value)>, MachineError> {
    rows.sort_by(|left, right| left.0.cmp(&right.0));
    if snapshot_exceeds_limit(&rows)? {
        return Err(MachineError::new(
            "EQUERYSNAPSHOTTOOLARGE",
            format!("machine query snapshot exceeds {MAX_QUERY_SNAPSHOT_BYTES} bytes"),
        ));
    }
    Ok(rows)
}

/// Fill a page up to `limit` rows without letting the encoded frame cross
/// `budget`. The frame is re-encoded per row because one large document must
/// be reported rather than silently truncated.
fn fill_page(
    state: &mut CursorState,
    token: &str,
    limit: usize,
    only_ids: bool,
    budget: usize,
) -> Page {
    let mut page = Page {
        identifiers: Vec::new(),
        items: serde_json::Map::new(),
        count: 0,
        oversized: None,
    };
    while page.count < limit && state.position < state.rows.len() {
        let (identifier, document) = &state.rows[state.position];
        if only_ids {
            page.identifiers.push(Value::String(identifier.clone()));
        } else {
            page.items.insert(identifier.clone(), document.clone());
        }
        let rendered = if only_ids {
            Value::Array(page.identifiers.clone())
        } else {
            Value::Object(page.items.clone())
        };
        let encoded = json!({
            "items": rendered,
            "nextCursor": token,
            "page": { "count": page.count + 1, "limit": limit },
        });
        if serde_json::to_string(&encoded).map_or(0, |value| value.len()) > budget {
            if only_ids {
                page.identifiers.pop();
            } else {
                page.items.remove(identifier);
            }
            if page.count == 0 {
                page.oversized = Some(identifier.clone());
            }
            break;
        }
        state.position += 1;
        page.count += 1;
    }
    page
}

/// An empty environment variable is falsy in JavaScript, and a repository
/// `.env` commonly declares these names with empty values. Treating one as
/// configured would open the engine with credentials that cannot work.
fn configured(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|value| !value.is_empty())
}

fn cursor_scope(request: &Value) -> String {
    let parts = json!({
        "op": request.get("op"),
        "collection": request.get("collection"),
        "query": request.get("query"),
        "access": request.get("access"),
    });
    serde_json::to_string(&parts).unwrap_or_default()
}

fn unix_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| {
            u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX)
        })
}

fn structured_query(request: &Value) -> Result<StructuredQuery, MachineError> {
    let query = request.get("query").cloned().unwrap_or_else(|| json!({}));
    StructuredQuery::from_value(&query, QueryLimits::default())
        .map_err(|error| MachineError::new("EQUERY_INVALID", error.to_string()))
}

fn require_string<'a>(request: &'a Value, field: &str) -> Result<&'a str, MachineError> {
    request
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            MachineError::new(
                "EBADREQUEST",
                format!("machine request field \"{field}\" must be a non-empty string"),
            )
        })
}

fn actor(request: &Value) -> Result<Option<AccessContext>, MachineError> {
    let Some(access) = request.get("access").and_then(Value::as_object) else {
        return Ok(None);
    };
    let Some(uid) = access.get("uid").and_then(Value::as_u64) else {
        return Ok(None);
    };
    let uid = u32::try_from(uid)
        .map_err(|_| MachineError::new("EBADREQUEST", "machine access uid is out of range"))?;
    let groups = access
        .get("groups")
        .and_then(Value::as_array)
        .map(|groups| {
            groups
                .iter()
                .filter_map(Value::as_u64)
                .filter_map(|group| u32::try_from(group).ok())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Ok(Some(AccessContext::new(uid, groups)))
}

fn storage_error(error: &NativeStorageError) -> MachineError {
    MachineError::new(error.code().as_str(), error.to_string())
}

fn write_actor(request: &Value) -> Result<Option<WriteActor>, MachineError> {
    Ok(actor(request)?.map(|actor| WriteActor::new(actor.uid(), actor.groups().iter().copied())))
}

/// Owner, group, and mode are honoured on creation only, matching the
/// published `put`/`INSERT` contract.
fn access(request: &Value) -> Result<WriteAccess, MachineError> {
    let Some(fields) = request.get("access").and_then(Value::as_object) else {
        return Ok(WriteAccess::default());
    };
    let read = |name: &str| -> Result<Option<u32>, MachineError> {
        fields
            .get(name)
            .and_then(Value::as_u64)
            .map(|value| {
                u32::try_from(value).map_err(|_| {
                    MachineError::new(
                        "EBADREQUEST",
                        format!("machine access {name} is out of range"),
                    )
                })
            })
            .transpose()
    };
    Ok(WriteAccess {
        uid: read("uid")?,
        gid: read("gid")?,
        mode: read("mode")?,
    })
}

fn optional_string(value: &Value, name: &str) -> Option<String> {
    value
        .get(name)
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}

fn engine_error(error: &EngineError) -> MachineError {
    let code = error
        .storage_code()
        .map(NativeStorageErrorCode::as_str)
        .or_else(|| error.format_code_str())
        .or_else(|| error.query_code_str())
        .unwrap_or_else(|| error.code().as_str());
    MachineError::new(code, error.to_string())
}

fn serialization_error(error: &serde_json::Error) -> MachineError {
    MachineError::new("EUNKNOWN", error.to_string())
}

/// Reject a machine result object that a client could confuse with an envelope.
#[must_use]
pub fn is_reserved_result_key(key: &str) -> bool {
    matches!(key, "protocolVersion" | "ok" | "op" | "requestId")
}

fn runtime_target() -> String {
    if let Some(target) = BUILD_TARGET.filter(|target| !target.is_empty()) {
        return target.to_owned();
    }
    let os = std::env::consts::OS;
    let architecture = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        other => other,
    };
    format!("{os}-{architecture}")
}

fn executable_on_path(name: &str) -> bool {
    let Some(path) = std::env::var_os("PATH") else {
        return false;
    };
    std::env::split_paths(&path).any(|directory| {
        let candidate = directory.join(name);
        if candidate.is_file() {
            return true;
        }
        #[cfg(windows)]
        {
            for extension in ["exe", "cmd", "bat", "com"] {
                if directory.join(format!("{name}.{extension}")).is_file() {
                    return true;
                }
            }
        }
        false
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn run(input: &str) -> Vec<Value> {
        let mut reader = Cursor::new(input.as_bytes().to_vec());
        let mut output = Vec::new();
        serve(&mut reader, &mut output, None, FrameLimits::default()).unwrap();
        String::from_utf8(output)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    #[test]
    fn handshake_reports_the_published_framing_contract() {
        let frames = run("{\"op\":\"handshake\",\"requestId\":\"one\"}\n");
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0]["ok"], json!(true));
        assert_eq!(frames[0]["protocolVersion"], json!(1));
        assert_eq!(frames[0]["requestId"], json!("one"));
        assert_eq!(frames[0]["result"]["machine"]["delimiter"], json!("LF"));
        assert_eq!(
            frames[0]["result"]["machine"]["duplicateKeys"],
            json!("rejected")
        );
    }

    #[test]
    fn handshake_versions_machine_access_and_document_bucket_capabilities() {
        let frame = &run("{\"op\":\"handshake\"}\n")[0];
        let capabilities = &frame["result"]["capabilities"];

        assert_eq!(capabilities["documentBuckets"]["version"], json!(1));
        assert_eq!(
            capabilities["documentBuckets"]["collectionKind"],
            json!("file")
        );
        assert_eq!(
            capabilities["documentBuckets"]["operations"],
            json!(DOCUMENT_BUCKET_OPERATIONS)
        );

        #[cfg(any(target_os = "macos", target_os = "linux"))]
        {
            assert_eq!(capabilities["machineAccess"]["version"], json!(1));
            assert_eq!(
                capabilities["machineAccess"]["operations"],
                json!(MACHINE_ACCESS_OPERATIONS)
            );
            assert_eq!(
                capabilities["machineAccess"]["directDenial"],
                json!("EACCES")
            );
            assert_eq!(capabilities["machineAccess"]["queryDenial"], json!("omit"));
        }

        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        assert!(capabilities.get("machineAccess").is_none());
    }

    #[test]
    fn malformed_frames_resume_at_the_next_delimiter() {
        let frames = run("not json\n{\"op\":\"handshake\"}\n");
        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0]["error"]["code"], json!("EFRAME_JSON"));
        assert_eq!(frames[1]["ok"], json!(true));
    }

    #[test]
    fn duplicate_keys_are_rejected_without_ending_the_session() {
        let frames = run("{\"op\":\"handshake\",\"op\":\"handshake\"}\n{\"op\":\"handshake\"}\n");
        assert_eq!(frames[0]["error"]["code"], json!("EFRAME_DUPLICATE_KEY"));
        assert_eq!(frames[1]["ok"], json!(true));
    }

    #[test]
    fn a_truncated_final_frame_ends_the_session() {
        let frames = run("{\"op\":\"handshake\"}\n{\"op\":\"hand");
        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0]["ok"], json!(true));
        assert_eq!(frames[1]["error"]["code"], json!("EFRAME_TRUNCATED"));
    }

    #[test]
    fn an_oversized_request_is_rejected_and_the_session_continues() {
        let mut reader = Cursor::new(
            format!(
                "{{\"op\":\"handshake\",\"pad\":\"{}\"}}\n{{\"op\":\"handshake\"}}\n",
                "x".repeat(64)
            )
            .into_bytes(),
        );
        let mut output = Vec::new();
        serve(
            &mut reader,
            &mut output,
            None,
            FrameLimits {
                max_request_bytes: 32,
                max_response_bytes: DEFAULT_MAX_RESPONSE_BYTES,
            },
        )
        .unwrap();
        let frames: Vec<Value> = String::from_utf8(output)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(
            frames[0]["error"]["code"],
            json!("EFRAME_REQUEST_TOO_LARGE")
        );
        assert_eq!(frames[1]["ok"], json!(true));
    }

    #[test]
    fn exclusive_startup_reports_a_contending_owner_in_the_handshake_frame() {
        let root = std::env::temp_dir().join(format!(
            "fylo-machine-exclusive-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let held = RootLease::acquire(&root).unwrap();
        let mut reader = Cursor::new(b"{\"op\":\"handshake\"}\n".to_vec());
        let mut output = Vec::new();
        serve_exclusive(
            &mut reader,
            &mut output,
            Some(root.clone()),
            FrameLimits::default(),
        )
        .unwrap();
        let frame: Value = serde_json::from_slice(&output).unwrap();
        assert_eq!(frame["ok"], json!(false));
        assert_eq!(frame["error"]["code"], json!("EROOTLOCKED"));
        drop(held);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn an_unknown_operation_reports_eunsupportedop() {
        let frames = run("{\"op\":\"launchMissiles\"}\n");
        assert_eq!(frames[0]["error"]["code"], json!("EUNSUPPORTEDOP"));
    }

    #[test]
    fn one_shot_sessions_reject_paged_queries() {
        let session = Session {
            default_root: None,
            limits: FrameLimits::default(),
            leases: std::cell::RefCell::new(std::collections::BTreeMap::new()),
            cursors: std::cell::RefCell::new(std::collections::BTreeMap::new()),
            cursor_sequence: std::cell::Cell::new(0),
            startup_error: None,
            persistent: false,
        };
        let error = session
            .paginate(&json!({ "page": { "limit": 1 } }), Vec::new())
            .unwrap_err();
        assert_eq!(error.code, "EQUERYLOOPREQUIRED");
    }

    #[test]
    fn snapshot_counter_fails_closed_at_its_limit() {
        let mut counter = LimitedCounter {
            bytes: 0,
            limit: 3,
            exceeded: false,
        };
        assert!(counter.write_all(b"four").is_err());
        assert!(counter.exceeded);
        assert_eq!(counter.bytes, 0);
    }
}
