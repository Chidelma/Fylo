//! Content-addressed auto-commit writing for versioned FYLO roots.
//!
//! This mirrors the JavaScript `VersionRepository.commitIfDirty` full-scan
//! path: snapshot the working tree into blobs, build the four-level tree
//! objects, and write an immutable commit only when the root hash actually
//! moved. The incremental hinted path is a performance optimization of the
//! same result, so the full scan is byte-compatible with it.

use fylo_vfs as fs;
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::{
    CollectionWriteLock, NativeStorageError, NativeStorageErrorCode, NativeWriteRoot,
    durable_replace, failpoint, generate_ttid, read_bounded_json, sync_directory,
};
use crate::MAX_VERSION_TREE_BYTES;

/// Bytes hashed for one content-addressed blob.
const MAX_BLOB_BYTES: u64 = 64 * 1024 * 1024;
/// Bytes read for one repository metadata file.
const MAX_METADATA_BYTES: u64 = 1024 * 1024;
/// Working-tree files hashed by one commit.
const MAX_SNAPSHOT_ENTRIES: usize = 200_000;
const DATA_DIRECTORIES: [&str; 2] = [".collections", ".buckets"];
const DEFAULT_BRANCH: &str = "main";

#[derive(Clone, Deserialize, Serialize)]
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

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
enum MaterializationPhase {
    Preparing,
    Staged,
    Swapping,
    BackupMoved,
    Installed,
    RefUpdated,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MaterializationTarget {
    relative: String,
    collection: String,
    had_current: bool,
    should_install: bool,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct MaterializationRefTransition {
    prior: BranchReference,
    target: BranchReference,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MaterializationTransaction {
    version: u8,
    phase: MaterializationPhase,
    target_root: String,
    targets: Vec<MaterializationTarget>,
    #[serde(rename = "ref")]
    reference: Option<MaterializationRefTransition>,
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
    /// Recover stranded repository worktree materialization when versioning is
    /// already initialized. A non-versioned root is left untouched.
    ///
    /// # Errors
    ///
    /// Returns an error for corrupt repository metadata or an incomplete
    /// rollback/roll-forward repair.
    pub fn recover_repository_materialization(&self) -> Result<(), NativeStorageError> {
        let repository = self.repository_root().join(".fylo-vcs");
        match fs::symlink_metadata(&repository) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
                return Err(NativeStorageError::new(
                    NativeStorageErrorCode::UnsafePath,
                    "version repository is a link or non-directory",
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(NativeStorageError::io(error)),
        }

        // Opening a repository for reads must not normalize its directory
        // layout. Older JavaScript repositories legitimately omit `objects`
        // until their first commit, and eagerly calling `ensure_repository`
        // would mutate those roots. Recovery is only necessary when a staged
        // materialization transaction actually exists.
        let staging = repository.join("staging");
        let staging_metadata = match fs::symlink_metadata(&staging) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(NativeStorageError::io(error)),
        };
        if staging_metadata.file_type().is_symlink() || !staging_metadata.is_dir() {
            return Err(NativeStorageError::new(
                NativeStorageErrorCode::UnsafePath,
                "materialization staging is a link or non-directory",
            ));
        }
        let mut recovery_needed = false;
        for entry in fs::read_dir(&staging).map_err(NativeStorageError::io)? {
            let entry = entry.map_err(NativeStorageError::io)?;
            let kind = entry.file_type().map_err(NativeStorageError::io)?;
            if kind.is_symlink() {
                return Err(NativeStorageError::new(
                    NativeStorageErrorCode::UnsafePath,
                    "materialization staging contains a symbolic link",
                ));
            }
            recovery_needed |= kind.is_dir();
        }
        if !recovery_needed {
            return Ok(());
        }
        let _ = self.ensure_repository()?;
        Ok(())
    }

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
        let repository = self.ensure_repository()?;
        let branch = read_head_branch(&repository)?;
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
        let repository = self.repository_root().join(".fylo-vcs");
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
        let entries = self.snapshot_working_tree(&repository, false)?;
        let root_hash = write_tree(&repository, &entries, false)?;
        let parent_root = match head.as_deref() {
            Some(head) => read_commit_root(&repository, head)?,
            None => None,
        };
        let clean = root_hash == parent_root;
        Ok(RepositoryStatus {
            enabled: true,
            branch: Some(branch),
            head,
            clean,
        })
    }

    /// Compare two trees without writing a single object.
    ///
    /// `from` and `to` each name `HEAD`, `WORKTREE`, or a commit identifier.
    /// Only content decides a change: two documents at one key differ when
    /// their hashes do, so a rewrite that produced identical bytes is not a
    /// change and does not appear.
    ///
    /// # Errors
    ///
    /// Returns an error for a repository that does not exist, a corrupt
    /// object, an unknown reference, or a non-default branch worktree.
    pub fn repository_diff(
        &self,
        from: &str,
        to: &str,
    ) -> Result<RepositoryDiff, NativeStorageError> {
        let repository = self.repository_root().join(".fylo-vcs");
        if !repository.join("HEAD").is_file() {
            return Err(NativeStorageError::new(
                NativeStorageErrorCode::NotFound,
                "FYLO root has no version repository",
            ));
        }
        let (from_label, left) = self.resolve_tree(&repository, from)?;
        let (to_label, right) = self.resolve_tree(&repository, to)?;

        let mut counts = TreeChangeCounts::default();
        let mut changes = Vec::new();
        for key in left.keys().chain(right.keys()).collect::<BTreeSet<_>>() {
            let (document, status) = match (left.get(key), right.get(key)) {
                (None, Some(entry)) => (entry.clone(), "added"),
                (Some(entry), None) => (entry.clone(), "deleted"),
                (Some(before), Some(after)) if before.hash != after.hash => {
                    (after.clone(), "modified")
                }
                _ => continue,
            };
            match status {
                "added" => counts.added += 1,
                "deleted" => counts.deleted += 1,
                _ => counts.modified += 1,
            }
            changes.push(TreeChange { document, status });
        }
        counts.total = changes.len();
        Ok(RepositoryDiff {
            from: from_label,
            to: to_label,
            counts,
            changes,
        })
    }

    /// Create or select a repository branch and return its materialized root.
    ///
    /// # Errors
    ///
    /// Returns an error for an invalid branch, a conflicting ref, corrupt
    /// repository metadata, unsafe worktree content, or a durable write
    /// failure.
    pub fn checkout_repository(
        &self,
        branch: &str,
        create: bool,
    ) -> Result<serde_json::Value, NativeStorageError> {
        crate::validate_branch_name(branch)?;
        let repository = self.ensure_repository()?;
        let current = read_head_branch(&repository)?;
        let reference_path = branch_reference_path(&repository, branch);
        let created = if create {
            if reference_path.is_file() {
                return Err(NativeStorageError::new(
                    NativeStorageErrorCode::CorruptMetadata,
                    format!("branch already exists: {branch}"),
                ));
            }
            let current_reference = read_branch_reference(&repository, &current)?;
            let target = branch_worktree(self.repository_root(), branch)?;
            if target.exists() {
                return Err(NativeStorageError::new(
                    NativeStorageErrorCode::CorruptMetadata,
                    format!("branch worktree already exists: {branch}"),
                ));
            }
            fs::create_dir_all(&target).map_err(NativeStorageError::io)?;
            copy_worktree(self.path(), &target)?;
            let now = iso8601_millis(super::unix_millis()?);
            let reference = BranchReference {
                name: branch.to_owned(),
                head: current_reference.head.clone(),
                root: path_to_wire(
                    target
                        .strip_prefix(self.repository_root())
                        .map_err(|_| unsafe_repository_path())?,
                ),
                created_at: now.clone(),
                updated_at: now,
                rest: BTreeMap::from([
                    (
                        "sourceBranch".to_owned(),
                        serde_json::Value::String(current),
                    ),
                    (
                        "sourceCommit".to_owned(),
                        current_reference
                            .head
                            .map_or(serde_json::Value::Null, serde_json::Value::String),
                    ),
                ]),
            };
            write_branch_reference(&repository, &reference)?;
            true
        } else {
            if !reference_path.is_file() {
                return Err(NativeStorageError::new(
                    NativeStorageErrorCode::NotFound,
                    format!("branch not found: {branch}"),
                ));
            }
            false
        };
        write_head_branch(&repository, branch)?;
        let reference = read_branch_reference(&repository, branch)?;
        let root = branch_worktree(self.repository_root(), branch)?;
        Ok(serde_json::json!({
            "branch": branch,
            "created": created,
            "head": reference.head,
            "root": root,
        }))
    }

    /// List every branch ref, including nested slash-separated names.
    ///
    /// # Errors
    ///
    /// Returns an error for corrupt or unsafe repository metadata.
    pub fn repository_branches(&self) -> Result<serde_json::Value, NativeStorageError> {
        let repository = self.ensure_repository()?;
        let current = read_head_branch(&repository)?;
        let mut references = Vec::new();
        collect_branch_references(
            &repository,
            &repository.join("refs").join("heads"),
            &mut references,
        )?;
        references.sort_by(|left, right| left.name.cmp(&right.name));
        Ok(serde_json::json!({ "current": current, "branches": references }))
    }

    /// Restore one commit into the active branch worktree.
    ///
    /// # Errors
    ///
    /// Returns an error for a missing/corrupt commit, dirty worktree without
    /// `force`, unsafe paths, or an incomplete durable materialization.
    pub fn restore_repository_commit(
        &self,
        commit: &str,
        force: bool,
    ) -> Result<serde_json::Value, NativeStorageError> {
        crate::validate_ttid_shape(commit)?;
        let repository = self.ensure_repository()?;
        let branch = read_head_branch(&repository)?;
        let mut reference = read_branch_reference(&repository, &branch)?;
        let _ = read_commit_manifest(&repository, commit)?;
        if !force && !self.repository_status()?.clean {
            return Err(NativeStorageError::new(
                NativeStorageErrorCode::ConcurrentWrite,
                "working tree has uncommitted changes; commit them first or pass --force",
            ));
        }
        let tree = self.commit_tree(&repository, commit)?;
        let prior = reference.clone();
        reference.head = Some(commit.to_owned());
        reference.updated_at = iso8601_millis(super::unix_millis()?);
        self.materialize_repository_transition(&repository, &tree, prior, reference)?;
        Ok(serde_json::json!({
            "branch": branch,
            "head": commit,
            "restored": commit,
            "forced": force,
            "root": self.path(),
        }))
    }

    /// Merge a committed ref into the active branch using a content-hash
    /// three-way merge.
    ///
    /// # Errors
    ///
    /// Returns an error for a dirty worktree, missing/corrupt ancestry,
    /// unsafe paths, or an incomplete durable materialization.
    pub fn merge_repository(
        &self,
        source: &str,
        message: Option<&str>,
    ) -> Result<serde_json::Value, NativeStorageError> {
        let repository = self.ensure_repository()?;
        if !self.repository_status()?.clean {
            return Err(NativeStorageError::new(
                NativeStorageErrorCode::ConcurrentWrite,
                "working tree has uncommitted changes; commit them before merging",
            ));
        }
        let branch = read_head_branch(&repository)?;
        let mut reference = read_branch_reference(&repository, &branch)?;
        let theirs = resolve_commit_reference(&repository, source)?;
        let ours = reference.head.clone();
        let source_is_ancestor = match ours.as_deref() {
            Some(head) => is_ancestor(&repository, &theirs, head)?,
            None => false,
        };
        if ours.as_deref() == Some(theirs.as_str()) || source_is_ancestor {
            return Ok(merge_result(
                &branch,
                &theirs,
                ours.as_deref(),
                ours.as_deref().unwrap_or(&theirs),
                "already-up-to-date",
                true,
                Some(&theirs),
                &[],
            ));
        }
        let ours_is_ancestor = match ours.as_deref() {
            Some(head) => is_ancestor(&repository, head, &theirs)?,
            None => true,
        };
        if ours_is_ancestor {
            let tree = self.commit_tree(&repository, &theirs)?;
            let prior = reference.clone();
            reference.head = Some(theirs.clone());
            reference.updated_at = iso8601_millis(super::unix_millis()?);
            self.materialize_repository_transition(&repository, &tree, prior, reference)?;
            return Ok(merge_result(
                &branch,
                &theirs,
                ours.as_deref(),
                &theirs,
                "fast-forward",
                true,
                None,
                &[],
            ));
        }
        let ours = ours.ok_or_else(|| {
            NativeStorageError::new(
                NativeStorageErrorCode::CorruptMetadata,
                "merge lost the active branch head",
            )
        })?;
        let base = common_ancestor(&repository, &ours, &theirs)?;
        let base_tree = match base.as_deref() {
            Some(base) => self.commit_tree(&repository, base)?,
            None => BTreeMap::new(),
        };
        let ours_tree = self.commit_tree(&repository, &ours)?;
        let theirs_tree = self.commit_tree(&repository, &theirs)?;
        let (merged, conflicts, applied) = three_way_merge(&base_tree, &ours_tree, &theirs_tree);
        if !conflicts.is_empty() {
            return Ok(merge_result(
                &branch,
                &theirs,
                Some(&ours),
                &ours,
                "conflict",
                false,
                base.as_deref(),
                &conflicts,
            ));
        }
        let commit = Self::write_merge_commit(
            &repository,
            &branch,
            &[ours.clone(), theirs.clone()],
            message.unwrap_or(&format!("Merge {source} into {branch}")),
            &merged,
        )?;
        let prior = reference.clone();
        reference.head = Some(commit.clone());
        reference.updated_at = iso8601_millis(super::unix_millis()?);
        self.materialize_repository_transition(&repository, &merged, prior, reference)?;
        let mut result = merge_result(
            &branch,
            &theirs,
            Some(&ours),
            &commit,
            "merge",
            true,
            base.as_deref(),
            &[],
        );
        result["commit"] = serde_json::Value::String(commit);
        result["applied"] = serde_json::Value::from(applied);
        Ok(result)
    }

    fn ensure_repository(&self) -> Result<PathBuf, NativeStorageError> {
        let repository = self.repository_root().join(".fylo-vcs");
        for relative in [
            ".fylo-vcs/refs/heads",
            ".fylo-vcs/commits",
            ".fylo-vcs/branches",
            ".fylo-vcs/objects",
            ".fylo-vcs/staging",
            ".fylo-vcs/locks",
        ] {
            ensure_repository_directory(self.repository_root(), Path::new(relative))?;
        }
        let main_reference = branch_reference_path(&repository, DEFAULT_BRANCH);
        if !main_reference.is_file() {
            let now = iso8601_millis(super::unix_millis()?);
            write_branch_reference(
                &repository,
                &BranchReference {
                    name: DEFAULT_BRANCH.to_owned(),
                    head: None,
                    root: ".".to_owned(),
                    created_at: now.clone(),
                    updated_at: now,
                    rest: BTreeMap::new(),
                },
            )?;
        }
        if !repository.join("HEAD").is_file() {
            write_head_branch(&repository, DEFAULT_BRANCH)?;
        }
        recover_materialization_transactions(self.repository_root(), &repository)?;
        Ok(repository)
    }

    fn materialize_repository_tree(
        &self,
        repository: &Path,
        tree: &BTreeMap<String, TreeDocument>,
        reference: Option<MaterializationRefTransition>,
    ) -> Result<(), NativeStorageError> {
        let _lock =
            CollectionWriteLock::acquire_at(&repository.join("locks"), "materialization.lock")?;
        let transaction = repository.join("staging").join(generate_ttid()?);
        let stage = transaction.join("next");
        let previous = transaction.join("previous");
        let mut collections = BTreeSet::new();
        let mut target_collections = BTreeMap::new();
        let mut manifest = MaterializationTransaction {
            version: 1,
            phase: MaterializationPhase::Preparing,
            target_root: relative_repository_path(self.repository_root(), self.path())?,
            targets: Vec::new(),
            reference,
        };
        for document in tree.values() {
            let data_directory = self.collection_data_directory(&document.collection);
            collections.insert((data_directory.to_owned(), document.collection.clone()));
            target_collections.insert(document.collection.clone(), data_directory.to_owned());
        }
        for data_directory in DATA_DIRECTORIES {
            let root = self.path().join(data_directory);
            let Ok(entries) = fs::read_dir(root) else {
                continue;
            };
            for entry in entries {
                let entry = entry.map_err(NativeStorageError::io)?;
                if entry.file_type().map_err(NativeStorageError::io)?.is_dir() {
                    let collection = entry.file_name().to_string_lossy().into_owned();
                    if self.is_versioned_collection(&collection) {
                        collections.insert((data_directory.to_owned(), collection));
                    }
                }
            }
        }
        for (data_directory, collection) in &collections {
            let relative = Path::new(data_directory).join(collection);
            manifest.targets.push(MaterializationTarget {
                relative: path_to_wire(&relative),
                collection: collection.clone(),
                had_current: self.path().join(&relative).exists(),
                should_install: target_collections.get(collection) == Some(data_directory),
            });
        }
        write_materialization_manifest(&transaction, &manifest)?;
        let outcome = (|| {
            self.stage_repository_tree(repository, tree, &stage)?;
            manifest.phase = MaterializationPhase::Staged;
            write_materialization_manifest(&transaction, &manifest)?;
            manifest.phase = MaterializationPhase::Swapping;
            write_materialization_manifest(&transaction, &manifest)?;
            for target in &manifest.targets {
                let relative = safe_materialization_target(target)?;
                let current = self.path().join(&relative);
                let backup = previous.join(&relative);
                let next = stage.join(&relative);
                if current.exists() {
                    fs::create_dir_all(backup.parent().ok_or_else(unsafe_repository_path)?)
                        .map_err(NativeStorageError::io)?;
                    rename_durable(&current, &backup)?;
                    manifest.phase = MaterializationPhase::BackupMoved;
                    write_materialization_manifest(&transaction, &manifest)?;
                }
                if next.exists() {
                    fs::create_dir_all(current.parent().ok_or_else(unsafe_repository_path)?)
                        .map_err(NativeStorageError::io)?;
                    rename_durable(&next, &current)?;
                }
            }
            for (collection, data_directory) in &target_collections {
                let kind = if data_directory == ".buckets" {
                    crate::CollectionKind::File
                } else {
                    crate::CollectionKind::Document
                };
                self.create_collection(collection, kind, None)?;
                self.rebuild_collection(collection)?;
            }
            manifest.phase = MaterializationPhase::Installed;
            write_materialization_manifest(&transaction, &manifest)?;
            if let Some(transition) = &manifest.reference {
                write_branch_reference(repository, &transition.target)?;
            }
            manifest.phase = MaterializationPhase::RefUpdated;
            write_materialization_manifest(&transaction, &manifest)?;
            Ok(())
        })();
        if let Err(error) = outcome {
            return rollback_after_materialization_error(
                self.repository_root(),
                &transaction,
                &manifest,
                error,
            );
        }
        cleanup_materialization(repository, &transaction)?;
        Ok(())
    }

    fn materialize_repository_transition(
        &self,
        repository: &Path,
        tree: &BTreeMap<String, TreeDocument>,
        prior: BranchReference,
        target: BranchReference,
    ) -> Result<(), NativeStorageError> {
        self.materialize_repository_tree(
            repository,
            tree,
            Some(MaterializationRefTransition { prior, target }),
        )
    }

    fn stage_repository_tree(
        &self,
        repository: &Path,
        tree: &BTreeMap<String, TreeDocument>,
        stage: &Path,
    ) -> Result<(), NativeStorageError> {
        fs::create_dir_all(stage).map_err(NativeStorageError::io)?;
        for document in tree.values() {
            if document.kind == "metadata" {
                continue;
            }
            let target = stage.join(safe_relative_path(&document.path)?);
            let bytes = read_version_object(repository, &document.hash)?;
            fs::create_dir_all(target.parent().ok_or_else(unsafe_repository_path)?)
                .map_err(NativeStorageError::io)?;
            durable_replace(&target, &bytes)?;
        }
        for document in tree.values().filter(|document| document.kind == "metadata") {
            let bytes = read_version_object(repository, &document.hash)?;
            if let Some(target) = find_staged_record(
                stage,
                self.collection_data_directory(&document.collection),
                &document.collection,
                &document.id,
            )? {
                apply_metadata_blob(&target, &bytes)?;
            }
        }
        Ok(())
    }

    fn write_merge_commit(
        repository: &Path,
        branch: &str,
        parents: &[String],
        message: &str,
        tree: &BTreeMap<String, TreeDocument>,
    ) -> Result<String, NativeStorageError> {
        let message = message.trim();
        if message.is_empty() {
            return Err(NativeStorageError::new(
                NativeStorageErrorCode::CorruptMetadata,
                "commit message is required",
            ));
        }
        let identifier = generate_ttid()?;
        let created_at = iso8601_millis(super::unix_millis()?);
        let root_hash = write_tree_from_documents(repository, tree)?;
        let commit_root = repository.join("commits").join(&identifier);
        fs::create_dir_all(&commit_root).map_err(NativeStorageError::io)?;
        durable_replace(
            &commit_root.join("tree.json"),
            format!("{}\n", serde_json::json!({ "root": root_hash })).as_bytes(),
        )?;
        let manifest = CommitManifest {
            id: identifier.clone(),
            branch: branch.to_owned(),
            parents: parents.to_vec(),
            message: message.to_owned(),
            created_at,
            root: format!(".fylo-vcs/commits/{identifier}"),
        };
        let encoded =
            serde_json::to_string_pretty(&manifest).map_err(|error| super::json_error(&error))?;
        durable_replace(
            &commit_root.join("manifest.json"),
            format!("{encoded}\n").as_bytes(),
        )?;
        Ok(identifier)
    }

    /// Resolve one reference to its labelled document tree.
    fn resolve_tree(
        &self,
        repository: &Path,
        reference: &str,
    ) -> Result<(String, BTreeMap<String, TreeDocument>), NativeStorageError> {
        let reference = reference.trim();
        let branch = read_head_branch(repository)?;
        if reference == "WORKTREE" {
            let entries = self.snapshot_working_tree(repository, false)?;
            let mut tree = BTreeMap::new();
            for entry in entries {
                let kind = entry.namespace;
                let namespace = namespace_directory(kind);
                tree.insert(
                    format!("{}/{kind}/{}", entry.collection, entry.filename),
                    TreeDocument {
                        path: Path::new(self.collection_data_directory(&entry.collection))
                            .join(&entry.collection)
                            .join(namespace)
                            .join(crate::shard_of(&entry.identifier, entry.shard_width))
                            .join(&entry.filename)
                            .to_string_lossy()
                            .into_owned(),
                        collection: entry.collection,
                        kind: kind.to_owned(),
                        id: entry.identifier,
                        hash: entry.hash,
                    },
                );
            }
            return Ok((format!("{branch}:WORKTREE"), tree));
        }
        if reference == "HEAD" {
            let head = read_branch_reference(repository, &branch)?.head;
            let tree = match head.as_deref() {
                Some(head) => self.commit_tree(repository, head)?,
                None => BTreeMap::new(),
            };
            return Ok((format!("{branch}:HEAD"), tree));
        }
        crate::validate_ttid_shape(reference)?;
        Ok((
            reference.to_owned(),
            self.commit_tree(repository, reference)?,
        ))
    }

    /// Flatten one commit's four-level tree back into its documents.
    fn commit_tree(
        &self,
        repository: &Path,
        commit: &str,
    ) -> Result<BTreeMap<String, TreeDocument>, NativeStorageError> {
        let mut tree = BTreeMap::new();
        let Some(root) = read_commit_root(repository, commit)? else {
            return Ok(tree);
        };
        for collection_node in read_tree_node(repository, &root)? {
            if collection_node.kind != "tree" {
                return Err(corrupt_tree("collection entry is not a tree"));
            }
            let collection = collection_node.name;
            crate::validate_collection_name(&collection)?;
            // The committed tree does not record the namespace directory; the
            // current descriptor is the authority for where it restores to.
            let data_directory = Path::new(self.collection_data_directory(&collection));
            for namespace_node in read_tree_node(repository, &collection_node.hash)? {
                if namespace_node.kind != "tree" {
                    return Err(corrupt_tree("namespace entry is not a tree"));
                }
                let namespace = namespace_node.name;
                if !matches!(namespace.as_str(), "docs" | ".deleted" | ".metadata") {
                    return Err(corrupt_tree("tree contains an unknown record namespace"));
                }
                let kind = versioned_kind_for_directory(&namespace);
                for shard_node in read_tree_node(repository, &namespace_node.hash)? {
                    if shard_node.kind != "tree" {
                        return Err(corrupt_tree("shard entry is not a tree"));
                    }
                    for blob in read_tree_node(repository, &shard_node.hash)? {
                        if blob.kind != "blob" {
                            return Err(corrupt_tree("record entry is not a blob"));
                        }
                        let Some(identifier) = crate::raw_file_identifier(&blob.name) else {
                            return Err(corrupt_tree("record entry has no identifier"));
                        };
                        crate::validate_ttid_shape(identifier)?;
                        let (shard_width, previous_widths) = self
                            .root
                            .collection(&collection)
                            .map_or((crate::DEFAULT_SHARD_WIDTH, Vec::new()), |handle| {
                                (
                                    handle.shard_width(),
                                    handle.previous_shard_widths().to_vec(),
                                )
                            });
                        if !crate::shard_candidates(identifier, shard_width, &previous_widths)
                            .contains(&shard_node.name)
                        {
                            return Err(corrupt_tree(
                                "record entry is stored under the wrong shard",
                            ));
                        }
                        tree.insert(
                            format!("{collection}/{kind}/{}", blob.name),
                            TreeDocument {
                                path: data_directory
                                    .join(&collection)
                                    .join(&namespace)
                                    .join(&shard_node.name)
                                    .join(&blob.name)
                                    .to_string_lossy()
                                    .into_owned(),
                                collection: collection.clone(),
                                kind: kind.to_owned(),
                                id: identifier.to_owned(),
                                hash: blob.hash,
                            },
                        );
                    }
                }
            }
        }
        Ok(tree)
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

    /// Namespace directory a collection's records live in.
    ///
    /// A committed tree does not record it, so the current descriptor is the
    /// authority for where a commit's documents would restore to.
    fn collection_data_directory(&self, collection: &str) -> &'static str {
        match self.root.collection(collection) {
            Ok(handle) if handle.kind() == crate::CollectionKind::File => ".buckets",
            _ => ".collections",
        }
    }

    fn is_versioned_collection(&self, collection: &str) -> bool {
        let descriptor = self
            .repository_root()
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

/// Inverse of [`namespace_directory`]: the kind a committed directory holds.
fn versioned_kind_for_directory(namespace: &str) -> &'static str {
    match namespace {
        ".deleted" => "deleted",
        ".metadata" => "metadata",
        _ => "active",
    }
}

fn branch_reference_path(repository: &Path, branch: &str) -> PathBuf {
    repository
        .join("refs")
        .join("heads")
        .join(format!("{branch}.json"))
}

fn write_branch_reference(
    repository: &Path,
    reference: &BranchReference,
) -> Result<(), NativeStorageError> {
    crate::validate_branch_name(&reference.name)?;
    let target = branch_reference_path(repository, &reference.name);
    if let Some(parent) = target.parent() {
        let root = repository.parent().ok_or_else(unsafe_repository_path)?;
        let relative = parent
            .strip_prefix(root)
            .map_err(|_| unsafe_repository_path())?;
        ensure_repository_directory(root, relative)?;
    }
    let encoded =
        serde_json::to_string_pretty(reference).map_err(|error| super::json_error(&error))?;
    durable_replace(&target, format!("{encoded}\n").as_bytes())
}

fn write_head_branch(repository: &Path, branch: &str) -> Result<(), NativeStorageError> {
    crate::validate_branch_name(branch)?;
    durable_replace(
        &repository.join("HEAD"),
        format!("ref: refs/heads/{branch}\n").as_bytes(),
    )
}

fn ensure_repository_directory(root: &Path, relative: &Path) -> Result<(), NativeStorageError> {
    let mut current = root.to_owned();
    for component in relative.components() {
        let std::path::Component::Normal(component) = component else {
            return Err(unsafe_repository_path());
        };
        current.push(component);
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
                return Err(NativeStorageError::new(
                    NativeStorageErrorCode::UnsafePath,
                    "version repository contains a link or non-directory",
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                fs::create_dir(&current).map_err(NativeStorageError::io)?;
                sync_directory(current.parent().ok_or_else(unsafe_repository_path)?)?;
            }
            Err(error) => return Err(NativeStorageError::io(error)),
        }
    }
    Ok(())
}

fn relative_repository_path(root: &Path, target: &Path) -> Result<String, NativeStorageError> {
    let relative = target
        .strip_prefix(root)
        .map_err(|_| unsafe_repository_path())?;
    if relative.as_os_str().is_empty() {
        return Ok(".".to_owned());
    }
    if relative
        .components()
        .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        return Err(unsafe_repository_path());
    }
    Ok(path_to_wire(relative))
}

fn materialization_target_root(
    root: &Path,
    manifest: &MaterializationTransaction,
) -> Result<PathBuf, NativeStorageError> {
    if manifest.target_root == "." {
        return Ok(root.to_owned());
    }
    Ok(root.join(safe_relative_path(&manifest.target_root)?))
}

fn safe_materialization_target(
    target: &MaterializationTarget,
) -> Result<PathBuf, NativeStorageError> {
    crate::validate_collection_name(&target.collection)?;
    let relative = safe_relative_path(&target.relative)?;
    let components = relative.components().collect::<Vec<_>>();
    if components.len() != 2
        || !DATA_DIRECTORIES
            .iter()
            .any(|directory| components[0].as_os_str() == std::ffi::OsStr::new(directory))
        || components[1].as_os_str() != std::ffi::OsStr::new(&target.collection)
    {
        return Err(NativeStorageError::new(
            NativeStorageErrorCode::CorruptMetadata,
            "corrupt FYLO materialization transaction target",
        ));
    }
    Ok(relative)
}

fn validate_materialization_manifest(
    manifest: &MaterializationTransaction,
) -> Result<(), NativeStorageError> {
    if manifest.version != 1 {
        return Err(NativeStorageError::new(
            NativeStorageErrorCode::CorruptMetadata,
            "unsupported FYLO materialization transaction version",
        ));
    }
    if manifest.target_root != "." {
        let _ = safe_relative_path(&manifest.target_root)?;
    }
    let mut targets = BTreeSet::new();
    for target in &manifest.targets {
        let relative = safe_materialization_target(target)?;
        if !targets.insert(relative) {
            return Err(NativeStorageError::new(
                NativeStorageErrorCode::CorruptMetadata,
                "duplicate FYLO materialization transaction target",
            ));
        }
    }
    if let Some(reference) = &manifest.reference {
        crate::validate_branch_name(&reference.prior.name)?;
        crate::validate_branch_name(&reference.target.name)?;
        if reference.prior.name != reference.target.name {
            return Err(NativeStorageError::new(
                NativeStorageErrorCode::CorruptMetadata,
                "FYLO materialization ref transition changes branch identity",
            ));
        }
    }
    Ok(())
}

fn write_materialization_manifest(
    transaction: &Path,
    manifest: &MaterializationTransaction,
) -> Result<(), NativeStorageError> {
    validate_materialization_manifest(manifest)?;
    fs::create_dir_all(transaction).map_err(NativeStorageError::io)?;
    let encoded =
        serde_json::to_string_pretty(manifest).map_err(|error| super::json_error(&error))?;
    durable_replace(
        &transaction.join("transaction.json"),
        format!("{encoded}\n").as_bytes(),
    )
}

fn read_materialization_manifest(
    transaction: &Path,
) -> Result<MaterializationTransaction, NativeStorageError> {
    let manifest = read_bounded_json(&transaction.join("transaction.json"), MAX_METADATA_BYTES)?;
    validate_materialization_manifest(&manifest)?;
    Ok(manifest)
}

fn path_exists(path: &Path) -> Result<bool, NativeStorageError> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(NativeStorageError::io(error)),
    }
}

