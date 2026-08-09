//! Crash-recoverable native writes for the existing FYLO filesystem layout.
//!
//! The journal and generation records intentionally use the JavaScript
//! engine's v1 schemas so either engine can recover an interrupted mutation.

use fylo_vfs::{self as fs, File, OpenOptions};
use std::collections::BTreeSet;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::UNIX_EPOCH;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use fylo_format::{Document, DocumentLimits, decode_ttid};
use fylo_query::{
    IndexLookupValue, QueryLimits, SqlOperation, StructuredQuery, index_entries_for_document,
    prepare_sql,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::{
    CollectionKind, ExpectedType, MAX_DOCUMENT_BYTES, NativeRoot, NativeStorageError,
    NativeStorageErrorCode, path_exists_no_follow, validate_ttid_shape,
};

const TRANSACTION_FORMAT: &str = "fylo.collection-transaction.v1";
const GENERATION_FORMAT: &str = "fylo.collection-generation.v1";
const MAX_TRANSACTION_BYTES: u64 = 16 * 1024 * 1024;
const MAX_CAPTURE_BYTES: u64 = 8 * 1024 * 1024;
const LOCK_TTL_MILLIS: u64 = 5 * 60 * 1000;
/// Floor for the index WAL before compaction is worth its rewrite. Above it
/// the snapshot's own size takes over, so a reader never merges more WAL than
/// snapshot.
const INDEX_WAL_COMPACT_BYTES: u64 = 64 * 1024;
#[cfg(unix)]
const DEFAULT_ACCESS_MODE: u32 = 0o600;

pub(crate) mod version;

static UNIQUE_SEQUENCE: AtomicU64 = AtomicU64::new(0);
static TTID_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// Optional UID/GID/mode projection supplied only while creating a record.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct WriteAccess {
    /// Preferred owner UID.
    pub uid: Option<u32>,
    /// Preferred group GID.
    pub gid: Option<u32>,
    /// POSIX-compatible permission mode.
    pub mode: Option<u32>,
}

impl WriteAccess {
    fn validate(self) -> Result<Self, NativeStorageError> {
        if self.mode.is_some_and(|mode| mode > 0o777) {
            return Err(NativeStorageError::new(
                NativeStorageErrorCode::CorruptMetadata,
                "write mode must be between 0o000 and 0o777",
            ));
        }
        Ok(self)
    }

    const fn is_empty(self) -> bool {
        self.uid.is_none() && self.gid.is_none() && self.mode.is_none()
    }
}

/// Options for a create-only native document put.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct PutDocumentOptions {
    /// Developer-defined typed metadata written in the create transaction.
    pub metadata: std::collections::BTreeMap<String, serde_json::Value>,
    /// Optional owner/group/mode projection.
    pub access: WriteAccess,
}

/// Options for a create-only native raw-file put.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PutRawFileOptions {
    /// Durable logical object key.
    pub key: String,
    /// Safe lowercase extension including the leading dot.
    pub extension: String,
    /// Developer-defined typed metadata.
    pub metadata: std::collections::BTreeMap<String, serde_json::Value>,
    /// Optional owner/group/mode projection.
    pub access: WriteAccess,
}

/// Trusted actor identity used to authorize a mutation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WriteActor {
    uid: u32,
    groups: BTreeSet<u32>,
}

impl WriteActor {
    /// Construct an actor from a developer-supplied UID and trusted group list.
    #[must_use]
    pub fn new(uid: u32, groups: impl IntoIterator<Item = u32>) -> Self {
        Self {
            uid,
            groups: groups.into_iter().collect(),
        }
    }
}

/// Observable result of one native SQL mutation.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlMutationResult {
    /// Executed mutation kind.
    pub kind: SqlMutationResultKind,
    /// Number of records written, updated, or deleted.
    pub affected: usize,
    /// Identifiers changed by the statement in deterministic order.
    pub identifiers: Vec<String>,
}

/// Supported SQL mutation result kinds.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum SqlMutationResultKind {
    /// `INSERT`.
    Insert,
    /// `UPDATE`.
    Update,
    /// `DELETE`.
    Delete,
}

/// Native mutation entry point.
#[derive(Clone, Debug)]
pub struct NativeWriteRoot {
    root: NativeRoot,
    config: super::RootConfig,
}

impl NativeWriteRoot {
    /// Open an existing canonical FYLO root for recoverable writes.
    ///
    /// # Errors
    ///
    /// Returns an error when the root cannot be opened safely.
    pub fn open(path: impl AsRef<Path>) -> Result<Self, NativeStorageError> {
        Ok(Self {
            root: NativeRoot::open(path)?,
            config: super::RootConfig::default(),
        })
    }

    /// Apply host-supplied runtime knobs to this writer.
    #[must_use]
    pub fn with_config(mut self, config: super::RootConfig) -> Self {
        self.config = config;
        self
    }

    /// Runtime knobs this writer was opened with.
    #[must_use]
    pub fn config(&self) -> super::RootConfig {
        self.config
    }

    /// Open a materialized worktree whose catalog and repository metadata live
    /// at another canonical root.
    ///
    /// # Errors
    ///
    /// Returns an error when either root cannot be opened safely.
    pub fn open_with_repository(
        path: impl AsRef<Path>,
        repository_root: impl AsRef<Path>,
    ) -> Result<Self, NativeStorageError> {
        Ok(Self {
            root: NativeRoot::open_with_repository(path, repository_root)?,
            config: super::RootConfig::default(),
        })
    }

    /// Canonical root identity.
    #[must_use]
    pub fn path(&self) -> &Path {
        self.root.path()
    }

    /// Canonical root that owns the catalog and version metadata.
    #[must_use]
    pub fn repository_root(&self) -> &Path {
        self.root.repository_root()
    }

    /// Recover one interrupted collection transaction.
    ///
    /// Active manifests roll back. Committed manifests roll forward. Both
    /// paths rebuild the derived prefix index before publishing a stable
    /// generation.
    ///
    /// # Errors
    ///
    /// Returns an error for a live writer, corrupt journal, unsafe path, or
    /// failed durable repair.
    pub fn recover_collection(&self, collection: &str) -> Result<bool, NativeStorageError> {
        let collection = self.root.collection(collection)?;
        let _lock = CollectionWriteLock::acquire(&collection.path)?;
        self.recover_locked(&collection)
    }

    /// Create one document at an explicitly supplied TTID.
    ///
    /// This slice is create-only. The caller supplies the identifier so the
    /// compatibility boundary does not silently invent a non-canonical TTID.
    ///
    /// # Errors
    ///
    /// Returns an error for an invalid document, duplicate identifier,
    /// permission projection failure, unsafe path, lock contention, or
    /// interrupted durable operation.
    pub fn put_document(
        &self,
        collection_name: &str,
        identifier: &str,
        encoded: &[u8],
        options: PutDocumentOptions,
    ) -> Result<(), NativeStorageError> {
        super::validate_canonical_ttid(identifier)?;
        let document = Document::parse(encoded, DocumentLimits::default()).map_err(|error| {
            NativeStorageError::new(
                NativeStorageErrorCode::CorruptDocument,
                format!("document is invalid: {error}"),
            )
        })?;
        let canonical = document.encode().map_err(|error| {
            NativeStorageError::new(
                NativeStorageErrorCode::CorruptDocument,
                format!("document cannot be encoded: {error}"),
            )
        })?;
        if canonical.len() as u64 > MAX_DOCUMENT_BYTES {
            return Err(NativeStorageError::new(
                NativeStorageErrorCode::FileTooLarge,
                "document exceeds the native write limit",
            ));
        }
        let PutDocumentOptions { metadata, access } = options;
        validate_custom_metadata(&metadata)?;
        let access = access.validate()?;
        let collection = self.writable_collection(collection_name)?;
        if collection.kind != CollectionKind::Document {
            return Err(NativeStorageError::new(
                NativeStorageErrorCode::WrongType,
                "put_document requires a document collection",
            ));
        }
        let _lock = CollectionWriteLock::acquire(&collection.path)?;
        self.recover_locked(&collection)?;
        let target = collection
            .path
            .join("docs")
            .join(crate::shard_of(identifier, collection.shard_width()))
            .join(format!("{identifier}.json"));
        if path_exists_no_follow(&target)? {
            return Err(NativeStorageError::new(
                NativeStorageErrorCode::CorruptMetadata,
                "document identifier already exists",
            ));
        }
        let mut transaction = Transaction::begin(self, &collection, "put-document")?;
        let outcome = (|| {
            transaction.capture(&target)?;
            let parent = target.parent().ok_or_else(|| {
                NativeStorageError::new(
                    NativeStorageErrorCode::UnsafePath,
                    "document target has no parent",
                )
            })?;
            ensure_directory(&self.root, parent)?;
            durable_replace(&target, &canonical)?;
            for (name, value) in &metadata {
                if value.is_null() {
                    continue;
                }
                let encoded = serde_json::to_vec(value).map_err(|error| json_error(&error))?;
                write_fylo_attribute(
                    &target,
                    &format!("{}{name}", super::META_XATTR_PREFIX),
                    &encoded,
                )?;
            }
            apply_access(&target, access)?;
            capture_index(&mut transaction, &collection)?;
            // The identifier is proven absent above, so nothing to remove.
            self.apply_index_delta(
                &collection,
                &BTreeSet::new(),
                &record_index_keys(&collection, identifier)?,
            )?;
            transaction.commit()
        })();
        if let Err(error) = outcome {
            if let Err(rollback) = transaction.rollback() {
                return Err(NativeStorageError::new(
                    NativeStorageErrorCode::Io,
                    format!("write failed ({error}) and rollback failed ({rollback})"),
                ));
            }
            return Err(error);
        }
        Ok(())
    }

    /// Create one raw file at an explicitly supplied TTID.
    ///
    /// # Errors
    ///
    /// Returns an error for invalid identifiers, extension/key/metadata
    /// bounds, duplicate records, unsafe paths, lock contention, permission
    /// projection failure, or interrupted durable operation.
    pub fn put_raw_file(
        &self,
        collection_name: &str,
        identifier: &str,
        bytes: &[u8],
        options: &PutRawFileOptions,
    ) -> Result<(), NativeStorageError> {
        super::validate_canonical_ttid(identifier)?;
        if bytes.len() as u64 > super::MAX_RAW_FILE_BYTES {
            return Err(NativeStorageError::new(
                NativeStorageErrorCode::FileTooLarge,
                "raw file exceeds the native write limit",
            ));
        }
        super::validate_raw_extension(&format!("{identifier}{}", options.extension), identifier)?;
        super::validate_raw_key(&options.key)?;
        validate_custom_metadata(&options.metadata)?;
        let access = options.access.validate()?;
        let collection = self.writable_collection(collection_name)?;
        if collection.kind != CollectionKind::File {
            return Err(NativeStorageError::new(
                NativeStorageErrorCode::WrongType,
                "put_raw_file requires a file collection",
            ));
        }
        let _lock = CollectionWriteLock::acquire(&collection.path)?;
        self.recover_locked(&collection)?;
        if collection.raw_file_ids()?.iter().any(|id| id == identifier) {
            return Err(NativeStorageError::new(
                NativeStorageErrorCode::CorruptMetadata,
                "raw-file identifier already exists",
            ));
        }
        let target = collection
            .path
            .join("docs")
            .join(crate::shard_of(identifier, collection.shard_width()))
            .join(format!("{identifier}{}", options.extension));
        let mut transaction = Transaction::begin(self, &collection, "put-file")?;
        let outcome = (|| {
            transaction.capture(&target)?;
            let parent = target.parent().ok_or_else(|| {
                NativeStorageError::new(
                    NativeStorageErrorCode::UnsafePath,
                    "raw-file target has no parent",
                )
            })?;
            ensure_directory(&self.root, parent)?;
            durable_replace(&target, bytes)?;
            write_fylo_attribute(&target, super::KEY_XATTR, options.key.as_bytes())?;
            for (name, value) in &options.metadata {
                if value.is_null() {
                    continue;
                }
                let encoded = serde_json::to_vec(value).map_err(|error| json_error(&error))?;
                write_fylo_attribute(
                    &target,
                    &format!("{}{name}", super::META_XATTR_PREFIX),
                    &encoded,
                )?;
            }
            // Every attribute write must land before the checksum stamp is
            // computed. On Windows an alternate-data-stream write updates the
            // file's last-write time, so a stamp taken earlier would record an
            // mtime the next reader cannot match, permanently invalidating the
            // checksum cache and making index rebuilds non-deterministic. POSIX
            // xattr writes leave mtime alone, so the order is harmless there.
            apply_access(&target, access)?;
            let metadata = fs::metadata(&target).map_err(NativeStorageError::io)?;
            let checksum = super::sha256_hex(bytes);
            let stamp = format!(
                "{checksum}:{}:{}",
                metadata.len(),
                super::modified_millis(&metadata)?
            );
            write_fylo_attribute(&target, super::CHECKSUM_XATTR, stamp.as_bytes())?;
            // Writing the stamp is itself a stream write on Windows, so it
            // invalidates the mtime it just recorded. Restoring the recorded
            // time makes the stamp self-consistent; on POSIX the attribute
            // write never moved mtime, so this changes nothing.
            restore_modified(&target, &metadata)?;
            capture_index(&mut transaction, &collection)?;
            // The identifier is proven absent above, so nothing to remove.
            self.apply_index_delta(
                &collection,
                &BTreeSet::new(),
                &record_index_keys(&collection, identifier)?,
            )?;
            transaction.commit()
        })();
        if let Err(error) = outcome {
            if let Err(rollback) = transaction.rollback() {
                return Err(NativeStorageError::new(
                    NativeStorageErrorCode::Io,
                    format!("raw-file write failed ({error}) and rollback failed ({rollback})"),
                ));
            }
            return Err(error);
        }
        Ok(())
    }

    /// Replace one existing document body while preserving its TTID and access
    /// metadata.
    ///
    /// # Errors
    ///
    /// Returns an error for a missing or malformed document, denied write,
    /// unsafe path, lock contention, or interrupted durable operation.
    pub fn patch_document(
        &self,
        collection_name: &str,
        identifier: &str,
        encoded: &[u8],
        actor: Option<&WriteActor>,
    ) -> Result<(), NativeStorageError> {
        validate_ttid_shape(identifier)?;
        let document = Document::parse(encoded, DocumentLimits::default()).map_err(|error| {
            NativeStorageError::new(
                NativeStorageErrorCode::CorruptDocument,
                format!("document is invalid: {error}"),
            )
        })?;
        let canonical = document.encode().map_err(|error| {
            NativeStorageError::new(
                NativeStorageErrorCode::CorruptDocument,
                format!("document cannot be encoded: {error}"),
            )
        })?;
        let collection = self.writable_collection(collection_name)?;
        if collection.kind != CollectionKind::Document {
            return Err(NativeStorageError::new(
                NativeStorageErrorCode::WrongType,
                "patch_document requires a document collection",
            ));
        }
        let _lock = CollectionWriteLock::acquire(&collection.path)?;
        self.recover_locked(&collection)?;
        let stored = collection.read_document(identifier)?;
        require_write_access(stored.access, actor)?;
        let target = stored.path;
        let before = record_index_keys(&collection, identifier)?;
        let mut transaction = Transaction::begin(self, &collection, "patch-document")?;
        let outcome = (|| {
            transaction.capture(&target)?;
            capture_index(&mut transaction, &collection)?;
            overwrite_in_place(&target, &canonical)?;
            self.apply_index_delta(
                &collection,
                &before,
                &record_index_keys(&collection, identifier)?,
            )?;
            transaction.commit()
        })();
        if let Err(error) = outcome {
            if let Err(rollback) = transaction.rollback() {
                return Err(NativeStorageError::new(
                    NativeStorageErrorCode::Io,
                    format!("patch failed ({error}) and rollback failed ({rollback})"),
                ));
            }
            return Err(error);
        }
        Ok(())
    }

    /// Shallow-merge fields into one existing document.
    ///
    /// This matches the JavaScript `patch(id, changes)` contract: top-level
    /// keys in `changes` replace top-level keys in the stored document.
    ///
    /// # Errors
    ///
    /// Returns an error for a non-object patch, malformed resulting document,
    /// denied write, unsafe path, lock contention, or interrupted durable
    /// operation.
    pub fn patch_document_fields(
        &self,
        collection_name: &str,
        identifier: &str,
        changes: &Map<String, Value>,
        actor: Option<&WriteActor>,
    ) -> Result<(), NativeStorageError> {
        validate_ttid_shape(identifier)?;
        let collection = self.document_collection(collection_name, "patch_document_fields")?;
        let _lock = CollectionWriteLock::acquire(&collection.path)?;
        self.recover_locked(&collection)?;
        let stored = collection.read_document(identifier)?;
        require_write_access(stored.access, actor)?;
        let mut document = parse_document_fields(&stored.bytes)?;
        merge_top_level(&mut document, changes);
        let canonical = encode_document_fields(document)?;
        self.patch_document_locked(&collection, identifier, &stored.path, &canonical)
    }

    /// Execute a bounded `INSERT`, `UPDATE`, or `DELETE` SQL statement.
    ///
    /// `insert_access` is used only by `INSERT`. `actor` is used only to
    /// authorize `UPDATE` and `DELETE`. An `INSERT` receives a monotonic TTID
    /// generated by this process and retries if that identifier already
    /// exists.
    ///
    /// # Errors
    ///
    /// Returns an error for malformed SQL, non-mutation operations, denied
    /// records, invalid resulting documents, unsafe paths, lock contention,
    /// or interrupted durable operation.
    pub fn execute_sql_mutation(
        &self,
        sql: &str,
        actor: Option<&WriteActor>,
        insert_access: WriteAccess,
    ) -> Result<SqlMutationResult, NativeStorageError> {
        let plan = prepare_sql(sql, QueryLimits::default()).map_err(|error| query_error(&error))?;
        if plan.explain && !plan.analyze {
            return Err(NativeStorageError::new(
                NativeStorageErrorCode::InvalidQuery,
                "EXPLAIN without ANALYZE does not execute a SQL mutation",
            ));
        }
        match plan.operation {
            SqlOperation::Insert => self.execute_sql_insert(&plan, insert_access),
            SqlOperation::Update => self.execute_sql_update(&plan, actor),
            SqlOperation::Delete => self.execute_sql_delete(&plan, actor),
            _ => Err(NativeStorageError::new(
                NativeStorageErrorCode::InvalidQuery,
                "native SQL mutation accepts only INSERT, UPDATE, or DELETE",
            )),
        }
    }

