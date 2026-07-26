//! Read-only native access to the existing FYLO filesystem layout.
//!
//! This crate never creates, renames, truncates, deletes, changes metadata, or
//! acquires a writer lock. It rejects linked components below the canonical
//! root and bounds every metadata, document, and index read.

use std::collections::BTreeSet;
use std::fmt;
use std::fs::{self, File, Metadata};
use std::io::{Read, Take};
use std::path::{Component, Path, PathBuf};

use fylo_format::decode_ttid;
use fylo_query::{IndexSnapshot, QueryLimits};
use serde::{Deserialize, Serialize};

/// Maximum collection descriptor bytes.
pub const MAX_DESCRIPTOR_BYTES: u64 = 64 * 1024;
/// Maximum generation-state bytes.
pub const MAX_GENERATION_BYTES: u64 = 16 * 1024;
/// Maximum document bytes read by the native preview.
pub const MAX_DOCUMENT_BYTES: u64 = 16 * 1024 * 1024;
/// Maximum prefix-index WAL bytes merged by one read.
pub const MAX_INDEX_WAL_BYTES: u64 = 64 * 1024 * 1024;

const RESERVED_COLLECTIONS: &[&str] = &[
    "sql",
    "as",
    "then",
    "db",
    "engine",
    "cache",
    "queue",
    "startup",
    "importBulkData",
    "join",
    "ready",
    "close",
    "_sql",
];

/// Canonical read-only FYLO root.
#[derive(Clone, Debug)]
pub struct NativeRoot {
    canonical: PathBuf,
}

impl NativeRoot {
    /// Open and canonicalize an existing directory.
    ///
    /// # Errors
    ///
    /// Returns an error when the root is absent, inaccessible, or not a
    /// directory.
    pub fn open(path: impl AsRef<Path>) -> Result<Self, NativeStorageError> {
        let canonical = fs::canonicalize(path.as_ref()).map_err(NativeStorageError::io)?;
        let metadata = fs::metadata(&canonical).map_err(NativeStorageError::io)?;
        if !metadata.is_dir() {
            return Err(NativeStorageError::new(
                NativeStorageErrorCode::WrongType,
                "FYLO root is not a directory",
            ));
        }
        Ok(Self { canonical })
    }

    /// Return the canonical root identity.
    #[must_use]
    pub fn path(&self) -> &Path {
        &self.canonical
    }

    /// Open one existing collection without modifying the root.
    ///
    /// # Errors
    ///
    /// Returns an error for invalid names, corrupt descriptors, unsafe paths,
    /// or missing collection directories.
    pub fn collection(&self, name: &str) -> Result<NativeCollection, NativeStorageError> {
        validate_collection_name(name)?;
        let descriptor_path = self
            .canonical
            .join(".fylo-catalog")
            .join("collections")
            .join(format!("{name}.json"));
        let descriptor = if path_exists_no_follow(&descriptor_path)? {
            let bytes = self.read_file(&descriptor_path, MAX_DESCRIPTOR_BYTES)?;
            serde_json::from_slice::<CollectionDescriptor>(&bytes).map_err(|error| {
                NativeStorageError::new(
                    NativeStorageErrorCode::CorruptMetadata,
                    format!("collection descriptor is corrupt: {error}"),
                )
            })?
        } else {
            CollectionDescriptor {
                kind: CollectionKind::Document,
            }
        };
        let namespace = match descriptor.kind {
            CollectionKind::Document => ".collections",
            CollectionKind::File => ".buckets",
        };
        let path = self.canonical.join(namespace).join(name);
        self.verify_path(&path, ExpectedType::Directory)?;
        Ok(NativeCollection {
            root: self.clone(),
            name: name.to_owned(),
            path,
            kind: descriptor.kind,
            namespace: namespace.to_owned(),
        })
    }

