//! Content-addressed auto-commit writing for versioned FYLO roots.
//!
//! This mirrors the JavaScript `VersionRepository.commitIfDirty` full-scan
//! path: snapshot the working tree into blobs, build the four-level tree
//! objects, and write an immutable commit only when the root hash actually
//! moved. The incremental hinted path is a performance optimization of the
//! same result, so the full scan is byte-compatible with it.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::{
    CollectionWriteLock, NativeStorageError, NativeStorageErrorCode, NativeWriteRoot,
    durable_replace, failpoint, generate_ttid, read_bounded_json,
};

/// Bytes hashed for one content-addressed blob.
const MAX_BLOB_BYTES: u64 = 64 * 1024 * 1024;
/// Bytes read for one repository metadata file.
const MAX_METADATA_BYTES: u64 = 1024 * 1024;
/// Working-tree files hashed by one commit.
const MAX_SNAPSHOT_ENTRIES: usize = 200_000;
const DATA_DIRECTORIES: [&str; 2] = [".collections", ".buckets"];
const DEFAULT_BRANCH: &str = "main";

#[derive(Deserialize, Serialize)]
struct BranchReference {
    name: String,
    head: Option<String>,
    root: String,
    #[serde(rename = "createdAt")]
    created_at: String,
    #[serde(rename = "updatedAt")]
    updated_at: String,
    #[serde(flatten)]
    rest: BTreeMap<String, serde_json::Value>,
}

#[derive(Deserialize)]
struct TreePointer {
    root: Option<String>,
}

#[derive(Serialize)]
struct TreeEntry {
    name: String,
    #[serde(rename = "type")]
    kind: &'static str,
    hash: String,
}

#[derive(Serialize)]
struct TreeNode {
    entries: Vec<TreeEntry>,
}

#[derive(Serialize)]
struct CommitManifest {
    id: String,
    branch: String,
    parents: Vec<String>,
    message: String,
    #[serde(rename = "createdAt")]
    created_at: String,
    root: String,
}

/// Branch identity plus whether the working tree matches `HEAD`.
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryStatus {
    /// Whether this root has a version repository at all.
    pub enabled: bool,
    /// Checked-out branch name.
    pub branch: Option<String>,
    /// Branch head commit identifier.
    pub head: Option<String>,
    /// True when the working tree hashes to the head commit's root tree.
    pub clean: bool,
}

/// One working-tree file captured as a content-addressed blob.
struct SnapshotEntry {
    shard_width: u32,
    collection: String,
    namespace: &'static str,
    identifier: String,
    filename: String,
    hash: String,
}

