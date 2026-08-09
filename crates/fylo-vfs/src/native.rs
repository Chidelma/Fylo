//! The seam on a target that has a filesystem.
//!
//! Every item is a re-export of the `std` item the engine already called. A
//! native build therefore emits the same code it did before the seam existed,
//! which is the point: the native path carries the durability guarantees, and
//! an indirection that could alter it would be a worse trade than the
//! portability it buys.

pub use std::fs::{
    DirEntry, File, FileTimes, FileType, Metadata, OpenOptions, Permissions, ReadDir, canonicalize,
    copy, create_dir, create_dir_all, hard_link, metadata, read, read_dir, read_to_string,
    remove_dir, remove_dir_all, remove_file, rename, set_permissions, symlink_metadata, write,
};

/// Whether a host filesystem is installed.
///
/// Always true here: the platform is the host.
pub fn host_installed() -> bool {
    true
}