    fn verify_path(
        &self,
        target: &Path,
        expected: ExpectedType,
    ) -> Result<Metadata, NativeStorageError> {
        let relative = target.strip_prefix(&self.canonical).map_err(|_| {
            NativeStorageError::new(
                NativeStorageErrorCode::UnsafePath,
                "storage path escapes the canonical FYLO root",
            )
        })?;
        let mut current = self.canonical.clone();
        for component in relative.components() {
            let Component::Normal(segment) = component else {
                return Err(NativeStorageError::new(
                    NativeStorageErrorCode::UnsafePath,
                    "storage path contains a non-normal component",
                ));
            };
            current.push(segment);
            let metadata = fs::symlink_metadata(&current).map_err(NativeStorageError::io)?;
            if metadata.file_type().is_symlink() {
                return Err(NativeStorageError::new(
                    NativeStorageErrorCode::UnsafePath,
                    format!(
                        "storage path contains a symbolic link: {}",
                        current.display()
                    ),
                ));
            }
        }
        let metadata = fs::symlink_metadata(target).map_err(NativeStorageError::io)?;
        let valid = match expected {
            ExpectedType::File => metadata.is_file(),
            ExpectedType::Directory => metadata.is_dir(),
        };
        if !valid {
            return Err(NativeStorageError::new(
                NativeStorageErrorCode::WrongType,
                format!("storage path has the wrong type: {}", target.display()),
            ));
        }
        let canonical = fs::canonicalize(target).map_err(NativeStorageError::io)?;
        if !canonical.starts_with(&self.canonical) {
            return Err(NativeStorageError::new(
                NativeStorageErrorCode::UnsafePath,
                "canonical storage path escapes the FYLO root",
            ));
        }
        Ok(metadata)
    }

    fn read_file(&self, path: &Path, max_bytes: u64) -> Result<Vec<u8>, NativeStorageError> {
        let before = self.verify_path(path, ExpectedType::File)?;
        if before.len() > max_bytes {
            return Err(NativeStorageError::new(
                NativeStorageErrorCode::FileTooLarge,
                format!(
                    "{} contains {} bytes; limit is {max_bytes}",
                    path.display(),
                    before.len()
                ),
            ));
        }
        let file = File::open(path).map_err(NativeStorageError::io)?;
        let opened = file.metadata().map_err(NativeStorageError::io)?;
        if !same_file(&before, &opened) {
            return Err(NativeStorageError::new(
                NativeStorageErrorCode::UnsafePath,
                "storage path changed while it was being opened",
            ));
        }
        read_bounded(file.take(max_bytes.saturating_add(1)), max_bytes)
    }
}

/// Existing collection kind.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CollectionKind {
    /// JSON document collection.
    Document,
    /// Raw byte/file collection.
    File,
}

#[derive(Deserialize)]
struct CollectionDescriptor {
    kind: CollectionKind,
}

/// Read-only handle for one collection.
#[derive(Clone, Debug)]
pub struct NativeCollection {
    root: NativeRoot,
    name: String,
    path: PathBuf,
    kind: CollectionKind,
    namespace: String,
}

impl NativeCollection {
    /// Collection name.
    #[must_use]
    pub fn name(&self) -> &str {
        &self.name
    }

    /// Collection kind.
    #[must_use]
    pub const fn kind(&self) -> CollectionKind {
        self.kind
    }

    /// Canonical collection directory path.
    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Read the current transaction generation.
    ///
    /// A missing state file represents generation zero in a stable state.
    ///
    /// # Errors
    ///
    /// Returns an error for corrupt, oversized, linked, or inaccessible state.
    pub fn generation(&self) -> Result<GenerationState, NativeStorageError> {
        let path = self
            .root
            .canonical
            .join(".fylo-transactions")
            .join(&self.namespace)
            .join(&self.name)
            .join("state.json");
        if !path_exists_no_follow(&path)? {
            return Ok(GenerationState {
                format: "fylo.collection-generation.v1".into(),
                generation: 0,
                state: GenerationStatus::Stable,
                transaction_id: None,
            });
        }
        let bytes = self.root.read_file(&path, MAX_GENERATION_BYTES)?;
        let state: GenerationState = serde_json::from_slice(&bytes).map_err(|error| {
            NativeStorageError::new(
                NativeStorageErrorCode::CorruptMetadata,
                format!("collection generation state is corrupt: {error}"),
            )
        })?;
        state.validate()?;
        Ok(state)
    }