impl NativeWriteRoot {
    /// Write one auto-commit when the working tree differs from `HEAD`.
    ///
    /// Returns the new commit identifier, or `None` when the root is not
    /// versioned or nothing changed. Repeating the call after a successful
    /// commit is a no-op, so recovery can always retry it.
    ///
    /// # Errors
    ///
    /// Returns an error for an empty message, a corrupt repository, a checked
    /// out non-default branch, an unsafe path, lock contention, or an
    /// interrupted durable write.
    pub fn commit_if_dirty(&self, message: &str) -> Result<Option<String>, NativeStorageError> {
        let message = message.trim();
        if message.is_empty() {
            return Err(NativeStorageError::new(
                NativeStorageErrorCode::CorruptMetadata,
                "commit message is required",
            ));
        }
        let repository = self.path().join(".fylo-vcs");
        if !repository.join("HEAD").is_file() {
            return Ok(None);
        }
        let branch = read_head_branch(&repository)?;
        if branch != DEFAULT_BRANCH {
            // Only the default branch materializes at the root; other branches
            // live in hidden worktrees the JavaScript engine owns.
            return Err(NativeStorageError::new(
                NativeStorageErrorCode::Unsupported,
                "native auto-commit supports only the default branch worktree",
            ));
        }
        let _lock = CollectionWriteLock::acquire_at(&repository.join("locks"), "autocommit.lock")?;
        let reference_path = repository
            .join("refs")
            .join("heads")
            .join(format!("{branch}.json"));
        let mut reference: BranchReference =
            read_bounded_json(&reference_path, MAX_METADATA_BYTES)?;
        if reference.name != branch {
            return Err(NativeStorageError::new(
                NativeStorageErrorCode::CorruptMetadata,
                "FYLO branch ref name does not match HEAD",
            ));
        }
        let entries = self.snapshot_working_tree(&repository, true)?;
        let root_hash = write_tree(&repository, &entries, true)?;
        let parent_root = match reference.head.as_deref() {
            Some(head) => read_commit_root(&repository, head)?,
            None => None,
        };
        if root_hash == parent_root {
            return Ok(None);
        }
        let identifier = generate_ttid()?;
        crate::validate_ttid_shape(&identifier)?;
        let created_at = iso8601_millis(super::unix_millis()?);
        let commit_root = repository.join("commits").join(&identifier);
        fs::create_dir_all(&commit_root).map_err(NativeStorageError::io)?;
        let pointer = serde_json::json!({ "root": root_hash });
        durable_replace(
            &commit_root.join("tree.json"),
            format!("{pointer}\n").as_bytes(),
        )?;
        let manifest = CommitManifest {
            id: identifier.clone(),
            branch: branch.clone(),
            parents: reference.head.clone().into_iter().collect(),
            message: message.to_owned(),
            created_at: created_at.clone(),
            root: format!(".fylo-vcs/commits/{identifier}"),
        };
        let encoded =
            serde_json::to_string_pretty(&manifest).map_err(|error| super::json_error(&error))?;
        durable_replace(
            &commit_root.join("manifest.json"),
            format!("{encoded}\n").as_bytes(),
        )?;
        failpoint("after-commit-object")?;
        reference.head = Some(identifier.clone());
        reference.updated_at = created_at;
        let encoded =
            serde_json::to_string_pretty(&reference).map_err(|error| super::json_error(&error))?;
        durable_replace(&reference_path, format!("{encoded}\n").as_bytes())?;
        Ok(Some(identifier))
    }

    /// Report branch identity and whether the working tree matches `HEAD`.
    ///
    /// This hashes the same four-level tree `commit_if_dirty` would build but
    /// persists nothing, so a status check never mutates the object store.
    ///
    /// # Errors
    ///
    /// Returns an error for a corrupt repository, an unsafe path, or an
    /// unreadable working tree.
    pub fn repository_status(&self) -> Result<RepositoryStatus, NativeStorageError> {
        let repository = self.path().join(".fylo-vcs");
        if !repository.join("HEAD").is_file() {
            return Ok(RepositoryStatus {
                enabled: false,
                branch: None,
                head: None,
                clean: true,
            });
        }
        let branch = read_head_branch(&repository)?;
        let reference: BranchReference = read_bounded_json(
            &repository
                .join("refs")
                .join("heads")
                .join(format!("{branch}.json")),
            MAX_METADATA_BYTES,
        )?;
        let head = reference.head.clone();
        let clean = if branch == DEFAULT_BRANCH {
            let entries = self.snapshot_working_tree(&repository, false)?;
            let root_hash = write_tree(&repository, &entries, false)?;
            let parent_root = match head.as_deref() {
                Some(head) => read_commit_root(&repository, head)?,
                None => None,
            };
            root_hash == parent_root
        } else {
            // Another branch's worktree is materialized elsewhere, so this
            // root's files say nothing about it.
            return Err(NativeStorageError::new(
                NativeStorageErrorCode::Unsupported,
                "native status supports only the default branch worktree",
            ));
        };
        Ok(RepositoryStatus {
            enabled: true,
            branch: Some(branch),
            head,
            clean,
        })
    }

