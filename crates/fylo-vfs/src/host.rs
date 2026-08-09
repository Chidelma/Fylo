//! The seam on a target with no filesystem of its own.
//!
//! The embedder installs a [`HostVfs`] — a table of `extern "C"` functions — and
//! every call below routes through it. The table is deliberately C, not
//! JavaScript-shaped: a browser worker driving OPFS synchronous access handles
//! is the first implementation, but a Swift, Kotlin, or Dart embedder that
//! wants to own storage fills the same twelve slots.
//!
//! Positional reads and writes are what OPFS offers and what every other host
//! can express, so the seam owns the file cursor rather than asking the host to
//! keep one.

use std::io::{self, ErrorKind, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// ABI version the engine expects from a host table.
///
/// A host compiled against an older layout would otherwise be read as the
/// current one, which is a silent memory error rather than a version mismatch.
pub const HOST_ABI_VERSION: u32 = 1;

/// Entry kind reported by [`HostVfs::stat`].
pub const HOST_KIND_MISSING: u32 = 0;
/// A regular file.
pub const HOST_KIND_FILE: u32 = 1;
/// A directory.
pub const HOST_KIND_DIRECTORY: u32 = 2;

/// Open for reading.
pub const HOST_OPEN_READ: u32 = 1 << 0;
/// Open for writing.
pub const HOST_OPEN_WRITE: u32 = 1 << 1;
/// Create when absent.
pub const HOST_OPEN_CREATE: u32 = 1 << 2;
/// Fail when the entry already exists.
pub const HOST_OPEN_EXCLUSIVE: u32 = 1 << 3;
/// Truncate to empty on open.
pub const HOST_OPEN_TRUNCATE: u32 = 1 << 4;
/// Write at the current end rather than at the cursor.
pub const HOST_OPEN_APPEND: u32 = 1 << 5;

/// One entry's observable metadata.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct HostStat {
    /// One of the `HOST_KIND_*` constants.
    pub kind: u32,
    /// Byte length of a file; zero for a directory.
    pub len: u64,
    /// Modification time in whole Unix milliseconds.
    ///
    /// A host that cannot observe one reports zero, and the engine stores its
    /// own timestamps rather than depending on this.
    pub modified_ms: u64,
}

/// The filesystem operations a host must provide.
///
/// Every function returns `0` on success or a negative `errno` on failure.
/// Paths are UTF-8 without a trailing NUL; the host must not retain the
/// pointer past the call.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct HostVfs {
    /// Must equal [`HOST_ABI_VERSION`].
    pub abi_version: u32,
    /// Open or create one file, yielding a handle the other calls use.
    pub open: unsafe extern "C" fn(*const u8, usize, u32, *mut u64) -> i32,
    /// Release one handle.
    pub close: unsafe extern "C" fn(u64) -> i32,
    /// Read at an absolute offset, reporting the count actually read.
    pub read_at: unsafe extern "C" fn(u64, u64, *mut u8, usize, *mut usize) -> i32,
    /// Write at an absolute offset, reporting the count actually written.
    pub write_at: unsafe extern "C" fn(u64, u64, *const u8, usize, *mut usize) -> i32,
    /// Set a file's length.
    pub truncate: unsafe extern "C" fn(u64, u64) -> i32,
    /// Flush a handle's writes to storage.
    pub flush: unsafe extern "C" fn(u64) -> i32,
    /// Describe one path without following links; hosts have none.
    pub stat: unsafe extern "C" fn(*const u8, usize, *mut HostStat) -> i32,
    /// Create a directory, optionally creating missing parents.
    pub mkdir: unsafe extern "C" fn(*const u8, usize, u32) -> i32,
    /// Remove one file.
    pub unlink: unsafe extern "C" fn(*const u8, usize) -> i32,
    /// Remove a directory, optionally with its contents.
    pub rmdir: unsafe extern "C" fn(*const u8, usize, u32) -> i32,
    /// Rename one entry over another atomically.
    pub rename: unsafe extern "C" fn(*const u8, usize, *const u8, usize) -> i32,
    /// Read one record's attribute manifest, or nothing when it has none.
    ///
    /// The manifest is a JSON map of attribute name to base64 value — the same
    /// bytes Windows keeps in an alternate data stream. Where the host puts it
    /// is the host's business: one file per record, one manifest per root, or a
    /// database. Reports the byte length it needs, so a caller whose buffer was
    /// too small retries rather than truncating.
    pub read_attrs: unsafe extern "C" fn(*const u8, usize, *mut u8, usize, *mut usize) -> i32,
    /// Replace one record's attribute manifest. An empty manifest removes it.
    pub write_attrs: unsafe extern "C" fn(*const u8, usize, *const u8, usize) -> i32,
    /// Receive one diagnostic line from the module.
    ///
    /// A module with no stdio has nowhere to put a panic message, so without
    /// this every failure reaches the host as a bare `unreachable` trap. The
    /// host decides what to do with the text.
    pub log: unsafe extern "C" fn(*const u8, usize),
    /// Report the wall clock in whole Unix milliseconds.
    ///
    /// `SystemTime::now` panics on `wasm32-unknown-unknown` — there is no
    /// clock behind it — and FYLO stamps records, leases, and transactions with
    /// one. A browser worker answers with `Date.now()`.
    pub now_unix_ms: unsafe extern "C" fn(*mut u64) -> i32,
    /// Fill a buffer with cryptographically secure random bytes.
    ///
    /// Part of the table so the module needs no binding-generator glue for it:
    /// a browser worker calls `crypto.getRandomValues`, and a Swift, Kotlin, or
    /// Dart embedder calls its own platform source.
    pub random: unsafe extern "C" fn(*mut u8, usize) -> i32,
    /// List a directory as NUL-separated names.
    ///
    /// Reports the byte length the listing needs. A caller whose buffer was too
    /// small retries with that length, so the host never truncates silently.
    pub read_dir: unsafe extern "C" fn(*const u8, usize, *mut u8, usize, *mut usize) -> i32,
}