    /// Merge developer metadata into one existing document or raw file.
    ///
    /// A JSON `null` removes that name, matching the JavaScript
    /// `metadata(record)` mutation contract. Canonical FYLO attributes are not
    /// writable through this path, and `user.fylo.meta-updated-at` advances
    /// strictly so two updates inside one millisecond stay ordered.
    ///
    /// # Errors
    ///
    /// Returns an error for an invalid identifier, invalid metadata name or
    /// value, missing record, denied write, unsafe path, lock contention, or
    /// interrupted durable operation.
    pub fn set_record_metadata(
        &self,
        collection_name: &str,
        identifier: &str,
        record: &Map<String, Value>,
        actor: Option<&WriteActor>,
    ) -> Result<(), NativeStorageError> {
        self.write_record_metadata(collection_name, identifier, record, actor, false)
    }

    /// Replace a record's developer metadata with `record` exactly.
    ///
    /// This is the `replaceDocMetadata` contract: a name the record omits is
    /// removed rather than left behind, so the caller does not have to know
    /// what is currently stored in order to state what should be.
    ///
    /// # Errors
    ///
    /// As [`Self::set_record_metadata`].
    pub fn replace_record_metadata(
        &self,
        collection_name: &str,
        identifier: &str,
        record: &Map<String, Value>,
        actor: Option<&WriteActor>,
    ) -> Result<(), NativeStorageError> {
        self.write_record_metadata(collection_name, identifier, record, actor, true)
    }

    fn write_record_metadata(
        &self,
        collection_name: &str,
        identifier: &str,
        record: &Map<String, Value>,
        actor: Option<&WriteActor>,
        replace: bool,
    ) -> Result<(), NativeStorageError> {
        validate_ttid_shape(identifier)?;
        validate_custom_metadata(&record.clone().into_iter().collect())?;
        let collection = self.writable_collection(collection_name)?;
        let _lock = CollectionWriteLock::acquire(&collection.path)?;
        self.recover_locked(&collection)?;
        let (target, access) = record_target(&collection, identifier)?;
        require_write_access(access, actor)?;
        let mut record = record.clone();
        if replace {
            for name in collection.read_custom_metadata(identifier)?.keys() {
                record.entry(name.clone()).or_insert(Value::Null);
            }
        }
        let record = &record;
        let updated_at = next_meta_updated_at(&target)?;
        // A document's index keys come from its fields alone, so this is a
        // no-op delta there; a raw file indexes `meta` and `lastModified`.
        let before = record_index_keys(&collection, identifier)?;
        let mut transaction = Transaction::begin(self, &collection, "set-metadata")?;
        let outcome = (|| {
            transaction.capture(&target)?;
            capture_index(&mut transaction, &collection)?;
            for (name, value) in record {
                let attribute = format!("{}{name}", super::META_XATTR_PREFIX);
                if value.is_null() {
                    remove_fylo_attribute(&target, &attribute)?;
                } else {
                    let encoded = serde_json::to_vec(value).map_err(|error| json_error(&error))?;
                    write_fylo_attribute(&target, &attribute, &encoded)?;
                }
            }
            write_fylo_attribute(
                &target,
                super::META_UPDATED_XATTR,
                updated_at.to_string().as_bytes(),
            )?;
            self.apply_index_delta(
                &collection,
                &before,
                &record_index_keys(&collection, identifier)?,
            )?;
            transaction.commit()
        })();
        finish_transaction(transaction, outcome, "metadata")
    }

    /// Project UID, GID, and mode onto one existing document or raw file.
    ///
    /// # Errors
    ///
    /// Returns an error for an invalid identifier, an empty projection, a
    /// missing record, a denied write, an unsafe path, lock contention, a
    /// non-POSIX platform, or an interrupted durable operation.
    pub fn set_record_access(
        &self,
        collection_name: &str,
        identifier: &str,
        access: WriteAccess,
        actor: Option<&WriteActor>,
    ) -> Result<(), NativeStorageError> {
        validate_ttid_shape(identifier)?;
        if access.is_empty() {
            return Err(NativeStorageError::new(
                NativeStorageErrorCode::Unsupported,
                "set_record_access requires at least one of uid, gid, or mode",
            ));
        }
        let collection = self.writable_collection(collection_name)?;
        let _lock = CollectionWriteLock::acquire(&collection.path)?;
        self.recover_locked(&collection)?;
        let (target, descriptor) = record_target(&collection, identifier)?;
        require_write_access(descriptor, actor)?;
        let mut transaction = Transaction::begin(self, &collection, "set-access")?;
        let outcome = (|| {
            transaction.capture(&target)?;
            apply_access(&target, access)?;
            transaction.commit()
        })();
        finish_transaction(transaction, outcome, "access")
    }

    /// Soft-delete one existing document or raw file into the retained
    /// tombstone tree.
    ///
    /// # Errors
    ///
    /// Returns an error for a missing document, denied write, conflicting
    /// tombstone, unsafe path, lock contention, or interrupted durable move.
    pub fn delete_document(
        &self,
        collection_name: &str,
        identifier: &str,
        actor: Option<&WriteActor>,
    ) -> Result<(), NativeStorageError> {
        validate_ttid_shape(identifier)?;
        let collection = self.writable_collection(collection_name)?;
        let _lock = CollectionWriteLock::acquire(&collection.path)?;
        self.recover_locked(&collection)?;
        let (source, access) = record_target(&collection, identifier)?;
        require_write_access(access, actor)?;
        let filename = source.file_name().ok_or_else(|| {
            NativeStorageError::new(NativeStorageErrorCode::UnsafePath, "record has no filename")
        })?;
        let target = collection
            .path
            .join(".deleted")
            .join(crate::shard_of(identifier, collection.shard_width()))
            .join(filename);
        if path_exists_no_follow(&target)? {
            return Err(NativeStorageError::new(
                NativeStorageErrorCode::CorruptMetadata,
                "retained document tombstone already exists",
            ));
        }
        let before = record_index_keys(&collection, identifier)?;
        let mut transaction = Transaction::begin(self, &collection, "delete-document")?;
        let outcome = (|| {
            transaction.capture(&source)?;
            transaction.capture(&target)?;
            capture_index(&mut transaction, &collection)?;
            let parent = target.parent().ok_or_else(|| {
                NativeStorageError::new(
                    NativeStorageErrorCode::UnsafePath,
                    "tombstone target has no parent",
                )
            })?;
            ensure_directory(&self.root, parent)?;
            fs::rename(&source, &target).map_err(NativeStorageError::io)?;
            sync_parent(&source)?;
            sync_parent(&target)?;
            failpoint("after-delete-rename")?;
            // The record now lives under `.deleted`, which is not indexed.
            self.apply_index_delta(&collection, &before, &BTreeSet::new())?;
            transaction.commit()
        })();
        if let Err(error) = outcome {
            if let Err(rollback) = transaction.rollback() {
                return Err(NativeStorageError::new(
                    NativeStorageErrorCode::Io,
                    format!("delete failed ({error}) and rollback failed ({rollback})"),
                ));
            }
            return Err(error);
        }
        Ok(())
    }

    /// Restore one retained document or raw-file tombstone into the live tree.
    ///
    /// The record keeps its TTID and its portable access descriptor, matching
    /// the JavaScript `restore(id)` contract.
    ///
    /// # Errors
    ///
    /// Returns an error when the identifier is invalid, a live record already
    /// occupies it, no tombstone exists, the actor is denied, the path is
    /// unsafe, the lock is held, or a durable operation is interrupted.
    pub fn restore_document(
        &self,
        collection_name: &str,
        identifier: &str,
        actor: Option<&WriteActor>,
    ) -> Result<(), NativeStorageError> {
        validate_ttid_shape(identifier)?;
        let collection = self.writable_collection(collection_name)?;
        let _lock = CollectionWriteLock::acquire(&collection.path)?;
        self.recover_locked(&collection)?;
        match record_target(&collection, identifier) {
            Ok(_) => {
                return Err(NativeStorageError::new(
                    NativeStorageErrorCode::CorruptMetadata,
                    "cannot restore a record that already exists",
                ));
            }
            Err(error) if error.code() == NativeStorageErrorCode::NotFound => {}
            Err(error) => return Err(error),
        }
        let (source, access) = match collection.kind {
            CollectionKind::Document => {
                let deleted = collection.read_deleted_document(identifier)?;
                (deleted.path, deleted.access)
            }
            CollectionKind::File => {
                let deleted = collection.read_deleted_raw_file(identifier)?;
                (deleted.path, deleted.access_descriptor)
            }
        };
        require_write_access(access, actor)?;
        let filename = source.file_name().ok_or_else(|| {
            NativeStorageError::new(
                NativeStorageErrorCode::UnsafePath,
                "retained record has no filename",
            )
        })?;
        let target = collection
            .path
            .join("docs")
            .join(crate::shard_of(identifier, collection.shard_width()))
            .join(filename);
        let mut transaction = Transaction::begin(self, &collection, "restore-document")?;
        let outcome = (|| {
            transaction.capture(&source)?;
            transaction.capture(&target)?;
            capture_index(&mut transaction, &collection)?;
            let parent = target.parent().ok_or_else(|| {
                NativeStorageError::new(
                    NativeStorageErrorCode::UnsafePath,
                    "restore target has no parent",
                )
            })?;
            ensure_directory(&self.root, parent)?;
            fs::rename(&source, &target).map_err(NativeStorageError::io)?;
            sync_parent(&source)?;
            sync_parent(&target)?;
            failpoint("after-restore-rename")?;
            // A live record at this identifier is refused above, so the
            // tombstone's keys are additions.
            self.apply_index_delta(
                &collection,
                &BTreeSet::new(),
                &record_index_keys(&collection, identifier)?,
            )?;
            transaction.commit()
        })();
        finish_transaction(transaction, outcome, "restore")
    }

    /// Move every record in a collection to a new shard width.
    ///
    /// The descriptor records the destination and the width being left before
    /// a single record moves, so an interrupted run leaves every record
    /// findable under one candidate or another and re-running finishes what
    /// remains. Documents are the source of truth, so this renames files and
    /// rebuilds the derived index without rewriting a record.
    ///
    /// # Errors
    ///
    /// Returns an error for an unsupported width, a missing collection, an
    /// unsafe path, lock contention, or an interrupted durable operation.
    pub fn reshard_collection(
        &self,
        collection_name: &str,
        width: u32,
    ) -> Result<usize, NativeStorageError> {
        if !(crate::MIN_SHARD_WIDTH..=crate::MAX_SHARD_WIDTH).contains(&width) {
            return Err(NativeStorageError::new(
                NativeStorageErrorCode::Unsupported,
                format!(
                    "shard width must be {} to {}: {width}",
                    crate::MIN_SHARD_WIDTH,
                    crate::MAX_SHARD_WIDTH
                ),
            ));
        }
        let collection = self.root.collection(collection_name)?;
        let recorded = collection.shard_width();
        let previous = collection.previous_shard_widths().to_vec();
        if recorded == width && previous.is_empty() {
            return Ok(0);
        }
        let _lock = CollectionWriteLock::acquire(&collection.path)?;
        self.recover_locked(&collection)?;
        let mut leaving: Vec<u32> = previous;
        if recorded != width && !leaving.contains(&recorded) {
            leaving.push(recorded);
        }
        leaving.retain(|value| *value != width);
        self.write_shard_width(collection_name, width, &leaving)?;
        let collection = self.root.collection(collection_name)?;

        let mut moved = 0;
        let mut transaction = Transaction::begin(self, &collection, "reshard")?;
        let outcome = (|| {
            for namespace in ["docs", ".deleted"] {
                let root = collection.path.join(namespace);
                for (source, target) in reshard_moves(&root, width, &leaving)? {
                    transaction.capture(&source)?;
                    transaction.capture(&target)?;
                    let parent = target.parent().ok_or_else(|| {
                        NativeStorageError::new(
                            NativeStorageErrorCode::UnsafePath,
                            "reshard target has no parent",
                        )
                    })?;
                    ensure_directory(&self.root, parent)?;
                    fs::rename(&source, &target).map_err(NativeStorageError::io)?;
                    sync_parent(&source)?;
                    sync_parent(&target)?;
                    failpoint("after-reshard-rename")?;
                    moved += 1;
                }
                remove_emptied_shards(&root)?;
            }
            capture_index(&mut transaction, &collection)?;
            self.rebuild_index(&collection)?;
            transaction.commit()
        })();
        finish_transaction(transaction, outcome, "reshard")?;
        self.write_shard_width(collection_name, width, &[])?;
        Ok(moved)
    }

    fn write_shard_width(
        &self,
        collection: &str,
        width: u32,
        leaving: &[u32],
    ) -> Result<(), NativeStorageError> {
        let path = self
            .root
            .catalog_root()
            .join(".fylo-catalog")
            .join("collections")
            .join(format!("{collection}.json"));
        let mut descriptor: Map<String, Value> =
            read_bounded_json(&path, super::MAX_DESCRIPTOR_BYTES)?;
        descriptor.insert("shardWidth".into(), Value::from(width));
        // A completed reshard must leave no width behind, or every later
        // lookup would keep probing a directory that can no longer hold
        // anything.
        descriptor.remove("previousShardWidths");
        if !leaving.is_empty() {
            descriptor.insert(
                "previousShardWidths".into(),
                Value::Array(leaving.iter().map(|width| Value::from(*width)).collect()),
            );
        }
        let mut encoded = serde_json::to_vec(&descriptor).map_err(|error| json_error(&error))?;
        encoded.push(b'\n');
        durable_replace(&path, &encoded)
    }

    /// Rebuild one collection's derived index from its documents.
    ///
    /// Documents are the source of truth, so this is always safe to repeat.
    ///
    /// # Errors
    ///
    /// Returns an error for a missing collection, an unsafe path, lock
    /// contention, or an interrupted durable write.
    pub fn rebuild_collection(&self, collection_name: &str) -> Result<(), NativeStorageError> {
        let collection = self.root.collection(collection_name)?;
        let _lock = CollectionWriteLock::acquire(&collection.path)?;
        self.recover_locked(&collection)?;
        let mut transaction = Transaction::begin(self, &collection, "rebuild-index")?;
        let outcome = (|| {
            capture_index(&mut transaction, &collection)?;
            self.rebuild_index(&collection)?;
            transaction.commit()
        })();
        finish_transaction(transaction, outcome, "index rebuild")
    }

    /// Re-hash every active and deleted raw file without trusting its checksum
    /// cache, matching the published `verifyCollection` machine operation.
    /// Missing stamps are refreshed best-effort; mismatched stamps are retained
    /// as evidence of the expected bytes.
    ///
    /// # Errors
    ///
    /// Returns an error for a non-file collection, unsafe paths, malformed
    /// metadata, oversized files, or I/O failures other than a file that
    /// vanished during the scan.
    pub fn verify_file_collection(
        &self,
        collection_name: &str,
    ) -> Result<Value, NativeStorageError> {
        let collection = self.root.collection(collection_name)?;
        if collection.kind != CollectionKind::File {
            return Err(NativeStorageError::new(
                NativeStorageErrorCode::WrongType,
                "verifyCollection requires a file collection",
            ));
        }
        let namespaces = [
            (
                "active",
                collection.path.join("docs"),
                collection.raw_file_ids()?,
            ),
            (
                "deleted",
                collection.path.join(".deleted"),
                collection.deleted_raw_file_ids()?,
            ),
        ];
        let mut files_scanned = 0_usize;
        let mut verified = 0_usize;
        let mut stamped = 0_usize;
        let mut corrupt = Vec::new();
        for (namespace, root, identifiers) in namespaces {
            for identifier in identifiers {
                let check = match verify_raw_file_checksum(&collection, &root, &identifier) {
                    Ok(check) => check,
                    Err(error) if error.code() == NativeStorageErrorCode::NotFound => continue,
                    Err(error) => return Err(error),
                };
                files_scanned += 1;
                match check.expected {
                    Some(expected) if expected != check.actual => corrupt.push(serde_json::json!({
                        "id": identifier,
                        "namespace": namespace,
                        "expected": expected,
                        "actual": check.actual,
                    })),
                    Some(_) => verified += 1,
                    None => {
                        // The checksum is a rebuildable cache. A read-only file
                        // can still be verified even when the cache cannot be
                        // refreshed, exactly like the JavaScript engine.
                        let _ = stamp_raw_file_checksum(&check.path, &check.actual);
                        stamped += 1;
                    }
                }
            }
        }
        Ok(serde_json::json!({
            "collection": collection_name,
            "filesScanned": files_scanned,
            "verified": verified,
            "stamped": stamped,
            "corrupt": corrupt,
        }))
    }

    /// Open one collection, or report that there is none.
    ///
    /// `NativeRoot::collection` reports a missing directory as an unsafe path,
    /// because for a reader it is one — the descriptor named something that is
    /// not there. Creating and dropping have to tell "absent" apart from
    /// "unsafe", so the directory is probed directly first.
    fn collection_if_present(
        &self,
        collection_name: &str,
    ) -> Result<Option<super::NativeCollection>, NativeStorageError> {
        let present = [".collections", ".buckets"].into_iter().try_fold(
            false,
            |found, namespace| -> Result<bool, NativeStorageError> {
                Ok(found
                    || path_exists_no_follow(
                        &self.root.path().join(namespace).join(collection_name),
                    )?)
            },
        )?;
        if !present {
            return Ok(None);
        }
        self.root.collection(collection_name).map(Some)
    }