    /// List validated live document identifiers in lexical path order.
    ///
    /// # Errors
    ///
    /// Returns an error when linked components, unexpected files, invalid
    /// identifiers, or filesystem failures are encountered.
    pub fn document_ids(&self) -> Result<Vec<String>, NativeStorageError> {
        if self.kind != CollectionKind::Document {
            return Err(NativeStorageError::new(
                NativeStorageErrorCode::Unsupported,
                "document enumeration is not available for file collections",
            ));
        }
        let docs = self.path.join("docs");
        self.root.verify_path(&docs, ExpectedType::Directory)?;
        let mut ids = Vec::new();
        let mut shards = read_dir_sorted(&docs)?;
        for shard in &mut shards {
            let shard_path = shard.path();
            let file_type = shard.file_type().map_err(NativeStorageError::io)?;
            if file_type.is_symlink() || !file_type.is_dir() {
                return Err(NativeStorageError::new(
                    NativeStorageErrorCode::UnsafePath,
                    format!(
                        "document shard is not a regular directory: {}",
                        shard_path.display()
                    ),
                ));
            }
            self.root
                .verify_path(&shard_path, ExpectedType::Directory)?;
            for entry in read_dir_sorted(&shard_path)? {
                let path = entry.path();
                let file_type = entry.file_type().map_err(NativeStorageError::io)?;
                if file_type.is_symlink() || !file_type.is_file() {
                    return Err(NativeStorageError::new(
                        NativeStorageErrorCode::UnsafePath,
                        format!("document entry is not a regular file: {}", path.display()),
                    ));
                }
                let Some(file_name) = path.file_name().and_then(|name| name.to_str()) else {
                    return Err(NativeStorageError::new(
                        NativeStorageErrorCode::InvalidDocumentId,
                        "document filename is not valid UTF-8",
                    ));
                };
                if is_scratch_file(file_name) {
                    continue;
                }
                let Some(identifier) = file_name.strip_suffix(".json") else {
                    continue;
                };
                validate_ttid_shape(identifier)?;
                if !identifier.starts_with(
                    shard_path
                        .file_name()
                        .and_then(|name| name.to_str())
                        .unwrap_or_default(),
                ) {
                    return Err(NativeStorageError::new(
                        NativeStorageErrorCode::InvalidDocumentId,
                        "document identifier does not match its shard",
                    ));
                }
                ids.push(identifier.to_owned());
            }
        }
        Ok(ids)
    }

    /// Read one document body and native file metadata.
    ///
    /// # Errors
    ///
    /// Returns an error for invalid IDs, unsafe paths, oversized files, or I/O
    /// failures.
    pub fn read_document(&self, identifier: &str) -> Result<StoredBytes, NativeStorageError> {
        validate_ttid_shape(identifier)?;
        if self.kind != CollectionKind::Document {
            return Err(NativeStorageError::new(
                NativeStorageErrorCode::Unsupported,
                "JSON document reads are not available for file collections",
            ));
        }
        let path = self
            .path
            .join("docs")
            .join(&identifier[..2])
            .join(format!("{identifier}.json"));
        let metadata = self.root.verify_path(&path, ExpectedType::File)?;
        let bytes = self.root.read_file(&path, MAX_DOCUMENT_BYTES)?;
        Ok(StoredBytes {
            bytes,
            modified_millis: modified_millis(&metadata)?,
            path,
        })
    }