// SAFETY: every field is a bare function pointer or a `u32`. Neither carries
// interior mutability or a thread affinity, so sharing the table is sound.
unsafe impl Send for HostVfs {}
// SAFETY: as above.
unsafe impl Sync for HostVfs {}

static HOST: OnceLock<HostVfs> = OnceLock::new();

/// Install the host filesystem for the life of the module.
///
/// # Errors
///
/// Returns an error when the ABI version is not [`HOST_ABI_VERSION`] or a host
/// is already installed. Replacing one mid-run would strand every open handle.
pub fn install_host(vfs: HostVfs) -> Result<(), &'static str> {
    if vfs.abi_version != HOST_ABI_VERSION {
        return Err("host VFS ABI version mismatch");
    }
    HOST.set(vfs).map_err(|_| "host VFS is already installed")
}

/// Whether a host filesystem is installed.
pub fn host_installed() -> bool {
    HOST.get().is_some()
}

/// Read one record's attribute manifest from the host.
///
/// # Errors
///
/// Returns an error when no host is installed or the host reports failure.
pub fn host_read_attrs(path: &Path) -> io::Result<Vec<u8>> {
    let host = host()?;
    let bytes = path_bytes(path)?;
    let mut buffer = vec![0_u8; 4096];
    loop {
        let mut needed = 0_usize;
        // SAFETY: `bytes` and `buffer` are live slices of the stated lengths
        // and `needed` a live local; the host retains no pointer. On overflow
        // it writes nothing and reports the length the retry allocates.
        let code = unsafe {
            (host.read_attrs)(
                bytes.as_ptr(),
                bytes.len(),
                buffer.as_mut_ptr(),
                buffer.len(),
                &raw mut needed,
            )
        };
        check(code)?;
        if needed > buffer.len() {
            buffer = vec![0_u8; needed];
            continue;
        }
        buffer.truncate(needed);
        return Ok(buffer);
    }
}

/// Replace one record's attribute manifest. Empty removes it.
///
/// # Errors
///
/// Returns an error when no host is installed or the host reports failure.
pub fn host_write_attrs(path: &Path, manifest: &[u8]) -> io::Result<()> {
    let host = host()?;
    let bytes = path_bytes(path)?;
    // SAFETY: both slices are live for the call with their lengths alongside;
    // the host retains neither pointer.
    check(unsafe {
        (host.write_attrs)(
            bytes.as_ptr(),
            bytes.len(),
            manifest.as_ptr(),
            manifest.len(),
        )
    })
}

