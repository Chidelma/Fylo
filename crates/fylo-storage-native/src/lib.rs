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
use same_file::Handle as FileIdentity;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

mod lease;
mod write;

pub use lease::RootLease;
pub use write::FAILPOINTS;
pub use write::version::RepositoryStatus;
pub use write::{NativeWriteRoot, PutDocumentOptions, PutRawFileOptions, WriteAccess, WriteActor};
pub use write::{SqlMutationResult, SqlMutationResultKind};

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
const META_UPDATED_XATTR: &str = "user.fylo.meta-updated-at";
const ACCESS_XATTR: &str = "user.fylo.access";

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
                shard_width: None,
                previous_shard_widths: None,
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
            shard_width: validate_shard_width(descriptor.shard_width)?,
            previous_shard_widths: descriptor
                .previous_shard_widths
                .unwrap_or_default()
                .into_iter()
                .map(|width| validate_shard_width(Some(width)))
                .collect::<Result<Vec<_>, _>>()?,
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

    /// Verify every commit, tree, and blob reachable from the active branch
    /// head, bounded by the requested commit limit.
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
        if limit == 0 || limit > 1000 {
            return Err(NativeStorageError::new(
                NativeStorageErrorCode::CorruptMetadata,
                "version verification commit limit must be between 1 and 1000",
            ));
        }
        let history = self.version_history(1)?;
        let mut state = VersionVerificationState::default();
        let mut pending = history
            .head
            .iter()
            .cloned()
            .map(VersionTraversal::Enter)
            .collect::<Vec<_>>();
        let mut active = BTreeSet::new();
        let mut verified = BTreeSet::new();
        let mut graph_complete = true;
        while let Some(event) = pending.pop() {
            match event {
                VersionTraversal::Exit(identifier) => {
                    active.remove(&identifier);
                    verified.insert(identifier);
                }
                VersionTraversal::Enter(identifier) => {
                    if verified.contains(&identifier) {
                        continue;
                    }
                    if !active.insert(identifier.clone()) {
                        return Err(NativeStorageError::new(
                            NativeStorageErrorCode::CorruptMetadata,
                            "FYLO commit graph contains a cycle",
                        ));
                    }
                    if state.commits_verified >= limit {
                        graph_complete = false;
                        break;
                    }
                    let commit = self.read_version_commit(&identifier)?;
                    self.verify_version_commit_tree(&identifier, &mut state)?;
                    state.commits_verified += 1;
                    pending.push(VersionTraversal::Exit(identifier));
                    pending.extend(
                        commit
                            .parents
                            .into_iter()
                            .rev()
                            .map(VersionTraversal::Enter),
                    );
                }
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
            commits_verified: state.commits_verified,
            history_complete: graph_complete,
            tree_objects,
            blob_objects,
            verified_bytes: state.verified_bytes,
            content_integrity: true,
        })
    }

    fn read_version_commit(&self, identifier: &str) -> Result<VersionCommit, NativeStorageError> {
        validate_ttid_shape(identifier).map_err(|error| {
            NativeStorageError::new(
                NativeStorageErrorCode::CorruptMetadata,
                format!("FYLO commit identifier is invalid: {error}"),
            )
        })?;
        let path = self
            .canonical
            .join(".fylo-vcs")
            .join("commits")
            .join(identifier)
            .join("manifest.json");
        let commit: VersionCommit = serde_json::from_slice(
            &self.read_file(&path, MAX_VERSION_METADATA_BYTES)?,
        )
        .map_err(|error| {
            NativeStorageError::new(
                NativeStorageErrorCode::CorruptMetadata,
                format!("FYLO commit manifest is corrupt: {error}"),
            )
        })?;
        commit.validate(identifier)?;
        Ok(commit)
    }

    fn verify_version_commit_tree(
        &self,
        identifier: &str,
        state: &mut VersionVerificationState,
    ) -> Result<(), NativeStorageError> {
        let tree_path = self
            .canonical
            .join(".fylo-vcs")
            .join("commits")
            .join(identifier)
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
                state,
            )?;
        }
        Ok(())
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
            if !directory_contains_exact_name(&current, segment)? {
                return Err(NativeStorageError::new(
                    NativeStorageErrorCode::UnsafePath,
                    format!(
                        "storage path component has non-canonical spelling: {}",
                        current.join(segment).display()
                    ),
                ));
            }
            current.push(segment);
            let metadata = fs::symlink_metadata(&current).map_err(NativeStorageError::io)?;
            if is_link_or_reparse(&metadata) {
                return Err(NativeStorageError::new(
                    NativeStorageErrorCode::UnsafePath,
                    format!(
                        "storage path contains a symbolic link or reparse point: {}",
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
        if opened.len() > max_bytes {
            return Err(NativeStorageError::new(
                NativeStorageErrorCode::FileTooLarge,
                format!(
                    "{} contains {} bytes; limit is {max_bytes}",
                    path.display(),
                    opened.len()
                ),
            ));
        }
        self.verify_open_file_identity(path, &file)?;
        Ok((file, opened))
    }

    fn verify_open_file_identity(
        &self,
        path: &Path,
        file: &File,
    ) -> Result<(), NativeStorageError> {
        self.verify_path(path, ExpectedType::File)?;
        let opened = FileIdentity::from_file(file.try_clone().map_err(NativeStorageError::io)?)
            .map_err(NativeStorageError::io)?;
        let current = FileIdentity::from_path(path).map_err(NativeStorageError::io)?;
        if opened == current {
            Ok(())
        } else {
            Err(NativeStorageError::new(
                NativeStorageErrorCode::UnsafePath,
                "storage path changed while an open file was being read",
            ))
        }
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
#[serde(rename_all = "camelCase")]
struct CollectionDescriptor {
    kind: CollectionKind,
    /// Characters of the creation segment a record's shard directory uses.
    ///
    /// A descriptor written before shard widths existed records none, and its
    /// records sit under the default this release uses.
    #[serde(default)]
    shard_width: Option<u32>,
    /// Widths an unfinished reshard is moving this collection away from.
    #[serde(default)]
    previous_shard_widths: Option<Vec<u32>>,
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
                    && expected_shard.is_some_and(|shard| {
                        // A tree written before the shard change buckets by the
                        // leading characters, so an old commit stays verifiable.
                        (0..=MAX_SHARD_WIDTH).any(|width| shard == shard_of(identifier, width))
                            || shard == legacy_shard_of(identifier)
                    })
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

enum VersionTraversal {
    Enter(String),
    Exit(String),
}

#[derive(Default)]
struct VersionVerificationState {
    objects: BTreeMap<String, VersionObjectKind>,
    verified_bytes: u64,
    commits_verified: usize,
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
    shard_width: u32,
    previous_shard_widths: Vec<u32>,
}

impl NativeCollection {
    /// Characters of the creation segment this collection's shards use.
    #[must_use]
    pub const fn shard_width(&self) -> u32 {
        self.shard_width
    }

    /// Widths an unfinished reshard is moving this collection away from.
    #[must_use]
    pub fn previous_shard_widths(&self) -> &[u32] {
        &self.previous_shard_widths
    }

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
                if !shard_matches(
                    identifier,
                    &shard_path,
                    self.shard_width,
                    &self.previous_shard_widths,
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
                if !shard_candidates(identifier, self.shard_width, &self.previous_shard_widths)
                    .iter()
                    .any(|candidate| candidate == shard_name)
                {
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

    /// Read one live record's developer metadata (`user.fylo.meta.*` xattrs).
    ///
    /// Works for both collection kinds, because the JavaScript engine stores
    /// document and raw-file developer metadata the same way.
    ///
    /// # Errors
    ///
    /// Returns an error for invalid IDs, unsafe paths, oversized metadata, or
    /// I/O failures.
    pub fn read_custom_metadata(
        &self,
        identifier: &str,
    ) -> Result<BTreeMap<String, Value>, NativeStorageError> {
        validate_ttid_shape(identifier)?;
        let path = if self.kind == CollectionKind::Document {
            self.read_document(identifier)?.path
        } else {
            self.read_raw_file(identifier)?.path
        };
        let (file, _) = self.root.open_file(&path, MAX_RAW_FILE_BYTES)?;
        let attributes = read_fylo_attributes(&file, &path)?;
        self.root.verify_open_file_identity(&path, &file)?;
        decode_custom_metadata(&attributes)
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
        let path = existing_shard_path(
            namespace,
            identifier,
            &format!("{identifier}.json"),
            self.shard_width,
            &self.previous_shard_widths,
        )?;
        let (mut file, metadata) = self.root.open_file(&path, MAX_DOCUMENT_BYTES)?;
        let attributes = read_fylo_attributes(&file, &path)?;
        let bytes = read_bounded(
            (&mut file).take(MAX_DOCUMENT_BYTES.saturating_add(1)),
            MAX_DOCUMENT_BYTES,
        )?;
        self.root.verify_open_file_identity(&path, &file)?;
        Ok(StoredBytes {
            bytes,
            modified_millis: modified_millis(&metadata)?,
            access: decode_access_descriptor(&attributes)?,
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
        let (mut file, metadata) = self.root.open_file(&path, MAX_RAW_FILE_BYTES)?;
        let attributes = read_fylo_attributes(&file, &path)?;
        self.root.verify_open_file_identity(&path, &file)?;
        let key = required_utf8_attribute(&attributes, KEY_XATTR, identifier)?;
        validate_raw_key(&key)?;
        let custom_metadata = decode_custom_metadata(&attributes)?;
        let access_descriptor = decode_access_descriptor(&attributes)?;
        let bytes = read_bounded(
            (&mut file).take(MAX_RAW_FILE_BYTES.saturating_add(1)),
            MAX_RAW_FILE_BYTES,
        )?;
        self.root.verify_open_file_identity(&path, &file)?;
        let computed_checksum = sha256_hex(&bytes);
        let modified_millis = modified_millis(&metadata)?;
        let modified_millis_exact = modified_millis_f64(&metadata)?;
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
            access_descriptor,
            modified_millis,
            modified_millis_exact,
            access: native_access(&metadata),
            path,
        })
    }

    fn find_raw_file_path(
        &self,
        namespace: &Path,
        identifier: &str,
    ) -> Result<PathBuf, NativeStorageError> {
        let mut shard = namespace.join(shard_of(identifier, self.shard_width));
        for candidate in shard_candidates(identifier, self.shard_width, &self.previous_shard_widths)
        {
            let path = namespace.join(candidate);
            if path_exists_no_follow(&path)? {
                shard = path;
                break;
            }
        }
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
            expected_key_count: None,
            missing_keys: None,
            missing_key_sample: Vec::new(),
            extra_key_sample: Vec::new(),
            extra_keys: None,
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
    /// Optional portable FYLO access descriptor.
    pub access: Option<AccessDescriptor>,
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
    /// Optional portable FYLO access descriptor.
    pub access_descriptor: Option<AccessDescriptor>,
    /// Filesystem modification time in Unix milliseconds.
    pub modified_millis: u64,
    /// Filesystem modification time with the sub-millisecond precision exposed
    /// by JavaScript `fs.stat().mtimeMs`.
    pub modified_millis_exact: f64,
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

/// Portable FYLO access descriptor stored in `user.fylo.access`.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AccessDescriptor {
    /// Descriptor format version.
    pub version: u8,
    /// Owning user ID.
    pub uid: u32,
    /// Owning group ID.
    pub gid: u32,
    /// POSIX-compatible permission bits.
    pub mode: u32,
}

/// Read-only prefix-index reference verification.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
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
    /// Whether merged index state exactly matches an independent rebuild.
    pub rebuild_equivalent: bool,
    /// Independently derived key count when rebuild comparison ran.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_key_count: Option<usize>,
    /// Expected keys absent from merged snapshot/WAL state.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub missing_keys: Option<usize>,
    /// Merged snapshot/WAL keys absent from the independent rebuild.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extra_keys: Option<usize>,
    /// Bounded sample of expected keys the merged state is missing.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub missing_key_sample: Vec<String>,
    /// Bounded sample of merged keys the rebuild did not derive.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub extra_key_sample: Vec<String>,
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

/// Bounded content-integrity report for the active head's reachable graph.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionVerification {
    /// Whether versioning is initialized.
    pub enabled: bool,
    /// Active branch when versioning is initialized.
    pub branch: Option<String>,
    /// Active branch head commit.
    pub head: Option<String>,
    /// Number of reachable commits whose trees were traversed.
    pub commits_verified: usize,
    /// Whether the requested bound covered the complete reachable graph.
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
    ///
    /// The JavaScript engine writes this with `path.relative`, so a repository
    /// created on Windows stores backslashes. Both spellings name the same
    /// directory and are accepted; the native writer always emits the
    /// forward-slash form so a Rust-written repository stays portable.
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
            || self.root.replace('\\', "/") != format!(".fylo-vcs/commits/{}", self.id)
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

/// Stable native storage failure codes.
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
    /// A document body was malformed or unsupported.
    CorruptDocument,
    /// Prefix-index bytes were corrupt.
    CorruptIndex,
    /// Collection name was invalid or reserved.
    InvalidCollection,
    /// Document ID syntax was invalid.
    InvalidDocumentId,
    /// Requested record was not found.
    NotFound,
    /// Another writer owns the collection or recovery is required.
    ConcurrentWrite,
    /// A portable access descriptor denied the operation.
    PermissionDenied,
    /// Another live process owns this root.
    RootLocked,
    /// This process's exclusive ownership of the root was lost.
    RootLeaseLost,
    /// A SQL mutation was malformed or used an unsupported execution shape.
    InvalidQuery,
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
            Self::CorruptDocument => "ENATIVE_DOCUMENT",
            Self::CorruptIndex => "ENATIVE_INDEX",
            Self::InvalidCollection => "ENATIVE_COLLECTION",
            Self::InvalidDocumentId => "EINVALIDDOCID",
            Self::NotFound => "ENATIVE_NOT_FOUND",
            Self::ConcurrentWrite => "ENATIVE_CONCURRENT_WRITE",
            Self::PermissionDenied => "EACCES",
            Self::RootLocked => "EROOTLOCKED",
            Self::RootLeaseLost => "EROOTLEASELOST",
            Self::InvalidQuery => "EQUERY_INVALID",
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
        if name != KEY_XATTR
            && name != CHECKSUM_XATTR
            && name != ACCESS_XATTR
            && name != META_UPDATED_XATTR
            && !name.starts_with(META_XATTR_PREFIX)
        {
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
            name == KEY_XATTR
                || name == CHECKSUM_XATTR
                || name == ACCESS_XATTR
                || name == META_UPDATED_XATTR
                || name.starts_with(META_XATTR_PREFIX)
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

fn decode_access_descriptor(
    attributes: &BTreeMap<String, Vec<u8>>,
) -> Result<Option<AccessDescriptor>, NativeStorageError> {
    let Some(encoded) = attributes.get(ACCESS_XATTR) else {
        return Ok(None);
    };
    let descriptor: AccessDescriptor = serde_json::from_slice(encoded).map_err(|error| {
        NativeStorageError::new(
            NativeStorageErrorCode::CorruptMetadata,
            format!("FYLO access descriptor is corrupt: {error}"),
        )
    })?;
    if descriptor.version != 1 || descriptor.mode > 0o777 {
        return Err(NativeStorageError::new(
            NativeStorageErrorCode::CorruptMetadata,
            "FYLO access descriptor is invalid",
        ));
    }
    Ok(Some(descriptor))
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
    if !encoded.len().is_multiple_of(4) {
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

pub(crate) fn validate_collection_name(name: &str) -> Result<(), NativeStorageError> {
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

/// Default shard width for a collection whose descriptor records none.
pub const DEFAULT_SHARD_WIDTH: u32 = 2;
/// Widest shard a collection may use.
pub const MAX_SHARD_WIDTH: u32 = 4;

/// Shard width for a collection that does not exist yet.
///
/// Deliberately not consulted for an existing collection: the layout is a
/// property of the root, so letting a per-process variable decide it would let
/// two processes disagree and relocate every record back and forth. Reading it
/// here is what keeps a natively created collection legible to the JavaScript
/// engine, which reads the same variable.
///
/// # Errors
///
/// Returns an error when the variable is set to something that is not an
/// integer within range.
pub fn configured_shard_width() -> Result<u32, NativeStorageError> {
    let Ok(raw) = std::env::var("FYLO_SHARD_WIDTH") else {
        return Ok(DEFAULT_SHARD_WIDTH);
    };
    if raw.is_empty() {
        return Ok(DEFAULT_SHARD_WIDTH);
    }
    let parsed = raw.parse::<u32>().map_err(|_| {
        NativeStorageError::new(
            NativeStorageErrorCode::CorruptMetadata,
            format!("FYLO_SHARD_WIDTH must be an integer from 0 to {MAX_SHARD_WIDTH}: {raw}"),
        )
    })?;
    validate_shard_width(Some(parsed))
}

fn validate_shard_width(width: Option<u32>) -> Result<u32, NativeStorageError> {
    let width = width.unwrap_or(DEFAULT_SHARD_WIDTH);
    if width > MAX_SHARD_WIDTH {
        return Err(NativeStorageError::new(
            NativeStorageErrorCode::CorruptMetadata,
            format!("collection shard width must be 0 to {MAX_SHARD_WIDTH}: {width}"),
        ));
    }
    Ok(width)
}

/// On-disk shard directory for a record.
///
/// The shard is the last two characters of the identifier's *creation*
/// segment. A TTID is base36 100 ns ticks, so its leading characters barely
/// move — the second rolls over roughly every 117 days, which put every record
/// written in a four-month window into one directory. The trailing characters
/// roll every 100 ns and 3.6 us, giving 1296 uniformly used buckets.
///
/// It must be the creation segment: an identifier may carry
/// `created-updated-deleted` lifecycle segments, and sharding the raw string
/// would move a record between directories when it is updated or deleted.
#[must_use]
pub fn shard_of(identifier: &str, width: u32) -> String {
    if width == 0 {
        return String::new();
    }
    let created = creation_segment(identifier);
    let width = width as usize;
    let shard: String = created
        .chars()
        .rev()
        .take(width)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    if shard.chars().count() < width {
        format!("{shard:0>width$}")
    } else {
        shard
    }
}

/// Shard a record occupies under the superseded layout, which used the leading
/// characters. Readers try this after [`shard_of`] so a root written before the
/// change stays readable through the published compatibility window.
#[must_use]
pub fn legacy_shard_of(identifier: &str) -> String {
    creation_segment(identifier).chars().take(2).collect()
}

/// Resolve a record's path under its shard.
///
/// A root written before the shard change keeps its records under the leading
/// characters, so a path that does not exist canonically falls back to the
/// superseded location. That keeps an unmigrated root readable, and a partly
/// migrated one — the state an interrupted migration leaves — as well. A record
/// in neither resolves to the canonical path so writes always land there.
/// Whether a record sits in a shard directory it may legitimately occupy.
///
/// Either the canonical shard or the superseded leading-character one is
/// accepted while the compatibility window is open; anything else means the
/// record was moved by something other than FYLO.
fn shard_matches(identifier: &str, shard_path: &Path, width: u32, previous: &[u32]) -> bool {
    let Some(shard) = shard_path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    shard_candidates(identifier, width, previous)
        .iter()
        .any(|candidate| candidate == shard)
}

/// Every shard directory a record may legitimately occupy, most likely first.
///
/// A reshard records the widths it is leaving until it completes, so a root
/// interrupted midway is still fully readable. The layout superseded by
/// ADR 0006 is always the last candidate.
#[must_use]
pub fn shard_candidates(identifier: &str, width: u32, previous: &[u32]) -> Vec<String> {
    let mut candidates = Vec::new();
    for candidate in std::iter::once(&width).chain(previous) {
        let shard = shard_of(identifier, *candidate);
        if !candidates.contains(&shard) {
            candidates.push(shard);
        }
    }
    let legacy = legacy_shard_of(identifier);
    if !candidates.contains(&legacy) {
        candidates.push(legacy);
    }
    candidates
}

fn existing_shard_path(
    namespace: &Path,
    identifier: &str,
    filename: &str,
    width: u32,
    previous: &[u32],
) -> Result<PathBuf, NativeStorageError> {
    let mut candidates = shard_candidates(identifier, width, previous).into_iter();
    let canonical = namespace
        .join(candidates.next().unwrap_or_default())
        .join(filename);
    if path_exists_no_follow(&canonical)? {
        return Ok(canonical);
    }
    for shard in candidates {
        let candidate = namespace.join(shard).join(filename);
        if path_exists_no_follow(&candidate)? {
            return Ok(candidate);
        }
    }
    Ok(canonical)
}

fn creation_segment(identifier: &str) -> &str {
    identifier.split('-').next().unwrap_or(identifier)
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

#[allow(clippy::cast_precision_loss)] // JavaScript fs.stat().mtimeMs is an f64.
fn modified_millis_f64(metadata: &Metadata) -> Result<f64, NativeStorageError> {
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
    Ok(duration.as_secs() as f64 * 1000.0 + f64::from(duration.subsec_nanos()) / 1_000_000.0)
}

#[cfg(windows)]
fn is_link_or_reparse(metadata: &Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;

    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    metadata.file_type().is_symlink()
        || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_link_or_reparse(metadata: &Metadata) -> bool {
    metadata.file_type().is_symlink()
}

fn directory_contains_exact_name(
    directory: &Path,
    expected: &std::ffi::OsStr,
) -> Result<bool, NativeStorageError> {
    for entry in fs::read_dir(directory).map_err(NativeStorageError::io)? {
        if entry.map_err(NativeStorageError::io)?.file_name() == expected {
            return Ok(true);
        }
    }
    Ok(false)
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
            Self::create_named("fylo-native")
        }

        fn create_named(prefix: &str) -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let sequence = TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "{prefix}-{}-{nonce}-{sequence}",
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

        fn write_version_commit(&self, identifier: &str, parents: &[&str], root: &str) {
            let commit_root = self.0.join(".fylo-vcs/commits").join(identifier);
            fs::create_dir_all(&commit_root).unwrap();
            fs::write(
                commit_root.join("manifest.json"),
                format!(
                    r#"{{"id":"{identifier}","branch":"main","parents":{},"message":"history","createdAt":"2026-07-26T00:00:00.000Z","root":".fylo-vcs/commits/{identifier}"}}"#,
                    serde_json::to_string(parents).unwrap()
                ),
            )
            .unwrap();
            fs::write(
                commit_root.join("tree.json"),
                format!(r#"{{"root":"{root}"}}"#),
            )
            .unwrap();
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
            xattr::set(
                &path,
                ACCESS_XATTR,
                br#"{"version":1,"uid":1000,"gid":100,"mode":416}"#,
            )
            .unwrap();
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
                expected_key_count: None,
                missing_keys: None,
                missing_key_sample: Vec::new(),
                extra_key_sample: Vec::new(),
                extra_keys: None,
            }
        );
    }

    #[test]
    fn reads_from_a_unicode_root() {
        let fixture = TestRoot::create_named("fylo-native-ü-日本語");
        let collection = NativeRoot::open(&fixture.0)
            .unwrap()
            .collection("users")
            .unwrap();
        assert_eq!(
            collection.read_document("4VRNF52JPCO").unwrap().bytes,
            br#"{"name":"Ada"}"#
        );
    }

    #[test]
    fn rejects_case_aliases_for_storage_components() {
        let fixture = TestRoot::create();
        let original = fixture
            .0
            .join(".collections/users/docs/4V/4VRNF52JPCO.json");
        let case_variant = fixture
            .0
            .join(".collections/users/docs/4V/4VRNF52JPCO.JSON");
        fs::rename(&original, &case_variant).unwrap();
        let collection = NativeRoot::open(&fixture.0)
            .unwrap()
            .collection("users")
            .unwrap();
        let error = collection.read_document("4VRNF52JPCO").unwrap_err();
        assert_eq!(error.code(), NativeStorageErrorCode::UnsafePath);
    }

    #[cfg(unix)]
    #[test]
    fn fails_closed_when_document_permissions_deny_reads() {
        use std::os::unix::fs::PermissionsExt;

        let fixture = TestRoot::create();
        let path = fixture
            .0
            .join(".collections/users/docs/4V/4VRNF52JPCO.json");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o000)).unwrap();
        let collection = NativeRoot::open(&fixture.0)
            .unwrap()
            .collection("users")
            .unwrap();
        let error = collection.read_document("4VRNF52JPCO").unwrap_err();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(error.code(), NativeStorageErrorCode::Io);
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
        let second_parent = "4VRNF52JPCP";
        let merge = "4VRNF52JPCQ";
        fixture.write_version_commit(second_parent, &[], &root);
        fixture.write_version_commit(merge, &[commit, second_parent], &root);
        fs::write(
            fixture.0.join(".fylo-vcs/refs/heads/main.json"),
            format!(r#"{{"name":"main","head":"{merge}"}}"#),
        )
        .unwrap();

        let native = NativeRoot::open(&fixture.0).unwrap();
        let report = native.verify_version_history(50).unwrap();
        assert!(report.content_integrity);
        assert!(report.history_complete);
        assert_eq!(report.commits_verified, 3);
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
        assert_eq!(
            stored.access_descriptor,
            Some(AccessDescriptor {
                version: 1,
                uid: 1000,
                gid: 100,
                mode: 0o640,
            })
        );
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

    #[test]
    fn rejects_path_replacement_while_original_handle_is_open() {
        let fixture = TestRoot::create();
        let root = NativeRoot::open(&fixture.0).unwrap();
        let path = root
            .path()
            .join(".collections/users/docs/4V/4VRNF52JPCO.json");
        let original = File::open(&path).unwrap();
        fs::remove_file(&path).unwrap();
        fs::write(&path, br#"{"name":"replacement"}"#).unwrap();
        let error = root
            .verify_open_file_identity(&path, &original)
            .unwrap_err();
        assert_eq!(error.code(), NativeStorageErrorCode::UnsafePath);
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

    #[cfg(windows)]
    #[test]
    fn rejects_reparse_point_document_shards() {
        use std::process::Command;

        let fixture = TestRoot::create();
        let external = fixture.0.join("external");
        let shard = fixture.0.join(".collections/users/docs/4V");
        fs::create_dir(&external).unwrap();
        fs::remove_dir_all(&shard).unwrap();
        // `New-Item -ItemType Junction` needs no privilege and reports a usable
        // error, unlike `cmd /C mklink`, whose failures this fixture used to
        // discard. Junctions are the reparse point the security check targets,
        // so a directory symlink is not an acceptable substitute.
        let created = Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command"])
            .arg(format!(
                "New-Item -ItemType Junction -Path '{}' -Target '{}' | Out-Null",
                shard.display(),
                external.display()
            ))
            .output()
            .unwrap();
        assert!(
            created.status.success(),
            "failed to create NTFS junction fixture: {}",
            String::from_utf8_lossy(&created.stderr)
        );
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