    fn snapshot_working_tree(
        &self,
        repository: &Path,
        persist: bool,
    ) -> Result<Vec<SnapshotEntry>, NativeStorageError> {
        let mut entries = Vec::new();
        for data_directory in DATA_DIRECTORIES {
            let data_root = self.path().join(data_directory);
            let Ok(children) = fs::read_dir(&data_root) else {
                continue;
            };
            for child in children {
                let child = child.map_err(NativeStorageError::io)?;
                let metadata = child.metadata().map_err(NativeStorageError::io)?;
                if !metadata.is_dir() {
                    continue;
                }
                let collection = child.file_name().to_string_lossy().into_owned();
                if crate::validate_collection_name(&collection).is_err()
                    || !self.is_versioned_collection(&collection)
                {
                    continue;
                }
                let shard_width = self
                    .root
                    .collection(&collection)
                    .map_or(crate::DEFAULT_SHARD_WIDTH, |handle| handle.shard_width());
                let collection_root = data_root.join(&collection);
                for (namespace, kind) in [("docs", "active"), (".deleted", "deleted")] {
                    Self::snapshot_namespace(
                        repository,
                        persist,
                        shard_width,
                        &collection_root.join(namespace),
                        &collection,
                        kind,
                        &mut entries,
                    )?;
                }
            }
        }
        if entries.len() > MAX_SNAPSHOT_ENTRIES {
            return Err(NativeStorageError::new(
                NativeStorageErrorCode::FileTooLarge,
                "working tree exceeds the native commit entry limit",
            ));
        }
        Ok(entries)
    }

    fn snapshot_namespace(
        repository: &Path,
        persist: bool,
        shard_width: u32,
        namespace_root: &Path,
        collection: &str,
        kind: &'static str,
        entries: &mut Vec<SnapshotEntry>,
    ) -> Result<(), NativeStorageError> {
        let Ok(shards) = fs::read_dir(namespace_root) else {
            return Ok(());
        };
        for shard in shards {
            let shard = shard.map_err(NativeStorageError::io)?;
            if !shard.metadata().map_err(NativeStorageError::io)?.is_dir() {
                continue;
            }
            for record in fs::read_dir(shard.path()).map_err(NativeStorageError::io)? {
                let record = record.map_err(NativeStorageError::io)?;
                let metadata =
                    fs::symlink_metadata(record.path()).map_err(NativeStorageError::io)?;
                if metadata.file_type().is_symlink() {
                    return Err(NativeStorageError::new(
                        NativeStorageErrorCode::UnsafePath,
                        "version storage path contains a symbolic link",
                    ));
                }
                if !metadata.is_file() {
                    continue;
                }
                let filename = record.file_name().to_string_lossy().into_owned();
                let identifier = filename
                    .split_once('.')
                    .map_or(filename.as_str(), |(head, _)| head)
                    .to_owned();
                if crate::validate_ttid_shape(&identifier).is_err() {
                    continue;
                }
                if metadata.len() > MAX_BLOB_BYTES {
                    return Err(NativeStorageError::new(
                        NativeStorageErrorCode::FileTooLarge,
                        "version blob exceeds the native commit size limit",
                    ));
                }
                let bytes = fs::read(record.path()).map_err(NativeStorageError::io)?;
                let hash = crate::sha256_hex(&bytes);
                if persist {
                    write_object(repository, &hash, &bytes)?;
                }
                entries.push(SnapshotEntry {
                    shard_width,
                    collection: collection.to_owned(),
                    namespace: kind,
                    identifier: identifier.clone(),
                    filename,
                    hash,
                });
                if let Some(blob) = metadata_blob(&record.path())? {
                    let hash = crate::sha256_hex(&blob);
                    if persist {
                        write_object(repository, &hash, &blob)?;
                    }
                    entries.push(SnapshotEntry {
                        shard_width,
                        collection: collection.to_owned(),
                        namespace: "metadata",
                        identifier: identifier.clone(),
                        filename: format!("{identifier}.json"),
                        hash,
                    });
                }
            }
        }
        Ok(())
    }

    fn is_versioned_collection(&self, collection: &str) -> bool {
        let descriptor = self
            .path()
            .join(".fylo-catalog")
            .join("collections")
            .join(format!("{collection}.json"));
        let Ok(parsed) = read_bounded_json::<serde_json::Value>(&descriptor, MAX_METADATA_BYTES)
        else {
            return true;
        };
        parsed.get("versioned") != Some(&serde_json::Value::Bool(false))
    }
}