/// Send one diagnostic line to the host, if one is installed.
pub fn host_log(message: &str) {
    let Some(host) = HOST.get() else {
        return;
    };
    // SAFETY: `message` is a live slice for the duration of the call and the
    // host may not retain the pointer.
    unsafe { (host.log)(message.as_ptr(), message.len()) }
}

/// Read the host's wall clock in whole Unix milliseconds.
///
/// # Errors
///
/// Returns an error when no host is installed or the host reports failure.
pub fn host_now_unix_ms() -> Result<u64, &'static str> {
    let host = HOST.get().ok_or("no host filesystem is installed")?;
    let mut millis = 0_u64;
    // SAFETY: `millis` is a live, writable local for the call's duration.
    let code = unsafe { (host.now_unix_ms)(&raw mut millis) };
    if code == 0 {
        Ok(millis)
    } else {
        Err("host clock failed")
    }
}

/// Fill `destination` with random bytes from the host.
///
/// # Errors
///
/// Returns an error when no host is installed or the host reports failure.
/// Never invents entropy: a silent fallback would produce predictable
/// identifiers and encryption material.
pub fn host_random(destination: &mut [u8]) -> Result<(), &'static str> {
    let host = HOST.get().ok_or("no host filesystem is installed")?;
    if destination.is_empty() {
        return Ok(());
    }
    // SAFETY: `destination` is a live, writable slice of the stated length and
    // the host may not retain the pointer.
    let code = unsafe { (host.random)(destination.as_mut_ptr(), destination.len()) };
    if code == 0 {
        Ok(())
    } else {
        Err("host random source failed")
    }
}

fn host() -> io::Result<&'static HostVfs> {
    HOST.get().ok_or_else(|| {
        io::Error::new(
            ErrorKind::Unsupported,
            "no host filesystem is installed; this build stores nothing until the embedder calls install_host",
        )
    })
}

fn check(code: i32) -> io::Result<()> {
    if code == 0 {
        return Ok(());
    }
    Err(io::Error::from_raw_os_error(-code))
}

fn path_bytes(path: &Path) -> io::Result<&[u8]> {
    path.to_str().map(str::as_bytes).ok_or_else(|| {
        io::Error::new(
            ErrorKind::InvalidInput,
            "host filesystem paths must be UTF-8",
        )
    })
}

/// One file's kind.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct FileType(u32);

impl FileType {
    /// Whether the entry is a directory.
    pub fn is_dir(self) -> bool {
        self.0 == HOST_KIND_DIRECTORY
    }
    /// Whether the entry is a regular file.
    pub fn is_file(self) -> bool {
        self.0 == HOST_KIND_FILE
    }
    /// Always false: a host filesystem has no links, which is why the engine's
    /// containment checks compile away on this target.
    pub fn is_symlink(self) -> bool {
        false
    }
}

/// Placeholder for the POSIX mode a host filesystem does not have.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct Permissions {
    readonly: bool,
}

impl Permissions {
    /// Whether writes are refused. Always false; ADR 0008 does not offer
    /// POSIX permissions on this target.
    pub fn readonly(&self) -> bool {
        self.readonly
    }
    /// Accepted and ignored, so a caller that mirrors native behavior compiles.
    pub fn set_readonly(&mut self, readonly: bool) {
        self.readonly = readonly;
    }
}

/// One entry's metadata.
#[derive(Clone, Copy, Debug)]
pub struct Metadata(HostStat);

impl Metadata {
    /// Byte length.
    pub fn len(&self) -> u64 {
        self.0.len
    }
    /// Whether the entry has no bytes.
    pub fn is_empty(&self) -> bool {
        self.0.len == 0
    }
    /// Whether the entry is a regular file.
    pub fn is_file(&self) -> bool {
        self.0.kind == HOST_KIND_FILE
    }
    /// Whether the entry is a directory.
    pub fn is_dir(&self) -> bool {
        self.0.kind == HOST_KIND_DIRECTORY
    }
    /// The entry's kind.
    pub fn file_type(&self) -> FileType {
        FileType(self.0.kind)
    }
    /// The absent POSIX mode.
    pub fn permissions(&self) -> Permissions {
        Permissions::default()
    }
    /// Modification time.
    ///
    /// # Errors
    ///
    /// Never fails; the signature matches `std` so callers need no `cfg`.
    pub fn modified(&self) -> io::Result<SystemTime> {
        Ok(UNIX_EPOCH + Duration::from_millis(self.0.modified_ms))
    }
}