    /// Read and validate the prefix index with its complete WAL overlay.
    ///
    /// # Errors
    ///
    /// Returns an error for unsafe paths, oversized files, I/O failures, or an
    /// invalid snapshot.
    pub fn index_snapshot(&self) -> Result<IndexSnapshot, NativeStorageError> {
        let index = self.path.join("index");
        let snapshot_path = index.join("keys.snapshot");
        let snapshot_bytes = self.root.read_file(
            &snapshot_path,
            QueryLimits::default().max_snapshot_bytes as u64,
        )?;
        let snapshot = IndexSnapshot::from_bytes(&snapshot_bytes, QueryLimits::default()).map_err(
            |error| {
                NativeStorageError::new(
                    NativeStorageErrorCode::CorruptIndex,
                    format!("prefix index snapshot is corrupt: {error}"),
                )
            },
        )?;
        let mut keys: BTreeSet<Vec<u8>> = snapshot
            .as_bytes()
            .split(|byte| *byte == b'\n')
            .filter(|key| !key.is_empty())
            .map(<[u8]>::to_vec)
            .collect();
        let wal_path = index.join("keys.wal");
        if path_exists_no_follow(&wal_path)? {
            let wal = self.root.read_file(&wal_path, MAX_INDEX_WAL_BYTES)?;
            let complete_length = wal
                .iter()
                .rposition(|byte| *byte == b'\n')
                .map_or(0, |position| position + 1);
            for line in wal[..complete_length].split(|byte| *byte == b'\n') {
                if line.len() < 3 || line[1] != b'\t' {
                    continue;
                }
                let key = line[2..].to_vec();
                if key.is_empty() {
                    continue;
                }
                match line[0] {
                    b'+' => {
                        keys.insert(key);
                    }
                    b'-' => {
                        keys.remove(&key);
                    }
                    _ => {}
                }
            }
        }
        let required = keys.iter().try_fold(0_usize, |total, key| {
            total
                .checked_add(key.len())
                .and_then(|size| size.checked_add(1))
        });
        let Some(required) = required else {
            return Err(NativeStorageError::new(
                NativeStorageErrorCode::FileTooLarge,
                "merged prefix index size overflow",
            ));
        };
        let mut merged = Vec::with_capacity(required);
        for key in keys {
            merged.extend_from_slice(&key);
            merged.push(b'\n');
        }
        IndexSnapshot::from_bytes(&merged, QueryLimits::default()).map_err(|error| {
            NativeStorageError::new(
                NativeStorageErrorCode::CorruptIndex,
                format!("merged prefix index is corrupt: {error}"),
            )
        })
    }
}

/// Bounded stored bytes plus canonical native metadata.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StoredBytes {
    /// Document bytes.
    pub bytes: Vec<u8>,
    /// Filesystem modification time in Unix milliseconds.
    pub modified_millis: u64,
    /// Verified native path.
    pub path: PathBuf,
}

/// Parsed collection generation state.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct GenerationState {
    /// Storage format identifier.
    pub format: String,
    /// Monotonic generation number.
    pub generation: u64,
    /// Stable or writing state.
    pub state: GenerationStatus,
    /// Transaction ID present only while writing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transaction_id: Option<String>,
}

impl GenerationState {
    fn validate(&self) -> Result<(), NativeStorageError> {
        let valid_transaction = match self.state {
            GenerationStatus::Stable => self.transaction_id.is_none(),
            GenerationStatus::Writing => self
                .transaction_id
                .as_ref()
                .is_some_and(|identifier| !identifier.is_empty()),
        };
        if self.format != "fylo.collection-generation.v1" || !valid_transaction {
            return Err(NativeStorageError::new(
                NativeStorageErrorCode::CorruptMetadata,
                "collection generation state has an invalid schema",
            ));
        }
        Ok(())
    }
}

/// Collection generation status.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GenerationStatus {
    /// No transaction is publishing changes.
    Stable,
    /// A writer has published an in-progress generation.
    Writing,
}

#[derive(Clone, Copy)]
enum ExpectedType {
    File,
    Directory,
}

/// Stable native read-only storage failure codes.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NativeStorageErrorCode {
    /// Filesystem I/O failed.
    Io,
    /// A path contained a linked or escaping component.
    UnsafePath,
    /// A path had an unexpected type.
    WrongType,
    /// A bounded file was oversized.
    FileTooLarge,
    /// Collection metadata was corrupt.
    CorruptMetadata,
    /// Prefix-index bytes were corrupt.
    CorruptIndex,
    /// Collection name was invalid or reserved.
    InvalidCollection,
    /// Document ID syntax was invalid.
    InvalidDocumentId,
    /// The preview does not support the requested collection/operation.
    Unsupported,
}