    /// Create one collection, or complete a partly created one.
    ///
    /// The descriptor is written before the directories it describes. A
    /// collection exists when its directory does, so an interrupted create
    /// leaves a descriptor naming nothing — which reads as "no such
    /// collection" — rather than a directory whose namespace and shard width
    /// nobody recorded. Re-running finishes it.
    ///
    /// Returns `true` when the collection did not exist beforehand.
    ///
    /// # Errors
    ///
    /// Returns an error for an invalid name, a kind that contradicts an
    /// existing collection, an unsafe path, or an interrupted durable write.
    pub fn create_collection(
        &self,
        collection_name: &str,
        kind: CollectionKind,
        versioned: Option<bool>,
    ) -> Result<bool, NativeStorageError> {
        super::validate_collection_name(collection_name)?;
        let existing = self.collection_if_present(collection_name)?;
        if let Some(collection) = &existing
            && collection.kind != kind
        {
            return Err(NativeStorageError::new(
                NativeStorageErrorCode::WrongType,
                format!(
                    "collection \"{collection_name}\" already exists with kind \"{}\"",
                    match collection.kind {
                        CollectionKind::Document => "document",
                        CollectionKind::File => "file",
                    }
                ),
            ));
        }

        let catalog = self
            .root
            .catalog_root()
            .join(".fylo-catalog")
            .join("collections");
        let descriptor_path = catalog.join(format!("{collection_name}.json"));
        // An existing collection keeps the width it was built with: the layout
        // is a property of the root, and the host only chooses for a collection
        // that does not exist yet.
        let width = match &existing {
            Some(collection) => collection.shard_width,
            // Validated here, not just where the CLI parses it: a host that
            // builds `RootConfig` directly reaches this with any `u32`, and an
            // out-of-range width would be written into the descriptor and
            // become the collection's permanent layout.
            None => super::validated_shard_width(self.config.shard_width)?,
        };
        if existing.is_none() {
            fs::create_dir_all(&catalog).map_err(NativeStorageError::io)?;
            let mut descriptor = Map::new();
            descriptor.insert("version".into(), Value::from(1));
            descriptor.insert(
                "kind".into(),
                Value::from(match kind {
                    CollectionKind::Document => "document",
                    CollectionKind::File => "file",
                }),
            );
            descriptor.insert("shardWidth".into(), Value::from(width));
            if versioned == Some(false) {
                descriptor.insert("versioned".into(), Value::from(false));
            }
            let mut encoded = serde_json::to_vec(&Value::Object(descriptor))
                .map_err(|error| json_error(&error))?;
            encoded.push(b'\n');
            durable_replace(&descriptor_path, &encoded)?;
        }

        let namespace = match kind {
            CollectionKind::Document => ".collections",
            CollectionKind::File => ".buckets",
        };
        let collection_root = self.root.path().join(namespace).join(collection_name);
        for directory in [
            collection_root.clone(),
            collection_root.join("docs"),
            collection_root.join(".deleted"),
            collection_root.join("index"),
        ] {
            ensure_directory(&self.root, &directory)?;
        }
        // Never rewrite an index that exists: re-creating a populated
        // collection would otherwise replace its keys with an empty snapshot.
        let index = collection_root.join("index");
        write_if_missing(
            &index.join("manifest.json"),
            format!(
                "{{\"format\":\"fylo.local-fs.index.v1\",\"createdAt\":{}}}\n",
                now_millis()?
            )
            .as_bytes(),
        )?;
        write_if_missing(&index.join("keys.snapshot"), b"")?;
        write_if_missing(&index.join("keys.wal"), b"")?;
        Ok(existing.is_none())
    }

    /// Remove one collection and the descriptor that names it.
    ///
    /// # Errors
    ///
    /// Returns an error for a missing collection, an unsafe path, or a failed
    /// removal.
    pub fn drop_collection(&self, collection_name: &str) -> Result<(), NativeStorageError> {
        super::validate_collection_name(collection_name)?;
        let Some(collection) = self.collection_if_present(collection_name)? else {
            return Err(NativeStorageError::new(
                NativeStorageErrorCode::NotFound,
                format!("collection \"{collection_name}\" does not exist"),
            ));
        };
        // Recover first: dropping a collection mid-transaction would discard
        // the journal that says what the interrupted write still owes.
        {
            let _lock = CollectionWriteLock::acquire(&collection.path)?;
            self.recover_locked(&collection)?;
        }
        remove_dir_durable(&collection.path)?;
        let descriptor_path = self
            .root
            .catalog_root()
            .join(".fylo-catalog")
            .join("collections")
            .join(format!("{collection_name}.json"));
        if path_exists_no_follow(&descriptor_path)? {
            fs::remove_file(&descriptor_path).map_err(NativeStorageError::io)?;
        }
        Ok(())
    }

    /// Allocate one process-monotonic TTID for a caller that has none.
    ///
    /// # Errors
    ///
    /// Returns an error when the system clock is outside the TTID range.
    pub fn allocate_identifier(&self) -> Result<String, NativeStorageError> {
        generate_ttid()
    }

    /// Resolve a collection for a record mutation.
    ///
    /// Refuses when the collection's recorded width differs from the one this
    /// process is configured for. The layout is a property of the root while
    /// the configuration is per process, so letting a write through would have
    /// it land under a shard the next reader does not look in. Relocating every
    /// record is bounded only by collection size, so it never happens
    /// implicitly inside a write — the caller is told which command does it.
    ///
    /// Reads are unaffected, and so are recovery, `rebuild`, and `reshard`:
    /// resharding is the operation that resolves the mismatch.
    fn writable_collection(
        &self,
        collection_name: &str,
    ) -> Result<super::NativeCollection, NativeStorageError> {
        let collection = self.root.collection(collection_name)?;
        if let Some(configured) = self.config.shard_width
            && configured != collection.shard_width()
        {
            return Err(NativeStorageError::new(
                NativeStorageErrorCode::ShardWidth,
                format!(
                    "collection \"{collection_name}\" is sharded at width {} but this process \
                     is configured for {configured}; run `fylo reshard {collection_name} --width \
                     {configured}` to move it, or drop the override",
                    collection.shard_width()
                ),
            ));
        }
        Ok(collection)
    }

    fn document_collection(
        &self,
        collection_name: &str,
        operation: &str,
    ) -> Result<super::NativeCollection, NativeStorageError> {
        let collection = self.writable_collection(collection_name)?;
        if collection.kind != CollectionKind::Document {
            return Err(NativeStorageError::new(
                NativeStorageErrorCode::WrongType,
                format!("{operation} requires a document collection"),
            ));
        }
        Ok(collection)
    }

    fn patch_document_locked(
        &self,
        collection: &super::NativeCollection,
        identifier: &str,
        target: &Path,
        canonical: &[u8],
    ) -> Result<(), NativeStorageError> {
        let before = record_index_keys(collection, identifier)?;
        let mut transaction = Transaction::begin(self, collection, "patch-document")?;
        let outcome = (|| {
            transaction.capture(target)?;
            capture_index(&mut transaction, collection)?;
            overwrite_in_place(target, canonical)?;
            self.apply_index_delta(
                collection,
                &before,
                &record_index_keys(collection, identifier)?,
            )?;
            transaction.commit()
        })();
        finish_transaction(transaction, outcome, "patch")?;
        Ok(())
    }

    fn execute_sql_insert(
        &self,
        plan: &fylo_query::SqlPlan,
        access: WriteAccess,
    ) -> Result<SqlMutationResult, NativeStorageError> {
        let values = required_object(&plan.ast, "$values", "SQL INSERT values")?;
        let encoded = encode_document_fields(values.clone())?;
        for _ in 0..16 {
            let identifier = generate_ttid()?;
            match self.put_document(
                &plan.collection,
                &identifier,
                &encoded,
                PutDocumentOptions {
                    access,
                    ..PutDocumentOptions::default()
                },
            ) {
                Ok(()) => {
                    return Ok(SqlMutationResult {
                        kind: SqlMutationResultKind::Insert,
                        affected: 1,
                        identifiers: vec![identifier],
                    });
                }
                Err(error)
                    if error.code() == NativeStorageErrorCode::CorruptMetadata
                        && error.to_string().contains("identifier already exists") => {}
                Err(error) => return Err(error),
            }
        }
        Err(NativeStorageError::new(
            NativeStorageErrorCode::ConcurrentWrite,
            "unable to allocate a unique TTID for SQL INSERT",
        ))
    }

    fn execute_sql_update(
        &self,
        plan: &fylo_query::SqlPlan,
        actor: Option<&WriteActor>,
    ) -> Result<SqlMutationResult, NativeStorageError> {
        let changes = required_object(&plan.ast, "$set", "SQL UPDATE assignments")?;
        let query_value = plan
            .ast
            .get("$where")
            .cloned()
            .unwrap_or_else(|| Value::Object(Map::new()));
        let query = StructuredQuery::from_value(&query_value, QueryLimits::default())
            .map_err(|error| query_error(&error))?;
        let collection = self.document_collection(&plan.collection, "SQL UPDATE")?;
        let _lock = CollectionWriteLock::acquire(&collection.path)?;
        self.recover_locked(&collection)?;
        let mut documents = matching_documents(&collection, &query, actor)?;
        for document in &mut documents {
            merge_top_level(&mut document.fields, changes);
            document.encoded = encode_document_fields(document.fields.clone())?;
        }
        self.write_sql_updates(&collection, &documents)?;
        Ok(SqlMutationResult {
            kind: SqlMutationResultKind::Update,
            affected: documents.len(),
            identifiers: documents
                .into_iter()
                .map(|document| document.identifier)
                .collect(),
        })
    }

    fn execute_sql_delete(
        &self,
        plan: &fylo_query::SqlPlan,
        actor: Option<&WriteActor>,
    ) -> Result<SqlMutationResult, NativeStorageError> {
        let query = StructuredQuery::from_value(&plan.ast, QueryLimits::default())
            .map_err(|error| query_error(&error))?;
        let collection = self.document_collection(&plan.collection, "SQL DELETE")?;
        let _lock = CollectionWriteLock::acquire(&collection.path)?;
        self.recover_locked(&collection)?;
        let documents = matching_documents(&collection, &query, actor)?;
        self.write_sql_deletes(&collection, &documents)?;
        Ok(SqlMutationResult {
            kind: SqlMutationResultKind::Delete,
            affected: documents.len(),
            identifiers: documents
                .into_iter()
                .map(|document| document.identifier)
                .collect(),
        })
    }

    fn write_sql_updates(
        &self,
        collection: &super::NativeCollection,
        documents: &[SqlDocument],
    ) -> Result<(), NativeStorageError> {
        if documents.is_empty() {
            return Ok(());
        }
        let before = record_index_keys_for(collection, documents)?;
        let mut transaction = Transaction::begin(self, collection, "update-many")?;
        let outcome = (|| {
            capture_documents(&mut transaction, documents)?;
            capture_index(&mut transaction, collection)?;
            for document in documents {
                overwrite_in_place(&document.path, &document.encoded)?;
            }
            self.apply_index_delta(
                collection,
                &before,
                &record_index_keys_for(collection, documents)?,
            )?;
            transaction.commit()
        })();
        finish_transaction(transaction, outcome, "SQL UPDATE")
    }

    fn write_sql_deletes(
        &self,
        collection: &super::NativeCollection,
        documents: &[SqlDocument],
    ) -> Result<(), NativeStorageError> {
        if documents.is_empty() {
            return Ok(());
        }
        let before = record_index_keys_for(collection, documents)?;
        let mut transaction = Transaction::begin(self, collection, "delete-many")?;
        let outcome = (|| {
            capture_documents(&mut transaction, documents)?;
            capture_index(&mut transaction, collection)?;
            for document in documents {
                let target = deleted_document_path(collection, &document.identifier);
                transaction.capture(&target)?;
                ensure_deleted_parent(self, &target)?;
                fs::rename(&document.path, &target).map_err(NativeStorageError::io)?;
                sync_parent(&document.path)?;
                sync_parent(&target)?;
                failpoint("after-delete-rename")?;
            }
            // Every record moved under `.deleted`, which is not indexed.
            self.apply_index_delta(collection, &before, &BTreeSet::new())?;
            transaction.commit()
        })();
        finish_transaction(transaction, outcome, "SQL DELETE")
    }

    fn recover_locked(
        &self,
        collection: &super::NativeCollection,
    ) -> Result<bool, NativeStorageError> {
        let generation = collection.generation()?;
        if generation.state == super::GenerationStatus::Stable {
            cleanup_orphan_transactions(self, collection)?;
            return Ok(false);
        }
        let identifier = generation.transaction_id.ok_or_else(|| {
            NativeStorageError::new(
                NativeStorageErrorCode::CorruptMetadata,
                "writing generation has no transaction identifier",
            )
        })?;
        validate_transaction_segment(&identifier)?;
        let root = transaction_root(self, collection, &identifier);
        self.root.verify_path(&root, ExpectedType::Directory)?;
        let manifest: TransactionManifest =
            read_bounded_json(&root.join("transaction.json"), MAX_TRANSACTION_BYTES)?;
        manifest.validate(collection.name(), &identifier)?;
        let captures = read_captures(&root)?;
        if manifest.phase == TransactionPhase::Active {
            restore_captures(&collection.path, &root, &captures)?;
        }
        self.rebuild_index(collection)?;
        write_generation(
            self,
            collection,
            &GenerationRecord::stable(manifest.generation_before.saturating_add(2)),
        )?;
        remove_dir_durable(&root)?;
        Ok(true)
    }

    /// Record one record's index change as a WAL append instead of walking the
    /// whole collection.
    ///
    /// An index key embeds the identifier of the record that produced it, so
    /// no key of one record is derivable from another and a mutation can only
    /// ever add or remove its own. `before` is read before the mutation and
    /// `after` after it; either is empty when the record does not exist at
    /// that point, which is what a create and a delete respectively see.
    fn apply_index_delta(
        &self,
        collection: &super::NativeCollection,
        before: &BTreeSet<String>,
        after: &BTreeSet<String>,
    ) -> Result<(), NativeStorageError> {
        let mut appended = Vec::new();
        for (sign, key) in before
            .difference(after)
            .map(|key| (b'-', key))
            .chain(after.difference(before).map(|key| (b'+', key)))
        {
            appended.push(sign);
            appended.push(b'\t');
            appended.extend_from_slice(key.as_bytes());
            appended.push(b'\n');
        }
        if appended.is_empty() {
            return Ok(());
        }
        let index = collection.path.join("index");
        ensure_directory(&self.root, &index)?;
        append_synced(&index.join("keys.wal"), &appended)?;
        compact_index_if_large(collection)
    }

    fn rebuild_index(
        &self,
        collection: &super::NativeCollection,
    ) -> Result<(), NativeStorageError> {
        let mut keys = BTreeSet::new();
        match collection.kind {
            CollectionKind::Document => {
                for identifier in collection.document_ids()? {
                    let stored = collection.read_document(&identifier)?;
                    let document = Document::parse(&stored.bytes, DocumentLimits::default())
                        .map_err(|error| {
                            NativeStorageError::new(
                                NativeStorageErrorCode::CorruptDocument,
                                format!("document is invalid during index rebuild: {error}"),
                            )
                        })?;
                    keys.extend(index_entries_for_document(
                        identifier.as_str(),
                        document.fields(),
                        |_, value| Ok::<_, NativeStorageError>(IndexLookupValue::plain(value)),
                    )?);
                }
            }
            CollectionKind::File => {
                for identifier in collection.raw_file_ids()? {
                    let stored = collection.read_raw_file(&identifier)?;
                    let fields = raw_file_index_fields(&identifier, &stored)?;
                    keys.extend(index_entries_for_document(
                        identifier.as_str(),
                        &fields,
                        |_, value| Ok::<_, NativeStorageError>(IndexLookupValue::plain(value)),
                    )?);
                }
            }
        }
        let index = collection.path.join("index");
        ensure_directory(&self.root, &index)?;
        let mut snapshot = Vec::new();
        for key in keys {
            snapshot.extend_from_slice(key.as_bytes());
            snapshot.push(b'\n');
        }
        durable_replace(&index.join("keys.snapshot"), &snapshot)?;
        durable_replace(&index.join("keys.wal"), b"")?;
        Ok(())
    }
}

struct RawChecksumCheck {
    path: PathBuf,
    expected: Option<String>,
    actual: String,
}

fn verify_raw_file_checksum(
    collection: &super::NativeCollection,
    namespace: &Path,
    identifier: &str,
) -> Result<RawChecksumCheck, NativeStorageError> {
    let path = collection.find_raw_file_path(namespace, identifier)?;
    let (mut file, _) = collection
        .root
        .open_file(&path, super::MAX_RAW_FILE_BYTES)?;
    let attributes = super::read_fylo_attributes(&file, &path)?;
    let bytes = super::read_bounded(
        (&mut file).take(super::MAX_RAW_FILE_BYTES.saturating_add(1)),
        super::MAX_RAW_FILE_BYTES,
    )?;
    collection.root.verify_open_file_identity(&path, &file)?;
    let expected = attributes
        .get(super::CHECKSUM_XATTR)
        .and_then(|value| std::str::from_utf8(value).ok())
        .and_then(|stamp| stamp.split(':').next())
        .filter(|checksum| {
            checksum.len() == 64
                && checksum
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        })
        .map(ToOwned::to_owned);
    Ok(RawChecksumCheck {
        path,
        expected,
        actual: super::sha256_hex(&bytes),
    })
}

fn stamp_raw_file_checksum(path: &Path, checksum: &str) -> Result<(), NativeStorageError> {
    let metadata = fs::metadata(path).map_err(NativeStorageError::io)?;
    let stamp = format!(
        "{checksum}:{}:{}",
        metadata.len(),
        super::modified_millis(&metadata)?
    );
    write_fylo_attribute(path, super::CHECKSUM_XATTR, stamp.as_bytes())?;
    restore_modified(path, &metadata)
}

#[derive(Debug)]
struct SqlDocument {
    identifier: String,
    path: PathBuf,
    fields: Map<String, Value>,
    encoded: Vec<u8>,
}

fn matching_documents(
    collection: &super::NativeCollection,
    query: &StructuredQuery,
    actor: Option<&WriteActor>,
) -> Result<Vec<SqlDocument>, NativeStorageError> {
    let mut matches = Vec::new();
    for identifier in collection.document_ids()? {
        let stored = collection.read_document(&identifier)?;
        let fields = parse_document_fields(&stored.bytes)?;
        let timestamps = decode_ttid(&identifier).map_err(|error| {
            NativeStorageError::new(
                NativeStorageErrorCode::InvalidDocumentId,
                format!("document TTID is invalid: {error}"),
            )
        })?;
        if !query.matches(&fields, timestamps.created_at, stored.modified_millis) {
            continue;
        }
        require_write_access(stored.access, actor)?;
        matches.push(SqlDocument {
            identifier,
            path: stored.path,
            fields,
            encoded: Vec::new(),
        });
        if query
            .limit()
            .is_some_and(|limit| limit > 0 && matches.len() >= limit)
        {
            break;
        }
    }
    Ok(matches)
}

fn record_target(
    collection: &super::NativeCollection,
    identifier: &str,
) -> Result<(PathBuf, Option<super::AccessDescriptor>), NativeStorageError> {
    match collection.kind {
        CollectionKind::Document => {
            let stored = collection.read_document(identifier)?;
            Ok((stored.path, stored.access))
        }
        CollectionKind::File => {
            let stored = collection.read_raw_file(identifier)?;
            Ok((stored.path, stored.access_descriptor))
        }
    }
}

