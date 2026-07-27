//! Read-only native access to the existing FYLO filesystem layout.
//!
//! This crate never creates, renames, truncates, deletes, changes metadata, or
//! acquires a writer lock. It rejects linked components below the canonical
//! root and bounds every metadata, document, and index read.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::fs::{self, File, Metadata};
use std::io::{Read, Take};
use std::path::{Component, Path, PathBuf};

use fylo_format::decode_ttid;
use fylo_query::{IndexSnapshot, QueryLimits};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

/// Maximum collection descriptor bytes.
pub const MAX_DESCRIPTOR_BYTES: u64 = 64 * 1024;
/// Maximum generation-state bytes.
pub const MAX_GENERATION_BYTES: u64 = 16 * 1024;
/// Maximum document bytes read by the native preview.
pub const MAX_DOCUMENT_BYTES: u64 = 16 * 1024 * 1024;
/// Maximum raw-file bytes returned by one native preview read.
pub const MAX_RAW_FILE_BYTES: u64 = 256 * 1024 * 1024;
/// Maximum prefix-index WAL bytes merged by one read.
pub const MAX_INDEX_WAL_BYTES: u64 = 64 * 1024 * 1024;
/// Maximum developer metadata value accepted from one xattr/ADS entry.
pub const MAX_META_VALUE_BYTES: usize = 60 * 1024;
/// Maximum aggregate FYLO metadata accepted from one raw file.
pub const MAX_FILE_METADATA_BYTES: usize = 1024 * 1024;
/// Maximum version-control ref or commit-manifest bytes.
pub const MAX_VERSION_METADATA_BYTES: u64 = 1024 * 1024;
/// Maximum bytes accepted for one content-addressed version tree node.
pub const MAX_VERSION_TREE_BYTES: u64 = 16 * 1024 * 1024;
/// Maximum bytes hashed for one content-addressed historical blob.
pub const MAX_VERSION_BLOB_BYTES: u64 = MAX_RAW_FILE_BYTES;
/// Maximum unique version objects traversed by one verification.
pub const MAX_VERSION_OBJECTS: usize = 1_000_000;
/// Maximum aggregate version-object bytes traversed by one verification.
pub const MAX_VERSION_TOTAL_BYTES: u64 = 16 * 1024 * 1024 * 1024;

