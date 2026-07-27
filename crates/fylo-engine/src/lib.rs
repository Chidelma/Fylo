//! FYLO engine orchestration.
//!
//! The current vertical slice is deliberately read-only. It combines native
//! storage discovery with the portable format and query kernels and verifies a
//! stable collection generation around every logical read.

mod encryption;

use std::fmt;
use std::path::Path;

use encryption::{EncryptionReader, reject_undeclared_ciphertext};
use fylo_format::{CanonicalMetadata, Document, DocumentLimits, FormatError, decode_ttid};
use fylo_query::{QueryError, QueryLimits, ScanQuery, SqlOperation, SqlPlan, StructuredQuery};
use fylo_storage_native::{
    CollectionKind, GenerationStatus, IndexVerification, NativeAccess, NativeCollection,
    NativeRoot, NativeStorageError, RepositoryHistory, StoredRawFile, VersionVerification,
};
use serde::Serialize;
use serde_json::{Map, Value};

const MAX_STABLE_READ_ATTEMPTS: usize = 3;

/// Read-only native FYLO engine.
#[derive(Clone)]
pub struct ReadOnlyEngine {
    root: NativeRoot,
    encryption: Option<EncryptionReader>,
}

impl ReadOnlyEngine {
    /// Open an existing FYLO root without modifying it.
    ///
    /// # Errors
    ///
    /// Returns an error when the root cannot be opened safely.
    pub fn open(path: impl AsRef<Path>) -> Result<Self, EngineError> {
        Ok(Self {
            root: NativeRoot::open(path).map_err(EngineError::storage)?,
            encryption: None,
        })
    }

    /// Open a read-only engine with a schema root but without a decryption key.
    ///
    /// This is useful for proving fail-closed behavior: collections declaring
    /// encrypted fields return `EENGINE_ENCRYPTION` until credentials are
    /// supplied.
    ///
    /// # Errors
    ///
    /// Returns an error when either root cannot be opened safely.
    pub fn open_with_schema(
        path: impl AsRef<Path>,
        schema_root: impl AsRef<Path>,
    ) -> Result<Self, EngineError> {
        Ok(Self {
            root: NativeRoot::open(path).map_err(EngineError::storage)?,
            encryption: Some(
                EncryptionReader::open(schema_root, None).map_err(EngineError::encryption)?,
            ),
        })
    }

    /// Open a read-only engine with JavaScript-compatible field decryption.
    ///
    /// # Errors
    ///
    /// Returns an error for unsafe roots, short/invalid credentials, corrupt
    /// schema metadata, or key derivation failures.
    pub fn open_with_encryption(
        path: impl AsRef<Path>,
        schema_root: impl AsRef<Path>,
        secret: &str,
        salt: &str,
    ) -> Result<Self, EngineError> {
        Ok(Self {
            root: NativeRoot::open(path).map_err(EngineError::storage)?,
            encryption: Some(
                EncryptionReader::open(schema_root, Some((secret, salt)))
                    .map_err(EngineError::encryption)?,
            ),
        })
    }

    /// Canonical root identity.
    #[must_use]
    pub fn root_path(&self) -> &Path {
        self.root.path()
    }

    /// Read the active repository's first-parent commit history.
    ///
    /// # Errors
    ///
    /// Returns a stable error for corrupt/unsafe repository metadata or an
    /// invalid limit.
    pub fn history(&self, limit: usize) -> Result<RepositoryHistory, EngineError> {
        self.root
            .version_history(limit)
            .map_err(EngineError::storage)
    }

    /// Verify active first-parent historical tree and blob integrity.
    ///
    /// # Errors
    ///
    /// Returns a stable error for corrupt/unsafe repository content or an
    /// exhausted verification bound.
    pub fn verify_history(&self, limit: usize) -> Result<VersionVerification, EngineError> {
        self.root
            .verify_version_history(limit)
            .map_err(EngineError::storage)
    }

    /// Read and validate one JSON document with canonical metadata.
    ///
    /// # Errors
    ///
    /// Returns a stable error for unsafe storage, corrupt documents, invalid
    /// identifiers, or concurrent write generations.
    pub fn get(&self, collection: &str, identifier: &str) -> Result<ReadDocument, EngineError> {
        let collection = self
            .root
            .collection(collection)
            .map_err(EngineError::storage)?;
        Self::read_stable(&collection, || {
            let stored = collection
                .read_document(identifier)
                .map_err(EngineError::storage)?;
            let document = self.decode_document(
                collection.name(),
                Document::parse(&stored.bytes, DocumentLimits::default())
                    .map_err(EngineError::format)?,
            )?;
            let timestamps = decode_ttid(identifier).map_err(EngineError::format)?;
            Ok(ReadDocument {
                metadata: CanonicalMetadata {
                    id: identifier.to_owned(),
                    created_at: timestamps.created_at,
                    updated_at: stored.modified_millis,
                    mtime: stored.modified_millis,
                },
                document,
            })
        })
    }