fn remove_materialized_target(path: &Path) -> Result<(), NativeStorageError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(NativeStorageError::io(error)),
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(NativeStorageError::new(
            NativeStorageErrorCode::UnsafePath,
            "materialization target is a link or non-directory",
        ));
    }
    let parent = path.parent().ok_or_else(unsafe_repository_path)?;
    fs::remove_dir_all(path).map_err(NativeStorageError::io)?;
    sync_directory(parent)
}

fn rename_durable(source: &Path, target: &Path) -> Result<(), NativeStorageError> {
    let source_parent = source.parent().ok_or_else(unsafe_repository_path)?;
    let target_parent = target.parent().ok_or_else(unsafe_repository_path)?;
    fs::rename(source, target).map_err(NativeStorageError::io)?;
    sync_directory(source_parent)?;
    if source_parent != target_parent {
        sync_directory(target_parent)?;
    }
    Ok(())
}

fn cleanup_materialization(
    repository: &Path,
    transaction: &Path,
) -> Result<(), NativeStorageError> {
    if transaction.parent() != Some(repository.join("staging").as_path()) {
        return Err(unsafe_repository_path());
    }
    remove_materialized_target(transaction)?;
    sync_directory(&repository.join("staging"))
}

fn rollback_materialization(
    root: &Path,
    transaction: &Path,
    manifest: &MaterializationTransaction,
) -> Result<(), NativeStorageError> {
    let target_root = materialization_target_root(root, manifest)?;
    for target in manifest.targets.iter().rev() {
        let relative = safe_materialization_target(target)?;
        let current = target_root.join(&relative);
        let backup = transaction.join("previous").join(&relative);
        if path_exists(&backup)? {
            remove_materialized_target(&current)?;
            fs::create_dir_all(current.parent().ok_or_else(unsafe_repository_path)?)
                .map_err(NativeStorageError::io)?;
            rename_durable(&backup, &current)?;
        } else if !target.had_current {
            remove_materialized_target(&current)?;
        }
    }
    if let Some(reference) = &manifest.reference {
        write_branch_reference(&root.join(".fylo-vcs"), &reference.prior)?;
    }
    cleanup_materialization(&root.join(".fylo-vcs"), transaction)
}