fn next_meta_updated_at(path: &Path) -> Result<u64, NativeStorageError> {
    let file = File::open(path).map_err(NativeStorageError::io)?;
    let previous = super::read_fylo_attributes(&file, path)?
        .get(super::META_UPDATED_XATTR)
        .and_then(|value| std::str::from_utf8(value).ok())
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0);
    let now = super::wall_clock()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| {
            NativeStorageError::new(
                NativeStorageErrorCode::Io,
                format!("system clock is before the Unix epoch: {error}"),
            )
        })?
        .as_millis();
    let now = u64::try_from(now).map_err(|_| {
        NativeStorageError::new(
            NativeStorageErrorCode::Io,
            "system clock exceeds the metadata timestamp range",
        )
    })?;
    Ok(now.max(previous.saturating_add(1)))
}

/// Records that are not already under the canonical shard, with where they go.
/// Remove shard directories a reshard emptied.
///
/// Enumeration costs one directory read per shard, so a widening left behind
/// as many empty directories as it created and the collection would stay slow
/// to walk forever. `remove_dir` refuses a non-empty directory, which is
/// exactly the guard wanted here: a shard that still holds a record is left
/// alone rather than inspected and raced.
fn remove_emptied_shards(root: &Path) -> Result<(), NativeStorageError> {
    let Ok(shards) = fs::read_dir(root) else {
        return Ok(());
    };
    for shard in shards {
        let shard = shard.map_err(NativeStorageError::io)?;
        if !shard.metadata().map_err(NativeStorageError::io)?.is_dir() {
            continue;
        }
        // A failure means the shard still holds records, or vanished under a
        // concurrent recovery. Either way it is not this pass's business.
        if fs::remove_dir(shard.path()).is_ok() {
            sync_parent(&shard.path())?;
        }
    }
    Ok(())
}

fn reshard_moves(
    root: &Path,
    width: u32,
    leaving: &[u32],
) -> Result<Vec<(PathBuf, PathBuf)>, NativeStorageError> {
    let mut moves = Vec::new();
    let Ok(shards) = fs::read_dir(root) else {
        return Ok(moves);
    };
    for shard in shards {
        let shard = shard.map_err(NativeStorageError::io)?;
        if !shard.metadata().map_err(NativeStorageError::io)?.is_dir() {
            continue;
        }
        for record in fs::read_dir(shard.path()).map_err(NativeStorageError::io)? {
            let record = record.map_err(NativeStorageError::io)?;
            let path = record.path();
            if !fs::symlink_metadata(&path)
                .map_err(NativeStorageError::io)?
                .is_file()
            {
                continue;
            }
            let filename = record.file_name().to_string_lossy().into_owned();
            let Some(identifier) = super::raw_file_identifier(&filename) else {
                continue;
            };
            if crate::validate_ttid_shape(identifier).is_err() {
                continue;
            }
            let target = root
                .join(crate::shard_of(identifier, width))
                .join(&filename);
            if target != path {
                moves.push((path, target));
            }
        }
    }
    let _ = leaving;
    Ok(moves)
}

fn parse_document_fields(bytes: &[u8]) -> Result<Map<String, Value>, NativeStorageError> {
    Document::parse(bytes, DocumentLimits::default())
        .map(Document::into_fields)
        .map_err(|error| {
            NativeStorageError::new(
                NativeStorageErrorCode::CorruptDocument,
                format!("document is invalid: {error}"),
            )
        })
}

fn encode_document_fields(fields: Map<String, Value>) -> Result<Vec<u8>, NativeStorageError> {
    Document::try_from_value(Value::Object(fields), DocumentLimits::default())
        .and_then(|document| document.encode())
        .map_err(|error| {
            NativeStorageError::new(
                NativeStorageErrorCode::CorruptDocument,
                format!("document cannot be encoded: {error}"),
            )
        })
}

fn merge_top_level(target: &mut Map<String, Value>, changes: &Map<String, Value>) {
    for (field, value) in changes {
        target.insert(field.clone(), value.clone());
    }
}

fn required_object<'a>(
    value: &'a Value,
    key: &str,
    description: &str,
) -> Result<&'a Map<String, Value>, NativeStorageError> {
    value.get(key).and_then(Value::as_object).ok_or_else(|| {
        NativeStorageError::new(
            NativeStorageErrorCode::InvalidQuery,
            format!("{description} must be an object"),
        )
    })
}

fn capture_documents(
    transaction: &mut Transaction<'_>,
    documents: &[SqlDocument],
) -> Result<(), NativeStorageError> {
    for document in documents {
        transaction.capture(&document.path)?;
    }
    Ok(())
}

/// Prefix-index keys the collection's live record contributes right now.
///
/// A record that does not exist contributes none, so this is also the correct
/// "before" for a create and "after" for a delete.
fn record_index_keys(
    collection: &super::NativeCollection,
    identifier: &str,
) -> Result<BTreeSet<String>, NativeStorageError> {
    let plain = |_: &str, value: &str| Ok::<_, NativeStorageError>(IndexLookupValue::plain(value));
    match collection.kind {
        CollectionKind::Document => match collection.read_document(identifier) {
            Ok(stored) => {
                let document =
                    Document::parse(&stored.bytes, DocumentLimits::default()).map_err(|error| {
                        NativeStorageError::new(
                            NativeStorageErrorCode::CorruptDocument,
                            format!("document is invalid during index update: {error}"),
                        )
                    })?;
                index_entries_for_document(identifier, document.fields(), plain)
            }
            Err(error) if error.code() == NativeStorageErrorCode::NotFound => Ok(BTreeSet::new()),
            Err(error) => Err(error),
        },
        CollectionKind::File => match collection.read_raw_file(identifier) {
            Ok(stored) => {
                let fields = raw_file_index_fields(identifier, &stored)?;
                index_entries_for_document(identifier, &fields, plain)
            }
            Err(error) if error.code() == NativeStorageErrorCode::NotFound => Ok(BTreeSet::new()),
            Err(error) => Err(error),
        },
    }
}

/// Fold the WAL into the snapshot once a reader would carry too much of it.
///
/// The threshold doubles with the snapshot, so a load of `n` records pays for
/// `O(log n)` compactions and each is amortized `O(1)` per write. Compaction
/// merges the same bytes the reader already merges, so unlike a rebuild it
/// never reads a record.
fn compact_index_if_large(collection: &super::NativeCollection) -> Result<(), NativeStorageError> {
    let index = collection.path.join("index");
    let wal = index.join("keys.wal");
    let snapshot = index.join("keys.snapshot");
    let length = |path: &Path| {
        fs::symlink_metadata(path)
            .ok()
            .filter(fs::Metadata::is_file)
            .map_or(0, |metadata| metadata.len())
    };
    if length(&wal) <= INDEX_WAL_COMPACT_BYTES.max(length(&snapshot)) {
        return Ok(());
    }
    let merged = collection.index_snapshot()?;
    durable_replace(&snapshot, merged.as_bytes())?;
    durable_replace(&wal, b"")
}

/// Union of [`record_index_keys`] over one statement's matched records.
fn record_index_keys_for(
    collection: &super::NativeCollection,
    documents: &[SqlDocument],
) -> Result<BTreeSet<String>, NativeStorageError> {
    let mut keys = BTreeSet::new();
    for document in documents {
        keys.extend(record_index_keys(collection, &document.identifier)?);
    }
    Ok(keys)
}

fn capture_index(
    transaction: &mut Transaction<'_>,
    collection: &super::NativeCollection,
) -> Result<(), NativeStorageError> {
    transaction.capture(&collection.path.join("index").join("keys.snapshot"))?;
    transaction.capture(&collection.path.join("index").join("keys.wal"))
}

fn finish_transaction(
    mut transaction: Transaction<'_>,
    outcome: Result<(), NativeStorageError>,
    operation: &str,
) -> Result<(), NativeStorageError> {
    if let Err(error) = outcome {
        if let Err(rollback) = transaction.rollback() {
            return Err(NativeStorageError::new(
                NativeStorageErrorCode::Io,
                format!("{operation} failed ({error}) and rollback failed ({rollback})"),
            ));
        }
        return Err(error);
    }
    Ok(())
}

fn deleted_document_path(collection: &super::NativeCollection, identifier: &str) -> PathBuf {
    collection
        .path
        .join(".deleted")
        .join(crate::shard_of(identifier, collection.shard_width()))
        .join(format!("{identifier}.json"))
}

fn ensure_deleted_parent(
    writer: &NativeWriteRoot,
    target: &Path,
) -> Result<(), NativeStorageError> {
    let parent = target.parent().ok_or_else(|| {
        NativeStorageError::new(
            NativeStorageErrorCode::UnsafePath,
            "tombstone target has no parent",
        )
    })?;
    ensure_directory(&writer.root, parent)
}

fn generate_ttid() -> Result<String, NativeStorageError> {
    let elapsed = super::wall_clock()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| {
            NativeStorageError::new(
                NativeStorageErrorCode::Io,
                format!("system clock is before the Unix epoch: {error}"),
            )
        })?;
    let clock_ticks = u64::try_from(elapsed.as_nanos() / 100).map_err(|_| {
        NativeStorageError::new(
            NativeStorageErrorCode::Io,
            "system clock exceeds the TTID timestamp range",
        )
    })?;
    // `fetch_update` returns the previous value, so the monotonic tick is
    // recomputed here from exactly the same expression the closure stored.
    let previous = TTID_SEQUENCE
        .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |previous| {
            Some(clock_ticks.max(previous.saturating_add(1)))
        })
        .unwrap_or_else(|previous| previous);
    let identifier = encode_base36(clock_ticks.max(previous.saturating_add(1)));
    validate_ttid_shape(&identifier)?;
    Ok(identifier)
}

fn encode_base36(mut value: u64) -> String {
    const DIGITS: &[u8; 36] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    let mut encoded = [0_u8; 13];
    let mut cursor = encoded.len();
    loop {
        cursor -= 1;
        encoded[cursor] = DIGITS[(value % 36) as usize];
        value /= 36;
        if value == 0 {
            break;
        }
    }
    String::from_utf8_lossy(&encoded[cursor..]).into_owned()
}