    /// Read one unwrapped raw file with canonical, custom, and native metadata.
    ///
    /// # Errors
    ///
    /// Returns a stable error for unsafe storage, missing/corrupt xattrs,
    /// invalid identifiers, oversized files, or concurrent write generations.
    pub fn get_file(&self, collection: &str, identifier: &str) -> Result<ReadFile, EngineError> {
        let collection = self
            .root
            .collection(collection)
            .map_err(EngineError::storage)?;
        Self::read_stable(&collection, || {
            let stored = collection
                .read_raw_file(identifier)
                .map_err(EngineError::storage)?;
            build_read_file(identifier, stored)
        })
    }

    /// Read one retained soft-deleted JSON document.
    ///
    /// # Errors
    ///
    /// Returns a stable error for unsafe/corrupt storage, invalid identifiers,
    /// or concurrent write generations.
    pub fn get_deleted(
        &self,
        collection: &str,
        identifier: &str,
    ) -> Result<ReadDeletedDocument, EngineError> {
        let collection = self
            .root
            .collection(collection)
            .map_err(EngineError::storage)?;
        Self::read_stable(&collection, || {
            let stored = collection
                .read_deleted_document(identifier)
                .map_err(EngineError::storage)?;
            let document = self.decode_document(
                collection.name(),
                Document::parse(&stored.bytes, DocumentLimits::default())
                    .map_err(EngineError::format)?,
            )?;
            let timestamps = decode_ttid(identifier).map_err(EngineError::format)?;
            Ok(ReadDeletedDocument {
                id: identifier.to_owned(),
                created_at: timestamps.created_at,
                deleted_at: stored.modified_millis,
                document,
            })
        })
    }

    /// Read one retained soft-deleted raw file.
    ///
    /// # Errors
    ///
    /// Returns a stable error for unsafe/corrupt storage, invalid identifiers,
    /// or concurrent write generations.
    pub fn get_deleted_file(
        &self,
        collection: &str,
        identifier: &str,
    ) -> Result<ReadDeletedFile, EngineError> {
        let collection = self
            .root
            .collection(collection)
            .map_err(EngineError::storage)?;
        Self::read_stable(&collection, || {
            let stored = collection
                .read_deleted_raw_file(identifier)
                .map_err(EngineError::storage)?;
            let deleted_at = stored.modified_millis;
            Ok(ReadDeletedFile {
                deleted_at,
                file: build_read_file(identifier, stored)?,
            })
        })
    }

    /// Execute one portable prefix-index scan under a stable generation.
    ///
    /// # Errors
    ///
    /// Returns a stable error for unsafe/corrupt storage, invalid queries, or a
    /// concurrent write generation.
    pub fn scan_index(
        &self,
        collection: &str,
        queries: &[ScanQuery],
    ) -> Result<Vec<String>, EngineError> {
        let collection = self
            .root
            .collection(collection)
            .map_err(EngineError::storage)?;
        Self::read_stable(&collection, || {
            collection
                .index_snapshot()
                .map_err(EngineError::storage)?
                .scan(queries, QueryLimits::default())
                .map_err(EngineError::query)?
                .into_iter()
                .map(|identifier| {
                    String::from_utf8(identifier).map_err(|error| {
                        EngineError::new(
                            EngineErrorCode::CorruptData,
                            format!("index document identifier is not UTF-8: {error}"),
                        )
                    })
                })
                .collect()
        })
    }

    /// Verify merged snapshot/WAL key structure and live-record references.
    ///
    /// # Errors
    ///
    /// Returns a stable error for corrupt/orphaned keys, unsafe storage, or a
    /// concurrent write generation.
    pub fn verify_index(&self, collection: &str) -> Result<IndexVerification, EngineError> {
        let collection = self
            .root
            .collection(collection)
            .map_err(EngineError::storage)?;
        Self::read_stable(&collection, || {
            collection
                .verify_index_references()
                .map_err(EngineError::storage)
        })
    }