/// Reproduces `xattrBlobForFile`: every `user.fylo.*` attribute except the
/// checksum, sorted, base64-encoded, in a version-2 envelope.
#[cfg(unix)]
fn metadata_blob(path: &Path) -> Result<Option<Vec<u8>>, NativeStorageError> {
    use base64::Engine as _;
    use base64::engine::general_purpose::STANDARD as BASE64;
    use xattr::FileExt;

    let file = fs::File::open(path).map_err(NativeStorageError::io)?;
    let mut attributes = BTreeMap::new();
    for name in file.list_xattr().map_err(NativeStorageError::io)? {
        let Some(name) = name.to_str() else {
            continue;
        };
        if !name.starts_with("user.fylo.") || name == crate::CHECKSUM_XATTR {
            continue;
        }
        let Some(value) = file.get_xattr(name).map_err(NativeStorageError::io)? else {
            continue;
        };
        attributes.insert(name.to_owned(), BASE64.encode(value));
    }
    encode_metadata_blob(&attributes)
}

#[cfg(windows)]
fn metadata_blob(path: &Path) -> Result<Option<Vec<u8>>, NativeStorageError> {
    use std::ffi::OsString;

    let mut stream = OsString::from(path.as_os_str());
    stream.push(":fylo.xattrs");
    let stored: BTreeMap<String, String> =
        match read_bounded_json(&PathBuf::from(stream), MAX_METADATA_BYTES) {
            Ok(stored) => stored,
            Err(_) => return Ok(None),
        };
    let attributes = stored
        .into_iter()
        .filter(|(name, _)| name.starts_with("user.fylo.") && name != crate::CHECKSUM_XATTR)
        .collect();
    encode_metadata_blob(&attributes)
}

#[cfg(not(any(unix, windows)))]
fn metadata_blob(_path: &Path) -> Result<Option<Vec<u8>>, NativeStorageError> {
    Ok(None)
}

#[cfg(any(unix, windows))]
fn encode_metadata_blob(
    attributes: &BTreeMap<String, String>,
) -> Result<Option<Vec<u8>>, NativeStorageError> {
    if attributes.is_empty() {
        return Ok(None);
    }
    let encoded = serde_json::to_string(&serde_json::json!({
        "version": 2,
        "xattrs": attributes,
    }))
    .map_err(|error| super::json_error(&error))?;
    Ok(Some(format!("{encoded}\n").into_bytes()))
}

fn write_tree(
    repository: &Path,
    entries: &[SnapshotEntry],
    persist: bool,
) -> Result<Option<String>, NativeStorageError> {
    type Shards = BTreeMap<String, BTreeMap<String, String>>;

    if entries.is_empty() {
        return Ok(None);
    }
    let mut grouped: BTreeMap<String, BTreeMap<&'static str, Shards>> = BTreeMap::new();
    for entry in entries {
        grouped
            .entry(entry.collection.clone())
            .or_default()
            .entry(namespace_directory(entry.namespace))
            .or_default()
            .entry(crate::shard_of(&entry.identifier, entry.shard_width))
            .or_default()
            .insert(entry.filename.clone(), entry.hash.clone());
    }
    let mut root_entries = Vec::new();
    for (collection, namespaces) in grouped {
        let mut collection_entries = Vec::new();
        for (namespace, shards) in namespaces {
            let mut namespace_entries = Vec::new();
            for (shard, records) in shards {
                let blobs = records
                    .into_iter()
                    .map(|(name, hash)| TreeEntry {
                        name,
                        kind: "blob",
                        hash,
                    })
                    .collect();
                namespace_entries.push(TreeEntry {
                    name: shard,
                    kind: "tree",
                    hash: write_tree_node(repository, blobs, persist)?,
                });
            }
            collection_entries.push(TreeEntry {
                name: namespace.to_owned(),
                kind: "tree",
                hash: write_tree_node(repository, namespace_entries, persist)?,
            });
        }
        root_entries.push(TreeEntry {
            name: collection,
            kind: "tree",
            hash: write_tree_node(repository, collection_entries, persist)?,
        });
    }
    write_tree_node(repository, root_entries, persist).map(Some)
}