fn rollback_after_materialization_error(
    root: &Path,
    transaction: &Path,
    manifest: &MaterializationTransaction,
    error: NativeStorageError,
) -> Result<(), NativeStorageError> {
    if let Err(rollback) = rollback_materialization(root, transaction, manifest) {
        return Err(NativeStorageError::new(
            NativeStorageErrorCode::Io,
            format!(
                "version tree materialization failed ({error}); rollback was incomplete ({rollback})"
            ),
        ));
    }
    Err(error)
}

fn rollforward_materialization(
    root: &Path,
    transaction: &Path,
    manifest: &MaterializationTransaction,
) -> Result<(), NativeStorageError> {
    let target_root = materialization_target_root(root, manifest)?;
    for target in &manifest.targets {
        let relative = safe_materialization_target(target)?;
        let current = target_root.join(&relative);
        let staged = transaction.join("next").join(&relative);
        if !target.should_install {
            remove_materialized_target(&current)?;
        } else if !path_exists(&current)? {
            if !path_exists(&staged)? {
                return Err(NativeStorageError::new(
                    NativeStorageErrorCode::CorruptMetadata,
                    format!(
                        "cannot recover installed materialization target: {}",
                        target.relative
                    ),
                ));
            }
            fs::create_dir_all(current.parent().ok_or_else(unsafe_repository_path)?)
                .map_err(NativeStorageError::io)?;
            rename_durable(&staged, &current)?;
        }
    }
    if let Some(reference) = &manifest.reference {
        write_branch_reference(&root.join(".fylo-vcs"), &reference.target)?;
    }
    cleanup_materialization(&root.join(".fylo-vcs"), transaction)
}