fn query_error(error: &fylo_query::QueryError) -> NativeStorageError {
    NativeStorageError::new(
        NativeStorageErrorCode::InvalidQuery,
        format!("SQL mutation is invalid: {error}"),
    )
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
enum TransactionPhase {
    Active,
    Committed,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TransactionManifest {
    format: String,
    id: String,
    collection: String,
    operation: String,
    phase: TransactionPhase,
    generation_before: u64,
    event_offset: u64,
    captures: Vec<serde_json::Value>,
}

impl TransactionManifest {
    fn validate(&self, collection: &str, identifier: &str) -> Result<(), NativeStorageError> {
        if self.format != TRANSACTION_FORMAT
            || self.id != identifier
            || self.collection != collection
            || self.operation.is_empty()
            || self.operation.len() > 256
            || !self.captures.is_empty()
        {
            return Err(NativeStorageError::new(
                NativeStorageErrorCode::CorruptMetadata,
                "transaction manifest has an invalid schema or identity",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GenerationRecord {
    format: String,
    generation: u64,
    state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    transaction_id: Option<String>,
}

impl GenerationRecord {
    fn writing(generation: u64, transaction_id: String) -> Self {
        Self {
            format: GENERATION_FORMAT.into(),
            generation,
            state: "writing".into(),
            transaction_id: Some(transaction_id),
        }
    }

    fn stable(generation: u64) -> Self {
        Self {
            format: GENERATION_FORMAT.into(),
            generation,
            state: "stable".into(),
            transaction_id: None,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Capture {
    path: String,
    present: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    backup: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    mode: Option<u32>,
    #[serde(rename = "mtimeMs", skip_serializing_if = "Option::is_none")]
    mtime_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    xattrs: Option<Vec<CapturedAttribute>>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct CapturedAttribute {
    name: String,
    value: String,
}

struct Transaction<'a> {
    writer: &'a NativeWriteRoot,
    collection: &'a super::NativeCollection,
    manifest: TransactionManifest,
    root: PathBuf,
    captures: Vec<Capture>,
    captured: BTreeSet<PathBuf>,
    finished: bool,
}

impl<'a> Transaction<'a> {
    fn begin(
        writer: &'a NativeWriteRoot,
        collection: &'a super::NativeCollection,
        operation: &str,
    ) -> Result<Self, NativeStorageError> {
        let generation = collection.generation()?;
        if generation.state != super::GenerationStatus::Stable {
            return Err(NativeStorageError::new(
                NativeStorageErrorCode::ConcurrentWrite,
                "collection requires recovery before writing",
            ));
        }
        let identifier = unique_name("rust-tx");
        let root = transaction_root(writer, collection, &identifier);
        ensure_directory(&writer.root, &root)?;
        ensure_directory(&writer.root, &root.join("captures"))?;
        ensure_directory(&writer.root, &root.join("before"))?;
        let event_offset = fs::metadata(
            collection
                .path
                .join("events")
                .join(format!("{}.ndjson", collection.name())),
        )
        .map_or(0, |metadata| metadata.len());
        let manifest = TransactionManifest {
            format: TRANSACTION_FORMAT.into(),
            id: identifier.clone(),
            collection: collection.name().into(),
            operation: operation.into(),
            phase: TransactionPhase::Active,
            generation_before: generation.generation,
            event_offset,
            captures: Vec::new(),
        };
        write_json_durable(&root.join("transaction.json"), &manifest)?;
        write_generation(
            writer,
            collection,
            &GenerationRecord::writing(generation.generation.saturating_add(1), identifier),
        )?;
        let mut transaction = Self {
            writer,
            collection,
            manifest,
            root,
            captures: Vec::new(),
            captured: BTreeSet::new(),
            finished: false,
        };
        // The manifest and the writing generation are already durable, so a
        // failure here owns them. Returning the error alone would leave a live
        // process having published a transaction it never started, forcing the
        // next opener to recover state this one could have undone itself.
        //
        // Nothing has been captured and no record has changed, so undoing
        // exactly what this function published is the whole job. A full
        // rollback would also rebuild the index, which is work this transaction
        // never invalidated and which can fail for reasons that have nothing to
        // do with it.
        if let Err(error) = failpoint("after-state-writing") {
            transaction.abandon()?;
            return Err(error);
        }
        Ok(transaction)
    }

    /// Undo a transaction that published its journal but changed nothing.
    fn abandon(&mut self) -> Result<(), NativeStorageError> {
        if self.finished {
            return Ok(());
        }
        write_generation(
            self.writer,
            self.collection,
            &GenerationRecord::stable(self.manifest.generation_before),
        )?;
        self.finished = true;
        remove_dir_durable(&self.root)
    }

    fn capture(&mut self, target: &Path) -> Result<(), NativeStorageError> {
        let relative = target.strip_prefix(&self.collection.path).map_err(|_| {
            NativeStorageError::new(
                NativeStorageErrorCode::UnsafePath,
                "transaction target escapes its collection",
            )
        })?;
        if relative.as_os_str().is_empty()
            || relative
                .components()
                .any(|component| !matches!(component, std::path::Component::Normal(_)))
        {
            return Err(NativeStorageError::new(
                NativeStorageErrorCode::UnsafePath,
                "transaction target is not a safe relative path",
            ));
        }
        if !self.captured.insert(relative.to_owned()) {
            return Ok(());
        }
        // Where attributes live in a sidecar file, that file is part of the
        // record. Capturing it as its own entry means the before-image, the
        // restore, and the remove-if-absent paths all cover it without any of
        // them learning what a sidecar is. Bounded at one level: a sidecar's
        // own sidecar is never captured.
        #[cfg(all(
            not(unix),
            not(windows),
            not(all(target_arch = "wasm32", target_os = "unknown"))
        ))]
        if !target
            .as_os_str()
            .to_string_lossy()
            .ends_with(super::SIDECAR_SUFFIX)
        {
            self.capture(&super::sidecar_path(target))?;
        }
        let present = path_exists_no_follow(target)?;
        let index = self.captures.len();
        let capture = if present {
            self.writer.root.verify_path(target, ExpectedType::File)?;
            let metadata = fs::symlink_metadata(target).map_err(NativeStorageError::io)?;
            let backup = PathBuf::from("before").join(format!("{index:06}.bin"));
            copy_durable(target, &self.root.join(&backup))?;
            Capture {
                path: portable_path(relative)?,
                present: true,
                backup: Some(portable_path(&backup)?),
                mode: Some(native_mode(&metadata)),
                mtime_ms: Some(modified_millis(&metadata)?),
                xattrs: Some(capture_attributes(target)?),
            }
        } else {
            Capture {
                path: portable_path(relative)?,
                present: false,
                backup: None,
                mode: None,
                mtime_ms: None,
                xattrs: None,
            }
        };
        write_json_durable(
            &self.root.join("captures").join(format!("{index:06}.json")),
            &capture,
        )?;
        self.captures.push(capture);
        failpoint("after-capture")?;
        Ok(())
    }

    fn commit(&mut self) -> Result<(), NativeStorageError> {
        failpoint("before-commit-marker")?;
        self.manifest.phase = TransactionPhase::Committed;
        write_json_durable(&self.root.join("transaction.json"), &self.manifest)?;
        failpoint("after-commit-marker")?;
        write_generation(
            self.writer,
            self.collection,
            &GenerationRecord::stable(self.manifest.generation_before.saturating_add(2)),
        )?;
        self.finished = true;
        remove_dir_durable(&self.root)?;
        Ok(())
    }

    fn rollback(&mut self) -> Result<(), NativeStorageError> {
        if self.finished {
            return Ok(());
        }
        // A failed recovery is worse than the crash it recovers from, so each
        // step names itself: an operator seeing only the platform's message has
        // no way to tell which durable operation refused.
        restore_captures(&self.collection.path, &self.root, &self.captures)
            .map_err(|error| rollback_step("restoring captures", &error))?;
        self.writer
            .rebuild_index(self.collection)
            .map_err(|error| rollback_step("rebuilding the index", &error))?;
        write_generation(
            self.writer,
            self.collection,
            &GenerationRecord::stable(self.manifest.generation_before.saturating_add(2)),
        )
        .map_err(|error| rollback_step("publishing the recovered generation", &error))?;
        self.finished = true;
        remove_dir_durable(&self.root)
            .map_err(|error| rollback_step("removing the transaction directory", &error))
    }
}

impl Drop for Transaction<'_> {
    fn drop(&mut self) {
        // Deliberately leave unfinished durable state for the next opener.
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct LockRecord {
    owner: String,
    pid: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    process_identity: Option<String>,
    ts: u64,
}

struct CollectionWriteLock {
    path: PathBuf,
    owner: String,
}

impl CollectionWriteLock {
    fn acquire(collection_root: &Path) -> Result<Self, NativeStorageError> {
        Self::acquire_at(&collection_root.join("locks"), "collection.lock")
    }

    fn acquire_at(locks: &Path, name: &str) -> Result<Self, NativeStorageError> {
        fs::create_dir_all(locks).map_err(NativeStorageError::io)?;
        let path = locks.join(name);
        let owner = unique_name("rust-owner");
        let record = LockRecord {
            owner: owner.clone(),
            pid: super::process_id(),
            process_identity: process_identity(super::process_id()),
            ts: unix_millis()?,
        };
        if !try_create_lock(&path, &record)? {
            reclaim_stale_lock(&path, &record)?;
            if !try_create_lock(&path, &record)? {
                return Err(NativeStorageError::new(
                    NativeStorageErrorCode::ConcurrentWrite,
                    "collection write lock is held by another process",
                ));
            }
        }
        Ok(Self { path, owner })
    }
}

impl Drop for CollectionWriteLock {
    fn drop(&mut self) {
        let Ok(record) = read_bounded_json::<LockRecord>(&self.path, 16 * 1024) else {
            return;
        };
        if record.owner != self.owner {
            return;
        }
        let released = self
            .path
            .with_extension(format!("released.{}", unique_name("lock")));
        if fs::rename(&self.path, &released).is_ok() {
            let _ = fs::remove_file(released);
        }
    }
}

fn try_create_lock(path: &Path, record: &LockRecord) -> Result<bool, NativeStorageError> {
    let scratch = sibling_scratch(path);
    write_new_synced(
        &scratch,
        serde_json::to_vec(record)
            .map_err(|error| json_error(&error))?
            .as_slice(),
    )?;
    let result = match fs::hard_link(&scratch, path) {
        Ok(()) => {
            sync_parent(path)?;
            true
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => false,
        // A host filesystem has no links. Link-then-check exists because
        // exclusive create is unreliable over NFS, and a filesystem with no
        // links is not NFS — so the exclusive create the host does offer is
        // the atomic primitive here.
        Err(error) if error.kind() == std::io::ErrorKind::Unsupported => {
            let encoded = serde_json::to_vec(record).map_err(|error| json_error(&error))?;
            match write_new_synced(path, &encoded) {
                Ok(()) => {
                    sync_parent(path)?;
                    true
                }
                Err(error) if error.code() == NativeStorageErrorCode::Io => false,
                Err(error) => return Err(error),
            }
        }
        Err(error) => return Err(NativeStorageError::io(error)),
    };
    fs::remove_file(scratch).map_err(NativeStorageError::io)?;
    Ok(result)
}

fn reclaim_stale_lock(path: &Path, contender: &LockRecord) -> Result<(), NativeStorageError> {
    let payload = fs::read(path).map_err(NativeStorageError::io)?;
    let existing: LockRecord = serde_json::from_slice(&payload).map_err(|_| {
        NativeStorageError::new(
            NativeStorageErrorCode::ConcurrentWrite,
            "collection lock is unreadable and cannot be reclaimed automatically",
        )
    })?;
    if lock_owner_alive(&existing)
        || unix_millis()?.saturating_sub(existing.ts) < LOCK_TTL_MILLIS
            && existing.process_identity.is_none()
    {
        return Ok(());
    }
    let claim = path.with_extension("lock.takeover");
    let claim_record = LockRecord {
        owner: contender.owner.clone(),
        pid: contender.pid,
        process_identity: contender.process_identity.clone(),
        ts: contender.ts,
    };
    if !try_create_lock(&claim, &claim_record)? {
        return Ok(());
    }
    let current = fs::read(path).map_err(NativeStorageError::io)?;
    if current == payload {
        let stale = path.with_extension(format!("stale.{}", unique_name("lock")));
        fs::rename(path, &stale).map_err(NativeStorageError::io)?;
        fs::remove_file(stale).map_err(NativeStorageError::io)?;
        sync_parent(path)?;
    }
    let _ = fs::remove_file(claim);
    Ok(())
}

fn lock_owner_alive(record: &LockRecord) -> bool {
    let observed = process_identity(record.pid);
    match (&record.process_identity, observed) {
        (Some(expected), Some(observed)) => expected == &observed,
        (None, Some(_)) => true,
        _ => false,
    }
}

#[cfg(target_os = "linux")]
fn process_identity(pid: u32) -> Option<String> {
    let boot = fs::read_to_string("/proc/sys/kernel/random/boot_id").ok()?;
    let status_line = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    // Field 22 of /proc/<pid>/stat is the process start time in clock ticks.
    // Everything before the last ')' is the comm field, which may itself
    // contain spaces, so the scan starts after it.
    let started_ticks = status_line
        .get(status_line.rfind(')')?.saturating_add(2)..)?
        .split_whitespace()
        .nth(19)?;
    Some(format!("linux:{}:{started_ticks}", boot.trim()))
}

#[cfg(target_os = "windows")]
fn process_identity(pid: u32) -> Option<String> {
    let command = format!(
        "(Get-CimInstance Win32_Process -Filter 'ProcessId = {pid}').CreationDate.ToUniversalTime().Ticks"
    );
    command_output(
        "powershell.exe",
        &["-NoProfile", "-NonInteractive", "-Command", &command],
    )
    .map(|value| format!("win32:{value}"))
}

#[cfg(not(any(target_os = "linux", target_os = "windows")))]
fn process_identity(pid: u32) -> Option<String> {
    let platform = if cfg!(target_os = "macos") {
        "darwin"
    } else {
        std::env::consts::OS
    };
    command_output("ps", &["-o", "lstart=", "-p", &pid.to_string()])
        .map(|value| format!("{platform}:{value}"))
}

// Only the Windows and generic-Unix process-identity probes shell out; Linux
// reads /proc directly.
#[cfg(not(target_os = "linux"))]
fn command_output(program: &str, arguments: &[&str]) -> Option<String> {
    let output = std::process::Command::new(program)
        .args(arguments)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8(output.stdout).ok()?.trim().to_owned();
    (!value.is_empty()).then_some(value)
}

fn transaction_root(
    writer: &NativeWriteRoot,
    collection: &super::NativeCollection,
    identifier: &str,
) -> PathBuf {
    writer
        .root
        .path()
        .join(".fylo-transactions")
        .join(&collection.namespace)
        .join(collection.name())
        .join(identifier)
}

fn generation_path(writer: &NativeWriteRoot, collection: &super::NativeCollection) -> PathBuf {
    transaction_root(writer, collection, "state.json")
        .parent()
        .expect("state parent")
        .join("state.json")
}

fn write_generation(
    writer: &NativeWriteRoot,
    collection: &super::NativeCollection,
    generation: &GenerationRecord,
) -> Result<(), NativeStorageError> {
    let path = generation_path(writer, collection);
    ensure_directory(&writer.root, path.parent().expect("generation has parent"))?;
    write_json_durable(&path, &generation)
}

fn read_captures(root: &Path) -> Result<Vec<Capture>, NativeStorageError> {
    let directory = root.join("captures");
    let mut entries = fs::read_dir(&directory)
        .map_err(NativeStorageError::io)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(NativeStorageError::io)?;
    entries.sort_by_key(fs::DirEntry::file_name);
    if entries.len() > 10_000 {
        return Err(NativeStorageError::new(
            NativeStorageErrorCode::FileTooLarge,
            "transaction capture count exceeds 10000",
        ));
    }
    entries
        .into_iter()
        .enumerate()
        .map(|(index, entry)| {
            let expected = format!("{index:06}.json");
            if entry.file_name() != std::ffi::OsStr::new(&expected)
                || !entry.file_type().map_err(NativeStorageError::io)?.is_file()
            {
                return Err(NativeStorageError::new(
                    NativeStorageErrorCode::CorruptMetadata,
                    "transaction capture sequence is corrupt",
                ));
            }
            read_bounded_json(&entry.path(), MAX_CAPTURE_BYTES)
        })
        .collect()
}

/// Clear the Windows read-only attribute so a rolled-back path can be deleted.
///
/// `set_readonly(false)` means something entirely different on Unix, where it
/// widens the mode to world-writable, so this is deliberately not shared.
// Clippy warns that this widens a Unix mode to world-writable. On Windows it
// only clears FILE_ATTRIBUTE_READONLY and carries none of that meaning, which
// is why the function exists per platform rather than shared.
#[allow(clippy::permissions_set_readonly_false)]
#[cfg(windows)]
fn clear_readonly(target: &Path, metadata: &fs::Metadata) -> Result<(), NativeStorageError> {
    let mut permissions = metadata.permissions();
    if permissions.readonly() {
        permissions.set_readonly(false);
        fs::set_permissions(target, permissions).map_err(NativeStorageError::io)?;
    }
    Ok(())
}

// The signature mirrors the Windows implementation so the caller stays
// platform-free.
#[allow(clippy::unnecessary_wraps)]
#[cfg(not(windows))]
fn clear_readonly(_target: &Path, _metadata: &fs::Metadata) -> Result<(), NativeStorageError> {
    Ok(())
}

/// Delete a path a rolled-back transaction created, reporting whether it was
/// there.
///
/// Windows refuses to delete a file carrying the read-only attribute and
/// refuses `remove_file` on a directory, and reports both as "Access is
/// denied", where POSIX needs only write permission on the parent. Recovery
/// must not be stopped by either, so the read-only attribute is cleared and a
/// directory is removed as one.
fn remove_capture_target(target: &Path) -> Result<bool, NativeStorageError> {
    match fs::remove_file(target) {
        Ok(()) => return Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) if error.kind() != std::io::ErrorKind::PermissionDenied => {
            return Err(NativeStorageError::io(error));
        }
        Err(_) => {}
    }
    let metadata = match fs::symlink_metadata(target) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(NativeStorageError::io(error)),
    };
    if metadata.is_dir() {
        fs::remove_dir(target).map_err(NativeStorageError::io)?;
        return Ok(true);
    }
    clear_readonly(target, &metadata)?;
    fs::remove_file(target).map_err(|error| {
        NativeStorageError::new(
            NativeStorageErrorCode::Io,
            format!(
                "cannot remove rolled-back path {}: {error}",
                target.to_string_lossy()
            ),
        )
    })?;
    Ok(true)
}

fn rollback_step(step: &str, error: &NativeStorageError) -> NativeStorageError {
    NativeStorageError::new(
        error.code(),
        format!("recovery failed while {step}: {error}"),
    )
}

fn restore_captures(
    collection_root: &Path,
    transaction_root: &Path,
    captures: &[Capture],
) -> Result<(), NativeStorageError> {
    for capture in captures.iter().rev() {
        let relative = safe_relative_path(&capture.path)?;
        let target = collection_root.join(&relative);
        if !capture.present {
            match remove_capture_target(&target) {
                Ok(true) => sync_parent(&target)?,
                Ok(false) => {}
                Err(error) => return Err(error),
            }
            continue;
        }
        let backup = capture.backup.as_deref().ok_or_else(|| {
            NativeStorageError::new(
                NativeStorageErrorCode::CorruptMetadata,
                "present transaction capture has no backup",
            )
        })?;
        let backup = transaction_root.join(safe_relative_path(backup)?);
        let step = |name: &str, error: &NativeStorageError| {
            NativeStorageError::new(
                error.code(),
                format!("{name} {}: {error}", target.to_string_lossy()),
            )
        };
        ensure_plain_parent(
            collection_root,
            target.parent().expect("capture has parent"),
        )
        .map_err(|error| step("preparing the parent of", &error))?;
        copy_durable(&backup, &target)
            .map_err(|error| step("restoring the before-image of", &error))?;
        restore_attributes(&target, capture.xattrs.as_deref().unwrap_or_default())
            .map_err(|error| step("restoring the attributes of", &error))?;
        if let Some(mode) = capture.mode {
            set_mode(&target, mode).map_err(|error| step("restoring the mode of", &error))?;
        }
        sync_parent(&target).map_err(|error| step("flushing the parent of", &error))?;
    }
    Ok(())
}

fn cleanup_orphan_transactions(
    writer: &NativeWriteRoot,
    collection: &super::NativeCollection,
) -> Result<(), NativeStorageError> {
    let state = generation_path(writer, collection);
    let Some(root) = state.parent() else {
        return Ok(());
    };
    if !root.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(root).map_err(NativeStorageError::io)? {
        let entry = entry.map_err(NativeStorageError::io)?;
        if entry.file_name() == "state.json" {
            continue;
        }
        if entry.file_type().map_err(NativeStorageError::io)?.is_dir() {
            remove_dir_durable(&entry.path())?;
        }
    }
    Ok(())
}

fn ensure_directory(root: &NativeRoot, path: &Path) -> Result<(), NativeStorageError> {
    if path_exists_no_follow(path)? {
        root.verify_path(path, ExpectedType::Directory)?;
        return Ok(());
    }
    let parent = path.parent().ok_or_else(|| {
        NativeStorageError::new(
            NativeStorageErrorCode::UnsafePath,
            "storage directory has no parent",
        )
    })?;
    if parent != root.path() {
        ensure_directory(root, parent)?;
    }
    match fs::create_dir(path) {
        Ok(()) => sync_parent(path)?,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(NativeStorageError::io(error)),
    }
    root.verify_path(path, ExpectedType::Directory)?;
    Ok(())
}

fn ensure_plain_parent(root: &Path, target: &Path) -> Result<(), NativeStorageError> {
    let relative = target.strip_prefix(root).map_err(|_| {
        NativeStorageError::new(
            NativeStorageErrorCode::UnsafePath,
            "rollback target escapes collection root",
        )
    })?;
    let mut current = root.to_owned();
    for component in relative.components() {
        let std::path::Component::Normal(segment) = component else {
            return Err(NativeStorageError::new(
                NativeStorageErrorCode::UnsafePath,
                "rollback path is not normal",
            ));
        };
        current.push(segment);
        if current.exists() {
            let metadata = fs::symlink_metadata(&current).map_err(NativeStorageError::io)?;
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err(NativeStorageError::new(
                    NativeStorageErrorCode::UnsafePath,
                    "rollback parent contains a link or non-directory",
                ));
            }
        } else {
            fs::create_dir(&current).map_err(NativeStorageError::io)?;
            sync_parent(&current)?;
        }
    }
    Ok(())
}

fn durable_replace(path: &Path, bytes: &[u8]) -> Result<(), NativeStorageError> {
    failpoint("before-file-write")?;
    let scratch = sibling_scratch(path);
    write_new_synced(&scratch, bytes)?;
    failpoint("after-file-sync")?;
    fs::rename(&scratch, path).map_err(NativeStorageError::io)?;
    failpoint("after-file-rename")?;
    sync_parent(path)
}

fn overwrite_in_place(path: &Path, bytes: &[u8]) -> Result<(), NativeStorageError> {
    failpoint("before-file-write")?;
    let metadata = fs::symlink_metadata(path).map_err(NativeStorageError::io)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(NativeStorageError::new(
            NativeStorageErrorCode::UnsafePath,
            "overwrite target is not a regular non-link file",
        ));
    }
    let mut file = OpenOptions::new()
        .write(true)
        .truncate(true)
        .open(path)
        .map_err(NativeStorageError::io)?;
    file.write_all(bytes).map_err(NativeStorageError::io)?;
    crate::sync_handle(&file).map_err(NativeStorageError::io)?;
    failpoint("after-file-sync")?;
    sync_parent(path)
}

fn raw_file_index_fields(
    identifier: &str,
    stored: &super::StoredRawFile,
) -> Result<Map<String, Value>, NativeStorageError> {
    let timestamps = decode_ttid(identifier).map_err(|error| {
        NativeStorageError::new(
            NativeStorageErrorCode::InvalidDocumentId,
            format!("raw-file TTID is invalid: {error}"),
        )
    })?;
    let mut fields = Map::new();
    fields.insert(
        "name".into(),
        Value::String(format!("{identifier}{}", stored.extension)),
    );
    fields.insert("key".into(), Value::String(stored.key.clone()));
    fields.insert("extension".into(), Value::String(stored.extension.clone()));
    fields.insert(
        "contentType".into(),
        Value::String(stored.content_type.clone()),
    );
    fields.insert(
        "contentLength".into(),
        Value::from(u64::try_from(stored.bytes.len()).map_err(|_| {
            NativeStorageError::new(
                NativeStorageErrorCode::FileTooLarge,
                "raw-file length does not fit the index format",
            )
        })?),
    );
    fields.insert("etag".into(), Value::String(stored.checksum_sha256.clone()));
    fields.insert(
        "checksumSHA256".into(),
        Value::String(stored.checksum_sha256.clone()),
    );
    fields.insert("createdAt".into(), Value::from(timestamps.created_at));
    fields.insert("lastModified".into(), Value::from(stored.modified_millis));
    if !stored.custom_metadata.is_empty() {
        fields.insert(
            "meta".into(),
            Value::Object(
                stored
                    .custom_metadata
                    .iter()
                    .map(|(name, value)| (name.clone(), value.clone()))
                    .collect(),
            ),
        );
    }
    Ok(fields)
}

fn validate_custom_metadata(
    metadata: &std::collections::BTreeMap<String, Value>,
) -> Result<(), NativeStorageError> {
    let mut total = 0_usize;
    for (name, value) in metadata {
        if name.is_empty()
            || name.len() > 64
            || name.contains('\0')
            || name.contains('/')
            || name.contains('\\')
        {
            return Err(NativeStorageError::new(
                NativeStorageErrorCode::CorruptMetadata,
                "raw-file custom metadata name is invalid",
            ));
        }
        let encoded = serde_json::to_vec(value).map_err(|error| json_error(&error))?;
        if encoded.len() > super::MAX_META_VALUE_BYTES {
            return Err(NativeStorageError::new(
                NativeStorageErrorCode::FileTooLarge,
                "raw-file custom metadata value exceeds 60 KiB",
            ));
        }
        total = total
            .checked_add(name.len())
            .and_then(|value| value.checked_add(encoded.len()))
            .ok_or_else(|| {
                NativeStorageError::new(
                    NativeStorageErrorCode::FileTooLarge,
                    "raw-file custom metadata size overflow",
                )
            })?;
        if total > super::MAX_FILE_METADATA_BYTES {
            return Err(NativeStorageError::new(
                NativeStorageErrorCode::FileTooLarge,
                "raw-file custom metadata exceeds 1 MiB",
            ));
        }
    }
    Ok(())
}

fn require_write_access(
    descriptor: Option<super::AccessDescriptor>,
    actor: Option<&WriteActor>,
) -> Result<(), NativeStorageError> {
    let Some(descriptor) = descriptor else {
        return Ok(());
    };
    let bits = match actor {
        Some(actor) if actor.uid == descriptor.uid => (descriptor.mode >> 6) & 0o7,
        Some(actor) if actor.groups.contains(&descriptor.gid) => (descriptor.mode >> 3) & 0o7,
        _ => descriptor.mode & 0o7,
    };
    if bits & 0o2 != 0 {
        Ok(())
    } else {
        Err(NativeStorageError::new(
            NativeStorageErrorCode::PermissionDenied,
            "portable FYLO access descriptor denied the mutation",
        ))
    }
}

#[cfg(unix)]
fn remove_fylo_attribute(path: &Path, name: &str) -> Result<(), NativeStorageError> {
    use xattr::FileExt;

    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .map_err(NativeStorageError::io)?;
    match file.remove_xattr(name) {
        Ok(()) => {}
        Err(error) if missing_xattr(&error) => return Ok(()),
        Err(error) => return Err(NativeStorageError::io(error)),
    }
    crate::sync_handle(&file).map_err(NativeStorageError::io)?;
    failpoint("after-metadata-write")
}

#[cfg(unix)]
fn missing_xattr(error: &std::io::Error) -> bool {
    if error.kind() == std::io::ErrorKind::NotFound {
        return true;
    }
    // `xattr` preserves the platform errno for an absent name. Darwin's
    // ENOATTR and Linux/Android's ENODATA are both ErrorKind::Other.
    #[cfg(target_vendor = "apple")]
    if error.raw_os_error() == Some(93) {
        return true;
    }
    #[cfg(any(target_os = "linux", target_os = "android"))]
    if error.raw_os_error() == Some(61) {
        return true;
    }
    false
}

#[cfg(windows)]
fn remove_fylo_attribute(path: &Path, name: &str) -> Result<(), NativeStorageError> {
    use std::ffi::OsString;

    let mut stream = OsString::from(path.as_os_str());
    stream.push(":fylo.xattrs");
    let stream = PathBuf::from(stream);
    let mut attributes: std::collections::BTreeMap<String, String> = match fs::read(&stream) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|error| {
            NativeStorageError::new(
                NativeStorageErrorCode::CorruptMetadata,
                format!("Windows FYLO ADS manifest is corrupt: {error}"),
            )
        })?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(NativeStorageError::io(error)),
    };
    if attributes.remove(name).is_none() {
        return Ok(());
    }
    let encoded = serde_json::to_vec(&attributes).map_err(|error| json_error(&error))?;
    let mut file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(stream)
        .map_err(NativeStorageError::io)?;
    file.write_all(&encoded).map_err(NativeStorageError::io)?;
    crate::sync_handle(&file).map_err(NativeStorageError::io)?;
    failpoint("after-metadata-write")
}

/// Drop one attribute from the record's sidecar, removing the file with the
/// last entry so an attribute-free record leaves nothing behind.
#[cfg(all(
    not(unix),
    not(windows),
    not(all(target_arch = "wasm32", target_os = "unknown"))
))]
fn remove_fylo_attribute(path: &Path, name: &str) -> Result<(), NativeStorageError> {
    let sidecar = super::sidecar_path(path);
    let mut attributes = read_sidecar(&sidecar)?;
    if attributes.remove(name).is_none() {
        return Ok(());
    }
    write_sidecar(&sidecar, &attributes)
}