/// Timestamps a caller would set natively.
#[derive(Clone, Copy, Debug, Default)]
pub struct FileTimes;

impl FileTimes {
    /// A new, empty request.
    #[must_use]
    pub fn new() -> Self {
        Self
    }
    /// Accepted and ignored.
    #[must_use]
    pub fn set_accessed(self, _time: SystemTime) -> Self {
        self
    }
    /// Accepted and ignored.
    #[must_use]
    pub fn set_modified(self, _time: SystemTime) -> Self {
        self
    }
}

/// How a file should be opened.
#[derive(Clone, Copy, Debug, Default)]
pub struct OpenOptions {
    flags: u32,
}

impl OpenOptions {
    /// A new, empty request.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }
    fn set(mut self, flag: u32, enabled: bool) -> Self {
        if enabled {
            self.flags |= flag;
        } else {
            self.flags &= !flag;
        }
        self
    }
    /// Request read access.
    #[must_use]
    pub fn read(&mut self, enabled: bool) -> Self {
        *self = self.set(HOST_OPEN_READ, enabled);
        *self
    }
    /// Request write access.
    #[must_use]
    pub fn write(&mut self, enabled: bool) -> Self {
        *self = self.set(HOST_OPEN_WRITE, enabled);
        *self
    }
    /// Append rather than overwrite. Implemented as writing at the current
    /// length, which is what a positional host offers.
    #[must_use]
    pub fn append(&mut self, enabled: bool) -> Self {
        *self = self.set(HOST_OPEN_WRITE | HOST_OPEN_APPEND, enabled);
        *self
    }
    /// Create the file when absent.
    #[must_use]
    pub fn create(&mut self, enabled: bool) -> Self {
        *self = self.set(HOST_OPEN_CREATE, enabled);
        *self
    }
    /// Create the file, failing when it exists.
    #[must_use]
    pub fn create_new(&mut self, enabled: bool) -> Self {
        *self = self.set(HOST_OPEN_CREATE | HOST_OPEN_EXCLUSIVE, enabled);
        *self
    }
    /// Truncate an existing file on open.
    #[must_use]
    pub fn truncate(&mut self, enabled: bool) -> Self {
        *self = self.set(HOST_OPEN_TRUNCATE, enabled);
        *self
    }
    /// Open the file.
    ///
    /// # Errors
    ///
    /// Returns the host's failure, or `Unsupported` when none is installed.
    pub fn open(&self, path: impl AsRef<Path>) -> io::Result<File> {
        File::open_with(path.as_ref(), self.flags)
    }
}

/// One open file.
#[derive(Debug)]
pub struct File {
    handle: u64,
    position: u64,
    append: bool,
    // A host addresses metadata by path, not by handle, so the file keeps the
    // path it was opened with rather than adding a thirteenth ABI slot.
    path: PathBuf,
}

impl File {
    fn open_with(path: &Path, flags: u32) -> io::Result<Self> {
        let host = host()?;
        let bytes = path_bytes(path)?;
        let mut handle = 0_u64;
        // SAFETY: `bytes` is a live slice for the duration of the call and its
        // length is passed alongside it; `handle` is a live, writable local.
        // The host contract forbids retaining either pointer.
        let code = unsafe { (host.open)(bytes.as_ptr(), bytes.len(), flags, &raw mut handle) };
        check(code)?;
        let mut file = Self {
            handle,
            position: 0,
            append: flags & HOST_OPEN_APPEND != 0,
            path: path.to_path_buf(),
        };
        if flags & HOST_OPEN_TRUNCATE != 0 {
            file.set_len(0)?;
        }
        Ok(file)
    }

    /// Open one existing file for reading.
    ///
    /// # Errors
    ///
    /// Returns the host's failure.
    pub fn open(path: impl AsRef<Path>) -> io::Result<Self> {
        Self::open_with(path.as_ref(), HOST_OPEN_READ)
    }