fn recover_materialization_transactions(
    root: &Path,
    repository: &Path,
) -> Result<(), NativeStorageError> {
    let _lock = CollectionWriteLock::acquire_at(&repository.join("locks"), "materialization.lock")?;
    let staging = repository.join("staging");
    fs::create_dir_all(&staging).map_err(NativeStorageError::io)?;
    let mut transactions = Vec::new();
    for entry in fs::read_dir(&staging).map_err(NativeStorageError::io)? {
        let entry = entry.map_err(NativeStorageError::io)?;
        let kind = entry.file_type().map_err(NativeStorageError::io)?;
        if kind.is_symlink() {
            return Err(NativeStorageError::new(
                NativeStorageErrorCode::UnsafePath,
                "materialization staging contains a symbolic link",
            ));
        }
        if kind.is_dir() {
            transactions.push(entry.path());
        }
    }
    transactions.sort();
    for transaction in transactions {
        if !path_exists(&transaction.join("transaction.json"))? {
            if path_exists(&transaction.join("previous"))? {
                return Err(NativeStorageError::new(
                    NativeStorageErrorCode::CorruptMetadata,
                    "materialization backup has no transaction manifest",
                ));
            }
            cleanup_materialization(repository, &transaction)?;
            continue;
        }
        let manifest = read_materialization_manifest(&transaction)?;
        match manifest.phase {
            MaterializationPhase::Installed | MaterializationPhase::RefUpdated => {
                rollforward_materialization(root, &transaction, &manifest)?;
            }
            MaterializationPhase::Preparing
            | MaterializationPhase::Staged
            | MaterializationPhase::Swapping
            | MaterializationPhase::BackupMoved => {
                rollback_materialization(root, &transaction, &manifest)?;
            }
        }
    }
    Ok(())
}