/// Drop one attribute from the host's manifest.
#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
fn remove_fylo_attribute(path: &Path, name: &str) -> Result<(), NativeStorageError> {
    let mut attributes = read_host_manifest(path)?;
    if attributes.remove(name).is_none() {
        return Ok(());
    }
    write_host_manifest(path, &attributes)
}

#[cfg(unix)]
fn write_fylo_attribute(path: &Path, name: &str, value: &[u8]) -> Result<(), NativeStorageError> {
    use xattr::FileExt;

    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .map_err(NativeStorageError::io)?;
    file.set_xattr(name, value)
        .map_err(NativeStorageError::io)?;
    crate::sync_handle(&file).map_err(NativeStorageError::io)?;
    failpoint("after-metadata-write")
}

#[cfg(windows)]
fn write_fylo_attribute(path: &Path, name: &str, value: &[u8]) -> Result<(), NativeStorageError> {
    use std::ffi::OsString;

    let mut stream = OsString::from(path.as_os_str());
    stream.push(":fylo.xattrs");
    let stream = PathBuf::from(stream);
    let mut attributes: std::collections::BTreeMap<String, String> = match fs::read(&stream) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|error| {
            NativeStorageError::new(
                NativeStorageErrorCode::CorruptMetadata,
                format!("Windows FYLO ADS manifest is corrupt: {error}"),
            )
        })?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            std::collections::BTreeMap::default()
        }
        Err(error) => return Err(NativeStorageError::io(error)),
    };
    attributes.insert(name.into(), BASE64.encode(value));
    let encoded = serde_json::to_vec(&attributes).map_err(|error| json_error(&error))?;
    let mut file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(stream)
        .map_err(NativeStorageError::io)?;
    file.write_all(&encoded).map_err(NativeStorageError::io)?;
    crate::sync_handle(&file).map_err(NativeStorageError::io)?;
    failpoint("after-metadata-write")
}

/// Write one attribute into the record's sidecar.
///
/// Read-modify-write of a whole manifest rather than a single-name update: the
/// record's attributes are a handful of small values, and a durable replace of
/// the whole file is both simpler and atomic where a partial rewrite would not
/// be. Windows does the same thing to its alternate data stream.
#[cfg(all(
    not(unix),
    not(windows),
    not(all(target_arch = "wasm32", target_os = "unknown"))
))]
fn write_fylo_attribute(path: &Path, name: &str, value: &[u8]) -> Result<(), NativeStorageError> {
    let sidecar = super::sidecar_path(path);
    let mut attributes = read_sidecar(&sidecar)?;
    attributes.insert(name.into(), BASE64.encode(value));
    write_sidecar(&sidecar, &attributes)
}

/// Store one attribute through the host.
///
/// The host owns the manifest's location, so a browser root keeps no file
/// beside the record. Read-modify-write of the whole manifest, as Windows does
/// to its alternate data stream: a record's attributes are a handful of small
/// values and replacing all of them is atomic where a partial update is not.
#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
fn write_fylo_attribute(path: &Path, name: &str, value: &[u8]) -> Result<(), NativeStorageError> {
    let mut attributes = read_host_manifest(path)?;
    attributes.insert(name.into(), BASE64.encode(value));
    write_host_manifest(path, &attributes)
}

#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
fn read_host_manifest(
    path: &Path,
) -> Result<std::collections::BTreeMap<String, String>, NativeStorageError> {
    let bytes = fylo_vfs::host_read_attrs(path).map_err(NativeStorageError::io)?;
    if bytes.is_empty() {
        return Ok(std::collections::BTreeMap::default());
    }
    serde_json::from_slice(&bytes).map_err(|error| {
        NativeStorageError::new(
            NativeStorageErrorCode::CorruptMetadata,
            format!("FYLO attribute manifest is corrupt: {error}"),
        )
    })
}

#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
fn write_host_manifest(
    path: &Path,
    attributes: &std::collections::BTreeMap<String, String>,
) -> Result<(), NativeStorageError> {
    let encoded = if attributes.is_empty() {
        Vec::new()
    } else {
        serde_json::to_vec(attributes).map_err(|error| json_error(&error))?
    };
    fylo_vfs::host_write_attrs(path, &encoded).map_err(NativeStorageError::io)?;
    failpoint("after-metadata-write")
}

#[cfg(all(
    not(unix),
    not(windows),
    not(all(target_arch = "wasm32", target_os = "unknown"))
))]
fn read_sidecar(
    sidecar: &Path,
) -> Result<std::collections::BTreeMap<String, String>, NativeStorageError> {
    match fs::read(sidecar) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|error| {
            NativeStorageError::new(
                NativeStorageErrorCode::CorruptMetadata,
                format!("FYLO attribute sidecar is corrupt: {error}"),
            )
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(std::collections::BTreeMap::default())
        }
        Err(error) => Err(NativeStorageError::io(error)),
    }
}

#[cfg(all(
    not(unix),
    not(windows),
    not(all(target_arch = "wasm32", target_os = "unknown"))
))]
fn write_sidecar(
    sidecar: &Path,
    attributes: &std::collections::BTreeMap<String, String>,
) -> Result<(), NativeStorageError> {
    if attributes.is_empty() {
        match fs::remove_file(sidecar) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(NativeStorageError::io(error)),
        }
        return failpoint("after-metadata-write");
    }
    let encoded = serde_json::to_vec(attributes).map_err(|error| json_error(&error))?;
    durable_replace(sidecar, &encoded)?;
    failpoint("after-metadata-write")
}

fn copy_durable(source: &Path, target: &Path) -> Result<(), NativeStorageError> {
    let source = File::open(source).map_err(NativeStorageError::io)?;
    let metadata = source.metadata().map_err(NativeStorageError::io)?;
    if !metadata.is_file() {
        return Err(NativeStorageError::new(
            NativeStorageErrorCode::WrongType,
            "transaction backup source is not a regular file",
        ));
    }
    if metadata.len() > super::MAX_RAW_FILE_BYTES {
        return Err(NativeStorageError::new(
            NativeStorageErrorCode::FileTooLarge,
            "transaction backup exceeds the raw-file limit",
        ));
    }
    let scratch = sibling_scratch(target);
    let mut output = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&scratch)
        .map_err(NativeStorageError::io)?;
    std::io::copy(&mut source.take(super::MAX_RAW_FILE_BYTES + 1), &mut output)
        .map_err(NativeStorageError::io)?;
    crate::sync_handle(&output).map_err(NativeStorageError::io)?;
    drop(output);
    // Windows replaces an existing destination only when it is writable, and a
    // retained tombstone is not, so restoring a before-image over one fails
    // with "Access is denied" where POSIX simply renames.
    if let Ok(existing) = fs::symlink_metadata(target) {
        clear_readonly(target, &existing)?;
    }
    fs::rename(scratch, target).map_err(NativeStorageError::io)?;
    sync_parent(target)
}

/// Append to an existing durable file without rewriting it.
///
/// A torn tail is expected rather than guarded against: the index reader stops
/// at the last complete line, so a crash mid-append loses the entry it was
/// writing and nothing before it.
fn append_synced(path: &Path, bytes: &[u8]) -> Result<(), NativeStorageError> {
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(NativeStorageError::io)?;
    file.write_all(bytes).map_err(NativeStorageError::io)?;
    crate::sync_handle(&file).map_err(NativeStorageError::io)
}

fn write_new_synced(path: &Path, bytes: &[u8]) -> Result<(), NativeStorageError> {
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(path)
        .map_err(NativeStorageError::io)?;
    file.write_all(bytes).map_err(NativeStorageError::io)?;
    crate::sync_handle(&file).map_err(NativeStorageError::io)
}

fn write_json_durable(path: &Path, value: &impl Serialize) -> Result<(), NativeStorageError> {
    let mut bytes = serde_json::to_vec(value).map_err(|error| json_error(&error))?;
    bytes.push(b'\n');
    durable_replace(path, &bytes)
}

fn read_bounded_json<T: for<'de> Deserialize<'de>>(
    path: &Path,
    max_bytes: u64,
) -> Result<T, NativeStorageError> {
    let metadata = fs::symlink_metadata(path).map_err(NativeStorageError::io)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > max_bytes {
        return Err(NativeStorageError::new(
            NativeStorageErrorCode::CorruptMetadata,
            "bounded JSON target is unsafe or oversized",
        ));
    }
    let capacity = usize::try_from(metadata.len()).map_err(|_| {
        NativeStorageError::new(
            NativeStorageErrorCode::FileTooLarge,
            "bounded JSON size does not fit this platform",
        )
    })?;
    let mut bytes = Vec::with_capacity(capacity);
    File::open(path)
        .map_err(NativeStorageError::io)?
        .take(max_bytes + 1)
        .read_to_end(&mut bytes)
        .map_err(NativeStorageError::io)?;
    if bytes.len() as u64 > max_bytes {
        return Err(NativeStorageError::new(
            NativeStorageErrorCode::FileTooLarge,
            "bounded JSON target grew beyond its limit",
        ));
    }
    serde_json::from_slice(&bytes).map_err(|error| {
        NativeStorageError::new(
            NativeStorageErrorCode::CorruptMetadata,
            format!("bounded JSON target is corrupt: {error}"),
        )
    })
}

/// Write a file only when it does not already exist.
///
/// Creating a collection that is partly there must finish it without touching
/// what is already correct: rewriting a populated index with an empty snapshot
/// would discard every key in it.
fn write_if_missing(path: &Path, bytes: &[u8]) -> Result<(), NativeStorageError> {
    if path_exists_no_follow(path)? {
        return Ok(());
    }
    durable_replace(path, bytes)
}

fn now_millis() -> Result<u64, NativeStorageError> {
    let millis = super::wall_clock()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| {
            NativeStorageError::new(
                NativeStorageErrorCode::Io,
                format!("system clock is before the Unix epoch: {error}"),
            )
        })?
        .as_millis();
    u64::try_from(millis).map_err(|_| {
        NativeStorageError::new(
            NativeStorageErrorCode::Io,
            "system clock exceeds the metadata timestamp range",
        )
    })
}

fn remove_dir_durable(path: &Path) -> Result<(), NativeStorageError> {
    let parent = path.parent().map(Path::to_owned);
    fs::remove_dir_all(path).map_err(NativeStorageError::io)?;
    if let Some(parent) = parent {
        sync_directory(&parent)?;
    }
    Ok(())
}

fn sync_parent(path: &Path) -> Result<(), NativeStorageError> {
    let parent = path.parent().ok_or_else(|| {
        NativeStorageError::new(NativeStorageErrorCode::Io, "storage path has no parent")
    })?;
    sync_directory(parent)
}

/// Force a file's modification time back to the value a checksum stamp
/// recorded, so the stamp and the file agree on every platform.
fn restore_modified(path: &Path, recorded: &fs::Metadata) -> Result<(), NativeStorageError> {
    let modified = recorded.modified().map_err(NativeStorageError::io)?;
    let file = OpenOptions::new()
        .write(true)
        .open(path)
        .map_err(NativeStorageError::io)?;
    let times = fs::FileTimes::new()
        .set_accessed(modified)
        .set_modified(modified);
    file.set_times(times).map_err(NativeStorageError::io)
}

fn sync_directory(path: &Path) -> Result<(), NativeStorageError> {
    let directory = open_directory(path).map_err(NativeStorageError::io)?;
    match crate::sync_handle(&directory) {
        Ok(()) => Ok(()),
        // Some filesystems refuse to flush a directory handle, and WASI has no
        // directory sync at all. The rename that preceded this call is still
        // atomic, so the operation stands. A platform that *can* flush and
        // fails for another reason still surfaces the error.
        Err(error) if cfg!(windows) || error.kind() == std::io::ErrorKind::Unsupported => {
            let _ = error;
            Ok(())
        }
        Err(error) => Err(NativeStorageError::io(error)),
    }
}

/// Windows refuses `CreateFile` on a directory without backup semantics, so a
/// plain `File::open` fails with "Access is denied" and every durable rename
/// would lose its parent flush. The flag is the documented way to obtain a
/// directory handle and is available through safe `std`.
#[cfg(windows)]
fn open_directory(path: &Path) -> std::io::Result<File> {
    use std::os::windows::fs::OpenOptionsExt;

    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
    OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
        .open(path)
}

#[cfg(not(windows))]
fn open_directory(path: &Path) -> std::io::Result<File> {
    File::open(path)
}

fn sibling_scratch(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("fylo");
    path.with_file_name(format!("{name}.{}.tmp", unique_name("rust")))
}

pub(crate) fn unique_name(prefix: &str) -> String {
    let sequence = UNIQUE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let nanos = super::wall_clock()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{prefix}-{}-{nanos:x}-{sequence:x}", super::process_id())
}

pub(crate) fn unix_millis() -> Result<u64, NativeStorageError> {
    // `SystemTime::now` panics rather than fails on a target with no clock, so
    // the host supplies one there. Every other target keeps `std`.
    #[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
    {
        return fylo_vfs::host_now_unix_ms().map_err(|message| {
            NativeStorageError::new(NativeStorageErrorCode::Io, message.to_owned())
        });
    }
    #[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
    {
        unix_millis_from_std()
    }
}

#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
fn unix_millis_from_std() -> Result<u64, NativeStorageError> {
    let millis = super::wall_clock()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| {
            NativeStorageError::new(
                NativeStorageErrorCode::Io,
                format!("system clock predates the Unix epoch: {error}"),
            )
        })?
        .as_millis();
    u64::try_from(millis).map_err(|_| {
        NativeStorageError::new(
            NativeStorageErrorCode::Io,
            "system timestamp exceeds the supported range",
        )
    })
}

fn portable_path(path: &Path) -> Result<String, NativeStorageError> {
    let value = path.to_str().ok_or_else(|| {
        NativeStorageError::new(
            NativeStorageErrorCode::UnsafePath,
            "transaction path is not valid UTF-8",
        )
    })?;
    Ok(value.replace(std::path::MAIN_SEPARATOR, "/"))
}

fn safe_relative_path(value: &str) -> Result<PathBuf, NativeStorageError> {
    if value.is_empty() || value.contains('\0') || value.contains('\\') {
        return Err(NativeStorageError::new(
            NativeStorageErrorCode::UnsafePath,
            "transaction path is not a canonical portable relative path",
        ));
    }
    let path = PathBuf::from(value);
    if path.has_root()
        || path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        return Err(NativeStorageError::new(
            NativeStorageErrorCode::UnsafePath,
            "transaction path escapes its root",
        ));
    }
    Ok(path)
}