    /// Execute a validated structured query over live JSON documents.
    ///
    /// Candidate planning remains a separate optimization; this bounded
    /// read-only path evaluates portable predicates in deterministic TTID
    /// order and preserves the existing zero-limit behavior.
    ///
    /// # Errors
    ///
    /// Returns a stable error for unsafe/corrupt storage, document format
    /// failures, or a concurrent write generation.
    pub fn find(
        &self,
        collection: &str,
        query: &StructuredQuery,
    ) -> Result<Vec<ReadDocument>, EngineError> {
        let collection = self
            .root
            .collection(collection)
            .map_err(EngineError::storage)?;
        Self::read_stable(&collection, || {
            let mut records = Vec::new();
            for identifier in collection.document_ids().map_err(EngineError::storage)? {
                let stored = collection
                    .read_document(&identifier)
                    .map_err(EngineError::storage)?;
                let document = self.decode_document(
                    collection.name(),
                    Document::parse(&stored.bytes, DocumentLimits::default())
                        .map_err(EngineError::format)?,
                )?;
                let timestamps = decode_ttid(&identifier).map_err(EngineError::format)?;
                if !query.matches(
                    document.fields(),
                    timestamps.created_at,
                    stored.modified_millis,
                ) {
                    continue;
                }
                records.push(ReadDocument {
                    metadata: CanonicalMetadata {
                        id: identifier,
                        created_at: timestamps.created_at,
                        updated_at: stored.modified_millis,
                        mtime: stored.modified_millis,
                    },
                    document,
                });
                if query
                    .limit()
                    .is_some_and(|limit| limit > 0 && records.len() >= limit)
                {
                    break;
                }
            }
            Ok(records)
        })
    }

    /// Execute a prepared read-only SQL `SELECT` plan.
    ///
    /// Projection, only-ID shaping, grouping, predicates, ordering, and limit
    /// behavior match the current JavaScript engine. Joins and mutations are
    /// deliberately rejected by this read-only preview.
    ///
    /// # Errors
    ///
    /// Returns a stable error for non-SELECT plans, joins, malformed query
    /// ASTs, unsafe storage, or unstable collection generations.
    pub fn select_sql(&self, plan: &SqlPlan) -> Result<Value, EngineError> {
        if plan.operation != SqlOperation::Select {
            return Err(EngineError::new(
                EngineErrorCode::Query,
                "read-only SQL execution accepts SELECT statements only",
            ));
        }
        if plan.ast.get("$leftCollection").is_some() {
            return Err(EngineError::new(
                EngineErrorCode::Query,
                "read-only SQL joins are not implemented",
            ));
        }
        let query = StructuredQuery::from_value(&plan.ast, QueryLimits::default())
            .map_err(EngineError::query)?;
        let records = self.find(&plan.collection, &query)?;
        Ok(shape_select_results(records, &plan.ast))
    }

    /// Inspect one collection without changing any files.
    ///
    /// # Errors
    ///
    /// Returns a stable error for unsafe, corrupt, missing, or concurrently
    /// mutating storage.
    pub fn inspect(&self, collection: &str) -> Result<CollectionInspection, EngineError> {
        let collection = self
            .root
            .collection(collection)
            .map_err(EngineError::storage)?;
        Self::read_stable(&collection, || {
            let generation = collection.generation().map_err(EngineError::storage)?;
            let (document_count, file_count, deleted_count) = match collection.kind() {
                CollectionKind::Document => (
                    collection
                        .document_ids()
                        .map_err(EngineError::storage)?
                        .len(),
                    0,
                    collection
                        .deleted_document_ids()
                        .map_err(EngineError::storage)?
                        .len(),
                ),
                CollectionKind::File => (
                    0,
                    collection
                        .raw_file_ids()
                        .map_err(EngineError::storage)?
                        .len(),
                    collection
                        .deleted_raw_file_ids()
                        .map_err(EngineError::storage)?
                        .len(),
                ),
            };
            let index_bytes = collection
                .index_snapshot()
                .map_err(EngineError::storage)?
                .as_bytes()
                .len();
            Ok(CollectionInspection {
                collection: collection.name().to_owned(),
                kind: collection.kind(),
                generation: generation.generation,
                state: generation.state,
                document_count,
                file_count,
                deleted_count,
                index_bytes,
                read_only: true,
            })
        })
    }

    fn read_stable<T>(
        collection: &NativeCollection,
        read: impl Fn() -> Result<T, EngineError>,
    ) -> Result<T, EngineError> {
        for _ in 0..MAX_STABLE_READ_ATTEMPTS {
            let before = collection.generation().map_err(EngineError::storage)?;
            if before.state == GenerationStatus::Writing {
                continue;
            }
            let value = read()?;
            let after = collection.generation().map_err(EngineError::storage)?;
            if after.state == GenerationStatus::Stable && after.generation == before.generation {
                return Ok(value);
            }
        }
        Err(EngineError::new(
            EngineErrorCode::ConcurrentWrite,
            "collection changed during a read-only operation",
        ))
    }