const KEY_XATTR: &str = "user.fylo.key";
const CHECKSUM_XATTR: &str = "user.fylo.checksum";
const META_XATTR_PREFIX: &str = "user.fylo.meta.";

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

    /// Read the active branch's first-parent commit history without
    /// materializing or modifying any version.
    ///
    /// # Errors
    ///
    /// Returns an error for corrupt refs/manifests, unsafe paths, cycles,
    /// invalid identifiers, or an excessive limit.
    pub fn version_history(&self, limit: usize) -> Result<RepositoryHistory, NativeStorageError> {
        if limit == 0 || limit > 1000 {
            return Err(NativeStorageError::new(
                NativeStorageErrorCode::CorruptMetadata,
                "version history limit must be between 1 and 1000",
            ));
        }
        let head_path = self.canonical.join(".fylo-vcs").join("HEAD");
        if !path_exists_no_follow(&head_path)? {
            return Ok(RepositoryHistory {
                enabled: false,
                branch: None,
                head: None,
                commits: Vec::new(),
                truncated: false,
            });
        }
        let head = String::from_utf8(self.read_file(&head_path, 4096)?).map_err(|error| {
            NativeStorageError::new(
                NativeStorageErrorCode::CorruptMetadata,
                format!("FYLO repository HEAD is not valid UTF-8: {error}"),
            )
        })?;
        let branch = head
            .trim()
            .strip_prefix("ref: refs/heads/")
            .ok_or_else(|| {
                NativeStorageError::new(
                    NativeStorageErrorCode::CorruptMetadata,
                    "FYLO repository HEAD is corrupt",
                )
            })?;
        validate_branch_name(branch)?;
        let reference_path = self
            .canonical
            .join(".fylo-vcs")
            .join("refs")
            .join("heads")
            .join(format!("{branch}.json"));
        let reference: BranchReference =
            serde_json::from_slice(&self.read_file(&reference_path, MAX_VERSION_METADATA_BYTES)?)
                .map_err(|error| {
                NativeStorageError::new(
                    NativeStorageErrorCode::CorruptMetadata,
                    format!("FYLO branch ref is corrupt: {error}"),
                )
            })?;
        if reference.name != branch {
            return Err(NativeStorageError::new(
                NativeStorageErrorCode::CorruptMetadata,
                "FYLO branch ref name does not match HEAD",
            ));
        }
        if let Some(head) = &reference.head {
            validate_ttid_shape(head).map_err(|error| {
                NativeStorageError::new(
                    NativeStorageErrorCode::CorruptMetadata,
                    format!("FYLO branch head is invalid: {error}"),
                )
            })?;
        }
        let mut next = reference.head.clone();
        let mut seen = BTreeSet::new();
        let mut commits = Vec::new();
        while commits.len() < limit {
            let Some(identifier) = next.take() else {
                break;
            };
            if !seen.insert(identifier.clone()) {
                return Err(NativeStorageError::new(
                    NativeStorageErrorCode::CorruptMetadata,
                    "FYLO commit history contains a cycle",
                ));
            }
            let path = self
                .canonical
                .join(".fylo-vcs")
                .join("commits")
                .join(&identifier)
                .join("manifest.json");
            let commit: VersionCommit =
                serde_json::from_slice(&self.read_file(&path, MAX_VERSION_METADATA_BYTES)?)
                    .map_err(|error| {
                        NativeStorageError::new(
                            NativeStorageErrorCode::CorruptMetadata,
                            format!("FYLO commit manifest is corrupt: {error}"),
                        )
                    })?;
            commit.validate(&identifier)?;
            next = commit.parents.first().cloned();
            commits.push(commit);
        }
        Ok(RepositoryHistory {
            enabled: true,
            branch: Some(branch.to_owned()),
            head: reference.head,
            commits,
            truncated: next.is_some(),
        })
    }

    /// Verify the content-addressed trees and blobs referenced by the active
    /// branch's bounded first-parent history.
    ///
    /// Objects are hashed through verified file descriptors and tree nodes are
    /// schema-, ordering-, type-, and path-validated. No historical version is
    /// materialized and no repository state is modified.
    ///
    /// # Errors
    ///
    /// Returns an error for corrupt manifests, tree pointers, objects, unsafe
    /// paths, excessive limits, object-count exhaustion, or byte-budget
    /// exhaustion.
    pub fn verify_version_history(
        &self,
        limit: usize,
    ) -> Result<VersionVerification, NativeStorageError> {
        let history = self.version_history(limit)?;
        let mut state = VersionVerificationState::default();
        for commit in &history.commits {
            let tree_path = self
                .canonical
                .join(".fylo-vcs")
                .join("commits")
                .join(&commit.id)
                .join("tree.json");
            let pointer: VersionTreePointer =
                serde_json::from_slice(&self.read_file(&tree_path, MAX_VERSION_METADATA_BYTES)?)
                    .map_err(|error| {
                        NativeStorageError::new(
                            NativeStorageErrorCode::CorruptMetadata,
                            format!("FYLO commit tree pointer is corrupt: {error}"),
                        )
                    })?;
            if let Some(root) = pointer.root {
                self.verify_version_tree_node(
                    root.as_str(),
                    VersionTreeLevel::Collection,
                    None,
                    &mut state,
                )?;
            }
        }
        let tree_objects = state
            .objects
            .values()
            .filter(|kind| matches!(kind, VersionObjectKind::Tree(_)))
            .count();
        let blob_objects = state.objects.len().saturating_sub(tree_objects);
        Ok(VersionVerification {
            enabled: history.enabled,
            branch: history.branch,
            head: history.head,
            commits_verified: history.commits.len(),
            history_complete: !history.truncated,
            tree_objects,
            blob_objects,
            verified_bytes: state.verified_bytes,
            content_integrity: true,
        })
    }

    fn verify_version_tree_node(
        &self,
        hash: &str,
        level: VersionTreeLevel,
        expected_shard: Option<&str>,
        state: &mut VersionVerificationState,
    ) -> Result<(), NativeStorageError> {
        if !state.register(hash, VersionObjectKind::Tree(level))? {
            return Ok(());
        }
        let bytes = self.read_version_object(hash, MAX_VERSION_TREE_BYTES)?;
        state.record_bytes(bytes.len() as u64)?;
        let node: VersionTreeNode = serde_json::from_slice(&bytes).map_err(|error| {
            NativeStorageError::new(
                NativeStorageErrorCode::CorruptMetadata,
                format!("FYLO version tree object is corrupt: {error}"),
            )
        })?;
        if node.entries.is_empty()
            || node
                .entries
                .windows(2)
                .any(|pair| pair[0].name >= pair[1].name)
        {
            return Err(NativeStorageError::new(
                NativeStorageErrorCode::CorruptMetadata,
                "FYLO version tree entries are empty, duplicated, or unsorted",
            ));
        }
        for entry in node.entries {
            entry.validate(level, expected_shard)?;
            if level == VersionTreeLevel::Blob {
                if state.register(&entry.hash, VersionObjectKind::Blob)? {
                    let bytes = self.verify_version_object(&entry.hash, MAX_VERSION_BLOB_BYTES)?;
                    state.record_bytes(bytes)?;
                }
            } else {
                let child_shard = if level == VersionTreeLevel::Shard {
                    Some(entry.name.as_str())
                } else {
                    expected_shard
                };
                self.verify_version_tree_node(&entry.hash, level.next(), child_shard, state)?;
            }
        }
        Ok(())
    }

    fn read_version_object(
        &self,
        hash: &str,
        max_bytes: u64,
    ) -> Result<Vec<u8>, NativeStorageError> {
        let path = self.version_object_path(hash)?;
        let bytes = self.read_file(&path, max_bytes)?;
        if sha256_hex(&bytes) != hash {
            return Err(NativeStorageError::new(
                NativeStorageErrorCode::CorruptMetadata,
                format!("FYLO version object {hash} failed content-hash verification"),
            ));
        }
        Ok(bytes)
    }

    fn verify_version_object(&self, hash: &str, max_bytes: u64) -> Result<u64, NativeStorageError> {
        let path = self.version_object_path(hash)?;
        let (mut file, metadata) = self.open_file(&path, max_bytes)?;
        let mut digest = Sha256::new();
        let mut buffer = vec![0_u8; 64 * 1024];
        let mut total = 0_u64;
        loop {
            let read = file.read(&mut buffer).map_err(NativeStorageError::io)?;
            if read == 0 {
                break;
            }
            total = total.checked_add(read as u64).ok_or_else(|| {
                NativeStorageError::new(
                    NativeStorageErrorCode::FileTooLarge,
                    "FYLO version object byte count overflow",
                )
            })?;
            if total > max_bytes {
                return Err(NativeStorageError::new(
                    NativeStorageErrorCode::FileTooLarge,
                    "FYLO version object exceeds the verification byte limit",
                ));
            }
            digest.update(&buffer[..read]);
        }
        let actual = hex_bytes(&digest.finalize());
        if actual != hash || total != metadata.len() {
            return Err(NativeStorageError::new(
                NativeStorageErrorCode::CorruptMetadata,
                format!("FYLO version object {hash} failed content-hash verification"),
            ));
        }
        Ok(total)
    }

    fn version_object_path(&self, hash: &str) -> Result<PathBuf, NativeStorageError> {
        validate_version_hash(hash)?;
        Ok(self
            .canonical
            .join(".fylo-vcs")
            .join("objects")
            .join(&hash[..2])
            .join(&hash[2..]))
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
        let (file, _) = self.open_file(path, max_bytes)?;
        read_bounded(file.take(max_bytes.saturating_add(1)), max_bytes)
    }

    fn open_file(
        &self,
        path: &Path,
        max_bytes: u64,
    ) -> Result<(File, Metadata), NativeStorageError> {
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
        Ok((file, opened))
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

#[derive(Deserialize)]
struct BranchReference {
    name: String,
    head: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct VersionTreePointer {
    root: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct VersionTreeNode {
    entries: Vec<VersionTreeEntry>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct VersionTreeEntry {
    name: String,
    #[serde(rename = "type")]
    kind: VersionTreeEntryKind,
    hash: String,
}

impl VersionTreeEntry {
    fn validate(
        &self,
        level: VersionTreeLevel,
        expected_shard: Option<&str>,
    ) -> Result<(), NativeStorageError> {
        validate_version_hash(&self.hash)?;
        let valid_name = !self.name.is_empty()
            && self.name.len() <= 255
            && !self.name.contains(['/', '\\'])
            && self.name != "."
            && self.name != "..";
        let valid_kind = match level {
            VersionTreeLevel::Blob => self.kind == VersionTreeEntryKind::Blob,
            _ => self.kind == VersionTreeEntryKind::Tree,
        };
        let valid_level = match level {
            VersionTreeLevel::Collection => validate_collection_name(&self.name).is_ok(),
            VersionTreeLevel::Namespace => {
                matches!(self.name.as_str(), "docs" | ".deleted" | ".metadata")
            }
            VersionTreeLevel::Shard => {
                self.name.len() == 2 && self.name.bytes().all(|byte| byte.is_ascii_alphanumeric())
            }
            VersionTreeLevel::Blob => raw_file_identifier(&self.name).is_some_and(|identifier| {
                validate_ttid_shape(identifier).is_ok()
                    && expected_shard.is_some_and(|shard| identifier.starts_with(shard))
            }),
        };
        if valid_name && valid_kind && valid_level {
            Ok(())
        } else {
            Err(NativeStorageError::new(
                NativeStorageErrorCode::CorruptMetadata,
                "FYLO version tree entry has an invalid schema",
            ))
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize)]
#[serde(rename_all = "lowercase")]
enum VersionTreeEntryKind {
    Tree,
    Blob,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd)]
enum VersionTreeLevel {
    Collection,
    Namespace,
    Shard,
    Blob,
}

impl VersionTreeLevel {
    const fn next(self) -> Self {
        match self {
            Self::Collection => Self::Namespace,
            Self::Namespace => Self::Shard,
            Self::Shard | Self::Blob => Self::Blob,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum VersionObjectKind {
    Tree(VersionTreeLevel),
    Blob,
}

#[derive(Default)]
struct VersionVerificationState {
    objects: BTreeMap<String, VersionObjectKind>,
    verified_bytes: u64,
}

impl VersionVerificationState {
    fn register(
        &mut self,
        hash: &str,
        kind: VersionObjectKind,
    ) -> Result<bool, NativeStorageError> {
        validate_version_hash(hash)?;
        if let Some(existing) = self.objects.get(hash) {
            if *existing == kind {
                return Ok(false);
            }
            return Err(NativeStorageError::new(
                NativeStorageErrorCode::CorruptMetadata,
                "FYLO version object is referenced with conflicting types",
            ));
        }
        if self.objects.len() >= MAX_VERSION_OBJECTS {
            return Err(NativeStorageError::new(
                NativeStorageErrorCode::FileTooLarge,
                "FYLO version verification exceeds the object-count limit",
            ));
        }
        self.objects.insert(hash.to_owned(), kind);
        Ok(true)
    }

    fn record_bytes(&mut self, bytes: u64) -> Result<(), NativeStorageError> {
        self.verified_bytes = self.verified_bytes.checked_add(bytes).ok_or_else(|| {
            NativeStorageError::new(
                NativeStorageErrorCode::FileTooLarge,
                "FYLO version verification byte count overflow",
            )
        })?;
        if self.verified_bytes > MAX_VERSION_TOTAL_BYTES {
            return Err(NativeStorageError::new(
                NativeStorageErrorCode::FileTooLarge,
                "FYLO version verification exceeds the aggregate byte limit",
            ));
        }
        Ok(())
    }
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
        self.document_ids_at(&self.path.join("docs"))
    }

    /// List validated retained tombstone identifiers.
    ///
    /// # Errors
    ///
    /// Returns an error for non-document collections or unsafe/corrupt
    /// tombstone paths.
    pub fn deleted_document_ids(&self) -> Result<Vec<String>, NativeStorageError> {
        if self.kind != CollectionKind::Document {
            return Err(NativeStorageError::new(
                NativeStorageErrorCode::Unsupported,
                "deleted-document enumeration is not available for file collections",
            ));
        }
        self.document_ids_at(&self.path.join(".deleted"))
    }

    fn document_ids_at(&self, namespace: &Path) -> Result<Vec<String>, NativeStorageError> {
        self.root.verify_path(namespace, ExpectedType::Directory)?;
        let mut ids = Vec::new();
        let mut shards = read_dir_sorted(namespace)?;
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

    /// List validated live raw-file identifiers in lexical path order.
    ///
    /// # Errors
    ///
    /// Returns an error for non-file collections, linked or malformed
    /// entries, duplicate identifiers, or filesystem failures.
    pub fn raw_file_ids(&self) -> Result<Vec<String>, NativeStorageError> {
        if self.kind != CollectionKind::File {
            return Err(NativeStorageError::new(
                NativeStorageErrorCode::Unsupported,
                "raw-file enumeration is available only for file collections",
            ));
        }
        self.raw_file_ids_at(&self.path.join("docs"))
    }

    /// List validated retained raw-file tombstone identifiers.
    ///
    /// # Errors
    ///
    /// Returns an error for non-file collections or unsafe/corrupt tombstone
    /// paths.
    pub fn deleted_raw_file_ids(&self) -> Result<Vec<String>, NativeStorageError> {
        if self.kind != CollectionKind::File {
            return Err(NativeStorageError::new(
                NativeStorageErrorCode::Unsupported,
                "deleted raw-file enumeration is available only for file collections",
            ));
        }
        self.raw_file_ids_at(&self.path.join(".deleted"))
    }

    fn raw_file_ids_at(&self, namespace: &Path) -> Result<Vec<String>, NativeStorageError> {
        self.root.verify_path(namespace, ExpectedType::Directory)?;
        let mut ids = BTreeSet::new();
        for shard in read_dir_sorted(namespace)? {
            let shard_path = shard.path();
            let file_type = shard.file_type().map_err(NativeStorageError::io)?;
            if file_type.is_symlink() || !file_type.is_dir() {
                return Err(NativeStorageError::new(
                    NativeStorageErrorCode::UnsafePath,
                    format!(
                        "raw-file shard is not a regular directory: {}",
                        shard_path.display()
                    ),
                ));
            }
            self.root
                .verify_path(&shard_path, ExpectedType::Directory)?;
            let shard_name = path_utf8_name(&shard_path, "raw-file shard")?;
            for entry in read_dir_sorted(&shard_path)? {
                let path = entry.path();
                let file_type = entry.file_type().map_err(NativeStorageError::io)?;
                if file_type.is_symlink() || !file_type.is_file() {
                    return Err(NativeStorageError::new(
                        NativeStorageErrorCode::UnsafePath,
                        format!("raw-file entry is not a regular file: {}", path.display()),
                    ));
                }
                let filename = path_utf8_name(&path, "raw-file")?;
                if is_scratch_file(filename) {
                    continue;
                }
                let Some(identifier) = raw_file_identifier(filename) else {
                    continue;
                };
                validate_ttid_shape(identifier)?;
                validate_raw_extension(filename, identifier)?;
                if !identifier.starts_with(shard_name) {
                    return Err(NativeStorageError::new(
                        NativeStorageErrorCode::InvalidDocumentId,
                        "raw-file identifier does not match its shard",
                    ));
                }
                if !ids.insert(identifier.to_owned()) {
                    return Err(NativeStorageError::new(
                        NativeStorageErrorCode::CorruptMetadata,
                        format!("multiple raw files found for document ID: {identifier}"),
                    ));
                }
            }
        }
        Ok(ids.into_iter().collect())
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
        self.read_document_at(&self.path.join("docs"), identifier)
    }

    /// Read one retained soft-deleted JSON document. Its modification time is
    /// the deletion timestamp established by the JavaScript engine.
    ///
    /// # Errors
    ///
    /// Returns an error for invalid IDs, unsafe paths, oversized files, or I/O
    /// failures.
    pub fn read_deleted_document(
        &self,
        identifier: &str,
    ) -> Result<StoredBytes, NativeStorageError> {
        validate_ttid_shape(identifier)?;
        if self.kind != CollectionKind::Document {
            return Err(NativeStorageError::new(
                NativeStorageErrorCode::Unsupported,
                "deleted JSON document reads are not available for file collections",
            ));
        }
        self.read_document_at(&self.path.join(".deleted"), identifier)
    }

    fn read_document_at(
        &self,
        namespace: &Path,
        identifier: &str,
    ) -> Result<StoredBytes, NativeStorageError> {
        let path = namespace
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

    /// Read one raw file with its durable object key, custom metadata,
    /// checksum, and native ownership/mode metadata.
    ///
    /// The data and xattrs are read from the same verified open file on Unix.
    /// Windows reads the existing `fylo.xattrs` ADS representation; native
    /// Windows race-hardening remains qualification-gated.
    ///
    /// # Errors
    ///
    /// Returns an error for invalid IDs, duplicate files, missing durable
    /// keys, corrupt metadata, unsafe paths, oversized files, or I/O failures.
    pub fn read_raw_file(&self, identifier: &str) -> Result<StoredRawFile, NativeStorageError> {
        validate_ttid_shape(identifier)?;
        if self.kind != CollectionKind::File {
            return Err(NativeStorageError::new(
                NativeStorageErrorCode::Unsupported,
                "raw-file reads are available only for file collections",
            ));
        }
        self.read_raw_file_at(&self.path.join("docs"), identifier)
    }

    /// Read one retained soft-deleted raw file. Its modification time is the
    /// deletion timestamp established by the JavaScript engine.
    ///
    /// # Errors
    ///
    /// Returns an error for invalid IDs, duplicate files, corrupt metadata,
    /// unsafe paths, oversized files, or I/O failures.
    pub fn read_deleted_raw_file(
        &self,
        identifier: &str,
    ) -> Result<StoredRawFile, NativeStorageError> {
        validate_ttid_shape(identifier)?;
        if self.kind != CollectionKind::File {
            return Err(NativeStorageError::new(
                NativeStorageErrorCode::Unsupported,
                "deleted raw-file reads are available only for file collections",
            ));
        }
        self.read_raw_file_at(&self.path.join(".deleted"), identifier)
    }

    fn read_raw_file_at(
        &self,
        namespace: &Path,
        identifier: &str,
    ) -> Result<StoredRawFile, NativeStorageError> {
        let path = self.find_raw_file_path(namespace, identifier)?;
        let filename = path_utf8_name(&path, "raw-file")?;
        let extension = validate_raw_extension(filename, identifier)?.to_owned();
        let (file, metadata) = self.root.open_file(&path, MAX_RAW_FILE_BYTES)?;
        let attributes = read_fylo_attributes(&file, &path)?;
        let key = required_utf8_attribute(&attributes, KEY_XATTR, identifier)?;
        validate_raw_key(&key)?;
        let custom_metadata = decode_custom_metadata(&attributes)?;
        let bytes = read_bounded(
            file.take(MAX_RAW_FILE_BYTES.saturating_add(1)),
            MAX_RAW_FILE_BYTES,
        )?;
        let computed_checksum = sha256_hex(&bytes);
        let modified_millis = modified_millis(&metadata)?;
        let checksum_sha256 = cached_checksum(
            attributes.get(CHECKSUM_XATTR),
            metadata.len(),
            modified_millis,
        )
        .unwrap_or(computed_checksum);
        Ok(StoredRawFile {
            bytes,
            key,
            extension: extension.clone(),
            content_type: raw_file_content_type(&extension).to_owned(),
            checksum_sha256,
            custom_metadata,
            modified_millis,
            access: native_access(&metadata),
            path,
        })
    }

    fn find_raw_file_path(
        &self,
        namespace: &Path,
        identifier: &str,
    ) -> Result<PathBuf, NativeStorageError> {
        let shard = namespace.join(&identifier[..2]);
        if !path_exists_no_follow(&shard)? {
            return Err(NativeStorageError::new(
                NativeStorageErrorCode::NotFound,
                format!("raw file not found: {identifier}"),
            ));
        }
        self.root.verify_path(&shard, ExpectedType::Directory)?;
        let mut match_path = None;
        for entry in read_dir_sorted(&shard)? {
            let path = entry.path();
            let filename = path_utf8_name(&path, "raw-file")?;
            if raw_file_identifier(filename) != Some(identifier) {
                continue;
            }
            let file_type = entry.file_type().map_err(NativeStorageError::io)?;
            if file_type.is_symlink() || !file_type.is_file() {
                return Err(NativeStorageError::new(
                    NativeStorageErrorCode::UnsafePath,
                    format!("raw file is not a regular, non-link file: {identifier}"),
                ));
            }
            validate_raw_extension(filename, identifier)?;
            if match_path.replace(path).is_some() {
                return Err(NativeStorageError::new(
                    NativeStorageErrorCode::CorruptMetadata,
                    format!("multiple raw files found for document ID: {identifier}"),
                ));
            }
        }
        let path = match_path.ok_or_else(|| {
            NativeStorageError::new(
                NativeStorageErrorCode::NotFound,
                format!("raw file not found: {identifier}"),
            )
        })?;
        self.root.verify_path(&path, ExpectedType::File)?;
        Ok(path)
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

    /// Verify that every merged snapshot/WAL key is structurally valid and
    /// references a live document or raw file.
    ///
    /// This is an integrity check, not yet full rebuild-equivalence proof.
    ///
    /// # Errors
    ///
    /// Returns an error for corrupt keys, orphaned identifiers, unsafe paths,
    /// or storage failures.
    pub fn verify_index_references(&self) -> Result<IndexVerification, NativeStorageError> {
        let live: BTreeSet<String> = match self.kind {
            CollectionKind::Document => self.document_ids()?.into_iter().collect(),
            CollectionKind::File => self.raw_file_ids()?.into_iter().collect(),
        };
        let snapshot = self.index_snapshot()?;
        let mut indexed = BTreeSet::new();
        let mut key_count = 0_usize;
        for key in snapshot
            .as_bytes()
            .split(|byte| *byte == b'\n')
            .filter(|key| !key.is_empty())
        {
            key_count = key_count.checked_add(1).ok_or_else(|| {
                NativeStorageError::new(
                    NativeStorageErrorCode::FileTooLarge,
                    "index key count overflow",
                )
            })?;
            let key = std::str::from_utf8(key).map_err(|error| {
                NativeStorageError::new(
                    NativeStorageErrorCode::CorruptIndex,
                    format!("index key is not valid UTF-8: {error}"),
                )
            })?;
            let segments: Vec<&str> = key.split('/').collect();
            if segments.len() < 4 {
                return Err(NativeStorageError::new(
                    NativeStorageErrorCode::CorruptIndex,
                    "index key has too few segments",
                ));
            }
            let identifier = segments.last().copied().unwrap_or_default();
            if identifier.contains('%') {
                return Err(NativeStorageError::new(
                    NativeStorageErrorCode::CorruptIndex,
                    "index document identifier must use canonical TTID bytes",
                ));
            }
            validate_ttid_shape(identifier).map_err(|error| {
                NativeStorageError::new(
                    NativeStorageErrorCode::CorruptIndex,
                    format!("index contains an invalid document identifier: {error}"),
                )
            })?;
            if !live.contains(identifier) {
                return Err(NativeStorageError::new(
                    NativeStorageErrorCode::CorruptIndex,
                    format!("index contains an orphaned document identifier: {identifier}"),
                ));
            }
            indexed.insert(identifier.to_owned());
        }
        Ok(IndexVerification {
            key_count,
            indexed_documents: indexed.len(),
            live_documents: live.len(),
            reference_integrity: true,
            rebuild_equivalent: false,
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

/// Raw-file bytes and metadata bound to one verified native file.
#[derive(Clone, Debug, PartialEq)]
pub struct StoredRawFile {
    /// Unwrapped file bytes.
    pub bytes: Vec<u8>,
    /// Durable logical object key from FYLO metadata.
    pub key: String,
    /// Safe final filename extension, including the leading dot.
    pub extension: String,
    /// Content type inferred using the existing FYLO extension table.
    pub content_type: String,
    /// SHA-256 checksum of the returned bytes.
    pub checksum_sha256: String,
    /// Developer-defined JSON metadata.
    pub custom_metadata: BTreeMap<String, Value>,
    /// Filesystem modification time in Unix milliseconds.
    pub modified_millis: u64,
    /// Native owner, group, and mode where the platform exposes them.
    pub access: NativeAccess,
    /// Verified native path.
    pub path: PathBuf,
}

/// Native file access metadata.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeAccess {
    /// POSIX owner ID when available.
    pub uid: Option<u32>,
    /// POSIX group ID when available.
    pub gid: Option<u32>,
    /// POSIX permission and special bits when available.
    pub mode: Option<u32>,
}

/// Read-only prefix-index reference verification.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexVerification {
    /// Number of merged snapshot/WAL keys checked.
    pub key_count: usize,
    /// Unique live identifiers represented by at least one key.
    pub indexed_documents: usize,
    /// Total live records in the authoritative document tree.
    pub live_documents: usize,
    /// Always true when this report is returned.
    pub reference_integrity: bool,
    /// False until exact independent rebuild comparison is implemented.
    pub rebuild_equivalent: bool,
}

/// Active first-parent FYLO repository history.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryHistory {
    /// Whether `.fylo-vcs/HEAD` exists.
    pub enabled: bool,
    /// Active branch when versioning is initialized.
    pub branch: Option<String>,
    /// Active branch head commit.
    pub head: Option<String>,
    /// Newest-to-oldest first-parent commits, bounded by the requested limit.
    pub commits: Vec<VersionCommit>,
    /// Whether an older first-parent commit exists beyond the requested limit.
    pub truncated: bool,
}

/// Bounded content-integrity report for active first-parent history.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionVerification {
    /// Whether versioning is initialized.
    pub enabled: bool,
    /// Active branch when versioning is initialized.
    pub branch: Option<String>,
    /// Active branch head commit.
    pub head: Option<String>,
    /// Number of first-parent commits whose trees were traversed.
    pub commits_verified: usize,
    /// Whether the requested bound covered the complete first-parent chain.
    pub history_complete: bool,
    /// Number of unique content-addressed tree objects verified.
    pub tree_objects: usize,
    /// Number of unique content-addressed document/file/metadata blobs verified.
    pub blob_objects: usize,
    /// Aggregate bytes hashed across unique objects.
    pub verified_bytes: u64,
    /// True only when all reported objects passed schema and hash verification.
    pub content_integrity: bool,
}

/// Validated immutable FYLO commit manifest.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionCommit {
    /// Commit TTID.
    pub id: String,
    /// Branch that originally produced the commit.
    pub branch: String,
    /// Parent commit TTIDs.
    pub parents: Vec<String>,
    /// Operator/developer commit message.
    pub message: String,
    /// ISO timestamp emitted by the JavaScript engine.
    pub created_at: String,
    /// Repository-relative immutable commit directory.
    pub root: String,
}

impl VersionCommit {
    fn validate(&self, expected_identifier: &str) -> Result<(), NativeStorageError> {
        if self.id != expected_identifier {
            return Err(NativeStorageError::new(
                NativeStorageErrorCode::CorruptMetadata,
                "FYLO commit manifest ID does not match its directory",
            ));
        }
        validate_ttid_shape(&self.id).map_err(|error| {
            NativeStorageError::new(
                NativeStorageErrorCode::CorruptMetadata,
                format!("FYLO commit manifest ID is invalid: {error}"),
            )
        })?;
        validate_branch_name(&self.branch)?;
        if self.parents.len() > 2
            || self
                .parents
                .iter()
                .any(|parent| parent == &self.id || validate_ttid_shape(parent).is_err())
            || self.message.trim().is_empty()
            || self.message.len() > 64 * 1024
            || self.created_at.is_empty()
            || self.root != format!(".fylo-vcs/commits/{}", self.id)
        {
            return Err(NativeStorageError::new(
                NativeStorageErrorCode::CorruptMetadata,
                "FYLO commit manifest has an invalid schema",
            ));
        }
        Ok(())
    }
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
    /// Requested record was not found.
    NotFound,
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
            Self::NotFound => "ENATIVE_NOT_FOUND",
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

#[cfg(unix)]
fn read_fylo_attributes(
    file: &File,
    _path: &Path,
) -> Result<BTreeMap<String, Vec<u8>>, NativeStorageError> {
    use xattr::FileExt;

    let mut attributes = BTreeMap::new();
    let mut aggregate_bytes = 0_usize;
    for name in file.list_xattr().map_err(NativeStorageError::io)? {
        let name = name.to_str().ok_or_else(|| {
            NativeStorageError::new(
                NativeStorageErrorCode::CorruptMetadata,
                "raw-file xattr name is not valid UTF-8",
            )
        })?;
        if name != KEY_XATTR && name != CHECKSUM_XATTR && !name.starts_with(META_XATTR_PREFIX) {
            continue;
        }
        let Some(value) = file.get_xattr(name).map_err(NativeStorageError::io)? else {
            continue;
        };
        if value.len() > MAX_META_VALUE_BYTES && name.starts_with(META_XATTR_PREFIX) {
            return Err(NativeStorageError::new(
                NativeStorageErrorCode::FileTooLarge,
                format!("raw-file metadata attribute {name} exceeds 60 KiB"),
            ));
        }
        aggregate_bytes = aggregate_bytes
            .checked_add(name.len())
            .and_then(|total| total.checked_add(value.len()))
            .ok_or_else(|| {
                NativeStorageError::new(
                    NativeStorageErrorCode::FileTooLarge,
                    "raw-file metadata aggregate size overflow",
                )
            })?;
        if aggregate_bytes > MAX_FILE_METADATA_BYTES {
            return Err(NativeStorageError::new(
                NativeStorageErrorCode::FileTooLarge,
                "raw-file FYLO metadata exceeds 1 MiB",
            ));
        }
        attributes.insert(name.to_owned(), value);
    }
    Ok(attributes)
}

#[cfg(windows)]
fn read_fylo_attributes(
    _file: &File,
    path: &Path,
) -> Result<BTreeMap<String, Vec<u8>>, NativeStorageError> {
    use std::ffi::OsString;

    const MAX_WINDOWS_ADS_MANIFEST_BYTES: u64 = 16 * 1024 * 1024;
    let mut stream = OsString::from(path.as_os_str());
    stream.push(":fylo.xattrs");
    let stream = PathBuf::from(stream);
    let metadata = match fs::metadata(&stream) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(BTreeMap::new()),
        Err(error) => return Err(NativeStorageError::io(error)),
    };
    if metadata.len() > MAX_WINDOWS_ADS_MANIFEST_BYTES {
        return Err(NativeStorageError::new(
            NativeStorageErrorCode::FileTooLarge,
            "Windows FYLO ADS manifest exceeds 16 MiB",
        ));
    }
    let encoded: BTreeMap<String, String> = serde_json::from_slice(
        &fs::read(stream).map_err(NativeStorageError::io)?,
    )
    .map_err(|error| {
        NativeStorageError::new(
            NativeStorageErrorCode::CorruptMetadata,
            format!("Windows FYLO ADS manifest is corrupt: {error}"),
        )
    })?;
    encoded
        .into_iter()
        .filter(|(name, _)| {
            name == KEY_XATTR || name == CHECKSUM_XATTR || name.starts_with(META_XATTR_PREFIX)
        })
        .map(|(name, value)| {
            decode_base64(&value)
                .map(|value| (name, value))
                .map_err(|message| {
                    NativeStorageError::new(NativeStorageErrorCode::CorruptMetadata, message)
                })
        })
        .collect()
}

#[cfg(not(any(unix, windows)))]
fn read_fylo_attributes(
    _file: &File,
    _path: &Path,
) -> Result<BTreeMap<String, Vec<u8>>, NativeStorageError> {
    Err(NativeStorageError::new(
        NativeStorageErrorCode::Unsupported,
        "FYLO native metadata is unavailable on this platform",
    ))
}

fn required_utf8_attribute(
    attributes: &BTreeMap<String, Vec<u8>>,
    name: &str,
    identifier: &str,
) -> Result<String, NativeStorageError> {
    let value = attributes.get(name).ok_or_else(|| {
        NativeStorageError::new(
            NativeStorageErrorCode::CorruptMetadata,
            format!("raw file system metadata is missing: {identifier}"),
        )
    })?;
    String::from_utf8(value.clone()).map_err(|error| {
        NativeStorageError::new(
            NativeStorageErrorCode::CorruptMetadata,
            format!("raw-file attribute {name} is not valid UTF-8: {error}"),
        )
    })
}

fn decode_custom_metadata(
    attributes: &BTreeMap<String, Vec<u8>>,
) -> Result<BTreeMap<String, Value>, NativeStorageError> {
    attributes
        .iter()
        .filter_map(|(name, value)| {
            name.strip_prefix(META_XATTR_PREFIX)
                .map(|field| (field, value))
        })
        .map(|(field, encoded)| {
            if field.is_empty() || field.len() > 64 {
                return Err(NativeStorageError::new(
                    NativeStorageErrorCode::CorruptMetadata,
                    "raw-file custom metadata name is invalid",
                ));
            }
            let value = match serde_json::from_slice(encoded) {
                Ok(value) => value,
                Err(_) => Value::String(String::from_utf8(encoded.clone()).map_err(|error| {
                    NativeStorageError::new(
                        NativeStorageErrorCode::CorruptMetadata,
                        format!("raw-file metadata {field} is not valid UTF-8: {error}"),
                    )
                })?),
            };
            Ok((field.to_owned(), value))
        })
        .collect()
}

fn cached_checksum(value: Option<&Vec<u8>>, size: u64, modified_millis: u64) -> Option<String> {
    let encoded = std::str::from_utf8(value?).ok()?;
    let mut parts = encoded.split(':');
    let checksum = parts.next()?;
    let cached_size = parts.next()?.parse::<u64>().ok()?;
    let cached_mtime = parts.next()?.parse::<u64>().ok()?;
    if parts.next().is_none()
        && checksum.len() == 64
        && checksum
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        && cached_size == size
        && cached_mtime == modified_millis
    {
        Some(checksum.to_ascii_lowercase())
    } else {
        None
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    hex_bytes(&digest)
}

fn hex_bytes(bytes: &[u8]) -> String {
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write;
        write!(&mut encoded, "{byte:02x}").expect("writing to a string cannot fail");
    }
    encoded
}

fn path_utf8_name<'a>(path: &'a Path, description: &str) -> Result<&'a str, NativeStorageError> {
    path.file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| {
            NativeStorageError::new(
                NativeStorageErrorCode::CorruptMetadata,
                format!("{description} filename is not valid UTF-8"),
            )
        })
}

fn raw_file_identifier(filename: &str) -> Option<&str> {
    let identifier = filename.split_once('.').map_or(filename, |(id, _)| id);
    (!identifier.is_empty()
        && identifier
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-'))
    .then_some(identifier)
}

fn validate_raw_extension<'a>(
    filename: &'a str,
    identifier: &str,
) -> Result<&'a str, NativeStorageError> {
    let extension = filename.strip_prefix(identifier).ok_or_else(|| {
        NativeStorageError::new(
            NativeStorageErrorCode::CorruptMetadata,
            "raw-file filename does not begin with its identifier",
        )
    })?;
    let valid = extension.len() >= 2
        && extension.len() <= 17
        && extension.starts_with('.')
        && extension[1..]
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit());
    if !valid {
        return Err(NativeStorageError::new(
            NativeStorageErrorCode::CorruptMetadata,
            "raw-file extension is invalid",
        ));
    }
    Ok(extension)
}

fn validate_raw_key(key: &str) -> Result<(), NativeStorageError> {
    let valid_shape = key.starts_with('/')
        && key.len() <= 1024
        && !key
            .chars()
            .any(|character| character <= '\u{1f}' || character == '\u{7f}' || character == '\\');
    if !valid_shape {
        return Err(NativeStorageError::new(
            NativeStorageErrorCode::CorruptMetadata,
            "raw-file durable key is invalid",
        ));
    }
    for segment in key.split('/').filter(|segment| !segment.is_empty()) {
        let decoded = percent_decode(segment)?;
        if decoded == "." || decoded == ".." {
            return Err(NativeStorageError::new(
                NativeStorageErrorCode::CorruptMetadata,
                "raw-file durable key contains a traversal segment",
            ));
        }
    }
    Ok(())
}

fn percent_decode(segment: &str) -> Result<String, NativeStorageError> {
    let source = segment.as_bytes();
    let mut decoded = Vec::with_capacity(source.len());
    let mut index = 0;
    while index < source.len() {
        if source[index] != b'%' {
            decoded.push(source[index]);
            index += 1;
            continue;
        }
        if index + 2 >= source.len() {
            return Err(NativeStorageError::new(
                NativeStorageErrorCode::CorruptMetadata,
                "raw-file durable key contains invalid percent encoding",
            ));
        }
        let high = hex_value(source[index + 1]);
        let low = hex_value(source[index + 2]);
        let (Some(high), Some(low)) = (high, low) else {
            return Err(NativeStorageError::new(
                NativeStorageErrorCode::CorruptMetadata,
                "raw-file durable key contains invalid percent encoding",
            ));
        };
        decoded.push((high << 4) | low);
        index += 3;
    }
    String::from_utf8(decoded).map_err(|error| {
        NativeStorageError::new(
            NativeStorageErrorCode::CorruptMetadata,
            format!("raw-file durable key contains invalid UTF-8 encoding: {error}"),
        )
    })
}

const fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn raw_file_content_type(extension: &str) -> &'static str {
    match extension {
        ".avif" => "image/avif",
        ".bmp" => "image/bmp",
        ".csv" => "text/csv",
        ".gif" => "image/gif",
        ".gz" => "application/gzip",
        ".html" => "text/html",
        ".jpeg" | ".jpg" => "image/jpeg",
        ".json" => "application/json",
        ".md" => "text/markdown",
        ".mov" => "video/quicktime",
        ".mp3" => "audio/mpeg",
        ".mp4" => "video/mp4",
        ".pdf" => "application/pdf",
        ".png" => "image/png",
        ".svg" => "image/svg+xml",
        ".tar" => "application/x-tar",
        ".txt" => "text/plain",
        ".wav" => "audio/wav",
        ".webm" => "video/webm",
        ".webp" => "image/webp",
        ".xml" => "application/xml",
        ".zip" => "application/zip",
        _ => "application/octet-stream",
    }
}

#[cfg(unix)]
fn native_access(metadata: &Metadata) -> NativeAccess {
    use std::os::unix::fs::MetadataExt;
    NativeAccess {
        uid: Some(metadata.uid()),
        gid: Some(metadata.gid()),
        mode: Some(metadata.mode() & 0o7777),
    }
}

#[cfg(not(unix))]
fn native_access(_metadata: &Metadata) -> NativeAccess {
    NativeAccess {
        uid: None,
        gid: None,
        mode: None,
    }
}

#[cfg(windows)]
fn decode_base64(encoded: &str) -> Result<Vec<u8>, &'static str> {
    if encoded.len() % 4 != 0 {
        return Err("Windows FYLO ADS manifest contains invalid base64");
    }
    let mut output = Vec::with_capacity(encoded.len() / 4 * 3);
    let quartets = encoded.as_bytes().chunks_exact(4);
    let quartet_count = quartets.len();
    for (index, quartet) in quartets.enumerate() {
        let is_last = index + 1 == quartet_count;
        if !is_last && quartet.contains(&b'=') {
            return Err("Windows FYLO ADS manifest contains invalid base64 padding");
        }
        let a = base64_value(quartet[0])?;
        let b = base64_value(quartet[1])?;
        let c = if quartet[2] == b'=' {
            0
        } else {
            base64_value(quartet[2])?
        };
        let d = if quartet[3] == b'=' {
            0
        } else {
            base64_value(quartet[3])?
        };
        if quartet[0] == b'=' || quartet[1] == b'=' || (quartet[2] == b'=' && quartet[3] != b'=') {
            return Err("Windows FYLO ADS manifest contains invalid base64 padding");
        }
        output.push((a << 2) | (b >> 4));
        if quartet[2] != b'=' {
            output.push((b << 4) | (c >> 2));
        }
        if quartet[3] != b'=' {
            output.push((c << 6) | d);
        }
    }
    Ok(output)
}

#[cfg(windows)]
fn base64_value(byte: u8) -> Result<u8, &'static str> {
    match byte {
        b'A'..=b'Z' => Ok(byte - b'A'),
        b'a'..=b'z' => Ok(byte - b'a' + 26),
        b'0'..=b'9' => Ok(byte - b'0' + 52),
        b'+' => Ok(62),
        b'/' => Ok(63),
        _ => Err("Windows FYLO ADS manifest contains invalid base64"),
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

fn validate_branch_name(name: &str) -> Result<(), NativeStorageError> {
    let valid = !name.is_empty()
        && name.len() <= 128
        && name.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_alphanumeric() || (index > 0 && matches!(byte, b'.' | b'_' | b'/' | b'-'))
        })
        && !name.contains("..")
        && !name.contains("//")
        && !name.ends_with('/')
        && !name.as_bytes().ends_with(b".lock");
    if valid {
        Ok(())
    } else {
        Err(NativeStorageError::new(
            NativeStorageErrorCode::CorruptMetadata,
            "FYLO branch name is invalid",
        ))
    }
}

