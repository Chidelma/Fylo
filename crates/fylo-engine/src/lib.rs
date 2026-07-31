//! FYLO engine orchestration.
//!
//! The current vertical slice is deliberately read-only. It combines native
//! storage discovery with the portable format and query kernels and verifies a
//! stable collection generation around every logical read.

mod encryption;
mod schema;

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::path::Path;

use encryption::{EncryptionReader, is_encrypted_field, reject_undeclared_ciphertext};
use fylo_format::{CanonicalMetadata, Document, DocumentLimits, FormatError, decode_ttid};
use fylo_query::{
    IndexLookupValue, JoinSpec, QueryError, QueryLimits, ScanQuery, SqlOperation, SqlPlan,
    StructuredQuery, index_entries_for_document,
};
use fylo_storage_native::{
    AccessDescriptor, CollectionKind, GenerationStatus, IndexVerification, NativeAccess,
    NativeCollection, NativeRoot, NativeStorageError, NativeWriteRoot, PutDocumentOptions,
    RepositoryHistory, StoredRawFile, VersionVerification, WriteAccess, WriteActor,
};
use schema::SchemaTools;
use serde::Serialize;
use serde_json::{Map, Value, json};

const MAX_STABLE_READ_ATTEMPTS: usize = 3;
/// Drifted index keys reported by one verification.
const MAX_DRIFT_SAMPLE: usize = 12;

/// Read-only native FYLO engine.
#[derive(Clone)]
pub struct ReadOnlyEngine {
    root: NativeRoot,
    encryption: Option<EncryptionReader>,
}

/// Native FYLO write engine.
///
/// The engine owns schema-declared field encryption and canonical document
/// encoding; `fylo-storage-native` owns durability. Encryption is applied
/// before any byte reaches the transaction journal so a crash can never leave
/// plaintext behind for a declared field.
#[derive(Clone)]
pub struct WriteEngine {
    writer: NativeWriteRoot,
    encryption: Option<EncryptionReader>,
    schema: Option<std::rc::Rc<SchemaTools>>,
}

impl WriteEngine {
    /// Open a write engine without field encryption.
    ///
    /// # Errors
    ///
    /// Returns an error when the root cannot be opened safely.
    pub fn open(path: impl AsRef<Path>) -> Result<Self, EngineError> {
        Ok(Self {
            writer: NativeWriteRoot::open(path).map_err(EngineError::storage)?,
            encryption: None,
            schema: None,
        })
    }

    /// Open a write engine with schema tooling but no decryption key.
    ///
    /// Schema inspection and validation work; a collection that declares
    /// `$encrypted` fields fails closed until credentials are supplied.
    ///
    /// # Errors
    ///
    /// Returns an error when either root cannot be opened safely.
    pub fn open_with_schema(
        path: impl AsRef<Path>,
        schema_root: impl AsRef<Path>,
    ) -> Result<Self, EngineError> {
        let schema_root = schema_root.as_ref().to_path_buf();
        Ok(Self {
            writer: NativeWriteRoot::open(path).map_err(EngineError::storage)?,
            encryption: Some(
                EncryptionReader::open(&schema_root, None).map_err(EngineError::encryption)?,
            ),
            schema: Some(std::rc::Rc::new(SchemaTools::new(schema_root))),
        })
    }