    fn decode_document(
        &self,
        collection: &str,
        document: Document,
    ) -> Result<Document, EngineError> {
        let fields = document.into_fields();
        let fields = if let Some(encryption) = &self.encryption {
            encryption
                .decode_document(collection, fields)
                .map_err(EngineError::encryption)?
        } else {
            reject_undeclared_ciphertext(collection, &fields).map_err(EngineError::encryption)?;
            fields
        };
        Document::try_from_value(Value::Object(fields), DocumentLimits::default())
            .map_err(EngineError::format)
    }
}

fn build_read_file(identifier: &str, stored: StoredRawFile) -> Result<ReadFile, EngineError> {
    let timestamps = decode_ttid(identifier).map_err(EngineError::format)?;
    let metadata = CanonicalMetadata {
        id: identifier.to_owned(),
        created_at: timestamps.created_at,
        updated_at: stored.modified_millis,
        mtime: stored.modified_millis,
    };
    Ok(ReadFile {
        file: RawFileManifest {
            name: format!("{identifier}{}", stored.extension),
            key: stored.key,
            extension: stored.extension,
            content_type: stored.content_type,
            content_length: stored.bytes.len() as u64,
            etag: stored.checksum_sha256.clone(),
            checksum_sha256: stored.checksum_sha256,
            created_at: timestamps.created_at,
            last_modified: stored.modified_millis,
        },
        metadata,
        custom_metadata: stored.custom_metadata.into_iter().collect(),
        access: stored.access,
        bytes: stored.bytes,
    })
}

fn shape_select_results(records: Vec<ReadDocument>, ast: &Value) -> Value {
    let selection = ast
        .get("$select")
        .and_then(Value::as_array)
        .map(|values| values.iter().filter_map(Value::as_str).collect::<Vec<_>>())
        .unwrap_or_default();
    let only_ids = ast
        .get("$onlyIds")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let group_by = ast.get("$groupby").and_then(Value::as_str);
    if let Some(group_by) = group_by {
        return shape_grouped_results(records, &selection, group_by, only_ids);
    }
    if only_ids {
        return Value::Array(
            records
                .into_iter()
                .map(|record| Value::String(record.metadata.id))
                .collect(),
        );
    }
    Value::Object(
        records
            .into_iter()
            .map(|record| {
                (
                    record.metadata.id,
                    Value::Object(project(record.document.into_fields(), &selection)),
                )
            })
            .collect(),
    )
}

fn shape_grouped_results(
    records: Vec<ReadDocument>,
    selection: &[&str],
    group_by: &str,
    only_ids: bool,
) -> Value {
    let mut groups = Map::new();
    for record in records {
        let mut fields = project(record.document.into_fields(), selection);
        let Some(group_value) = fields.get(group_by).filter(|value| js_truthy(value)) else {
            continue;
        };
        let group = js_string(group_value);
        fields.remove(group_by);
        let members = groups
            .entry(group)
            .or_insert_with(|| Value::Object(Map::new()));
        members
            .as_object_mut()
            .expect("group entries are created as objects")
            .insert(record.metadata.id, Value::Object(fields));
    }
    if !only_ids {
        return Value::Object(groups);
    }
    Value::Object(
        groups
            .into_iter()
            .map(|(group, members)| {
                let identifiers = members
                    .as_object()
                    .expect("group entries are objects")
                    .keys()
                    .cloned()
                    .map(Value::String)
                    .collect();
                (group, Value::Array(identifiers))
            })
            .collect(),
    )
}

fn project(mut fields: Map<String, Value>, selection: &[&str]) -> Map<String, Value> {
    if !selection.is_empty() {
        fields.retain(|field, _| selection.contains(&field.as_str()));
    }
    fields
}

fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => value.as_f64().is_some_and(|value| value != 0.0),
        Value::String(value) => !value.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::String(value) => value.clone(),
        Value::Array(values) => values.iter().map(js_string).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

/// Validated document plus canonical storage metadata.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadDocument {
    /// Canonical metadata.
    pub metadata: CanonicalMetadata,
    /// Stored JSON document.
    pub document: Document,
}

/// Retained soft-deleted JSON document.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadDeletedDocument {
    /// Original TTID.
    pub id: String,
    /// TTID creation timestamp.
    pub created_at: u64,
    /// Tombstone modification/deletion timestamp.
    pub deleted_at: u64,
    /// Stored JSON document.
    pub document: Document,
}