fn collect_branch_references(
    repository: &Path,
    directory: &Path,
    references: &mut Vec<BranchReference>,
) -> Result<(), NativeStorageError> {
    for entry in fs::read_dir(directory).map_err(NativeStorageError::io)? {
        let entry = entry.map_err(NativeStorageError::io)?;
        let kind = entry.file_type().map_err(NativeStorageError::io)?;
        if kind.is_symlink() {
            return Err(NativeStorageError::new(
                NativeStorageErrorCode::UnsafePath,
                "branch refs contain a symbolic link",
            ));
        }
        if kind.is_dir() {
            collect_branch_references(repository, &entry.path(), references)?;
            continue;
        }
        if !kind.is_file()
            || entry.path().extension().and_then(|value| value.to_str()) != Some("json")
        {
            continue;
        }
        let reference: BranchReference = read_bounded_json(&entry.path(), MAX_METADATA_BYTES)?;
        crate::validate_branch_name(&reference.name)?;
        if branch_reference_path(repository, &reference.name) != entry.path() {
            return Err(NativeStorageError::new(
                NativeStorageErrorCode::CorruptMetadata,
                "branch ref name does not match its path",
            ));
        }
        references.push(reference);
    }
    Ok(())
}

fn branch_worktree(root: &Path, branch: &str) -> Result<PathBuf, NativeStorageError> {
    crate::validate_branch_name(branch)?;
    if branch == DEFAULT_BRANCH {
        return Ok(root.to_path_buf());
    }
    let target = root.join(".fylo-vcs").join("branches").join(branch);
    let boundary = root.join(".fylo-vcs").join("branches");
    if !target.starts_with(&boundary) {
        return Err(unsafe_repository_path());
    }
    Ok(target)
}