fn validate_transaction_segment(value: &str) -> Result<(), NativeStorageError> {
    if value.is_empty()
        || value.len() > 128
        || value.contains('\0')
        || Path::new(value).file_name() != Some(std::ffi::OsStr::new(value))
    {
        return Err(NativeStorageError::new(
            NativeStorageErrorCode::CorruptMetadata,
            "transaction identifier is not a safe path segment",
        ));
    }
    Ok(())
}

fn modified_millis(metadata: &fs::Metadata) -> Result<f64, NativeStorageError> {
    let duration = metadata
        .modified()
        .map_err(NativeStorageError::io)?
        .duration_since(UNIX_EPOCH)
        .map_err(|error| {
            NativeStorageError::new(
                NativeStorageErrorCode::CorruptMetadata,
                format!("file modification time predates the Unix epoch: {error}"),
            )
        })?;
    Ok(duration.as_secs_f64() * 1000.0)
}

#[cfg(unix)]
fn native_mode(metadata: &fs::Metadata) -> u32 {
    use std::os::unix::fs::MetadataExt;
    metadata.mode() & 0o777
}

#[cfg(windows)]
fn native_mode(_metadata: &fs::Metadata) -> u32 {
    0o666
}

#[cfg(not(any(unix, windows)))]
fn native_mode(_metadata: &fs::Metadata) -> u32 {
    0o600
}

#[cfg(unix)]
fn capture_attributes(path: &Path) -> Result<Vec<CapturedAttribute>, NativeStorageError> {
    use xattr::FileExt;

    let file = File::open(path).map_err(NativeStorageError::io)?;
    let mut attributes = Vec::new();
    for name in file.list_xattr().map_err(NativeStorageError::io)? {
        let name = name.to_str().ok_or_else(|| {
            NativeStorageError::new(
                NativeStorageErrorCode::CorruptMetadata,
                "transaction xattr name is not valid UTF-8",
            )
        })?;
        let Some(value) = file.get_xattr(name).map_err(NativeStorageError::io)? else {
            continue;
        };
        attributes.push(CapturedAttribute {
            name: name.into(),
            value: BASE64.encode(value),
        });
    }
    Ok(attributes)
}

// The signature mirrors the Unix implementation so callers stay platform-free.
#[allow(clippy::unnecessary_wraps)]
#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
fn capture_attributes(path: &Path) -> Result<Vec<CapturedAttribute>, NativeStorageError> {
    Ok(read_host_manifest(path)?
        .into_iter()
        .map(|(name, value)| CapturedAttribute { name, value })
        .collect())
}

#[cfg(all(
    not(unix),
    not(windows),
    not(all(target_arch = "wasm32", target_os = "unknown"))
))]
fn capture_attributes(_path: &Path) -> Result<Vec<CapturedAttribute>, NativeStorageError> {
    // The sidecar is captured as a file in its own right, so its contents are
    // already covered by the transaction's before-image.
    Ok(Vec::new())
}

/// Capture a record's alternate data stream so a rollback can restore it.
///
/// FYLO metadata lives in one JSON manifest stream on NTFS rather than in
/// per-name xattrs, and its values are already base64, so the manifest maps
/// directly onto the captured form the Unix path produces.
#[cfg(windows)]
fn capture_attributes(path: &Path) -> Result<Vec<CapturedAttribute>, NativeStorageError> {
    Ok(read_attribute_stream(path)?
        .into_iter()
        .map(|(name, value)| CapturedAttribute { name, value })
        .collect())
}

/// Restore a record's alternate data stream from its before-image.
///
/// The stream is replaced wholesale, and removed when the before-image had
/// none, so a rolled-back mutation cannot leave an attribute it added behind.
#[cfg(windows)]
fn restore_attributes(
    path: &Path,
    attributes: &[CapturedAttribute],
) -> Result<(), NativeStorageError> {
    let stream = attribute_stream_path(path);
    if attributes.is_empty() {
        match fs::remove_file(&stream) {
            Ok(()) => return Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(NativeStorageError::io(error)),
        }
    }
    let manifest: std::collections::BTreeMap<String, String> = attributes
        .iter()
        .map(|attribute| (attribute.name.clone(), attribute.value.clone()))
        .collect();
    let encoded = serde_json::to_vec(&manifest).map_err(|error| json_error(&error))?;
    let mut file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(stream)
        .map_err(NativeStorageError::io)?;
    file.write_all(&encoded).map_err(NativeStorageError::io)?;
    crate::sync_handle(&file).map_err(NativeStorageError::io)
}

/// Path of the FYLO metadata stream beside a record.
#[cfg(windows)]
fn attribute_stream_path(path: &Path) -> PathBuf {
    use std::ffi::OsString;

    let mut stream = OsString::from(path.as_os_str());
    stream.push(":fylo.xattrs");
    PathBuf::from(stream)
}

/// Read the FYLO metadata stream, treating an absent one as empty.
#[cfg(windows)]
fn read_attribute_stream(
    path: &Path,
) -> Result<std::collections::BTreeMap<String, String>, NativeStorageError> {
    match fs::read(attribute_stream_path(path)) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|error| {
            NativeStorageError::new(
                NativeStorageErrorCode::CorruptMetadata,
                format!("Windows FYLO ADS manifest is corrupt: {error}"),
            )
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(std::collections::BTreeMap::new())
        }
        Err(error) => Err(NativeStorageError::io(error)),
    }
}

#[cfg(unix)]
fn restore_attributes(
    path: &Path,
    attributes: &[CapturedAttribute],
) -> Result<(), NativeStorageError> {
    use xattr::FileExt;

    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .map_err(NativeStorageError::io)?;
    for name in file.list_xattr().map_err(NativeStorageError::io)? {
        file.remove_xattr(&name).map_err(NativeStorageError::io)?;
    }
    for attribute in attributes {
        let value = BASE64.decode(&attribute.value).map_err(|error| {
            NativeStorageError::new(
                NativeStorageErrorCode::CorruptMetadata,
                format!("transaction xattr is not canonical base64: {error}"),
            )
        })?;
        if BASE64.encode(&value) != attribute.value {
            return Err(NativeStorageError::new(
                NativeStorageErrorCode::CorruptMetadata,
                "transaction xattr is not canonical base64",
            ));
        }
        file.set_xattr(&attribute.name, &value)
            .map_err(NativeStorageError::io)?;
    }
    Ok(())
}

#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
fn restore_attributes(
    path: &Path,
    attributes: &[CapturedAttribute],
) -> Result<(), NativeStorageError> {
    write_host_manifest(
        path,
        &attributes
            .iter()
            .map(|attribute| (attribute.name.clone(), attribute.value.clone()))
            .collect(),
    )
}

#[cfg(all(
    not(unix),
    not(windows),
    not(all(target_arch = "wasm32", target_os = "unknown"))
))]
fn restore_attributes(
    _path: &Path,
    attributes: &[CapturedAttribute],
) -> Result<(), NativeStorageError> {
    if attributes.is_empty() {
        Ok(())
    } else {
        Err(NativeStorageError::new(
            NativeStorageErrorCode::Unsupported,
            "transaction metadata restoration is unavailable on this platform",
        ))
    }
}

#[cfg(unix)]
fn apply_access(path: &Path, access: WriteAccess) -> Result<(), NativeStorageError> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt, chown};
    use xattr::FileExt;

    if access.is_empty() {
        return Ok(());
    }
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .map_err(NativeStorageError::io)?;
    let metadata = file.metadata().map_err(NativeStorageError::io)?;
    let uid = access.uid.unwrap_or(metadata.uid());
    let gid = access.gid.unwrap_or(metadata.gid());
    let mode = access.mode.unwrap_or(DEFAULT_ACCESS_MODE);
    let descriptor = super::AccessDescriptor {
        version: 1,
        uid,
        gid,
        mode,
    };
    let encoded = serde_json::to_vec(&descriptor).map_err(|error| json_error(&error))?;
    file.set_xattr(super::ACCESS_XATTR, &encoded)
        .map_err(NativeStorageError::io)?;
    failpoint("after-access-marker")?;
    chown(path, Some(uid), Some(gid)).map_err(NativeStorageError::io)?;
    failpoint("after-chown")?;
    fs::set_permissions(path, fs::Permissions::from_mode(mode)).map_err(NativeStorageError::io)?;
    failpoint("after-chmod")?;
    crate::sync_handle(&file).map_err(NativeStorageError::io)
}

#[cfg(not(unix))]
fn apply_access(_path: &Path, access: WriteAccess) -> Result<(), NativeStorageError> {
    if access.is_empty() {
        Ok(())
    } else {
        Err(NativeStorageError::new(
            NativeStorageErrorCode::Unsupported,
            "UID/GID/mode access control is available only on POSIX platforms",
        ))
    }
}

#[cfg(unix)]
fn set_mode(path: &Path, mode: u32) -> Result<(), NativeStorageError> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(mode)).map_err(NativeStorageError::io)
}

// The signature mirrors the Unix implementation so callers stay platform-free.
#[allow(clippy::unnecessary_wraps)]
#[cfg(not(unix))]
fn set_mode(_path: &Path, _mode: u32) -> Result<(), NativeStorageError> {
    Ok(())
}

/// Every durable transition a crash test may interrupt.
///
/// The list is the contract the crash matrix enumerates, so a new failpoint
/// must be declared here to be injectable — which is also what stops it from
/// being added without coverage.
pub const FAILPOINTS: [&str; 15] = [
    "before-file-write",
    "after-file-rename",
    "after-file-sync",
    "after-capture",
    "after-state-writing",
    "after-metadata-write",
    "after-access-marker",
    "after-chown",
    "after-chmod",
    "after-delete-rename",
    "after-restore-rename",
    "after-reshard-rename",
    "before-commit-marker",
    "after-commit-marker",
    "after-commit-object",
];

fn failpoint(name: &str) -> Result<(), NativeStorageError> {
    debug_assert!(
        FAILPOINTS.contains(&name),
        "undeclared failpoint: {name}; add it to FAILPOINTS so the crash matrix covers it"
    );
    if std::env::var("FYLO_RUST_FAILPOINT").ok().as_deref() != Some(name) {
        return Ok(());
    }
    match std::env::var("FYLO_RUST_FAILPOINT_ACTION").ok().as_deref() {
        Some("abort") => std::process::abort(),
        Some("panic") => panic!("FYLO Rust failpoint: {name}"),
        // A full volume is the failure a durable writer is most likely to meet
        // and least likely to be tested against, and it is an ordinary I/O
        // error rather than a lost process: the writer must roll back in place
        // and leave nothing for recovery to do.
        Some("enospc") => Err(NativeStorageError::io(std::io::Error::from_raw_os_error(
            DISK_FULL_ERRNO,
        ))),
        // A filesystem or project quota can be exhausted while the underlying
        // volume still has free blocks. It follows the same in-process
        // rollback contract as ENOSPC, but carries a distinct native error so
        // the matrix proves neither platform path is accidentally special.
        Some("edquot") => Err(NativeStorageError::io(std::io::Error::from_raw_os_error(
            DISK_QUOTA_ERRNO,
        ))),
        _ => Err(NativeStorageError::new(
            NativeStorageErrorCode::Io,
            format!("injected FYLO Rust failpoint: {name}"),
        )),
    }
}

/// `ENOSPC` on Unix, `ERROR_DISK_FULL` on Windows.
#[cfg(windows)]
const DISK_FULL_ERRNO: i32 = 112;
#[cfg(not(windows))]
const DISK_FULL_ERRNO: i32 = 28;

/// `ERROR_DISK_QUOTA_EXCEEDED` on Windows.
#[cfg(windows)]
const DISK_QUOTA_ERRNO: i32 = 1_295;
/// `EDQUOT` on Linux and Android.
#[cfg(any(target_os = "linux", target_os = "android"))]
const DISK_QUOTA_ERRNO: i32 = 122;
/// `EDQUOT` on Darwin and the BSD family supported by Rust.
#[cfg(all(not(windows), not(any(target_os = "linux", target_os = "android"))))]
const DISK_QUOTA_ERRNO: i32 = 69;