impl NativeStorageErrorCode {
    /// Stable external string.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Io => "ENATIVE_IO",
            Self::UnsafePath => "ENATIVE_UNSAFE_PATH",
            Self::WrongType => "ENATIVE_WRONG_TYPE",
            Self::FileTooLarge => "ENATIVE_FILE_SIZE",
            Self::CorruptMetadata => "ENATIVE_METADATA",
            Self::CorruptIndex => "ENATIVE_INDEX",
            Self::InvalidCollection => "ENATIVE_COLLECTION",
            Self::InvalidDocumentId => "EINVALIDDOCID",
            Self::Unsupported => "ENATIVE_UNSUPPORTED",
        }
    }
}

/// Native read-only storage error.
#[derive(Debug)]
pub struct NativeStorageError {
    code: NativeStorageErrorCode,
    message: String,
    source: Option<std::io::Error>,
}

impl NativeStorageError {
    fn new(code: NativeStorageErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            source: None,
        }
    }

    fn io(error: std::io::Error) -> Self {
        Self {
            code: NativeStorageErrorCode::Io,
            message: error.to_string(),
            source: Some(error),
        }
    }

    /// Stable error code.
    #[must_use]
    pub const fn code(&self) -> NativeStorageErrorCode {
        self.code
    }
}

impl fmt::Display for NativeStorageError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.code.as_str(), self.message)
    }
}

impl std::error::Error for NativeStorageError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.source
            .as_ref()
            .map(|error| error as &(dyn std::error::Error + 'static))
    }
}

fn validate_collection_name(name: &str) -> Result<(), NativeStorageError> {
    let bytes = name.as_bytes();
    let valid = bytes.len() >= 2
        && bytes.first().is_some_and(u8::is_ascii_alphanumeric)
        && bytes.last().is_some_and(u8::is_ascii_alphanumeric)
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-');
    if !valid || RESERVED_COLLECTIONS.contains(&name) {
        return Err(NativeStorageError::new(
            NativeStorageErrorCode::InvalidCollection,
            "invalid or reserved collection name",
        ));
    }
    Ok(())
}

fn validate_ttid_shape(identifier: &str) -> Result<(), NativeStorageError> {
    let valid = !identifier.is_empty()
        && identifier.len() <= 36
        && identifier.split('-').count() <= 3
        && identifier.split('-').all(|segment| {
            !segment.is_empty()
                && segment.len() <= 11
                && segment.bytes().all(|byte| byte.is_ascii_alphanumeric())
        });
    if !valid || decode_ttid(identifier).is_err() {
        return Err(NativeStorageError::new(
            NativeStorageErrorCode::InvalidDocumentId,
            "invalid FYLO document identifier",
        ));
    }
    Ok(())
}

fn path_exists_no_follow(path: &Path) -> Result<bool, NativeStorageError> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(NativeStorageError::io(error)),
    }
}

fn read_dir_sorted(path: &Path) -> Result<Vec<fs::DirEntry>, NativeStorageError> {
    let mut entries = fs::read_dir(path)
        .map_err(NativeStorageError::io)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(NativeStorageError::io)?;
    entries.sort_by_key(fs::DirEntry::file_name);
    Ok(entries)
}

fn read_bounded(mut reader: Take<File>, max_bytes: u64) -> Result<Vec<u8>, NativeStorageError> {
    let mut bytes = Vec::new();
    reader
        .read_to_end(&mut bytes)
        .map_err(NativeStorageError::io)?;
    if bytes.len() as u64 > max_bytes {
        return Err(NativeStorageError::new(
            NativeStorageErrorCode::FileTooLarge,
            format!("file exceeds {max_bytes} bytes"),
        ));
    }
    Ok(bytes)
}

fn is_scratch_file(name: &str) -> bool {
    Path::new(name)
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("tmp"))
}

fn modified_millis(metadata: &Metadata) -> Result<u64, NativeStorageError> {
    let duration = metadata
        .modified()
        .map_err(NativeStorageError::io)?
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| {
            NativeStorageError::new(
                NativeStorageErrorCode::CorruptMetadata,
                format!("file modification time predates the Unix epoch: {error}"),
            )
        })?;
    u64::try_from(duration.as_millis()).map_err(|_| {
        NativeStorageError::new(
            NativeStorageErrorCode::CorruptMetadata,
            "file modification time exceeds u64 milliseconds",
        )
    })
}