    /// Create or truncate one file for writing.
    ///
    /// # Errors
    ///
    /// Returns the host's failure.
    pub fn create(path: impl AsRef<Path>) -> io::Result<Self> {
        Self::open_with(
            path.as_ref(),
            HOST_OPEN_WRITE | HOST_OPEN_CREATE | HOST_OPEN_TRUNCATE,
        )
    }

    /// Set this file's length.
    ///
    /// # Errors
    ///
    /// Returns the host's failure.
    pub fn set_len(&mut self, len: u64) -> io::Result<()> {
        let host = host()?;
        // SAFETY: `handle` came from this table's `open` and has not been closed.
        check(unsafe { (host.truncate)(self.handle, len) })
    }

    /// Flush this file's writes to storage.
    ///
    /// # Errors
    ///
    /// Returns the host's failure.
    pub fn sync_all(&self) -> io::Result<()> {
        let host = host()?;
        // SAFETY: as above.
        check(unsafe { (host.flush)(self.handle) })
    }

    /// Flush this file's contents, ignoring metadata.
    ///
    /// # Errors
    ///
    /// Returns the host's failure.
    pub fn sync_data(&self) -> io::Result<()> {
        self.sync_all()
    }

    /// This file's metadata.
    ///
    /// # Errors
    ///
    /// Returns the host's failure.
    pub fn metadata(&self) -> io::Result<Metadata> {
        stat(&self.path).map(Metadata)
    }

    /// Accepted and ignored; a host filesystem has no timestamps to set.
    ///
    /// # Errors
    ///
    /// Never fails.
    pub fn set_times(&self, _times: FileTimes) -> io::Result<()> {
        Ok(())
    }

    /// Take an advisory exclusive lock.
    ///
    /// Always granted. A host hands out one writable handle per path — an OPFS
    /// sync access handle is exclusive by construction — so holding the handle
    /// already *is* the exclusion the native lock file arranges. The signature
    /// mirrors `std` so the lease needs no `cfg`.
    ///
    /// # Errors
    ///
    /// Never fails.
    pub fn try_lock(&self) -> Result<(), std::fs::TryLockError> {
        Ok(())
    }

    /// Release the advisory lock.
    ///
    /// # Errors
    ///
    /// Never fails; the lock is the handle, and closing it releases.
    pub fn unlock(&self) -> io::Result<()> {
        Ok(())
    }

    /// Open a second handle to the same path.
    ///
    /// # Errors
    ///
    /// Returns the host's failure.
    pub fn try_clone(&self) -> io::Result<Self> {
        let mut clone = Self::open_with(&self.path, HOST_OPEN_READ)?;
        clone.position = self.position;
        Ok(clone)
    }
}

impl Drop for File {
    fn drop(&mut self) {
        if let Some(host) = HOST.get() {
            // SAFETY: the handle is live exactly until this call, and `Drop`
            // runs once.
            let _ = unsafe { (host.close)(self.handle) };
        }
    }
}

impl Read for File {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let host = host()?;
        let mut read = 0_usize;
        // SAFETY: `buffer` is a live, writable slice of the stated length, and
        // `read` is a live local. Neither pointer outlives the call.
        let code = unsafe {
            (host.read_at)(
                self.handle,
                self.position,
                buffer.as_mut_ptr(),
                buffer.len(),
                &raw mut read,
            )
        };
        check(code)?;
        self.position = self.position.saturating_add(read as u64);
        Ok(read)
    }
}

impl Write for File {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        let host = host()?;
        if self.append {
            self.position = self.metadata()?.len();
        }
        let mut written = 0_usize;
        // SAFETY: `buffer` is a live slice of the stated length and `written` a
        // live local; the host may not retain either.
        let code = unsafe {
            (host.write_at)(
                self.handle,
                self.position,
                buffer.as_ptr(),
                buffer.len(),
                &raw mut written,
            )
        };
        check(code)?;
        self.position = self.position.saturating_add(written as u64);
        Ok(written)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.sync_all()
    }
}

impl Seek for File {
    fn seek(&mut self, from: SeekFrom) -> io::Result<u64> {
        self.position = match from {
            SeekFrom::Start(offset) => offset,
            SeekFrom::Current(delta) => self.position.saturating_add_signed(delta),
            SeekFrom::End(delta) => self.metadata()?.len().saturating_add_signed(delta),
        };
        Ok(self.position)
    }
}