    /// Open a write engine with JavaScript-compatible field encryption.
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
        let schema_root = schema_root.as_ref().to_path_buf();
        Ok(Self {
            writer: NativeWriteRoot::open(path).map_err(EngineError::storage)?,
            encryption: Some(
                EncryptionReader::open(&schema_root, Some((secret, salt)))
                    .map_err(EngineError::encryption)?,
            ),
            schema: Some(std::rc::Rc::new(SchemaTools::new(schema_root))),
        })
    }

    /// Canonical root identity.
    #[must_use]
    pub fn root_path(&self) -> &Path {
        self.writer.path()
    }

    /// Create one document, encrypting every schema-declared field first.
    ///
    /// # Errors
    ///
    /// Returns an error for an invalid document, missing encryption
    /// credentials, or any durable write failure.
    pub fn put_document(
        &self,
        collection: &str,
        identifier: &str,
        fields: Map<String, Value>,
        access: WriteAccess,
    ) -> Result<(), EngineError> {
        let bytes = self.encode(collection, fields)?;
        self.writer
            .put_document(
                collection,
                identifier,
                &bytes,
                PutDocumentOptions { access },
            )
            .map_err(EngineError::storage)
    }

    /// Replace one document body, encrypting every schema-declared field first.
    ///
    /// # Errors
    ///
    /// Returns an error for an invalid document, missing encryption
    /// credentials, a denied write, or any durable write failure.
    pub fn patch_document(
        &self,
        collection: &str,
        identifier: &str,
        fields: Map<String, Value>,
        actor: Option<&AccessContext>,
    ) -> Result<(), EngineError> {
        let bytes = self.encode(collection, fields)?;
        let actor = actor.map(write_actor);
        self.writer
            .patch_document(collection, identifier, &bytes, actor.as_ref())
            .map_err(EngineError::storage)
    }

    /// `schemaInspect` for one collection.
    ///
    /// # Errors
    ///
    /// Returns an error when no schema root is configured or the manifest is
    /// corrupt.
    pub fn schema_inspect(&self, collection: &str) -> Result<Value, EngineError> {
        self.schema_tools()?
            .inspect(collection)
            .map_err(EngineError::schema)
    }

    /// `schemaDoctor` for one collection.
    ///
    /// # Errors
    ///
    /// Returns an error when no schema root is configured.
    pub fn schema_doctor(&self, collection: &str) -> Result<Value, EngineError> {
        Ok(self.schema_tools()?.doctor(collection))
    }

    /// Head schema version label, or `None` for an unversioned collection.
    ///
    /// # Errors
    ///
    /// Returns an error when no schema root is configured or the manifest is
    /// corrupt.
    pub fn schema_current(&self, collection: &str) -> Result<Option<String>, EngineError> {
        self.schema_tools()?
            .current_version(collection)
            .map_err(EngineError::schema)
    }

    /// Resolved schema root.
    ///
    /// # Errors
    ///
    /// Returns an error when no schema root is configured.
    pub fn schema_dir(&self) -> Result<&Path, EngineError> {
        Ok(self.schema_tools()?.schema_dir())
    }

    /// Validate one document against the head schema and stamp `_v`.
    ///
    /// # Errors
    ///
    /// Returns an error when no schema root is configured, the validator is
    /// unavailable, or the document does not match its schema.
    pub fn schema_validate(
        &self,
        collection: &str,
        document: &Map<String, Value>,
    ) -> Result<Map<String, Value>, EngineError> {
        Ok(self
            .schema_tools()?
            .validate_against_head(collection, document)
            .map_err(EngineError::schema)?
            .unwrap_or_else(|| document.clone()))
    }

    fn schema_tools(&self) -> Result<&SchemaTools, EngineError> {
        self.schema.as_deref().ok_or_else(|| {
            EngineError::new(
                EngineErrorCode::Schema,
                "schema operations require FYLO_SCHEMA and both encryption credentials",
            )
        })
    }

    fn encode(&self, collection: &str, fields: Map<String, Value>) -> Result<Vec<u8>, EngineError> {
        let fields = if let Some(encryption) = self.encryption.as_ref() {
            // Validate before encrypting: CHEX must see the plaintext the
            // schema describes, and the `_v` stamp it returns must survive.
            //
            // The JavaScript engine validates and stamps `_v` only under
            // `FYLO_STRICT`, so an unconditional native stamp would make the
            // same put produce different bytes in the two engines.
            let fields = match self.schema.as_ref() {
                // An empty `FYLO_STRICT` is falsy in JavaScript, so it must
                // not enable validation here either.
                Some(schema)
                    if std::env::var("FYLO_STRICT").is_ok_and(|value| !value.is_empty()) =>
                {
                    schema
                        .validate_against_head(collection, &fields)
                        .map_err(EngineError::schema)?
                        .unwrap_or(fields)
                }
                _ => fields,
            };
            encryption
                .encode_document(collection, fields)
                .map_err(EngineError::encryption)?
        } else {
            reject_undeclared_ciphertext(collection, &fields).map_err(EngineError::encryption)?;
            fields
        };
        Document::try_from_value(Value::Object(fields), DocumentLimits::default())
            .and_then(|document| document.encode())
            .map_err(EngineError::format)
    }
}

fn write_actor(actor: &AccessContext) -> WriteActor {
    WriteActor::new(actor.uid, actor.groups.iter().copied())
}

/// Trusted actor identity supplied by a client or application boundary.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AccessContext {
    uid: u32,
    groups: BTreeSet<u32>,
}

