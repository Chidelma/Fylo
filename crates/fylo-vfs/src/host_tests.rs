//! The host backend exercised against a real filesystem.
//!
//! The browser backend would otherwise only ever be type-checked: no OPFS
//! exists in a `cargo test` run, and a bug in the cursor arithmetic or the
//! directory-listing retry would surface first in a browser. Installing a
//! table that forwards to `std::fs` runs the same code the browser will,
//! against storage the test can verify directly.

use std::collections::BTreeMap;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::sync::Mutex;

use super::host::{
    File, HOST_ABI_VERSION, HOST_KIND_DIRECTORY, HOST_KIND_FILE, HOST_KIND_MISSING,
    HOST_OPEN_CREATE, HOST_OPEN_EXCLUSIVE, HOST_OPEN_WRITE, HostStat, HostVfs, OpenOptions,
    create_dir_all, install_host, read, read_dir, remove_file, rename, symlink_metadata, write,
};

static HANDLES: Mutex<Option<BTreeMap<u64, std::fs::File>>> = Mutex::new(None);
static NEXT_HANDLE: Mutex<u64> = Mutex::new(1);

fn with_handles<T>(action: impl FnOnce(&mut BTreeMap<u64, std::fs::File>) -> T) -> T {
    let mut guard = HANDLES.lock().expect("handle table");
    action(guard.get_or_insert_with(BTreeMap::new))
}

/// SAFETY contract for every callback below: the seam passes a live pointer
/// with its length and never expects the host to retain it, so each one is
/// viewed only for the duration of the call.
unsafe fn borrow_path(pointer: *const u8, len: usize) -> PathBuf {
    // SAFETY: the seam guarantees `pointer` addresses `len` initialized bytes
    // for this call.
    let bytes = unsafe { std::slice::from_raw_parts(pointer, len) };
    PathBuf::from(std::str::from_utf8(bytes).expect("UTF-8 path"))
}

unsafe extern "C" fn open(path: *const u8, len: usize, flags: u32, out: *mut u64) -> i32 {
    // SAFETY: see `borrow_path`.
    let path = unsafe { borrow_path(path, len) };
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    if flags & HOST_OPEN_WRITE != 0 {
        options.write(true);
    }
    if flags & HOST_OPEN_EXCLUSIVE != 0 {
        options.create_new(true);
    } else if flags & HOST_OPEN_CREATE != 0 {
        options.create(true);
    }
    match options.open(&path) {
        Ok(file) => {
            let mut next = NEXT_HANDLE.lock().expect("handle counter");
            let handle = *next;
            *next += 1;
            with_handles(|handles| handles.insert(handle, file));
            // SAFETY: the seam passes a live, writable `u64`.
            unsafe { *out = handle };
            0
        }
        Err(error) => -error.raw_os_error().unwrap_or(5),
    }
}

unsafe extern "C" fn close(handle: u64) -> i32 {
    with_handles(|handles| handles.remove(&handle));
    0
}

unsafe extern "C" fn read_at(
    handle: u64,
    offset: u64,
    buffer: *mut u8,
    len: usize,
    out: *mut usize,
) -> i32 {
    with_handles(|handles| {
        let Some(file) = handles.get_mut(&handle) else {
            return -9;
        };
        if file.seek(SeekFrom::Start(offset)).is_err() {
            return -5;
        }
        // SAFETY: the seam passes a live, writable slice of `len` bytes.
        let slice = unsafe { std::slice::from_raw_parts_mut(buffer, len) };
        match file.read(slice) {
            // SAFETY: the seam passes a live, writable `usize`.
            Ok(count) => {
                unsafe { *out = count };
                0
            }
            Err(error) => -error.raw_os_error().unwrap_or(5),
        }
    })
}