/// One entry yielded by [`read_dir`].
#[derive(Clone, Debug)]
pub struct DirEntry {
    path: PathBuf,
}

impl DirEntry {
    /// The entry's full path.
    pub fn path(&self) -> PathBuf {
        self.path.clone()
    }
    /// The entry's final component.
    pub fn file_name(&self) -> std::ffi::OsString {
        self.path.file_name().unwrap_or_default().to_os_string()
    }
    /// The entry's kind.
    ///
    /// # Errors
    ///
    /// Returns the host's failure.
    pub fn file_type(&self) -> io::Result<FileType> {
        Ok(symlink_metadata(&self.path)?.file_type())
    }
    /// The entry's metadata.
    ///
    /// # Errors
    ///
    /// Returns the host's failure.
    pub fn metadata(&self) -> io::Result<Metadata> {
        symlink_metadata(&self.path)
    }
}

/// An iterator over one directory's entries.
#[derive(Debug)]
pub struct ReadDir {
    entries: std::vec::IntoIter<DirEntry>,
}

impl Iterator for ReadDir {
    type Item = io::Result<DirEntry>;
    fn next(&mut self) -> Option<Self::Item> {
        self.entries.next().map(Ok)
    }
}

fn stat(path: &Path) -> io::Result<HostStat> {
    let host = host()?;
    let bytes = path_bytes(path)?;
    let mut out = HostStat::default();
    // SAFETY: `bytes` is a live slice of the stated length and `out` a live
    // writable local; the host retains neither.
    let code = unsafe { (host.stat)(bytes.as_ptr(), bytes.len(), &raw mut out) };
    check(code)?;
    if out.kind == HOST_KIND_MISSING {
        return Err(io::Error::new(ErrorKind::NotFound, "entry not found"));
    }
    Ok(out)
}

/// Describe one path without following links.
///
/// # Errors
///
/// Returns the host's failure.
pub fn symlink_metadata(path: impl AsRef<Path>) -> io::Result<Metadata> {
    stat(path.as_ref()).map(Metadata)
}

/// Describe one path. Identical to [`symlink_metadata`]: hosts have no links.
///
/// # Errors
///
/// Returns the host's failure.
pub fn metadata(path: impl AsRef<Path>) -> io::Result<Metadata> {
    symlink_metadata(path)
}

/// A host root is already canonical: there are no links or relative mounts.
///
/// # Errors
///
/// Returns the host's failure when the path does not exist.
pub fn canonicalize(path: impl AsRef<Path>) -> io::Result<PathBuf> {
    let path = path.as_ref();
    stat(path)?;
    Ok(path.to_path_buf())
}

/// Create one directory.
///
/// # Errors
///
/// Returns the host's failure.
pub fn create_dir(path: impl AsRef<Path>) -> io::Result<()> {
    make_dir(path.as_ref(), 0)
}

/// Create one directory and any missing parent.
///
/// # Errors
///
/// Returns the host's failure.
pub fn create_dir_all(path: impl AsRef<Path>) -> io::Result<()> {
    make_dir(path.as_ref(), 1)
}

fn make_dir(path: &Path, recursive: u32) -> io::Result<()> {
    let host = host()?;
    let bytes = path_bytes(path)?;
    // SAFETY: `bytes` is a live slice of the stated length; the host retains
    // no pointer.
    check(unsafe { (host.mkdir)(bytes.as_ptr(), bytes.len(), recursive) })
}

/// Remove one file.
///
/// # Errors
///
/// Returns the host's failure.
pub fn remove_file(path: impl AsRef<Path>) -> io::Result<()> {
    let host = host()?;
    let bytes = path_bytes(path.as_ref())?;
    // SAFETY: as above.
    check(unsafe { (host.unlink)(bytes.as_ptr(), bytes.len()) })
}

/// Remove one empty directory.
///
/// # Errors
///
/// Returns the host's failure.
pub fn remove_dir(path: impl AsRef<Path>) -> io::Result<()> {
    drop_dir(path.as_ref(), 0)
}

/// Remove one directory and everything inside it.
///
/// # Errors
///
/// Returns the host's failure.
pub fn remove_dir_all(path: impl AsRef<Path>) -> io::Result<()> {
    drop_dir(path.as_ref(), 1)
}

