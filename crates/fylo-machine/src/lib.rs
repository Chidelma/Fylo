//! Bounded NDJSON machine protocol v1 over the native Rust engine.
//!
//! The canonical contract lives in `api/machine/v1`. This crate owns framing,
//! limits, and stable error mapping; it does not reimplement query,
//! permission, or transaction semantics.

mod strict;

use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::time::Instant;

use fylo_engine::{AccessContext, EngineError, ReadOnlyEngine, WriteEngine};
use fylo_query::{JoinSpec, QueryLimits, SqlOperation, StructuredQuery, prepare_sql};
use fylo_storage_native::{
    CollectionKind, NativeStorageError, NativeWriteRoot, RootLease, WriteAccess, WriteActor,
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
    let limits = limits.clamped();
    let mut session = Session {
        default_root,
        limits,
        leases: std::cell::RefCell::new(std::collections::BTreeMap::new()),
        cursors: std::cell::RefCell::new(std::collections::BTreeMap::new()),
        cursor_sequence: std::cell::Cell::new(0),
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
        let mut frame = Vec::new();
        let (read, oversized, delimited) =
            read_frame(input, self.limits.max_request_bytes, &mut frame)?;
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
        let request_id = request
            .get("requestId")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned);
        let operation = request
            .get("op")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned);
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
            "backupStatus" => Ok(json!({ "configured": false, "state": "disabled", "runs": 0 })),
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
            "branch" => self.branches(request),
            "status" => self.status(request),
            "diff" => self.diff(request),
            "schemaInspect" => self.schema_inspect(request),
            "schemaCurrent" => self.schema_current(request),
            "schemaHistory" => self.schema_history(request),
            "schemaDoctor" => self.schema_doctor(request),
            "schemaValidate" => self.schema_validate(request),
            _ if is_known_operation(operation) => Err(MachineError::new(
                "EUNSUPPORTEDOP",
                format!("native machine preview does not implement operation {operation}"),
            )),
            _ => Err(MachineError::new(
                "EBADREQUEST",
                format!("unknown machine operation {operation}"),
            )),
        }
    }

    fn handshake(&self) -> Value {
        json!({
            "protocolVersion": PROTOCOL_VERSION,
            "runtimeVersion": env!("CARGO_PKG_VERSION"),
            "buildKind": "native-rust-preview",
            "buildTarget": std::env::consts::ARCH,
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
            "capabilities": {
                "handshake": true,
                "exclusiveRoot": true,
                "rootLease": "kernel-held",
                "writes": true,
                "queryPagination": {
                    "version": 1,
                    "operations": ["findDocs", "findDeletedDocs"],
                    "defaultItems": DEFAULT_QUERY_PAGE_ITEMS,
                    "maxItems": MAX_QUERY_PAGE_ITEMS,
                    "cursorTtlMs": QUERY_CURSOR_TTL_MS,
                    "ordering": "ttid-binary-ascending",
                    "scope": "persistent-process",
                    "restartPolicy": "restart-from-first-page"
                },
                "operations": SUPPORTED_OPERATIONS,
            }
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
        leases.insert(root.clone(), lease);
        Ok(root)
    }

    fn engine(&self, request: &Value) -> Result<ReadOnlyEngine, MachineError> {
        ReadOnlyEngine::open(self.root(request)?).map_err(|error| engine_error(&error))
    }

    fn get_document(&self, request: &Value) -> Result<Value, MachineError> {
        let engine = self.engine(request)?;
        let collection = require_string(request, "collection")?;
        let identifier = require_string(request, "id")?;
        let actor = actor(request)?;
        let record = match actor.as_ref() {
            Some(actor) => engine.get_as(collection, identifier, actor),
            None => engine.get(collection, identifier),
        }
        .map_err(|error| engine_error(&error))?;
        let document =
            serde_json::to_value(record.document).map_err(|error| serialization_error(&error))?;
        Ok(json!({ identifier: document }))
    }

    fn find_documents(&self, request: &Value) -> Result<Value, MachineError> {
        let engine = self.engine(request)?;
        let collection = require_string(request, "collection")?;
        let query = structured_query(request)?;
        let actor = actor(request)?;
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
        if request.get("page").is_none() {
            return Ok(Value::Array(
                pairs
                    .into_iter()
                    .map(|(identifier, document)| json!({ identifier: document }))
                    .collect(),
            ));
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
            "generation": inspection.generation,
        }))
    }

    fn verify_collection(&self, request: &Value) -> Result<Value, MachineError> {
        let engine = self.engine(request)?;
        let collection = require_string(request, "collection")?;
        serde_json::to_value(
            engine
                .verify_index(collection)
                .map_err(|error| engine_error(&error))?,
        )
        .map_err(|error| serialization_error(&error))
    }

    fn history(&self, request: &Value) -> Result<Value, MachineError> {
        let engine = self.engine(request)?;
        let limit = request
            .get("limit")
            .and_then(Value::as_u64)
            .and_then(|limit| usize::try_from(limit).ok())
            .unwrap_or(50);
        serde_json::to_value(
            engine
                .history(limit)
                .map_err(|error| engine_error(&error))?,
        )
        .map_err(|error| serialization_error(&error))
    }

    fn get_metadata(&self, request: &Value) -> Result<Value, MachineError> {
        let engine = self.engine(request)?;
        engine
            .metadata(
                require_string(request, "collection")?,
                require_string(request, "id")?,
            )
            .map_err(|error| engine_error(&error))
    }

    fn writer(&self, request: &Value) -> Result<NativeWriteRoot, MachineError> {
        NativeWriteRoot::open(self.root(request)?).map_err(|error| storage_error(&error))
    }

    fn write_engine(&self, request: &Value) -> Result<WriteEngine, MachineError> {
        let root = self.root(request)?;
        let schema =
            configured("FYLO_SCHEMA").filter(|schema| std::path::Path::new(schema).is_dir());
        let credentials = configured("FYLO_ENCRYPTION_KEY").zip(configured("FYLO_CIPHER_SALT"));
        match (schema, credentials) {
            (Some(schema), Some((secret, salt))) => {
                WriteEngine::open_with_encryption(root, schema, &secret, &salt)
            }
            (Some(schema), None) => WriteEngine::open_with_schema(root, schema),
            (None, _) => WriteEngine::open(root),
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
        serde_json::to_value(mutation).map_err(|error| serialization_error(&error))
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
        Ok(json!({ "collection": collection, "rebuilt": true }))
    }

    fn put_data(&self, request: &Value) -> Result<Value, MachineError> {
        let collection = require_string(request, "collection")?;
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
        self.write_engine(request)?
            .put_document(collection, &identifier, data.clone(), access(request)?)
            .map_err(|error| engine_error(&error))?;
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
        let rows = engine
            .find_deleted(collection, &query, actor.as_ref())
            .map_err(|error| engine_error(&error))?;
        if request.get("page").is_none() {
            return serde_json::to_value(rows).map_err(|error| serialization_error(&error));
        }
        let mut pairs = Vec::with_capacity(rows.len());
        for record in rows {
            let identifier = record.id.clone();
            let encoded =
                serde_json::to_value(record).map_err(|error| serialization_error(&error))?;
            pairs.push((identifier, encoded));
        }
        self.paginate(request, pairs)
    }

    /// Serve one page of a query snapshot.
    ///
    /// The snapshot is taken once and held under an opaque token, so a client
    /// paging through a mutating collection sees a consistent result set rather
    /// than a shifting window. Cursors are process-scoped: a restarted server
    /// reports `EINVALIDCURSOR` and the client restarts from the first page.
    fn paginate(&self, request: &Value, rows: Vec<(String, Value)>) -> Result<Value, MachineError> {
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
            let mut sorted = rows;
            sorted.sort_by(|left, right| left.0.cmp(&right.0));
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
        Ok(json!({ "affected": matched.len(), "identifiers": matched }))
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
        Ok(json!({ "affected": matched.len(), "identifiers": matched }))
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
        let rows = match actor.as_ref() {
            Some(actor) => engine.find_as(collection, &query, actor),
            None => engine.find(collection, &query),
        }
        .map_err(|error| engine_error(&error))?;
        Ok(rows.into_iter().map(|row| row.metadata.id).collect())
    }

    fn branches(&self, request: &Value) -> Result<Value, MachineError> {
        let history = self
            .engine(request)?
            .history(1)
            .map_err(|error| engine_error(&error))?;
        Ok(json!({
            "current": history.branch,
            "branches": history.branch.map(|name| json!([{ "name": name, "head": history.head }])),
        }))
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
        let diff = self
            .writer(request)?
            .repository_diff(from, to)
            .map_err(|error| storage_error(&error))?;
        serde_json::to_value(diff).map_err(|error| serialization_error(&error))
    }

    fn status(&self, request: &Value) -> Result<Value, MachineError> {
        let status = self
            .writer(request)?
            .repository_status()
            .map_err(|error| storage_error(&error))?;
        if !status.enabled {
            return Err(MachineError::new(
                "EUNSUPPORTEDOP",
                "this FYLO root has no version repository",
            ));
        }
        Ok(json!({
            "branch": status.branch,
            "head": status.head,
            "clean": status.clean,
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
            "current": inspect["current"],
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

const SUPPORTED_OPERATIONS: [&str; 32] = [
    "handshake",
    "diff",
    "joinDocs",
    "backupStatus",
    "executeSQL",
    "createCollection",
    "dropCollection",
    "inspectCollection",
    "rebuildCollection",
    "verifyCollection",
    "getDoc",
    "getMeta",
    "setMeta",
    "findDocs",
    "putData",
    "patchDoc",
    "delDoc",
    "commit",
    "log",
    "getLatest",
    "findDeletedDocs",
    "restoreDoc",
    "batchPutData",
    "patchDocs",
    "delDocs",
    "branch",
    "status",
    "schemaInspect",
    "schemaCurrent",
    "schemaHistory",
    "schemaDoctor",
    "schemaValidate",
];

/// Operation names the canonical registry defines but this preview does not
/// implement yet. Reporting `EUNSUPPORTEDOP` instead of `EBADREQUEST` keeps a
/// client's capability probe meaningful.
const KNOWN_OPERATIONS: [&str; 38] = [
    "handshake",
    "backupStatus",
    "backupReconcile",
    "executeSQL",
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
    "joinDocs",
    "putData",
    "batchPutData",
    "patchDoc",
    "patchDocs",
    "delDoc",
    "delDocs",
    "importBulkData",
    "checkout",
    "branch",
    "commit",
    "log",
    "status",
    "diff",
    "restoreCommit",
    "merge",
    "schemaInspect",
    "schemaCurrent",
    "schemaHistory",
    "schemaDoctor",
    "schemaValidate",
    "schemaMaterialize",
];

fn is_known_operation(operation: &str) -> bool {
    KNOWN_OPERATIONS.contains(&operation)
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

fn engine_error(error: &EngineError) -> MachineError {
    MachineError::new(error.code().as_str(), error.to_string())
}

fn serialization_error(error: &serde_json::Error) -> MachineError {
    MachineError::new("EUNKNOWN", error.to_string())
}

/// Reject a machine result object that a client could confuse with an envelope.
#[must_use]
pub fn is_reserved_result_key(key: &str) -> bool {
    matches!(key, "protocolVersion" | "ok" | "op" | "requestId")
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
    fn a_registered_but_unimplemented_operation_reports_eunsupportedop() {
        let frames = run("{\"op\":\"merge\",\"source\":\"other\"}\n");
        assert_eq!(frames[0]["error"]["code"], json!("EUNSUPPORTEDOP"));
    }

    #[test]
    fn an_unknown_operation_reports_ebadrequest() {
        let frames = run("{\"op\":\"launchMissiles\"}\n");
        assert_eq!(frames[0]["error"]["code"], json!("EBADREQUEST"));
    }
}
