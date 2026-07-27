//! Exclusive root ownership held by the kernel.
//!
//! The JavaScript engine takes an advisory lock on a sentinel beside the root
//! and records a metadata generation next to it. `std::fs::File::try_lock` is
//! the same primitive — `flock` on Unix, `LockFileEx` on Windows — in safe
//! Rust, so both engines contend for one lock and neither needs a platform
//! `unsafe` boundary.
//!
//! The sentinel file persists after shutdown; the kernel releases its lock on
//! close, crash, or SIGKILL, so a dead owner never blocks a successor.

use std::fs::{File, OpenOptions, TryLockError};
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::{NativeStorageError, NativeStorageErrorCode};

/// Bytes read for one lease metadata record.
const MAX_LEASE_METADATA_BYTES: u64 = 4096;

/// Owner identity recorded beside the sentinel.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct LeaseMetadata {
    version: u32,
    root: String,
    owner: String,
    pid: u32,
    host: String,
    acquired_at: u64,
}

/// A held exclusive lease on one canonical FYLO root.
///
/// Dropping the value releases the kernel lock.
#[derive(Debug)]
pub struct RootLease {
    root: PathBuf,
    owner: String,
    sentinel: File,
    metadata_path: PathBuf,
}

impl RootLease {
    /// Take exclusive ownership of `root`, or report the live owner.
    ///
    /// # Errors
    ///
    /// Returns `ENATIVE_ROOT_LOCKED` when another process owns the root, and
    /// an I/O error when the sentinel cannot be created or written.
    pub fn acquire(root: impl AsRef<Path>) -> Result<Self, NativeStorageError> {
        let canonical = std::fs::canonicalize(root.as_ref()).map_err(NativeStorageError::io)?;
        let (sentinel_path, metadata_path) = lease_paths(&canonical)?;
        let sentinel = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .truncate(false)
            .open(&sentinel_path)
            .map_err(NativeStorageError::io)?;
        match sentinel.try_lock() {
            Ok(()) => {}
            Err(TryLockError::WouldBlock) => {
                return Err(NativeStorageError::new(
                    NativeStorageErrorCode::RootLocked,
                    describe_owner(&metadata_path, &canonical),
                ));
            }
            Err(TryLockError::Error(error)) => return Err(NativeStorageError::io(error)),
        }
        let owner = super::write::unique_name("rust-root-owner");
        let metadata = LeaseMetadata {
            version: 1,
            root: canonical.to_string_lossy().into_owned(),
            owner: owner.clone(),
            pid: std::process::id(),
            host: host_name(),
            acquired_at: super::write::unix_millis()?,
        };
        let encoded = serde_json::to_vec(&metadata).map_err(|error| {
            NativeStorageError::new(
                NativeStorageErrorCode::CorruptMetadata,
                format!("lease metadata cannot be encoded: {error}"),
            )
        })?;
        let mut file = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&metadata_path)
            .map_err(NativeStorageError::io)?;
        file.write_all(&encoded).map_err(NativeStorageError::io)?;
        file.sync_all().map_err(NativeStorageError::io)?;
        Ok(Self {
            root: canonical,
            owner,
            sentinel,
            metadata_path,
        })
    }

    /// Canonical root this lease covers.
    #[must_use]
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Confirm this process still owns the recorded generation.
    ///
    /// The kernel lock cannot be stolen, but the sentinel can be replaced on
    /// disk; a mismatched generation means a successor took over and this
    /// process must stop writing.
    ///
    /// # Errors
    ///
    /// Returns `ENATIVE_ROOT_LEASE_LOST` when the recorded owner is not this
    /// lease.
    pub fn assert_owned(&self) -> Result<(), NativeStorageError> {
        let recorded = read_metadata(&self.metadata_path)
            .filter(|metadata| metadata.version == 1 && metadata.owner == self.owner);
        if recorded.is_some() {
            return Ok(());
        }
        Err(NativeStorageError::new(
            NativeStorageErrorCode::RootLeaseLost,
            "exclusive ownership of this FYLO root was lost",
        ))
    }
}

impl Drop for RootLease {
    fn drop(&mut self) {
        let _ = self.sentinel.unlock();
    }
}

/// The JavaScript engine derives both paths from the root's parent, so the
/// sentinel never lives inside the directory it protects.
fn lease_paths(canonical: &Path) -> Result<(PathBuf, PathBuf), NativeStorageError> {
    let parent = canonical.parent().ok_or_else(|| {
        NativeStorageError::new(
            NativeStorageErrorCode::UnsafePath,
            "FYLO root has no parent directory",
        )
    })?;
    let basename = canonical.file_name().map_or_else(
        || "root".to_owned(),
        |name| name.to_string_lossy().into_owned(),
    );
    let sentinel = parent.join(format!(".{basename}.fylo-root-owner.lock"));
    let metadata = parent.join(format!(".{basename}.fylo-root-owner.lock.json"));
    Ok((sentinel, metadata))
}

fn describe_owner(metadata_path: &Path, canonical: &Path) -> String {
    read_metadata(metadata_path).map_or_else(
        || {
            format!(
                "FYLO root already has a live exclusive owner: {}",
                canonical.to_string_lossy()
            )
        },
        |metadata| {
            format!(
                "FYLO root already has a live exclusive owner (pid {} on {}): {}",
                metadata.pid,
                metadata.host,
                canonical.to_string_lossy()
            )
        },
    )
}

fn read_metadata(path: &Path) -> Option<LeaseMetadata> {
    let metadata = std::fs::symlink_metadata(path).ok()?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() > MAX_LEASE_METADATA_BYTES
    {
        return None;
    }
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

fn host_name() -> String {
    std::env::var("HOSTNAME")
        .ok()
        .or_else(|| std::env::var("COMPUTERNAME").ok())
        .unwrap_or_else(|| "unknown".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_second_lease_on_one_root_is_refused_until_the_first_is_dropped() {
        let directory = std::env::temp_dir().join(super::super::write::unique_name("fylo-lease"));
        std::fs::create_dir_all(&directory).unwrap();
        let held = RootLease::acquire(&directory).unwrap();
        held.assert_owned().unwrap();
        let refused = RootLease::acquire(&directory).unwrap_err();
        assert_eq!(refused.code(), NativeStorageErrorCode::RootLocked);
        drop(held);
        let successor = RootLease::acquire(&directory).unwrap();
        successor.assert_owned().unwrap();
        drop(successor);
        let _ = std::fs::remove_dir_all(&directory);
    }
}