impl AccessContext {
    /// Construct an actor from a UID and trusted supplementary GIDs.
    #[must_use]
    pub fn new(uid: u32, groups: impl IntoIterator<Item = u32>) -> Self {
        Self {
            uid,
            groups: groups.into_iter().collect(),
        }
    }

    /// Trusted actor UID.
    #[must_use]
    pub const fn uid(&self) -> u32 {
        self.uid
    }

    /// Trusted supplementary group IDs.
    #[must_use]
    pub const fn groups(&self) -> &BTreeSet<u32> {
        &self.groups
    }
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

    /// Verify the active head's reachable commit, tree, and blob integrity.
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
        self.get_with_access(collection, identifier, None)
    }

    /// Read one document as a trusted actor.
    ///
    /// # Errors
    ///
    /// Returns `EACCES` when the document's portable descriptor denies reads.
    pub fn get_as(
        &self,
        collection: &str,
        identifier: &str,
        actor: &AccessContext,
    ) -> Result<ReadDocument, EngineError> {
        self.get_with_access(collection, identifier, Some(actor))
    }

    fn get_with_access(
        &self,
        collection: &str,
        identifier: &str,
        actor: Option<&AccessContext>,
    ) -> Result<ReadDocument, EngineError> {
        let collection = self
            .root
            .collection(collection)
            .map_err(EngineError::storage)?;
        Self::read_stable(&collection, || {
            let stored = collection
                .read_document(identifier)
                .map_err(EngineError::storage)?;
            require_read_access(stored.access, actor)?;
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

    /// Canonical plus developer metadata for one live record.
    ///
    /// System fields win over colliding developer keys, so a caller always
    /// receives canonical identifiers and timestamps.
    ///
    /// # Errors
    ///
    /// Returns an error for a missing record, corrupt metadata, an unsafe
    /// path, or denied access.
    pub fn metadata(&self, collection: &str, identifier: &str) -> Result<Value, EngineError> {
        let handle = self
            .root
            .collection(collection)
            .map_err(EngineError::storage)?;
        let custom: Map<String, Value> = handle
            .read_custom_metadata(identifier)
            .map_err(EngineError::storage)?
            .into_iter()
            .collect();
        if handle.kind() == CollectionKind::File {
            let file = self.get_file(collection, identifier)?;
            let mut merged = file.metadata.merge_with_custom(&custom);
            let descriptor = serde_json::to_value(&file.file).map_err(|error| {
                EngineError::new(EngineErrorCode::CorruptData, error.to_string())
            })?;
            if let Some(fields) = descriptor.as_object() {
                for (name, value) in fields {
                    merged.entry(name.clone()).or_insert_with(|| value.clone());
                }
            }
            return Ok(Value::Object(merged));
        }
        let record = self.get(collection, identifier)?;
        Ok(Value::Object(record.metadata.merge_with_custom(&custom)))
    }

    /// Read one unwrapped raw file with canonical, custom, and native metadata.
    ///
    /// # Errors
    ///
    /// Returns a stable error for unsafe storage, missing/corrupt xattrs,
    /// invalid identifiers, oversized files, or concurrent write generations.
    pub fn get_file(&self, collection: &str, identifier: &str) -> Result<ReadFile, EngineError> {
        self.get_file_with_access(collection, identifier, None)
    }

    /// Read one raw file as a trusted actor.
    ///
    /// # Errors
    ///
    /// Returns `EACCES` when the file's portable descriptor denies reads.
    pub fn get_file_as(
        &self,
        collection: &str,
        identifier: &str,
        actor: &AccessContext,
    ) -> Result<ReadFile, EngineError> {
        self.get_file_with_access(collection, identifier, Some(actor))
    }

    fn get_file_with_access(
        &self,
        collection: &str,
        identifier: &str,
        actor: Option<&AccessContext>,
    ) -> Result<ReadFile, EngineError> {
        let collection = self
            .root
            .collection(collection)
            .map_err(EngineError::storage)?;
        Self::read_stable(&collection, || {
            let stored = collection
                .read_raw_file(identifier)
                .map_err(EngineError::storage)?;
            require_read_access(stored.access_descriptor, actor)?;
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
        self.get_deleted_with_access(collection, identifier, None)
    }

    /// Read one retained deleted document as a trusted actor.
    ///
    /// # Errors
    ///
    /// Returns `EACCES` when the retained descriptor denies reads.
    pub fn get_deleted_as(
        &self,
        collection: &str,
        identifier: &str,
        actor: &AccessContext,
    ) -> Result<ReadDeletedDocument, EngineError> {
        self.get_deleted_with_access(collection, identifier, Some(actor))
    }

    fn get_deleted_with_access(
        &self,
        collection: &str,
        identifier: &str,
        actor: Option<&AccessContext>,
    ) -> Result<ReadDeletedDocument, EngineError> {
        let collection = self
            .root
            .collection(collection)
            .map_err(EngineError::storage)?;
        Self::read_stable(&collection, || {
            let stored = collection
                .read_deleted_document(identifier)
                .map_err(EngineError::storage)?;
            require_read_access(stored.access, actor)?;
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
        self.get_deleted_file_with_access(collection, identifier, None)
    }

    /// Read one retained deleted raw file as a trusted actor.
    ///
    /// # Errors
    ///
    /// Returns `EACCES` when the retained descriptor denies reads.
    pub fn get_deleted_file_as(
        &self,
        collection: &str,
        identifier: &str,
        actor: &AccessContext,
    ) -> Result<ReadDeletedFile, EngineError> {
        self.get_deleted_file_with_access(collection, identifier, Some(actor))
    }

    fn get_deleted_file_with_access(
        &self,
        collection: &str,
        identifier: &str,
        actor: Option<&AccessContext>,
    ) -> Result<ReadDeletedFile, EngineError> {
        let collection = self
            .root
            .collection(collection)
            .map_err(EngineError::storage)?;
        Self::read_stable(&collection, || {
            let stored = collection
                .read_deleted_raw_file(identifier)
                .map_err(EngineError::storage)?;
            require_read_access(stored.access_descriptor, actor)?;
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
            let mut verification = collection
                .verify_index_references()
                .map_err(EngineError::storage)?;
            let encrypted_fields = self
                .encryption
                .as_ref()
                .map(|encryption| encryption.encrypted_fields(collection.name()))
                .transpose()
                .map_err(EngineError::encryption)?
                .unwrap_or_default();
            let mut expected = BTreeSet::new();
            let identifiers = match collection.kind() {
                CollectionKind::Document => {
                    collection.document_ids().map_err(EngineError::storage)?
                }
                CollectionKind::File => collection.raw_file_ids().map_err(EngineError::storage)?,
            };
            for identifier in identifiers {
                let fields = match collection.kind() {
                    CollectionKind::Document => {
                        let stored = collection
                            .read_document(&identifier)
                            .map_err(EngineError::storage)?;
                        self.decode_document(
                            collection.name(),
                            Document::parse(&stored.bytes, DocumentLimits::default())
                                .map_err(EngineError::format)?,
                        )?
                        .into_fields()
                    }
                    CollectionKind::File => {
                        let stored = collection
                            .read_raw_file(&identifier)
                            .map_err(EngineError::storage)?;
                        raw_file_index_fields(&identifier, stored)?
                    }
                };
                expected.extend(
                    index_entries_for_document(&identifier, &fields, |field, value| {
                        if is_encrypted_field(field, &encrypted_fields) {
                            let encryption = self.encryption.as_ref().ok_or_else(|| {
                                "encrypted index field has no schema/key context".to_owned()
                            })?;
                            encryption
                                .blind_index(value)
                                .map(IndexLookupValue::encrypted)
                        } else {
                            Ok(IndexLookupValue::plain(value))
                        }
                    })
                    .map_err(EngineError::encryption)?,
                );
            }
            let snapshot = collection.index_snapshot().map_err(EngineError::storage)?;
            let actual: BTreeSet<String> = snapshot
                .as_bytes()
                .split(|byte| *byte == b'\n')
                .filter(|key| !key.is_empty())
                .map(|key| {
                    std::str::from_utf8(key)
                        .map(str::to_owned)
                        .map_err(|error| {
                            EngineError::new(
                                EngineErrorCode::Storage,
                                format!("prefix index key is not valid UTF-8: {error}"),
                            )
                        })
                })
                .collect::<Result<_, _>>()?;
            verification.expected_key_count = Some(expected.len());
            verification.missing_keys = Some(expected.difference(&actual).count());
            verification.extra_keys = Some(actual.difference(&expected).count());
            verification.rebuild_equivalent = actual == expected;
            // A count alone cannot be acted on: an operator, and a failing CI
            // job, need to see which keys drifted. The sample is bounded so a
            // wholesale mismatch cannot produce an unbounded report.
            verification.missing_key_sample = expected
                .difference(&actual)
                .take(MAX_DRIFT_SAMPLE)
                .cloned()
                .collect();
            verification.extra_key_sample = actual
                .difference(&expected)
                .take(MAX_DRIFT_SAMPLE)
                .cloned()
                .collect();
            Ok(verification)
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
        self.find_with_access(collection, query, None)
    }

    /// Join two document collections.
    ///
    /// A nested loop over both sides, matching the JavaScript engine: joins are
    /// answered from documents rather than from the prefix index, because the
    /// index records keys and a join compares values.
    ///
    /// # Errors
    ///
    /// Returns a stable error for unsafe/corrupt storage or an invalid join.
    pub fn join(
        &self,
        join: &JoinSpec,
        actor: Option<&AccessContext>,
    ) -> Result<JoinResult, EngineError> {
        let empty = StructuredQuery::from_value(&json!({}), QueryLimits::default())
            .map_err(EngineError::query)?;
        let left = self.find_with_access(join.left_collection(), &empty, actor)?;
        let right = self.find_with_access(join.right_collection(), &empty, actor)?;

        let mut rows: Vec<JoinedRow> = Vec::new();
        'outer: for left_row in &left {
            for right_row in &right {
                if !join.matches(left_row.document.fields(), right_row.document.fields()) {
                    continue;
                }
                // The pair identifier is the JavaScript key verbatim: two
                // identifiers separated by a comma and a space.
                rows.push((
                    format!("{}, {}", left_row.metadata.id, right_row.metadata.id),
                    join.project(left_row.document.fields(), right_row.document.fields()),
                ));
                if join.limit().is_some_and(|limit| rows.len() >= limit) {
                    break 'outer;
                }
            }
        }

        let Some(field) = join.group_by() else {
            if join.only_ids() {
                return Ok(JoinResult::Ids(
                    rows.into_iter().map(|(id, _)| id).collect(),
                ));
            }
            return Ok(JoinResult::Rows(
                rows.into_iter()
                    .map(|(id, row)| (id, Value::Object(row)))
                    .collect(),
            ));
        };
        let mut grouped: BTreeMap<String, Vec<JoinedRow>> = BTreeMap::new();
        for (id, row) in rows {
            // `String(data[field])` in JavaScript, so an absent field buckets
            // under "undefined" rather than being dropped.
            let key = match row.get(field) {
                None => "undefined".to_owned(),
                Some(Value::String(text)) => text.clone(),
                Some(value) => value.to_string(),
            };
            grouped.entry(key).or_default().push((id, row));
        }
        if join.only_ids() {
            return Ok(JoinResult::GroupedIds(
                grouped
                    .into_iter()
                    .map(|(key, rows)| (key, rows.into_iter().map(|(id, _)| id).collect()))
                    .collect(),
            ));
        }
        Ok(JoinResult::Grouped(
            grouped
                .into_iter()
                .map(|(key, rows)| {
                    (
                        key,
                        rows.into_iter()
                            .map(|(id, row)| (id, Value::Object(row)))
                            .collect(),
                    )
                })
                .collect(),
        ))
    }

    /// Execute a structured query as a trusted actor.
    ///
    /// Protected rows that deny reads are omitted, matching the JavaScript
    /// collection cursor.
    ///
    /// # Errors
    ///
    /// Returns a stable error for unsafe/corrupt storage or invalid queries.
    pub fn find_as(
        &self,
        collection: &str,
        query: &StructuredQuery,
        actor: &AccessContext,
    ) -> Result<Vec<ReadDocument>, EngineError> {
        self.find_with_access(collection, query, Some(actor))
    }

    fn find_with_access(
        &self,
        collection: &str,
        query: &StructuredQuery,
        actor: Option<&AccessContext>,
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
                if !read_access_allowed(stored.access, actor) {
                    continue;
                }
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

    /// Execute a structured query across retained tombstones.
    ///
    /// Ordering and predicate semantics match the live cursor; only the source
    /// namespace differs.
    ///
    /// # Errors
    ///
    /// Returns a stable error for unsafe/corrupt storage or invalid queries.
    pub fn find_deleted(
        &self,
        collection: &str,
        query: &StructuredQuery,
        actor: Option<&AccessContext>,
    ) -> Result<Vec<ReadDeletedDocument>, EngineError> {
        let collection = self
            .root
            .collection(collection)
            .map_err(EngineError::storage)?;
        Self::read_stable(&collection, || {
            let mut records = Vec::new();
            for identifier in collection
                .deleted_document_ids()
                .map_err(EngineError::storage)?
            {
                let stored = collection
                    .read_deleted_document(&identifier)
                    .map_err(EngineError::storage)?;
                if !read_access_allowed(stored.access, actor) {
                    continue;
                }
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
                records.push(ReadDeletedDocument {
                    id: identifier,
                    created_at: timestamps.created_at,
                    deleted_at: stored.modified_millis,
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
        self.select_sql_with_access(plan, None)
    }

    /// Execute a read-only SQL plan as a trusted actor.
    ///
    /// # Errors
    ///
    /// Returns a stable error for invalid plans, storage, or access failures.
    pub fn select_sql_as(
        &self,
        plan: &SqlPlan,
        actor: &AccessContext,
    ) -> Result<Value, EngineError> {
        self.select_sql_with_access(plan, Some(actor))
    }

    fn select_sql_with_access(
        &self,
        plan: &SqlPlan,
        actor: Option<&AccessContext>,
    ) -> Result<Value, EngineError> {
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
        let records = self.find_with_access(&plan.collection, &query, actor)?;
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

fn require_read_access(
    descriptor: Option<AccessDescriptor>,
    actor: Option<&AccessContext>,
) -> Result<(), EngineError> {
    if read_access_allowed(descriptor, actor) {
        Ok(())
    } else {
        Err(EngineError::new(
            EngineErrorCode::Access,
            "portable FYLO access descriptor denied the read",
        ))
    }
}

fn read_access_allowed(
    descriptor: Option<AccessDescriptor>,
    actor: Option<&AccessContext>,
) -> bool {
    let Some(descriptor) = descriptor else {
        return true;
    };
    let bits = match actor {
        Some(actor) if actor.uid == descriptor.uid => (descriptor.mode >> 6) & 0o7,
        Some(actor) if actor.groups.contains(&descriptor.gid) => (descriptor.mode >> 3) & 0o7,
        _ => descriptor.mode & 0o7,
    };
    bits & 0o4 != 0
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

fn raw_file_index_fields(
    identifier: &str,
    stored: StoredRawFile,
) -> Result<Map<String, Value>, EngineError> {
    let custom_metadata = stored.custom_metadata.clone();
    let last_modified = stored.modified_millis_exact;
    let manifest = build_read_file(identifier, stored)?.file;
    let Value::Object(mut fields) = serde_json::to_value(manifest).map_err(|error| {
        EngineError::new(
            EngineErrorCode::Storage,
            format!("cannot encode raw-file index manifest: {error}"),
        )
    })?
    else {
        unreachable!("RawFileManifest serializes as an object");
    };
    fields.insert("lastModified".into(), Value::from(last_modified));
    if !custom_metadata.is_empty() {
        fields.insert(
            "meta".into(),
            Value::Object(custom_metadata.into_iter().collect()),
        );
    }
    Ok(fields)
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

/// One joined pair: the `"<leftId>, <rightId>"` key and the projected row.
type JoinedRow = (String, Map<String, Value>);

/// One join's result, in the four shapes the JavaScript engine returns.
///
/// The shape is chosen by the join, not by the caller: `$groupby` buckets the
/// rows and `$onlyIds` drops the bodies, so the four combinations are distinct
/// result types rather than one type with empty fields.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(untagged)]
pub enum JoinResult {
    /// Joined rows keyed by `"<leftId>, <rightId>"`.
    Rows(Map<String, Value>),
    /// Joined pair identifiers only.
    Ids(Vec<String>),
    /// Rows bucketed by the `$groupby` field.
    Grouped(BTreeMap<String, Map<String, Value>>),
    /// Pair identifiers bucketed by the `$groupby` field.
    GroupedIds(BTreeMap<String, Vec<String>>),
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
    /// Portable UID/GID/mode policy denied the operation.
    Access,
    /// The native engine cannot honour a documented contract on this input.
    Unsupported,
    /// A document failed schema validation, or schema tooling failed.
    Schema,
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
            Self::Access => "EACCES",
            Self::Unsupported => "EENGINE_UNSUPPORTED",
            Self::Schema => "ESCHEMA",
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

    fn schema(message: String) -> Self {
        Self::new(EngineErrorCode::Schema, message)
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