fn validate_version_hash(hash: &str) -> Result<(), NativeStorageError> {
    if hash.len() == 64
        && hash
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        Ok(())
    } else {
        Err(NativeStorageError::new(
            NativeStorageErrorCode::CorruptMetadata,
            "FYLO version object hash is invalid",
        ))
    }
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

fn read_bounded<R: Read>(
    mut reader: Take<R>,
    max_bytes: u64,
) -> Result<Vec<u8>, NativeStorageError> {
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

        fn write_version_object(&self, bytes: &[u8]) -> String {
            let hash = sha256_hex(bytes);
            let path = self
                .0
                .join(".fylo-vcs/objects")
                .join(&hash[..2])
                .join(&hash[2..]);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, bytes).unwrap();
            hash
        }

        #[cfg(unix)]
        fn create_raw_file(&self) -> PathBuf {
            use std::os::unix::fs::PermissionsExt;

            fs::create_dir_all(self.0.join(".fylo-catalog/collections")).unwrap();
            fs::write(
                self.0.join(".fylo-catalog/collections/assets.json"),
                br#"{"kind":"file"}"#,
            )
            .unwrap();
            fs::create_dir_all(self.0.join(".buckets/assets/docs/4V")).unwrap();
            fs::create_dir_all(self.0.join(".buckets/assets/index")).unwrap();
            fs::write(self.0.join(".buckets/assets/index/keys.snapshot"), b"").unwrap();
            let path = self.0.join(".buckets/assets/docs/4V/4VRNF52JPCO.bin");
            fs::write(&path, [0, 1, 2, 3, 255]).unwrap();
            xattr::set(&path, KEY_XATTR, b"/fixtures/sample.bin").unwrap();
            xattr::set(&path, "user.fylo.meta.source", br#""rust-native-test""#).unwrap();
            xattr::set(&path, "user.fylo.meta.reviewed", b"true").unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
            path
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
        assert_eq!(
            collection.verify_index_references().unwrap(),
            IndexVerification {
                key_count: 1,
                indexed_documents: 1,
                live_documents: 1,
                reference_integrity: true,
                rebuild_equivalent: false,
            }
        );
    }

    #[test]
    fn reads_bounded_first_parent_version_history() {
        let fixture = TestRoot::create();
        let commit = "4VRNF52JPCO";
        fs::create_dir_all(fixture.0.join(".fylo-vcs/refs/heads")).unwrap();
        fs::create_dir_all(fixture.0.join(".fylo-vcs/commits").join(commit)).unwrap();
        fs::write(fixture.0.join(".fylo-vcs/HEAD"), b"ref: refs/heads/main\n").unwrap();
        fs::write(
            fixture.0.join(".fylo-vcs/refs/heads/main.json"),
            format!(r#"{{"name":"main","head":"{commit}"}}"#),
        )
        .unwrap();
        fs::write(
            fixture
                .0
                .join(".fylo-vcs/commits")
                .join(commit)
                .join("manifest.json"),
            format!(
                r#"{{"id":"{commit}","branch":"main","parents":[],"message":"baseline","createdAt":"2026-07-26T00:00:00.000Z","root":".fylo-vcs/commits/{commit}"}}"#
            ),
        )
        .unwrap();
        let history = NativeRoot::open(&fixture.0)
            .unwrap()
            .version_history(50)
            .unwrap();
        assert!(history.enabled);
        assert_eq!(history.branch.as_deref(), Some("main"));
        assert_eq!(history.head.as_deref(), Some(commit));
        assert_eq!(history.commits.len(), 1);
        assert_eq!(history.commits[0].message, "baseline");
    }

    #[test]
    fn verifies_content_addressed_version_tree_and_blob_hashes() {
        let fixture = TestRoot::create();
        let commit = "4VRNF52JPCO";
        fs::create_dir_all(fixture.0.join(".fylo-vcs/refs/heads")).unwrap();
        fs::create_dir_all(fixture.0.join(".fylo-vcs/commits").join(commit)).unwrap();
        fs::write(fixture.0.join(".fylo-vcs/HEAD"), b"ref: refs/heads/main\n").unwrap();
        fs::write(
            fixture.0.join(".fylo-vcs/refs/heads/main.json"),
            format!(r#"{{"name":"main","head":"{commit}"}}"#),
        )
        .unwrap();
        fs::write(
            fixture
                .0
                .join(".fylo-vcs/commits")
                .join(commit)
                .join("manifest.json"),
            format!(
                r#"{{"id":"{commit}","branch":"main","parents":[],"message":"baseline","createdAt":"2026-07-26T00:00:00.000Z","root":".fylo-vcs/commits/{commit}"}}"#
            ),
        )
        .unwrap();

        let blob = fixture.write_version_object(br#"{"name":"Ada"}"#);
        let bucket = fixture.write_version_object(
            format!(r#"{{"entries":[{{"name":"{commit}.json","type":"blob","hash":"{blob}"}}]}}"#)
                .as_bytes(),
        );
        let namespace = fixture.write_version_object(
            format!(r#"{{"entries":[{{"name":"4V","type":"tree","hash":"{bucket}"}}]}}"#)
                .as_bytes(),
        );
        let collection = fixture.write_version_object(
            format!(r#"{{"entries":[{{"name":"docs","type":"tree","hash":"{namespace}"}}]}}"#)
                .as_bytes(),
        );
        let root = fixture.write_version_object(
            format!(r#"{{"entries":[{{"name":"users","type":"tree","hash":"{collection}"}}]}}"#)
                .as_bytes(),
        );
        fs::write(
            fixture
                .0
                .join(".fylo-vcs/commits")
                .join(commit)
                .join("tree.json"),
            format!(r#"{{"root":"{root}"}}"#),
        )
        .unwrap();

        let native = NativeRoot::open(&fixture.0).unwrap();
        let report = native.verify_version_history(50).unwrap();
        assert!(report.content_integrity);
        assert!(report.history_complete);
        assert_eq!(report.commits_verified, 1);
        assert_eq!(report.tree_objects, 4);
        assert_eq!(report.blob_objects, 1);

        fs::write(
            fixture
                .0
                .join(".fylo-vcs/objects")
                .join(&blob[..2])
                .join(&blob[2..]),
            b"corrupt",
        )
        .unwrap();
        assert_eq!(
            native.verify_version_history(50).unwrap_err().code(),
            NativeStorageErrorCode::CorruptMetadata
        );
    }

    #[test]
    fn reports_unversioned_roots_without_mutation() {
        let fixture = TestRoot::create();
        assert_eq!(
            NativeRoot::open(&fixture.0)
                .unwrap()
                .version_history(50)
                .unwrap(),
            RepositoryHistory {
                enabled: false,
                branch: None,
                head: None,
                commits: Vec::new(),
                truncated: false,
            }
        );
    }

    #[test]
    fn rejects_orphaned_index_references() {
        let fixture = TestRoot::create();
        fs::remove_file(
            fixture
                .0
                .join(".collections/users/docs/4V/4VRNF52JPCO.json"),
        )
        .unwrap();
        let collection = NativeRoot::open(&fixture.0)
            .unwrap()
            .collection("users")
            .unwrap();
        assert_eq!(
            collection.verify_index_references().unwrap_err().code(),
            NativeStorageErrorCode::CorruptIndex
        );
    }

    #[test]
    fn reads_retained_document_tombstones() {
        let fixture = TestRoot::create();
        fs::create_dir_all(fixture.0.join(".collections/users/.deleted/4V")).unwrap();
        fs::write(
            fixture
                .0
                .join(".collections/users/.deleted/4V/4VRNF52JPCO.json"),
            br#"{"name":"Deleted Ada"}"#,
        )
        .unwrap();
        let collection = NativeRoot::open(&fixture.0)
            .unwrap()
            .collection("users")
            .unwrap();
        assert_eq!(collection.deleted_document_ids().unwrap(), ["4VRNF52JPCO"]);
        assert_eq!(
            collection
                .read_deleted_document("4VRNF52JPCO")
                .unwrap()
                .bytes,
            br#"{"name":"Deleted Ada"}"#
        );
    }

    #[cfg(unix)]
    #[test]
    fn reads_raw_bytes_custom_metadata_and_native_access() {
        let fixture = TestRoot::create();
        let expected_path = fixture.create_raw_file();
        let collection = NativeRoot::open(&fixture.0)
            .unwrap()
            .collection("assets")
            .unwrap();
        assert_eq!(collection.raw_file_ids().unwrap(), ["4VRNF52JPCO"]);
        let stored = collection.read_raw_file("4VRNF52JPCO").unwrap();
        assert_eq!(stored.path, fs::canonicalize(expected_path).unwrap());
        assert_eq!(stored.bytes, [0, 1, 2, 3, 255]);
        assert_eq!(stored.key, "/fixtures/sample.bin");
        assert_eq!(stored.extension, ".bin");
        assert_eq!(stored.content_type, "application/octet-stream");
        assert_eq!(
            stored.custom_metadata.get("source"),
            Some(&Value::String("rust-native-test".into()))
        );
        assert_eq!(
            stored.custom_metadata.get("reviewed"),
            Some(&Value::Bool(true))
        );
        assert_eq!(stored.access.mode, Some(0o640));
        assert_eq!(stored.checksum_sha256.len(), 64);
    }

    #[cfg(unix)]
    #[test]
    fn rejects_duplicate_raw_file_identifiers() {
        let fixture = TestRoot::create();
        fixture.create_raw_file();
        let duplicate = fixture.0.join(".buckets/assets/docs/4V/4VRNF52JPCO.txt");
        fs::write(&duplicate, b"duplicate").unwrap();
        xattr::set(&duplicate, KEY_XATTR, b"/duplicate.txt").unwrap();
        let collection = NativeRoot::open(&fixture.0)
            .unwrap()
            .collection("assets")
            .unwrap();
        assert_eq!(
            collection.read_raw_file("4VRNF52JPCO").unwrap_err().code(),
            NativeStorageErrorCode::CorruptMetadata
        );
    }

    #[cfg(unix)]
    #[test]
    fn reads_retained_raw_file_tombstones() {
        let fixture = TestRoot::create();
        let live = fixture.create_raw_file();
        let deleted = fixture
            .0
            .join(".buckets/assets/.deleted/4V/4VRNF52JPCO.bin");
        fs::create_dir_all(deleted.parent().unwrap()).unwrap();
        fs::rename(live, &deleted).unwrap();
        let collection = NativeRoot::open(&fixture.0)
            .unwrap()
            .collection("assets")
            .unwrap();
        assert_eq!(collection.deleted_raw_file_ids().unwrap(), ["4VRNF52JPCO"]);
        let stored = collection.read_deleted_raw_file("4VRNF52JPCO").unwrap();
        assert_eq!(stored.bytes, [0, 1, 2, 3, 255]);
        assert_eq!(stored.key, "/fixtures/sample.bin");
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