/// Raw-file bytes plus all metadata exposed by the read-only engine.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadFile {
    /// Canonical TTID and filesystem timestamps.
    pub metadata: CanonicalMetadata,
    /// Existing FYLO raw-file manifest fields.
    pub file: RawFileManifest,
    /// Developer-defined xattr/ADS metadata.
    pub custom_metadata: Map<String, Value>,
    /// Native owner, group, and permission mode.
    pub access: NativeAccess,
    /// Unwrapped file bytes. Protocol adapters must choose a bounded encoding.
    #[serde(skip_serializing)]
    pub bytes: Vec<u8>,
}

/// Retained soft-deleted raw file.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadDeletedFile {
    /// Tombstone modification/deletion timestamp.
    pub deleted_at: u64,
    /// Raw-file body and metadata.
    #[serde(flatten)]
    pub file: ReadFile,
}

/// Existing FYLO raw-file manifest representation.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RawFileManifest {
    /// TTID filename.
    pub name: String,
    /// Durable logical object key.
    pub key: String,
    /// Safe final extension.
    pub extension: String,
    /// Inferred content type.
    pub content_type: String,
    /// Unwrapped byte length.
    pub content_length: u64,
    /// Entity tag, equal to the cached/recomputed SHA-256.
    pub etag: String,
    /// SHA-256 checksum.
    #[serde(rename = "checksumSHA256")]
    pub checksum_sha256: String,
    /// TTID creation time in Unix milliseconds.
    pub created_at: u64,
    /// Filesystem modification time in Unix milliseconds.
    pub last_modified: u64,
}

/// Read-only collection inspection result.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionInspection {
    /// Collection name.
    pub collection: String,
    /// Document or file collection.
    pub kind: CollectionKind,
    /// Stable transaction generation.
    pub generation: u64,
    /// Stable/writing state observed by the reader.
    pub state: GenerationStatus,
    /// Validated live JSON document count.
    pub document_count: usize,
    /// Validated live raw-file count.
    pub file_count: usize,
    /// Validated retained tombstone count.
    pub deleted_count: usize,
    /// Immutable index snapshot bytes, or zero when absent.
    pub index_bytes: usize,
    /// Always true for this preview engine.
    pub read_only: bool,
}

/// Stable read-only engine error codes.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EngineErrorCode {
    /// Native storage rejected the operation.
    Storage,
    /// Portable format validation failed.
    Format,
    /// Portable query validation/execution failed.
    Query,
    /// Index or identifier data was corrupt.
    CorruptData,
    /// A writer prevented a stable generation read.
    ConcurrentWrite,
    /// Encrypted data could not be safely decoded.
    Encryption,
}

impl EngineErrorCode {
    /// Stable external string.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Storage => "EENGINE_STORAGE",
            Self::Format => "EENGINE_FORMAT",
            Self::Query => "EENGINE_QUERY",
            Self::CorruptData => "EENGINE_CORRUPT",
            Self::ConcurrentWrite => "EENGINE_CONCURRENT_WRITE",
            Self::Encryption => "EENGINE_ENCRYPTION",
        }
    }
}

/// Read-only engine error.
#[derive(Debug)]
pub struct EngineError {
    code: EngineErrorCode,
    message: String,
    source: Option<Box<dyn std::error::Error + Send + Sync>>,
}

impl EngineError {
    fn new(code: EngineErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            source: None,
        }
    }

    fn storage(error: NativeStorageError) -> Self {
        Self {
            code: EngineErrorCode::Storage,
            message: error.to_string(),
            source: Some(Box::new(error)),
        }
    }

    fn format(error: FormatError) -> Self {
        Self {
            code: EngineErrorCode::Format,
            message: error.to_string(),
            source: Some(Box::new(error)),
        }
    }

    fn query(error: QueryError) -> Self {
        Self {
            code: EngineErrorCode::Query,
            message: error.to_string(),
            source: Some(Box::new(error)),
        }
    }

    fn encryption(message: impl Into<String>) -> Self {
        Self::new(EngineErrorCode::Encryption, message)
    }

    /// Stable error code.
    #[must_use]
    pub const fn code(&self) -> EngineErrorCode {
        self.code
    }
}

impl fmt::Display for EngineError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.code.as_str(), self.message)
    }
}

impl std::error::Error for EngineError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.source
            .as_ref()
            .map(|error| error.as_ref() as &(dyn std::error::Error + 'static))
    }
}