fn copy_worktree(source: &Path, target: &Path) -> Result<(), NativeStorageError> {
    for data_directory in DATA_DIRECTORIES {
        let current = source.join(data_directory);
        if current.is_dir() {
            copy_directory(&current, &target.join(data_directory))?;
        }
    }
    Ok(())
}

fn copy_directory(source: &Path, target: &Path) -> Result<(), NativeStorageError> {
    fs::create_dir_all(target).map_err(NativeStorageError::io)?;
    for entry in fs::read_dir(source).map_err(NativeStorageError::io)? {
        let entry = entry.map_err(NativeStorageError::io)?;
        let kind = entry.file_type().map_err(NativeStorageError::io)?;
        let destination = target.join(entry.file_name());
        if kind.is_symlink() {
            return Err(NativeStorageError::new(
                NativeStorageErrorCode::UnsafePath,
                "branch worktree contains a symbolic link",
            ));
        }
        if kind.is_dir() {
            copy_directory(&entry.path(), &destination)?;
        } else if kind.is_file() {
            fs::copy(entry.path(), &destination).map_err(NativeStorageError::io)?;
            let permissions = entry
                .metadata()
                .map_err(NativeStorageError::io)?
                .permissions();
            fs::set_permissions(&destination, permissions).map_err(NativeStorageError::io)?;
            copy_extended_metadata(&entry.path(), &destination)?;
        }
    }
    Ok(())
}

#[cfg(unix)]
fn copy_extended_metadata(source: &Path, target: &Path) -> Result<(), NativeStorageError> {
    for name in xattr::list(source).map_err(NativeStorageError::io)? {
        if let Some(value) = xattr::get(source, &name).map_err(NativeStorageError::io)? {
            xattr::set(target, &name, &value).map_err(NativeStorageError::io)?;
        }
    }
    Ok(())
}

#[cfg(windows)]
fn copy_extended_metadata(source: &Path, target: &Path) -> Result<(), NativeStorageError> {
    use std::ffi::OsString;
    use std::io::Write as _;

    let mut source_stream = OsString::from(source.as_os_str());
    source_stream.push(":fylo.xattrs");
    let bytes = match fs::read(PathBuf::from(source_stream)) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(NativeStorageError::io(error)),
    };
    let _: BTreeMap<String, String> =
        serde_json::from_slice(&bytes).map_err(|error| super::json_error(&error))?;
    let recorded = fs::metadata(target).map_err(NativeStorageError::io)?;
    let mut target_stream = OsString::from(target.as_os_str());
    target_stream.push(":fylo.xattrs");
    let mut file = fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(PathBuf::from(target_stream))
        .map_err(NativeStorageError::io)?;
    file.write_all(&bytes).map_err(NativeStorageError::io)?;
    crate::sync_handle(&file).map_err(NativeStorageError::io)?;
    super::restore_modified(target, &recorded)
}

#[cfg(not(any(unix, windows)))]
fn copy_extended_metadata(_source: &Path, _target: &Path) -> Result<(), NativeStorageError> {
    Ok(())
}