unsafe extern "C" fn write_at(
    handle: u64,
    offset: u64,
    buffer: *const u8,
    len: usize,
    out: *mut usize,
) -> i32 {
    with_handles(|handles| {
        let Some(file) = handles.get_mut(&handle) else {
            return -9;
        };
        if file.seek(SeekFrom::Start(offset)).is_err() {
            return -5;
        }
        // SAFETY: the seam passes a live slice of `len` initialized bytes.
        let slice = unsafe { std::slice::from_raw_parts(buffer, len) };
        match file.write(slice) {
            Ok(count) => {
                // SAFETY: the seam passes a live, writable `usize`.
                unsafe { *out = count };
                0
            }
            Err(error) => -error.raw_os_error().unwrap_or(5),
        }
    })
}

unsafe extern "C" fn truncate(handle: u64, len: u64) -> i32 {
    with_handles(|handles| {
        handles
            .get_mut(&handle)
            .map_or(-9, |file| match file.set_len(len) {
                Ok(()) => 0,
                Err(error) => -error.raw_os_error().unwrap_or(5),
            })
    })
}

unsafe extern "C" fn flush(handle: u64) -> i32 {
    with_handles(|handles| {
        handles
            .get_mut(&handle)
            .map_or(-9, |file| match file.sync_all() {
                Ok(()) => 0,
                Err(error) => -error.raw_os_error().unwrap_or(5),
            })
    })
}

unsafe extern "C" fn stat(path: *const u8, len: usize, out: *mut HostStat) -> i32 {
    // SAFETY: see `borrow_path`.
    let path = unsafe { borrow_path(path, len) };
    let mut result = HostStat {
        kind: HOST_KIND_MISSING,
        len: 0,
        modified_ms: 0,
    };
    if let Ok(metadata) = std::fs::symlink_metadata(&path) {
        result.kind = if metadata.is_dir() {
            HOST_KIND_DIRECTORY
        } else {
            HOST_KIND_FILE
        };
        result.len = metadata.len();
    }
    // SAFETY: the seam passes a live, writable `HostStat`.
    unsafe { *out = result };
    0
}

unsafe extern "C" fn mkdir(path: *const u8, len: usize, recursive: u32) -> i32 {
    // SAFETY: see `borrow_path`.
    let path = unsafe { borrow_path(path, len) };
    let result = if recursive == 0 {
        std::fs::create_dir(&path)
    } else {
        std::fs::create_dir_all(&path)
    };
    match result {
        Ok(()) => 0,
        Err(error) => -error.raw_os_error().unwrap_or(5),
    }
}

unsafe extern "C" fn unlink(path: *const u8, len: usize) -> i32 {
    // SAFETY: see `borrow_path`.
    let path = unsafe { borrow_path(path, len) };
    match std::fs::remove_file(&path) {
        Ok(()) => 0,
        Err(error) => -error.raw_os_error().unwrap_or(5),
    }
}

unsafe extern "C" fn rmdir(path: *const u8, len: usize, recursive: u32) -> i32 {
    // SAFETY: see `borrow_path`.
    let path = unsafe { borrow_path(path, len) };
    let result = if recursive == 0 {
        std::fs::remove_dir(&path)
    } else {
        std::fs::remove_dir_all(&path)
    };
    match result {
        Ok(()) => 0,
        Err(error) => -error.raw_os_error().unwrap_or(5),
    }
}

unsafe extern "C" fn rename_entry(
    from: *const u8,
    from_len: usize,
    to: *const u8,
    to_len: usize,
) -> i32 {
    // SAFETY: see `borrow_path`.
    let (from, to) = unsafe { (borrow_path(from, from_len), borrow_path(to, to_len)) };
    match std::fs::rename(&from, &to) {
        Ok(()) => 0,
        Err(error) => -error.raw_os_error().unwrap_or(5),
    }
}

unsafe extern "C" fn host_random(buffer: *mut u8, len: usize) -> i32 {
    // Deterministic on purpose: the test asserts the table is reached, not the
    // quality of an entropy source it does not own.
    // SAFETY: the seam passes a live, writable slice of `len` bytes.
    let slice = unsafe { std::slice::from_raw_parts_mut(buffer, len) };
    for (index, byte) in slice.iter_mut().enumerate() {
        *byte = u8::try_from(index % 251).unwrap_or(0);
    }
    0
}