fn namespace_directory(kind: &str) -> &'static str {
    match kind {
        "active" => "docs",
        "deleted" => ".deleted",
        _ => ".metadata",
    }
}

fn write_tree_node(
    repository: &Path,
    mut entries: Vec<TreeEntry>,
    persist: bool,
) -> Result<String, NativeStorageError> {
    entries.sort_by(|left, right| left.name.cmp(&right.name));
    let serialized =
        serde_json::to_string(&TreeNode { entries }).map_err(|error| super::json_error(&error))?;
    let hash = crate::sha256_hex(serialized.as_bytes());
    if persist {
        write_object(repository, &hash, serialized.as_bytes())?;
    }
    Ok(hash)
}

fn write_object(repository: &Path, hash: &str, bytes: &[u8]) -> Result<(), NativeStorageError> {
    let target = object_path(repository, hash)?;
    if target.is_file() {
        return Ok(());
    }
    let parent = target.parent().ok_or_else(|| {
        NativeStorageError::new(
            NativeStorageErrorCode::UnsafePath,
            "version object has no parent directory",
        )
    })?;
    fs::create_dir_all(parent).map_err(NativeStorageError::io)?;
    durable_replace(&target, bytes)
}

fn object_path(repository: &Path, hash: &str) -> Result<PathBuf, NativeStorageError> {
    if hash.len() != 64 || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(NativeStorageError::new(
            NativeStorageErrorCode::CorruptMetadata,
            "version object hash is invalid",
        ));
    }
    Ok(repository.join("objects").join(&hash[..2]).join(&hash[2..]))
}

fn read_commit_root(
    repository: &Path,
    identifier: &str,
) -> Result<Option<String>, NativeStorageError> {
    crate::validate_ttid_shape(identifier)?;
    let pointer: TreePointer = read_bounded_json(
        &repository
            .join("commits")
            .join(identifier)
            .join("tree.json"),
        MAX_METADATA_BYTES,
    )?;
    Ok(pointer.root)
}

fn read_head_branch(repository: &Path) -> Result<String, NativeStorageError> {
    let head = fs::read_to_string(repository.join("HEAD")).map_err(NativeStorageError::io)?;
    let branch = head
        .trim()
        .strip_prefix("ref: refs/heads/")
        .ok_or_else(|| {
            NativeStorageError::new(
                NativeStorageErrorCode::CorruptMetadata,
                "FYLO repository HEAD is corrupt",
            )
        })?
        .to_owned();
    crate::validate_branch_name(&branch)?;
    Ok(branch)
}

/// `Date.prototype.toISOString` without a calendar dependency.
fn iso8601_millis(milliseconds: u64) -> String {
    let seconds = milliseconds / 1000;
    let millis = milliseconds % 1000;
    let (hour, minute, second) = (seconds / 3600 % 24, seconds / 60 % 60, seconds % 60);
    let (year, month, day) = civil_from_days(seconds / 86_400);
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z")
}

/// Howard Hinnant's `civil_from_days`, restricted to the post-epoch range FYLO
/// timestamps occupy.
fn civil_from_days(days: u64) -> (u64, u64, u64) {
    let shifted = days + 719_468;
    let era = shifted / 146_097;
    let day_of_era = shifted % 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted_month = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * shifted_month + 2) / 5 + 1;
    let month = if shifted_month < 10 {
        shifted_month + 3
    } else {
        shifted_month - 9
    };
    (if month <= 2 { year + 1 } else { year }, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_javascript_compatible_iso_timestamps() {
        assert_eq!(iso8601_millis(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(
            iso8601_millis(1_769_472_000_123),
            "2026-01-27T00:00:00.123Z"
        );
        assert_eq!(
            iso8601_millis(1_583_020_800_000),
            "2020-03-01T00:00:00.000Z"
        );
    }
}