fn path_to_wire(path: &Path) -> String {
    path.components()
        .filter_map(|component| match component {
            std::path::Component::Normal(value) => Some(value.to_string_lossy()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn unsafe_repository_path() -> NativeStorageError {
    NativeStorageError::new(
        NativeStorageErrorCode::UnsafePath,
        "version repository path escapes its root",
    )
}

fn safe_relative_path(path: &str) -> Result<PathBuf, NativeStorageError> {
    let path = Path::new(path);
    if path.has_root()
        || path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        return Err(unsafe_repository_path());
    }
    Ok(path.to_path_buf())
}

fn read_version_object(repository: &Path, hash: &str) -> Result<Vec<u8>, NativeStorageError> {
    let target = object_path(repository, hash)?;
    let metadata = fs::symlink_metadata(&target).map_err(NativeStorageError::io)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > MAX_BLOB_BYTES {
        return Err(NativeStorageError::new(
            NativeStorageErrorCode::CorruptMetadata,
            "version object is unsafe or exceeds its size limit",
        ));
    }
    let bytes = fs::read(target).map_err(NativeStorageError::io)?;
    if crate::sha256_hex(&bytes) != hash {
        return Err(NativeStorageError::new(
            NativeStorageErrorCode::CorruptMetadata,
            "version object failed content-hash verification",
        ));
    }
    Ok(bytes)
}

fn find_staged_record(
    stage: &Path,
    data_directory: &str,
    collection: &str,
    identifier: &str,
) -> Result<Option<PathBuf>, NativeStorageError> {
    for namespace in ["docs", ".deleted"] {
        let root = stage.join(data_directory).join(collection).join(namespace);
        let Ok(shards) = fs::read_dir(root) else {
            continue;
        };
        for shard in shards {
            let shard = shard.map_err(NativeStorageError::io)?;
            if !shard.file_type().map_err(NativeStorageError::io)?.is_dir() {
                continue;
            }
            for entry in fs::read_dir(shard.path()).map_err(NativeStorageError::io)? {
                let entry = entry.map_err(NativeStorageError::io)?;
                let name = entry.file_name();
                if name.to_string_lossy().split('.').next() == Some(identifier) {
                    return Ok(Some(entry.path()));
                }
            }
        }
    }
    Ok(None)
}

#[cfg(unix)]
fn apply_metadata_blob(target: &Path, bytes: &[u8]) -> Result<(), NativeStorageError> {
    use base64::Engine as _;
    use base64::engine::general_purpose::STANDARD as BASE64;
    let value: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|error| super::json_error(&error))?;
    if value.get("version") != Some(&serde_json::Value::from(2)) {
        return Err(corrupt_tree(
            "version metadata object has an unsupported version",
        ));
    }
    let attributes = value
        .get("xattrs")
        .and_then(serde_json::Value::as_object)
        .ok_or_else(|| {
            NativeStorageError::new(
                NativeStorageErrorCode::CorruptMetadata,
                "version metadata object is corrupt",
            )
        })?;
    for (name, encoded) in attributes {
        if !name.starts_with("user.fylo.") || name == crate::CHECKSUM_XATTR {
            return Err(NativeStorageError::new(
                NativeStorageErrorCode::CorruptMetadata,
                "version metadata contains an unsupported attribute",
            ));
        }
        let encoded = encoded.as_str().ok_or_else(|| {
            NativeStorageError::new(
                NativeStorageErrorCode::CorruptMetadata,
                "version metadata attribute is not encoded text",
            )
        })?;
        let decoded = BASE64.decode(encoded).map_err(|_| {
            NativeStorageError::new(
                NativeStorageErrorCode::CorruptMetadata,
                "version metadata attribute has invalid base64",
            )
        })?;
        xattr::set(target, name, &decoded).map_err(NativeStorageError::io)?;
    }
    Ok(())
}

#[cfg(windows)]
fn apply_metadata_blob(target: &Path, bytes: &[u8]) -> Result<(), NativeStorageError> {
    use base64::Engine as _;
    use std::ffi::OsString;
    use std::io::Write as _;

    let value: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|error| super::json_error(&error))?;
    if value.get("version") != Some(&serde_json::Value::from(2)) {
        return Err(corrupt_tree(
            "version metadata object has an unsupported version",
        ));
    }
    let attributes = value
        .get("xattrs")
        .and_then(serde_json::Value::as_object)
        .ok_or_else(|| corrupt_tree("version metadata object is corrupt"))?;
    let mut stored = BTreeMap::new();
    for (name, encoded) in attributes {
        if !name.starts_with("user.fylo.") || name == crate::CHECKSUM_XATTR {
            return Err(corrupt_tree(
                "version metadata contains an unsupported attribute",
            ));
        }
        let encoded = encoded
            .as_str()
            .ok_or_else(|| corrupt_tree("version metadata attribute is not encoded text"))?;
        base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .map_err(|_| corrupt_tree("version metadata attribute has invalid base64"))?;
        stored.insert(name.clone(), encoded.to_owned());
    }
    let recorded = fs::metadata(target).map_err(NativeStorageError::io)?;
    let mut stream = OsString::from(target.as_os_str());
    stream.push(":fylo.xattrs");
    let encoded = serde_json::to_vec(&stored).map_err(|error| super::json_error(&error))?;
    let mut file = fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(PathBuf::from(stream))
        .map_err(NativeStorageError::io)?;
    file.write_all(&encoded).map_err(NativeStorageError::io)?;
    crate::sync_handle(&file).map_err(NativeStorageError::io)?;
    super::restore_modified(target, &recorded)
}

#[cfg(not(any(unix, windows)))]
fn apply_metadata_blob(_target: &Path, _bytes: &[u8]) -> Result<(), NativeStorageError> {
    Ok(())
}

fn read_commit_manifest(
    repository: &Path,
    identifier: &str,
) -> Result<crate::VersionCommit, NativeStorageError> {
    crate::validate_ttid_shape(identifier)?;
    let manifest: crate::VersionCommit = read_bounded_json(
        &repository
            .join("commits")
            .join(identifier)
            .join("manifest.json"),
        MAX_METADATA_BYTES,
    )?;
    manifest.validate(identifier)?;
    Ok(manifest)
}

fn resolve_commit_reference(
    repository: &Path,
    reference: &str,
) -> Result<String, NativeStorageError> {
    if crate::validate_ttid_shape(reference).is_ok() {
        let _ = read_commit_manifest(repository, reference)?;
        return Ok(reference.to_owned());
    }
    crate::validate_branch_name(reference)?;
    read_branch_reference(repository, reference)?
        .head
        .ok_or_else(|| {
            NativeStorageError::new(
                NativeStorageErrorCode::NotFound,
                format!("branch has no commits: {reference}"),
            )
        })
}

fn ancestor_depths(
    repository: &Path,
    identifier: &str,
) -> Result<BTreeMap<String, usize>, NativeStorageError> {
    let mut depths = BTreeMap::new();
    let mut queue = std::collections::VecDeque::from([(identifier.to_owned(), 0_usize)]);
    while let Some((current, depth)) = queue.pop_front() {
        if depths.contains_key(&current) {
            continue;
        }
        let commit = read_commit_manifest(repository, &current)?;
        depths.insert(current, depth);
        for parent in commit.parents {
            queue.push_back((parent, depth + 1));
        }
        if depths.len() > 100_000 {
            return Err(NativeStorageError::new(
                NativeStorageErrorCode::FileTooLarge,
                "version ancestry exceeds its traversal limit",
            ));
        }
    }
    Ok(depths)
}

fn is_ancestor(
    repository: &Path,
    ancestor: &str,
    descendant: &str,
) -> Result<bool, NativeStorageError> {
    Ok(ancestor_depths(repository, descendant)?.contains_key(ancestor))
}

fn common_ancestor(
    repository: &Path,
    left: &str,
    right: &str,
) -> Result<Option<String>, NativeStorageError> {
    let left_depths = ancestor_depths(repository, left)?;
    let right_depths = ancestor_depths(repository, right)?;
    Ok(left_depths
        .iter()
        .filter_map(|(identifier, left_depth)| {
            right_depths
                .get(identifier)
                .map(|right_depth| (left_depth + right_depth, identifier.clone()))
        })
        .min_by(std::cmp::Ord::cmp)
        .map(|(_, identifier)| identifier))
}

fn three_way_merge(
    base: &BTreeMap<String, TreeDocument>,
    ours: &BTreeMap<String, TreeDocument>,
    theirs: &BTreeMap<String, TreeDocument>,
) -> (BTreeMap<String, TreeDocument>, Vec<String>, usize) {
    let mut merged = ours.clone();
    let mut conflicts = Vec::new();
    let mut applied = 0;
    for key in base
        .keys()
        .chain(ours.keys())
        .chain(theirs.keys())
        .collect::<BTreeSet<_>>()
    {
        let base_hash = base.get(key).map(|entry| entry.hash.as_str());
        let our_hash = ours.get(key).map(|entry| entry.hash.as_str());
        let their_hash = theirs.get(key).map(|entry| entry.hash.as_str());
        if our_hash == their_hash || their_hash == base_hash {
            continue;
        }
        if our_hash == base_hash {
            match theirs.get(key) {
                Some(entry) => {
                    merged.insert(key.clone(), entry.clone());
                }
                None => {
                    merged.remove(key);
                }
            }
            applied += 1;
        } else {
            conflicts.push((*key).clone());
        }
    }
    (merged, conflicts, applied)
}

#[allow(clippy::too_many_arguments)]
fn merge_result(
    branch: &str,
    source: &str,
    ours: Option<&str>,
    head: &str,
    mode: &str,
    merged: bool,
    base: Option<&str>,
    conflicts: &[String],
) -> serde_json::Value {
    let mut result = serde_json::json!({
        "branch": branch,
        "source": source,
        "base": base,
        "head": head,
        "mode": mode,
        "merged": merged,
        "parents": if head == source {
            vec![source]
        } else {
            ours.map_or_else(|| vec![source], |ours| vec![ours, source])
        },
        "applied": 0,
        "conflicts": conflicts,
    });
    if mode == "merge" {
        result["commit"] = serde_json::Value::Null;
    }
    result
}

fn write_tree_from_documents(
    repository: &Path,
    documents: &BTreeMap<String, TreeDocument>,
) -> Result<Option<String>, NativeStorageError> {
    type Shards = BTreeMap<String, BTreeMap<String, String>>;
    let mut grouped: BTreeMap<String, BTreeMap<String, Shards>> = BTreeMap::new();
    for document in documents.values() {
        let relative = safe_relative_path(&document.path)?;
        let components = relative
            .components()
            .filter_map(|component| match component {
                std::path::Component::Normal(value) => Some(value.to_string_lossy().into_owned()),
                _ => None,
            })
            .collect::<Vec<_>>();
        if components.len() < 5 {
            return Err(unsafe_repository_path());
        }
        grouped
            .entry(document.collection.clone())
            .or_default()
            .entry(components[2].clone())
            .or_default()
            .entry(components[3].clone())
            .or_default()
            .insert(components[4].clone(), document.hash.clone());
    }
    if grouped.is_empty() {
        return Ok(None);
    }
    let mut root = Vec::new();
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
                    hash: write_tree_node(repository, blobs, true)?,
                });
            }
            collection_entries.push(TreeEntry {
                name: namespace,
                kind: "tree",
                hash: write_tree_node(repository, namespace_entries, true)?,
            });
        }
        root.push(TreeEntry {
            name: collection,
            kind: "tree",
            hash: write_tree_node(repository, collection_entries, true)?,
        });
    }
    write_tree_node(repository, root, true).map(Some)
}