unsafe extern "C" fn host_now_unix_ms(out: *mut u64) -> i32 {
    // SAFETY: the seam passes a live, writable `u64`.
    unsafe { *out = 1_785_000_000_000 };
    0
}

unsafe extern "C" fn host_log(_message: *const u8, _len: usize) {}

static ATTRIBUTES: Mutex<Option<BTreeMap<String, Vec<u8>>>> = Mutex::new(None);

fn with_attributes<T>(action: impl FnOnce(&mut BTreeMap<String, Vec<u8>>) -> T) -> T {
    let mut guard = ATTRIBUTES.lock().expect("attribute table");
    action(guard.get_or_insert_with(BTreeMap::new))
}

unsafe extern "C" fn host_read_attrs(
    path: *const u8,
    len: usize,
    buffer: *mut u8,
    capacity: usize,
    needed: *mut usize,
) -> i32 {
    // SAFETY: see `borrow_path`.
    let path = unsafe { borrow_path(path, len) };
    let manifest = with_attributes(|table| {
        table
            .get(&path.to_string_lossy().into_owned())
            .cloned()
            .unwrap_or_default()
    });
    // SAFETY: the seam passes a live, writable `usize`.
    unsafe { *needed = manifest.len() };
    if manifest.len() > capacity {
        return 0;
    }
    if !manifest.is_empty() {
        // SAFETY: the seam passes a writable buffer of at least `capacity`
        // bytes, and `manifest` is no longer than that.
        unsafe { std::ptr::copy_nonoverlapping(manifest.as_ptr(), buffer, manifest.len()) };
    }
    0
}

unsafe extern "C" fn host_write_attrs(
    path: *const u8,
    len: usize,
    manifest: *const u8,
    manifest_len: usize,
) -> i32 {
    // SAFETY: see `borrow_path`.
    let path = unsafe { borrow_path(path, len) }
        .to_string_lossy()
        .into_owned();
    if manifest_len == 0 {
        with_attributes(|table| table.remove(&path));
        return 0;
    }
    // SAFETY: the seam passes a live slice of `manifest_len` initialized bytes.
    let bytes = unsafe { std::slice::from_raw_parts(manifest, manifest_len) }.to_vec();
    with_attributes(|table| table.insert(path, bytes));
    0
}

unsafe extern "C" fn list_dir(
    path: *const u8,
    len: usize,
    buffer: *mut u8,
    capacity: usize,
    out: *mut usize,
) -> i32 {
    // SAFETY: see `borrow_path`.
    let path = unsafe { borrow_path(path, len) };
    let Ok(entries) = std::fs::read_dir(&path) else {
        return -2;
    };
    let mut encoded = Vec::new();
    for entry in entries.flatten() {
        encoded.extend_from_slice(entry.file_name().to_string_lossy().as_bytes());
        encoded.push(0);
    }
    // SAFETY: the seam passes a live, writable `usize`.
    unsafe { *out = encoded.len() };
    if encoded.len() > capacity {
        // The seam retries with the reported length rather than truncating.
        return 0;
    }
    // SAFETY: the seam passes a writable buffer of at least `capacity` bytes,
    // and `encoded` is no longer than that.
    unsafe { std::ptr::copy_nonoverlapping(encoded.as_ptr(), buffer, encoded.len()) };
    0
}

fn install() {
    let _ = install_host(HostVfs {
        abi_version: HOST_ABI_VERSION,
        open,
        close,
        read_at,
        write_at,
        truncate,
        flush,
        stat,
        mkdir,
        unlink,
        rmdir,
        rename: rename_entry,
        read_dir: list_dir,
        random: host_random,
        now_unix_ms: host_now_unix_ms,
        read_attrs: host_read_attrs,
        write_attrs: host_write_attrs,
        log: host_log,
    });
}

fn scratch(name: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "fylo-vfs-host-{}-{}-{name}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos()
    ));
    std::fs::create_dir_all(&path).expect("scratch");
    path
}