#[cfg(unix)]
fn same_file(left: &Metadata, right: &Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    left.dev() == right.dev() && left.ino() == right.ino()
}

#[cfg(not(unix))]
fn same_file(left: &Metadata, right: &Metadata) -> bool {
    left.len() == right.len()
        && left.modified().ok() == right.modified().ok()
        && left.file_type() == right.file_type()
}

#[cfg(test)]
mod tests {
    use std::io::Write;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;

    struct TestRoot(PathBuf);
    static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    impl TestRoot {
        fn create() -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let sequence = TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "fylo-native-{}-{nonce}-{sequence}",
                std::process::id()
            ));
            fs::create_dir_all(path.join(".collections/users/docs/4V")).unwrap();
            fs::create_dir_all(path.join(".collections/users/index")).unwrap();
            fs::write(
                path.join(".collections/users/docs/4V/4VRNF52JPCO.json"),
                br#"{"name":"Ada"}"#,
            )
            .unwrap();
            fs::write(
                path.join(".collections/users/index/keys.snapshot"),
                b"name/eq/Ada/4VRNF52JPCO\n",
            )
            .unwrap();
            fs::write(path.join(".collections/users/index/keys.wal"), b"").unwrap();
            Self(path)
        }
    }

    impl Drop for TestRoot {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    #[test]
    fn reads_existing_documents_and_indexes_without_writes() {
        let fixture = TestRoot::create();
        let root = NativeRoot::open(&fixture.0).unwrap();
        let collection = root.collection("users").unwrap();
        assert_eq!(collection.document_ids().unwrap(), ["4VRNF52JPCO"]);
        assert_eq!(
            collection.read_document("4VRNF52JPCO").unwrap().bytes,
            br#"{"name":"Ada"}"#
        );
        assert_eq!(collection.generation().unwrap().generation, 0);
        assert_eq!(
            collection.index_snapshot().unwrap().as_bytes(),
            b"name/eq/Ada/4VRNF52JPCO\n"
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_linked_document_shards() {
        use std::os::unix::fs::symlink;

        let fixture = TestRoot::create();
        let external = fixture.0.join("external");
        fs::create_dir(&external).unwrap();
        fs::remove_dir_all(fixture.0.join(".collections/users/docs/4V")).unwrap();
        symlink(&external, fixture.0.join(".collections/users/docs/4V")).unwrap();
        let collection = NativeRoot::open(&fixture.0)
            .unwrap()
            .collection("users")
            .unwrap();
        assert_eq!(
            collection.document_ids().unwrap_err().code(),
            NativeStorageErrorCode::UnsafePath
        );
    }

    #[test]
    fn bounded_reader_rejects_growth_beyond_limit() {
        let fixture = TestRoot::create();
        let root = NativeRoot::open(&fixture.0).unwrap();
        let path = root.path().join("large");
        let mut file = File::create(&path).unwrap();
        file.write_all(&[0; 9]).unwrap();
        drop(file);
        let error = root.read_file(&path, 8).unwrap_err();
        assert_eq!(
            error.code(),
            NativeStorageErrorCode::FileTooLarge,
            "{error}"
        );
    }

    #[test]
    fn merges_complete_wal_mutations_and_ignores_a_torn_tail() {
        let fixture = TestRoot::create();
        fs::write(
            fixture.0.join(".collections/users/index/keys.wal"),
            b"-\tname/eq/Ada/4VRNF52JPCO\n+\tname/eq/Grace/4VRNF52JPCO\n+\ttorn",
        )
        .unwrap();
        let snapshot = NativeRoot::open(&fixture.0)
            .unwrap()
            .collection("users")
            .unwrap()
            .index_snapshot()
            .unwrap();
        assert_eq!(snapshot.as_bytes(), b"name/eq/Grace/4VRNF52JPCO\n");
    }
}