fn read_branch_reference(
    repository: &Path,
    branch: &str,
) -> Result<BranchReference, NativeStorageError> {
    read_bounded_json(
        &repository
            .join("refs")
            .join("heads")
            .join(format!("{branch}.json")),
        MAX_METADATA_BYTES,
    )
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

/// One document as a tree records it, on either side of a diff.
#[derive(Clone, Debug, Serialize)]
pub struct TreeDocument {
    /// Owning collection.
    pub collection: String,
    /// `active` or `deleted`.
    pub kind: String,
    /// Record identifier.
    pub id: String,
    /// Path relative to the root.
    pub path: String,
    /// Content hash.
    pub hash: String,
}

/// One document's difference between two trees.
#[derive(Clone, Debug, Serialize)]
pub struct TreeChange {
    /// The document, taken from the side that has it.
    #[serde(flatten)]
    pub document: TreeDocument,
    /// `added`, `modified`, or `deleted`.
    pub status: &'static str,
}

/// Counted differences between two trees.
#[derive(Clone, Copy, Debug, Default, Serialize)]
pub struct TreeChangeCounts {
    /// Documents only the right side has.
    pub added: usize,
    /// Documents both sides have with different content.
    pub modified: usize,
    /// Documents only the left side has.
    pub deleted: usize,
    /// Every change.
    pub total: usize,
}

/// One resolved comparison between two trees.
#[derive(Clone, Debug, Serialize)]
pub struct RepositoryDiff {
    /// Label of the left side.
    pub from: String,
    /// Label of the right side.
    pub to: String,
    /// Change counts by status.
    pub counts: TreeChangeCounts,
    /// Every differing document, ordered by tree key.
    pub changes: Vec<TreeChange>,
}

#[derive(Deserialize)]
struct StoredTreeEntry {
    name: String,
    #[serde(rename = "type")]
    kind: String,
    hash: String,
}

#[derive(Deserialize)]
struct StoredTreeNode {
    entries: Vec<StoredTreeEntry>,
}

fn read_tree_node(
    repository: &Path,
    hash: &str,
) -> Result<Vec<StoredTreeEntry>, NativeStorageError> {
    let node: StoredTreeNode =
        read_bounded_json(&object_path(repository, hash)?, MAX_VERSION_TREE_BYTES)?;
    let mut previous: Option<&str> = None;
    for entry in &node.entries {
        if Path::new(&entry.name).file_name() != Some(std::ffi::OsStr::new(&entry.name))
            || entry.name.is_empty()
            || previous.is_some_and(|name| name >= entry.name.as_str())
        {
            return Err(corrupt_tree(
                "tree entries are unsafe, duplicated, or unordered",
            ));
        }
        let _ = object_path(repository, &entry.hash)?;
        if !matches!(entry.kind.as_str(), "tree" | "blob") {
            return Err(corrupt_tree("tree entry has an invalid type"));
        }
        previous = Some(&entry.name);
    }
    Ok(node.entries)
}

fn corrupt_tree(message: &str) -> NativeStorageError {
    NativeStorageError::new(NativeStorageErrorCode::CorruptMetadata, message)
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
    fn recovery_does_not_normalize_an_idle_javascript_repository() {
        let root = std::env::temp_dir().join(format!(
            "fylo-idle-version-repository-{}",
            generate_ttid().unwrap()
        ));
        fs::create_dir_all(root.join(".fylo-vcs/staging")).unwrap();
        let writer = NativeWriteRoot::open(&root).unwrap();

        writer.recover_repository_materialization().unwrap();

        assert!(!root.join(".fylo-vcs/objects").exists());
        fs::remove_dir_all(root).unwrap();
    }

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