#[test]
fn round_trips_content_through_the_host_table() {
    install();
    let root = scratch("round-trip");
    let target = root.join("document.json");

    write(&target, b"{\"name\":\"Ada\"}").expect("write");
    assert_eq!(read(&target).expect("read"), b"{\"name\":\"Ada\"}");
    assert_eq!(symlink_metadata(&target).expect("stat").len(), 14);
    assert!(symlink_metadata(&target).expect("stat").is_file());
    assert!(symlink_metadata(&root).expect("stat").is_dir());

    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn tracks_the_cursor_across_reads_writes_and_seeks() {
    install();
    let root = scratch("cursor");
    let target = root.join("cursor.bin");

    let mut file = File::create(&target).expect("create");
    file.write_all(b"0123456789").expect("write");
    drop(file);

    let mut file = File::open(&target).expect("open");
    let mut head = [0_u8; 4];
    file.read_exact(&mut head).expect("read head");
    assert_eq!(&head, b"0123");
    // The seam owns the cursor, so a second read must not restart at zero.
    let mut next = [0_u8; 3];
    file.read_exact(&mut next).expect("read next");
    assert_eq!(&next, b"456");
    file.seek(SeekFrom::Start(8)).expect("seek");
    let mut tail = Vec::new();
    file.read_to_end(&mut tail).expect("read tail");
    assert_eq!(tail, b"89");

    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn appends_at_the_end_rather_than_the_cursor() {
    install();
    let root = scratch("append");
    let target = root.join("keys.wal");

    write(&target, b"+\tone\n").expect("seed");
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&target)
        .expect("append open");
    file.write_all(b"+\ttwo\n").expect("append");
    drop(file);

    assert_eq!(read(&target).expect("read"), b"+\tone\n+\ttwo\n");

    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn create_new_refuses_an_existing_path() {
    install();
    let root = scratch("exclusive");
    let target = root.join("once.json");

    write(&target, b"first").expect("seed");
    let second = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&target);
    assert!(second.is_err(), "create_new replaced an existing file");

    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn lists_a_directory_larger_than_the_first_buffer() {
    install();
    let root = scratch("listing");
    let directory = root.join("docs");
    create_dir_all(&directory).expect("mkdir");
    // Names long enough that the listing exceeds the seam's initial 4 KiB
    // buffer, which is the retry path a small fixture would never reach.
    for index in 0..200 {
        write(directory.join(format!("{index:0>40}.json")), b"{}").expect("seed");
    }

    let names: Vec<_> = read_dir(&directory)
        .expect("read_dir")
        .map(|entry| entry.expect("entry").file_name())
        .collect();
    assert_eq!(names.len(), 200);

    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn renames_and_removes_through_the_host_table() {
    install();
    let root = scratch("rename");
    let from = root.join("scratch.tmp");
    let to = root.join("final.json");

    write(&from, b"payload").expect("write");
    rename(&from, &to).expect("rename");
    assert!(symlink_metadata(&from).is_err());
    assert_eq!(read(&to).expect("read"), b"payload");
    remove_file(&to).expect("remove");
    assert!(symlink_metadata(&to).is_err());

    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn truncate_on_open_empties_an_existing_file() {
    install();
    let root = scratch("truncate");
    let target = root.join("state.json");

    write(&target, b"stale contents").expect("seed");
    let mut file = OpenOptions::new()
        .write(true)
        .truncate(true)
        .open(&target)
        .expect("truncating open");
    file.write_all(b"new").expect("write");
    drop(file);

    assert_eq!(read(&target).expect("read"), b"new");

    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn reports_a_missing_host_rather_than_pretending_to_store() {
    // Not `install()`: this asserts the message an embedder sees when it
    // forgets to supply a table, which must not look like an empty database.
    let error = super::host::symlink_metadata("/definitely/absent").unwrap_err();
    assert!(
        matches!(
            error.kind(),
            std::io::ErrorKind::Unsupported | std::io::ErrorKind::NotFound
        ),
        "{error}"
    );
}