fn json_error(error: &serde_json::Error) -> NativeStorageError {
    NativeStorageError::new(
        NativeStorageErrorCode::CorruptMetadata,
        format!("cannot encode native transaction metadata: {error}"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    struct TestRoot(PathBuf);

    impl TestRoot {
        fn create() -> Self {
            let root = std::env::temp_dir().join(unique_name("fylo-native-write"));
            fs::create_dir_all(root.join(".collections/users/docs")).unwrap();
            fs::create_dir_all(root.join(".collections/users/.deleted")).unwrap();
            fs::create_dir_all(root.join(".collections/users/index")).unwrap();
            fs::write(root.join(".collections/users/index/keys.snapshot"), b"").unwrap();
            fs::write(root.join(".collections/users/index/keys.wal"), b"").unwrap();
            Self(root)
        }
    }

    impl Drop for TestRoot {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    #[test]
    fn puts_a_document_with_a_compatible_transaction_generation() {
        let fixture = TestRoot::create();
        let writer = NativeWriteRoot::open(&fixture.0).unwrap();
        writer
            .put_document(
                "users",
                "4VRNF52JPCO",
                br#"{"name":"Ada","score":42}"#,
                PutDocumentOptions::default(),
            )
            .unwrap();
        let collection = writer.root.collection("users").unwrap();
        assert_eq!(
            collection.read_document("4VRNF52JPCO").unwrap().bytes,
            br#"{"name":"Ada","score":42}"#
        );
        assert!(
            fixture
                .0
                .join(".collections/users/docs/O/4VRNF52JPCO.json")
                .is_file()
        );
        assert_eq!(collection.generation().unwrap().generation, 2);
        assert_eq!(
            collection.index_snapshot().unwrap().as_bytes(),
            b"name/eq/Ada/4VRNF52JPCO\nname/f/Ada/4VRNF52JPCO\nname/g3/Ada/4VRNF52JPCO\nname/r/adA/4VRNF52JPCO\nscore/eq/42/4VRNF52JPCO\nscore/n/c045000000000000/4VRNF52JPCO\nscore/nr/3fbaffffffffffff/4VRNF52JPCO\n"
        );
    }

    #[test]
    fn patches_and_soft_deletes_without_changing_the_document_identity() {
        let fixture = TestRoot::create();
        let writer = NativeWriteRoot::open(&fixture.0).unwrap();
        writer
            .put_document(
                "users",
                "4VRNF52JPCO",
                br#"{"name":"Ada","score":42}"#,
                PutDocumentOptions::default(),
            )
            .unwrap();
        writer
            .patch_document(
                "users",
                "4VRNF52JPCO",
                br#"{"name":"Grace","score":50}"#,
                None,
            )
            .unwrap();
        let collection = writer.root.collection("users").unwrap();
        assert_eq!(
            collection.read_document("4VRNF52JPCO").unwrap().bytes,
            br#"{"name":"Grace","score":50}"#
        );
        assert!(
            std::str::from_utf8(collection.index_snapshot().unwrap().as_bytes())
                .unwrap()
                .contains("name/eq/Grace/4VRNF52JPCO")
        );
        writer
            .delete_document("users", "4VRNF52JPCO", None)
            .unwrap();
        assert!(collection.document_ids().unwrap().is_empty());
        assert_eq!(
            collection
                .read_deleted_document("4VRNF52JPCO")
                .unwrap()
                .bytes,
            br#"{"name":"Grace","score":50}"#
        );
        assert!(collection.index_snapshot().unwrap().as_bytes().is_empty());
        assert_eq!(collection.generation().unwrap().generation, 6);
    }

    #[test]
    fn shallow_patch_preserves_unspecified_fields() {
        let fixture = TestRoot::create();
        let writer = NativeWriteRoot::open(&fixture.0).unwrap();
        writer
            .put_document(
                "users",
                "4VRNF52JPCO",
                br#"{"name":"Ada","score":42}"#,
                PutDocumentOptions::default(),
            )
            .unwrap();
        writer
            .patch_document_fields(
                "users",
                "4VRNF52JPCO",
                &serde_json::from_value(json!({"score": 50})).unwrap(),
                None,
            )
            .unwrap();
        assert_eq!(
            writer
                .root
                .collection("users")
                .unwrap()
                .read_document("4VRNF52JPCO")
                .unwrap()
                .bytes,
            br#"{"name":"Ada","score":50}"#
        );
    }

    #[test]
    fn sql_mutations_insert_update_and_delete_atomically() {
        let fixture = TestRoot::create();
        let writer = NativeWriteRoot::open(&fixture.0).unwrap();
        let inserted = writer
            .execute_sql_mutation(
                "INSERT INTO users (name, score) VALUES ('Ada', 42)",
                None,
                WriteAccess::default(),
            )
            .unwrap();
        assert_eq!(inserted.kind, SqlMutationResultKind::Insert);
        assert_eq!(inserted.affected, 1);
        assert_eq!(inserted.identifiers.len(), 1);

        writer
            .put_document(
                "users",
                "4VRNF52JPCO",
                br#"{"name":"Grace","score":42}"#,
                PutDocumentOptions::default(),
            )
            .unwrap();
        let updated = writer
            .execute_sql_mutation(
                "UPDATE users SET score = 50 WHERE score = 42",
                None,
                WriteAccess::default(),
            )
            .unwrap();
        assert_eq!(updated.kind, SqlMutationResultKind::Update);
        assert_eq!(updated.affected, 2);
        for identifier in &updated.identifiers {
            let stored = writer
                .root
                .collection("users")
                .unwrap()
                .read_document(identifier)
                .unwrap();
            assert_eq!(
                parse_document_fields(&stored.bytes).unwrap().get("score"),
                Some(&json!(50))
            );
        }

        let deleted = writer
            .execute_sql_mutation(
                "DELETE FROM users WHERE score = 50",
                None,
                WriteAccess::default(),
            )
            .unwrap();
        assert_eq!(deleted.kind, SqlMutationResultKind::Delete);
        assert_eq!(deleted.affected, 2);
        assert!(
            writer
                .root
                .collection("users")
                .unwrap()
                .document_ids()
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn document_put_writes_initial_metadata_and_skips_null_names() {
        let fixture = TestRoot::create();
        let writer = NativeWriteRoot::open(&fixture.0).unwrap();
        writer
            .put_document(
                "users",
                "4VRNF52JPCO",
                br#"{"name":"Ada"}"#,
                PutDocumentOptions {
                    metadata: serde_json::from_value(json!({
                        "source": "native-put",
                        "absent": null
                    }))
                    .unwrap(),
                    ..PutDocumentOptions::default()
                },
            )
            .unwrap();
        let target = writer
            .root
            .collection("users")
            .unwrap()
            .read_document("4VRNF52JPCO")
            .unwrap()
            .path;
        let file = File::open(&target).unwrap();
        let attributes = super::super::read_fylo_attributes(&file, &target).unwrap();
        assert_eq!(
            attributes.get("user.fylo.meta.source").map(Vec::as_slice),
            Some(&br#""native-put""#[..])
        );
        assert!(!attributes.contains_key("user.fylo.meta.absent"));
    }

    #[test]
    fn metadata_merges_removes_and_advances_the_update_stamp() {
        let fixture = TestRoot::create();
        let writer = NativeWriteRoot::open(&fixture.0).unwrap();
        writer
            .put_document(
                "users",
                "4VRNF52JPCO",
                br#"{"name":"Ada"}"#,
                PutDocumentOptions::default(),
            )
            .unwrap();
        writer
            .set_record_metadata(
                "users",
                "4VRNF52JPCO",
                &serde_json::from_value(json!({"team": "storage", "draft": true})).unwrap(),
                None,
            )
            .unwrap();
        let first = read_meta_stamp(&writer, "4VRNF52JPCO");
        writer
            .set_record_metadata(
                "users",
                "4VRNF52JPCO",
                &serde_json::from_value(json!({"draft": Value::Null})).unwrap(),
                None,
            )
            .unwrap();
        // Removing an already-absent xattr is idempotent on every supported
        // Unix platform; Darwin reports ENOATTR as ErrorKind::Other.
        writer
            .set_record_metadata(
                "users",
                "4VRNF52JPCO",
                &serde_json::from_value(json!({"draft": Value::Null})).unwrap(),
                None,
            )
            .unwrap();
        let target = writer
            .root
            .collection("users")
            .unwrap()
            .read_document("4VRNF52JPCO")
            .unwrap()
            .path;
        let file = File::open(&target).unwrap();
        let attributes = super::super::read_fylo_attributes(&file, &target).unwrap();
        assert!(attributes.contains_key("user.fylo.meta.team"));
        assert!(!attributes.contains_key("user.fylo.meta.draft"));
        assert!(read_meta_stamp(&writer, "4VRNF52JPCO") > first);
    }

    fn read_meta_stamp(writer: &NativeWriteRoot, identifier: &str) -> u64 {
        let target = writer
            .root
            .collection("users")
            .unwrap()
            .read_document(identifier)
            .unwrap()
            .path;
        let file = File::open(&target).unwrap();
        super::super::read_fylo_attributes(&file, &target)
            .unwrap()
            .get(super::super::META_UPDATED_XATTR)
            .map(|value| String::from_utf8_lossy(value).parse::<u64>().unwrap())
            .unwrap()
    }

    #[test]
    fn a_before_image_restores_the_metadata_a_mutation_replaced() {
        let fixture = TestRoot::create();
        let writer = NativeWriteRoot::open(&fixture.0).unwrap();
        writer
            .put_document(
                "users",
                "4VRNF52JPCO",
                br#"{"name":"Ada"}"#,
                PutDocumentOptions::default(),
            )
            .unwrap();
        let target = writer
            .root
            .collection("users")
            .unwrap()
            .read_document("4VRNF52JPCO")
            .unwrap()
            .path;

        write_fylo_attribute(&target, "user.fylo.meta.team", br#""storage""#).unwrap();
        let before = capture_attributes(&target).unwrap();
        assert!(
            before.iter().any(|a| a.name == "user.fylo.meta.team"),
            "the before-image captured no metadata to restore"
        );

        // A mutation replaces one name and adds another.
        write_fylo_attribute(&target, "user.fylo.meta.team", br#""platform""#).unwrap();
        write_fylo_attribute(&target, "user.fylo.meta.draft", b"true").unwrap();

        restore_attributes(&target, &before).unwrap();

        let file = File::open(&target).unwrap();
        let restored = crate::read_fylo_attributes(&file, &target).unwrap();
        assert_eq!(
            restored.get("user.fylo.meta.team").map(Vec::as_slice),
            Some(&br#""storage""#[..]),
            "rollback did not restore the replaced metadata"
        );
        assert!(
            !restored.contains_key("user.fylo.meta.draft"),
            "rollback left behind metadata the mutation added"
        );
    }

    #[test]
    fn replacing_metadata_removes_a_name_the_record_omits() {
        let fixture = TestRoot::create();
        let writer = NativeWriteRoot::open(&fixture.0).unwrap();
        writer
            .put_document(
                "users",
                "4VRNF52JPCO",
                br#"{"name":"Ada"}"#,
                PutDocumentOptions::default(),
            )
            .unwrap();
        writer
            .set_record_metadata(
                "users",
                "4VRNF52JPCO",
                &serde_json::from_value(json!({"team": "storage", "draft": true})).unwrap(),
                None,
            )
            .unwrap();

        // A merge leaves an omitted name alone; a replace is authoritative.
        writer
            .set_record_metadata(
                "users",
                "4VRNF52JPCO",
                &serde_json::from_value(json!({"team": "platform"})).unwrap(),
                None,
            )
            .unwrap();
        let merged = writer
            .root
            .collection("users")
            .unwrap()
            .read_custom_metadata("4VRNF52JPCO")
            .unwrap();
        assert_eq!(merged.get("draft"), Some(&json!(true)));

        writer
            .replace_record_metadata(
                "users",
                "4VRNF52JPCO",
                &serde_json::from_value(json!({"team": "platform"})).unwrap(),
                None,
            )
            .unwrap();
        let replaced = writer
            .root
            .collection("users")
            .unwrap()
            .read_custom_metadata("4VRNF52JPCO")
            .unwrap();
        assert_eq!(replaced.get("team"), Some(&json!("platform")));
        assert!(!replaced.contains_key("draft"));
    }

    #[cfg(unix)]
    #[test]
    fn access_projection_applies_mode_and_then_denies_a_foreign_actor() {
        use std::os::unix::fs::PermissionsExt;

        let fixture = TestRoot::create();
        let writer = NativeWriteRoot::open(&fixture.0).unwrap();
        writer
            .put_document(
                "users",
                "4VRNF52JPCO",
                br#"{"name":"Ada"}"#,
                PutDocumentOptions::default(),
            )
            .unwrap();
        writer
            .set_record_access(
                "users",
                "4VRNF52JPCO",
                WriteAccess {
                    uid: None,
                    gid: None,
                    mode: Some(0o640),
                },
                None,
            )
            .unwrap();
        let target = writer
            .root
            .collection("users")
            .unwrap()
            .read_document("4VRNF52JPCO")
            .unwrap()
            .path;
        assert_eq!(
            fs::metadata(&target).unwrap().permissions().mode() & 0o777,
            0o640
        );
        let foreign = WriteActor::new(u32::MAX, []);
        let denied = writer
            .set_record_metadata(
                "users",
                "4VRNF52JPCO",
                &serde_json::from_value(json!({"team": "storage"})).unwrap(),
                Some(&foreign),
            )
            .unwrap_err();
        assert_eq!(denied.code(), NativeStorageErrorCode::PermissionDenied);
    }

    #[cfg(unix)]
    #[test]
    fn group_membership_authorizes_a_protected_document_mutation() {
        use std::os::unix::fs::MetadataExt;

        let fixture = TestRoot::create();
        let gid = fs::metadata(&fixture.0).unwrap().gid();
        let writer = NativeWriteRoot::open(&fixture.0).unwrap();
        writer
            .put_document(
                "users",
                "4VRNF52JPCO",
                br#"{"name":"Ada"}"#,
                PutDocumentOptions {
                    access: WriteAccess {
                        uid: None,
                        gid: Some(gid),
                        mode: Some(0o660),
                    },
                    ..PutDocumentOptions::default()
                },
            )
            .unwrap();
        assert_eq!(
            writer
                .patch_document(
                    "users",
                    "4VRNF52JPCO",
                    br#"{"name":"Denied"}"#,
                    Some(&WriteActor::new(u32::MAX - 1, std::iter::empty())),
                )
                .unwrap_err()
                .code(),
            NativeStorageErrorCode::PermissionDenied
        );
        writer
            .patch_document(
                "users",
                "4VRNF52JPCO",
                br#"{"name":"Editor"}"#,
                Some(&WriteActor::new(u32::MAX - 1, [gid])),
            )
            .unwrap();
    }

    #[test]
    fn puts_raw_bytes_with_key_metadata_checksum_and_index_entries() {
        let fixture = TestRoot::create();
        fs::create_dir_all(fixture.0.join(".fylo-catalog/collections")).unwrap();
        fs::write(
            fixture.0.join(".fylo-catalog/collections/assets.json"),
            br#"{"kind":"file"}"#,
        )
        .unwrap();
        fs::create_dir_all(fixture.0.join(".buckets/assets/docs")).unwrap();
        fs::create_dir_all(fixture.0.join(".buckets/assets/.deleted")).unwrap();
        fs::create_dir_all(fixture.0.join(".buckets/assets/index")).unwrap();
        fs::write(fixture.0.join(".buckets/assets/index/keys.snapshot"), b"").unwrap();
        fs::write(fixture.0.join(".buckets/assets/index/keys.wal"), b"").unwrap();
        let writer = NativeWriteRoot::open(&fixture.0).unwrap();
        writer
            .put_raw_file(
                "assets",
                "4VRNF52JPCO",
                &[0, 1, 2, 3, 255],
                &PutRawFileOptions {
                    key: "/fixtures/sample.bin".into(),
                    extension: ".bin".into(),
                    metadata: [("reviewed".into(), Value::Bool(true))]
                        .into_iter()
                        .collect(),
                    access: WriteAccess::default(),
                },
            )
            .unwrap();
        let collection = writer.root.collection("assets").unwrap();
        let stored = collection.read_raw_file("4VRNF52JPCO").unwrap();
        assert_eq!(stored.bytes, [0, 1, 2, 3, 255]);
        assert_eq!(stored.key, "/fixtures/sample.bin");
        assert_eq!(
            stored.custom_metadata.get("reviewed"),
            Some(&Value::Bool(true))
        );
        assert_eq!(stored.checksum_sha256, crate::sha256_hex(&stored.bytes));
        let snapshot = collection.index_snapshot().unwrap();
        let snapshot = std::str::from_utf8(snapshot.as_bytes()).unwrap();
        assert!(
            snapshot.contains("key/eq/%252Ffixtures%252Fsample.bin/4VRNF52JPCO"),
            "{snapshot}"
        );
    }

    /// Mutations maintain the index by appending to the WAL rather than
    /// walking the collection, so the only thing that proves them correct is
    /// that the merged result still equals what a walk of the records
    /// produces. Every incremental path is exercised, then rebuilt from truth.
    #[test]
    fn incremental_index_updates_match_a_rebuild_from_the_records() {
        let fixture = TestRoot::create();
        let writer = NativeWriteRoot::open(&fixture.0).unwrap();
        let identifiers: Vec<String> = (0..60).map(|index| format!("4VRNF52J{index:03}")).collect();
        for (index, identifier) in identifiers.iter().enumerate() {
            writer
                .put_document(
                    "users",
                    identifier,
                    format!(
                        r#"{{"name":"row-{index}","score":{index},"tag":"t{}"}}"#,
                        index % 5
                    )
                    .as_bytes(),
                    PutDocumentOptions::default(),
                )
                .unwrap();
        }
        writer
            .patch_document("users", &identifiers[0], br#"{"name":"Grace"}"#, None)
            .unwrap();
        writer
            .patch_document_fields(
                "users",
                &identifiers[1],
                &json!({ "extra": "merged" }).as_object().unwrap().clone(),
                None,
            )
            .unwrap();
        writer
            .set_record_metadata(
                "users",
                &identifiers[2],
                &json!({ "reviewed": true }).as_object().unwrap().clone(),
                None,
            )
            .unwrap();
        writer
            .delete_document("users", &identifiers[3], None)
            .unwrap();
        writer
            .delete_document("users", &identifiers[4], None)
            .unwrap();
        writer
            .restore_document("users", &identifiers[4], None)
            .unwrap();

        let collection = writer.root.collection("users").unwrap();
        // The WAL must actually be carrying entries, or this asserts nothing.
        let index = collection.path.join("index");
        assert!(
            fs::metadata(index.join("keys.wal")).unwrap().len() > 0,
            "incremental updates never reached the WAL"
        );
        let incremental = collection.index_snapshot().unwrap().as_bytes().to_vec();

        writer.rebuild_collection("users").unwrap();
        let rebuilt = writer
            .root
            .collection("users")
            .unwrap()
            .index_snapshot()
            .unwrap()
            .as_bytes()
            .to_vec();
        assert_eq!(
            std::str::from_utf8(&incremental).unwrap(),
            std::str::from_utf8(&rebuilt).unwrap()
        );
    }

    /// The handshake advertises `ttid-binary-ascending` and every query cursor
    /// depends on it. Directory order is (shard, identifier), and ADR 0006 made
    /// the shard the identifier's trailing characters, so the two orders now
    /// disagree — these identifiers sort one way by TTID and the other by
    /// shard.
    /// TTID matches case-insensitively, so `4vrnf52jpco` and `4VRNF52JPCO`
    /// are both valid spellings of one identifier. Naming a file after each
    /// gives one record on a case-insensitive filesystem and two on a
    /// case-sensitive one, so the non-canonical spelling is refused where it
    /// would first become a file.
    /// A flat collection accepted writes and then failed every read, because
    /// enumeration walks `docs/` expecting shard directories and refuses a
    /// file. Refusing the width is what stops a root reaching that state.
    /// The layout is a property of the root; the configuration is per process.
    /// A write under a mismatched width would land in a shard the next reader
    /// does not look in, and relocating every record is bounded only by
    /// collection size, so it never happens implicitly inside a write.
    #[test]
    fn refuses_a_write_whose_configured_width_differs_from_the_collection() {
        let fixture = TestRoot::create();
        // Created at the default width, with the descriptor that records it.
        NativeWriteRoot::open(&fixture.0)
            .unwrap()
            .create_collection("audit", CollectionKind::Document, None)
            .unwrap();

        // This process is configured for a different width.
        let mismatched =
            NativeWriteRoot::open(&fixture.0)
                .unwrap()
                .with_config(super::super::RootConfig {
                    shard_width: Some(3),
                    ..super::super::RootConfig::default()
                });
        let error = mismatched
            .put_document(
                "audit",
                "4VRNF52JPCO",
                br#"{"name":"Ada"}"#,
                PutDocumentOptions::default(),
            )
            .unwrap_err();
        assert_eq!(error.code(), NativeStorageErrorCode::ShardWidth);
        assert_eq!(error.code().as_str(), "ESHARDWIDTH");
        // The message names the command that resolves it.
        assert!(error.to_string().contains("fylo reshard audit"), "{error}");

        // Reads are unaffected, and so is the reshard that resolves it.
        assert!(mismatched.root.collection("audit").is_ok());
        mismatched.reshard_collection("audit", 3).unwrap();
        mismatched
            .put_document(
                "audit",
                "4VRNF52JPCO",
                br#"{"name":"Ada"}"#,
                PutDocumentOptions::default(),
            )
            .unwrap();
    }

    #[test]
    fn refuses_a_flat_collection_width() {
        let fixture = TestRoot::create();
        let writer =
            NativeWriteRoot::open(&fixture.0)
                .unwrap()
                .with_config(super::super::RootConfig {
                    shard_width: Some(0),
                    ..super::super::RootConfig::default()
                });
        let error = writer
            .create_collection("flat", CollectionKind::Document, None)
            .unwrap_err();
        assert_eq!(error.code(), NativeStorageErrorCode::CorruptMetadata);
        assert!(error.to_string().contains("must be 1 to 4"), "{error}");
    }

    #[test]
    fn refuses_a_non_canonical_identifier_spelling() {
        let fixture = TestRoot::create();
        let writer = NativeWriteRoot::open(&fixture.0).unwrap();
        let error = writer
            .put_document(
                "users",
                "4vrnf52jpco",
                br#"{"name":"Ada"}"#,
                PutDocumentOptions::default(),
            )
            .unwrap_err();
        assert_eq!(error.code(), NativeStorageErrorCode::InvalidDocumentId);
        // The message names the spelling to use, so a caller can repair it.
        assert!(error.to_string().contains("4VRNF52JPCO"), "{error}");
        // The canonical spelling is accepted, and nothing was left behind.
        writer
            .put_document(
                "users",
                "4VRNF52JPCO",
                br#"{"name":"Ada"}"#,
                PutDocumentOptions::default(),
            )
            .unwrap();
        assert_eq!(
            writer
                .root
                .collection("users")
                .unwrap()
                .document_ids()
                .unwrap(),
            vec!["4VRNF52JPCO".to_owned()]
        );
    }

    #[test]
    fn enumeration_is_ascending_by_identifier_not_by_shard_directory() {
        let fixture = TestRoot::create();
        let writer = NativeWriteRoot::open(&fixture.0).unwrap();
        for identifier in ["4VRNF52AAZZ", "4VRNF52BB11"] {
            writer
                .put_document(
                    "users",
                    identifier,
                    br#"{"name":"Ada"}"#,
                    PutDocumentOptions::default(),
                )
                .unwrap();
        }
        let collection = writer.root.collection("users").unwrap();
        assert_eq!(
            collection.document_ids().unwrap(),
            vec!["4VRNF52AAZZ".to_owned(), "4VRNF52BB11".to_owned()],
            "enumeration followed shard directory order"
        );
    }

    #[test]
    fn compacts_the_index_wal_once_it_outgrows_the_snapshot() {
        let fixture = TestRoot::create();
        let writer = NativeWriteRoot::open(&fixture.0).unwrap();
        for index in 0..300 {
            writer
                .put_document(
                    "users",
                    &format!("4VRNF52J{index:03}"),
                    format!(
                        r#"{{"name":"row-{index}","score":{index},"tag":"t{}"}}"#,
                        index % 5
                    )
                    .as_bytes(),
                    PutDocumentOptions::default(),
                )
                .unwrap();
        }
        let index = fixture.0.join(".collections/users/index");
        let wal = fs::metadata(index.join("keys.wal")).unwrap().len();
        let snapshot = fs::metadata(index.join("keys.snapshot")).unwrap().len();
        assert!(snapshot > 0, "compaction never ran");
        assert!(
            wal <= INDEX_WAL_COMPACT_BYTES.max(snapshot),
            "WAL grew to {wal} bytes against a {snapshot}-byte snapshot"
        );
    }
}