fn drop_dir(path: &Path, recursive: u32) -> io::Result<()> {
    let host = host()?;
    let bytes = path_bytes(path)?;
    // SAFETY: as above.
    check(unsafe { (host.rmdir)(bytes.as_ptr(), bytes.len(), recursive) })
}

/// Rename one entry over another.
///
/// # Errors
///
/// Returns the host's failure.
pub fn rename(from: impl AsRef<Path>, to: impl AsRef<Path>) -> io::Result<()> {
    let host = host()?;
    let from = path_bytes(from.as_ref())?;
    let to = path_bytes(to.as_ref())?;
    // SAFETY: both slices are live for the call and their lengths accompany
    // them; the host retains neither pointer.
    check(unsafe { (host.rename)(from.as_ptr(), from.len(), to.as_ptr(), to.len()) })
}

/// List one directory.
///
/// # Errors
///
/// Returns the host's failure.
pub fn read_dir(path: impl AsRef<Path>) -> io::Result<ReadDir> {
    let host = host()?;
    let root = path.as_ref();
    let bytes = path_bytes(root)?;
    let mut buffer = vec![0_u8; 4096];
    loop {
        let mut needed = 0_usize;
        // SAFETY: `buffer` is a live writable slice of the stated capacity and
        // `needed` a live local. On overflow the host writes nothing and only
        // reports the length, which the retry below allocates.
        let code = unsafe {
            (host.read_dir)(
                bytes.as_ptr(),
                bytes.len(),
                buffer.as_mut_ptr(),
                buffer.len(),
                &raw mut needed,
            )
        };
        check(code)?;
        if needed > buffer.len() {
            buffer = vec![0_u8; needed];
            continue;
        }
        let entries = buffer[..needed]
            .split(|byte| *byte == 0)
            .filter(|name| !name.is_empty())
            .map(|name| {
                std::str::from_utf8(name)
                    .map(|name| DirEntry {
                        path: root.join(name),
                    })
                    .map_err(|_| {
                        io::Error::new(ErrorKind::InvalidData, "host directory name is not UTF-8")
                    })
            })
            .collect::<io::Result<Vec<_>>>()?;
        return Ok(ReadDir {
            entries: entries.into_iter(),
        });
    }
}

/// Read one whole file.
///
/// # Errors
///
/// Returns the host's failure.
pub fn read(path: impl AsRef<Path>) -> io::Result<Vec<u8>> {
    let mut file = File::open(path)?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    Ok(bytes)
}

/// Read one whole file as UTF-8.
///
/// # Errors
///
/// Returns the host's failure, or `InvalidData` for non-UTF-8 content.
pub fn read_to_string(path: impl AsRef<Path>) -> io::Result<String> {
    String::from_utf8(read(path)?)
        .map_err(|_| io::Error::new(ErrorKind::InvalidData, "file is not UTF-8"))
}

/// Replace one file's contents.
///
/// # Errors
///
/// Returns the host's failure.
pub fn write(path: impl AsRef<Path>, contents: impl AsRef<[u8]>) -> io::Result<()> {
    let mut file = File::create(path)?;
    file.write_all(contents.as_ref())
}

/// Copy one file's contents to another path.
///
/// # Errors
///
/// Returns the host's failure.
pub fn copy(from: impl AsRef<Path>, to: impl AsRef<Path>) -> io::Result<u64> {
    let bytes = read(from)?;
    write(to, &bytes)?;
    Ok(bytes.len() as u64)
}

/// Link one path to another.
///
/// # Errors
///
/// Always `Unsupported`: a host filesystem has no links, which is why the
/// browser lease uses handle exclusivity rather than a link-created lock file.
pub fn hard_link(_from: impl AsRef<Path>, _to: impl AsRef<Path>) -> io::Result<()> {
    Err(io::Error::new(
        ErrorKind::Unsupported,
        "a host filesystem has no hard links",
    ))
}

/// Accepted and ignored; ADR 0008 does not offer POSIX permissions here.
///
/// # Errors
///
/// Never fails.
pub fn set_permissions(_path: impl AsRef<Path>, _permissions: Permissions) -> io::Result<()> {
    Ok(())
}
