//! Crash-recoverable native writes for the existing FYLO filesystem layout.
//!
//! The journal and generation records intentionally use the JavaScript
//! engine's v1 schemas so either engine can recover an interrupted mutation.

use std::collections::BTreeSet;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use fylo_format::{Document, DocumentLimits, decode_ttid};
use fylo_query::{IndexLookupValue, index_entries_for_document};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::{
    ACCESS_XATTR, CollectionKind, ExpectedType, MAX_DOCUMENT_BYTES, NativeRoot, NativeStorageError,
    NativeStorageErrorCode, path_exists_no_follow, validate_ttid_shape,
};

const TRANSACTION_FORMAT: &str = "fylo.collection-transaction.v1";
const GENERATION_FORMAT: &str = "fylo.collection-generation.v1";
const MAX_TRANSACTION_BYTES: u64 = 16 * 1024 * 1024;
const MAX_CAPTURE_BYTES: u64 = 8 * 1024 * 1024;
const LOCK_TTL_MILLIS: u64 = 5 * 60 * 1000;
const DEFAULT_ACCESS_MODE: u32 = 0o600;

static UNIQUE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

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
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct PutDocumentOptions {
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

/// Native mutation entry point.
#[derive(Clone, Debug)]
pub struct NativeWriteRoot {
    root: NativeRoot,
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
        })
    }

    /// Canonical root identity.
    #[must_use]
    pub fn path(&self) -> &Path {
        self.root.path()
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
        if canonical.len() as u64 > MAX_DOCUMENT_BYTES {
            return Err(NativeStorageError::new(
                NativeStorageErrorCode::FileTooLarge,
                "document exceeds the native write limit",
            ));
        }
        let access = options.access.validate()?;
        let collection = self.root.collection(collection_name)?;
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
            .join(&identifier[..2])
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
            apply_access(&target, access)?;
            transaction.capture(&collection.path.join("index").join("keys.snapshot"))?;
            transaction.capture(&collection.path.join("index").join("keys.wal"))?;
            self.rebuild_index(&collection)?;
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
        validate_ttid_shape(identifier)?;
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
        let collection = self.root.collection(collection_name)?;
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
            .join(&identifier[..2])
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
                let encoded = serde_json::to_vec(value).map_err(|error| json_error(&error))?;
                write_fylo_attribute(
                    &target,
                    &format!("{}{name}", super::META_XATTR_PREFIX),
                    &encoded,
                )?;
            }
            let metadata = fs::metadata(&target).map_err(NativeStorageError::io)?;
            let checksum = super::sha256_hex(bytes);
            let stamp = format!(
                "{checksum}:{}:{}",
                metadata.len(),
                super::modified_millis(&metadata)?
            );
            write_fylo_attribute(&target, super::CHECKSUM_XATTR, stamp.as_bytes())?;
            apply_access(&target, access)?;
            transaction.capture(&collection.path.join("index").join("keys.snapshot"))?;
            transaction.capture(&collection.path.join("index").join("keys.wal"))?;
            self.rebuild_index(&collection)?;
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
        let collection = self.root.collection(collection_name)?;
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
        let mut transaction = Transaction::begin(self, &collection, "patch-document")?;
        let outcome = (|| {
            transaction.capture(&target)?;
            transaction.capture(&collection.path.join("index").join("keys.snapshot"))?;
            transaction.capture(&collection.path.join("index").join("keys.wal"))?;
            overwrite_in_place(&target, &canonical)?;
            self.rebuild_index(&collection)?;
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

    /// Soft-delete one existing document into the retained tombstone tree.
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
        let collection = self.root.collection(collection_name)?;
        if collection.kind != CollectionKind::Document {
            return Err(NativeStorageError::new(
                NativeStorageErrorCode::WrongType,
                "delete_document requires a document collection",
            ));
        }
        let _lock = CollectionWriteLock::acquire(&collection.path)?;
        self.recover_locked(&collection)?;
        let stored = collection.read_document(identifier)?;
        require_write_access(stored.access, actor)?;
        let source = stored.path;
        let target = collection
            .path
            .join(".deleted")
            .join(&identifier[..2])
            .join(format!("{identifier}.json"));
        if path_exists_no_follow(&target)? {
            return Err(NativeStorageError::new(
                NativeStorageErrorCode::CorruptMetadata,
                "retained document tombstone already exists",
            ));
        }
        let mut transaction = Transaction::begin(self, &collection, "delete-document")?;
        let outcome = (|| {
            transaction.capture(&source)?;
            transaction.capture(&target)?;
            transaction.capture(&collection.path.join("index").join("keys.snapshot"))?;
            transaction.capture(&collection.path.join("index").join("keys.wal"))?;
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
            self.rebuild_index(&collection)?;
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
        failpoint("after-state-writing")?;
        Ok(Self {
            writer,
            collection,
            manifest,
            root,
            captures: Vec::new(),
            captured: BTreeSet::new(),
            finished: false,
        })
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
        restore_captures(&self.collection.path, &self.root, &self.captures)?;
        self.writer.rebuild_index(self.collection)?;
        write_generation(
            self.writer,
            self.collection,
            &GenerationRecord::stable(self.manifest.generation_before.saturating_add(2)),
        )?;
        self.finished = true;
        remove_dir_durable(&self.root)
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
        let locks = collection_root.join("locks");
        fs::create_dir_all(&locks).map_err(NativeStorageError::io)?;
        let path = locks.join("collection.lock");
        let owner = unique_name("rust-owner");
        let record = LockRecord {
            owner: owner.clone(),
            pid: std::process::id(),
            process_identity: process_identity(std::process::id()),
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
    let stat = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let fields = stat
        .get(stat.rfind(')')?.saturating_add(2)..)?
        .split_whitespace();
    let start = fields.skip(19).next()?;
    Some(format!("linux:{}:{start}", boot.trim()))
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
    entries.sort_by_key(std::fs::DirEntry::file_name);
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

fn restore_captures(
    collection_root: &Path,
    transaction_root: &Path,
    captures: &[Capture],
) -> Result<(), NativeStorageError> {
    for capture in captures.iter().rev() {
        let relative = safe_relative_path(&capture.path)?;
        let target = collection_root.join(&relative);
        if !capture.present {
            match fs::remove_file(&target) {
                Ok(()) => sync_parent(&target)?,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(NativeStorageError::io(error)),
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
        ensure_plain_parent(
            collection_root,
            target.parent().expect("capture has parent"),
        )?;
        copy_durable(&backup, &target)?;
        restore_attributes(&target, capture.xattrs.as_deref().unwrap_or_default())?;
        if let Some(mode) = capture.mode {
            set_mode(&target, mode)?;
        }
        sync_parent(&target)?;
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
    file.sync_all().map_err(NativeStorageError::io)?;
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
    fields.insert(
        "lastModified".into(),
        Value::from(stored.modified_millis_exact),
    );
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
fn write_fylo_attribute(path: &Path, name: &str, value: &[u8]) -> Result<(), NativeStorageError> {
    use xattr::FileExt;

    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .map_err(NativeStorageError::io)?;
    file.set_xattr(name, value)
        .map_err(NativeStorageError::io)?;
    file.sync_all().map_err(NativeStorageError::io)?;
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
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Default::default(),
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
    file.sync_all().map_err(NativeStorageError::io)?;
    failpoint("after-metadata-write")
}

#[cfg(not(any(unix, windows)))]
fn write_fylo_attribute(
    _path: &Path,
    _name: &str,
    _value: &[u8],
) -> Result<(), NativeStorageError> {
    Err(NativeStorageError::new(
        NativeStorageErrorCode::Unsupported,
        "FYLO native metadata is unavailable on this platform",
    ))
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
    output.sync_all().map_err(NativeStorageError::io)?;
    drop(output);
    fs::rename(scratch, target).map_err(NativeStorageError::io)?;
    sync_parent(target)
}

fn write_new_synced(path: &Path, bytes: &[u8]) -> Result<(), NativeStorageError> {
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(path)
        .map_err(NativeStorageError::io)?;
    file.write_all(bytes).map_err(NativeStorageError::io)?;
    file.sync_all().map_err(NativeStorageError::io)
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

fn sync_directory(path: &Path) -> Result<(), NativeStorageError> {
    let directory = File::open(path).map_err(NativeStorageError::io)?;
    match directory.sync_all() {
        Ok(()) => Ok(()),
        Err(_error) if cfg!(windows) => Ok(()),
        Err(error) => Err(NativeStorageError::io(error)),
    }
}

fn sibling_scratch(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("fylo");
    path.with_file_name(format!("{name}.{}.tmp", unique_name("rust")))
}

fn unique_name(prefix: &str) -> String {
    let sequence = UNIQUE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{prefix}-{}-{nanos:x}-{sequence:x}", std::process::id())
}

fn unix_millis() -> Result<u64, NativeStorageError> {
    let millis = SystemTime::now()
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
    if path.is_absolute()
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

#[cfg(not(unix))]
fn capture_attributes(_path: &Path) -> Result<Vec<CapturedAttribute>, NativeStorageError> {
    Ok(Vec::new())
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

#[cfg(not(unix))]
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
    file.set_xattr(ACCESS_XATTR, &encoded)
        .map_err(NativeStorageError::io)?;
    failpoint("after-access-marker")?;
    chown(path, Some(uid), Some(gid)).map_err(NativeStorageError::io)?;
    failpoint("after-chown")?;
    fs::set_permissions(path, fs::Permissions::from_mode(mode)).map_err(NativeStorageError::io)?;
    failpoint("after-chmod")?;
    file.sync_all().map_err(NativeStorageError::io)
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

#[cfg(not(unix))]
fn set_mode(_path: &Path, _mode: u32) -> Result<(), NativeStorageError> {
    Ok(())
}

fn failpoint(name: &str) -> Result<(), NativeStorageError> {
    if std::env::var("FYLO_RUST_FAILPOINT").ok().as_deref() != Some(name) {
        return Ok(());
    }
    match std::env::var("FYLO_RUST_FAILPOINT_ACTION").ok().as_deref() {
        Some("abort") => std::process::abort(),
        Some("panic") => panic!("FYLO Rust failpoint: {name}"),
        _ => Err(NativeStorageError::new(
            NativeStorageErrorCode::Io,
            format!("injected FYLO Rust failpoint: {name}"),
        )),
    }
}

fn json_error(error: &serde_json::Error) -> NativeStorageError {
    NativeStorageError::new(
        NativeStorageErrorCode::CorruptMetadata,
        format!("cannot encode native transaction metadata: {error}"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
