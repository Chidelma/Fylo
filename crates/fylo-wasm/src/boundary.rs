//! The module's edge: imported host functions in, exported buffers out.
//!
//! Everything unsafe in the browser engine lives here. Nothing below this file
//! knows the host exists.

#![allow(
    unsafe_code,
    reason = "ADR 0008 confines the host boundary to this module"
)]

use std::io::Cursor;

use fylo_machine::{FrameLimits, RootConfig, serve_configured};
use fylo_vfs::{HOST_ABI_VERSION, HostStat, HostVfs, install_host};

/// ABI this module implements. A host that does not recognize it must refuse
/// to load the module rather than guess at the layout.
pub const MODULE_ABI_VERSION: u32 = 1;

// The host supplies the filesystem. Names match `HostVfs` field for field, so
// a mismatch is a link error at instantiation rather than a wrong call later.
#[link(wasm_import_module = "fylo_host")]
unsafe extern "C" {
    fn open(path: *const u8, path_len: usize, flags: u32, handle: *mut u64) -> i32;
    fn close(handle: u64) -> i32;
    fn read_at(handle: u64, offset: u64, buffer: *mut u8, len: usize, read: *mut usize) -> i32;
    fn write_at(
        handle: u64,
        offset: u64,
        buffer: *const u8,
        len: usize,
        written: *mut usize,
    ) -> i32;
    fn truncate(handle: u64, len: u64) -> i32;
    fn flush(handle: u64) -> i32;
    fn stat(path: *const u8, path_len: usize, out: *mut HostStat) -> i32;
    fn mkdir(path: *const u8, path_len: usize, recursive: u32) -> i32;
    fn unlink(path: *const u8, path_len: usize) -> i32;
    fn rmdir(path: *const u8, path_len: usize, recursive: u32) -> i32;
    fn rename(from: *const u8, from_len: usize, to: *const u8, to_len: usize) -> i32;
    fn read_dir(
        path: *const u8,
        path_len: usize,
        buffer: *mut u8,
        capacity: usize,
        needed: *mut usize,
    ) -> i32;
    fn random(buffer: *mut u8, len: usize) -> i32;
    fn now_unix_ms(out: *mut u64) -> i32;
    fn read_attrs(
        path: *const u8,
        path_len: usize,
        buffer: *mut u8,
        capacity: usize,
        needed: *mut usize,
    ) -> i32;
    fn write_attrs(path: *const u8, path_len: usize, manifest: *const u8, len: usize) -> i32;
    fn log(message: *const u8, len: usize);
}

/// Route `getrandom` to the host table.
///
/// Its Web Crypto backend reaches the browser through a binding generator,
/// which would put `__wbindgen_placeholder__` imports in the module and oblige
/// every embedder — Swift, Kotlin, Dart — to ship JavaScript glue. Entropy is
/// a host capability like any other, so it travels the same plain C table.
///
/// # Errors
///
/// Fails when no host is installed or the host's source fails. It never falls
/// back: invented entropy would produce predictable identifiers and encryption
/// material.
#[unsafe(no_mangle)]
unsafe extern "Rust" fn __getrandom_v03_custom(
    destination: *mut u8,
    len: usize,
) -> Result<(), getrandom::Error> {
    if len == 0 {
        return Ok(());
    }
    // SAFETY: `getrandom` guarantees `destination` addresses `len` writable
    // bytes for this call.
    let buffer = unsafe { std::slice::from_raw_parts_mut(destination, len) };
    fylo_vfs::host_random(buffer).map_err(|_| getrandom::Error::UNEXPECTED)
}

/// Report the ABI this module implements.
#[unsafe(no_mangle)]
pub extern "C" fn fylo_abi_version() -> u32 {
    MODULE_ABI_VERSION
}

/// Reserve `len` bytes the host may write into.
///
/// Returns a null pointer when `len` is zero. Like Rust's standard containers,
/// an allocator-level out-of-memory condition traps rather than returning.
#[unsafe(no_mangle)]
pub extern "C" fn fylo_alloc(len: usize) -> *mut u8 {
    if len == 0 {
        return std::ptr::null_mut();
    }
    let buffer = vec![0_u8; len].into_boxed_slice();
    // Ownership passes to the host until it calls `fylo_free` with the same
    // length, which reconstructs the slice metadata without guessing a Vec
    // capacity.
    Box::into_raw(buffer) as *mut u8
}

/// Release a buffer obtained from [`fylo_alloc`] or returned by [`fylo_exec`].
///
/// `len` must be the length that produced the pointer.
#[unsafe(no_mangle)]
pub extern "C" fn fylo_free(pointer: *mut u8, len: usize) {
    if pointer.is_null() || len == 0 {
        return;
    }
    // SAFETY: the pointer came from a boxed slice of this exact length in
    // `fylo_alloc` or `pack`, and the host contract requires that same length
    // back. Reconstructing and dropping it frees precisely that allocation.
    let slice = std::ptr::slice_from_raw_parts_mut(pointer, len);
    drop(unsafe { Box::from_raw(slice) });
}

/// Answer a batch of newline-delimited machine frames.
///
/// Returns `(pointer << 32) | length` addressing the NDJSON response, which
/// the host must release with [`fylo_free`]. A zero return means the response
/// was empty.
#[unsafe(no_mangle)]
pub extern "C" fn fylo_exec(request: *const u8, len: usize) -> u64 {
    if install().is_err() {
        return pack(
            br#"{"protocolVersion":1,"ok":false,"op":null,"requestId":null,"durationMs":0,"error":{"name":"FyloMachineError","message":"host filesystem table was rejected","code":"ENATIVE_UNSUPPORTED"}}"#
                .to_vec(),
        );
    }
    if request.is_null() || len == 0 {
        return 0;
    }
    // SAFETY: the host wrote `len` bytes into a buffer from `fylo_alloc` and
    // does not mutate it for the duration of this call.
    let input = unsafe { std::slice::from_raw_parts(request, len) }.to_vec();
    let mut reader = Cursor::new(input);
    let mut output = Vec::new();
    // A browser has no environment, so the knobs are explicit. Frame limits are
    // the published defaults; the host bounds its own buffers.
    if serve_configured(
        &mut reader,
        &mut output,
        None,
        FrameLimits::default(),
        RootConfig::default(),
    )
    .is_err()
    {
        return pack(
            br#"{"protocolVersion":1,"ok":false,"op":null,"requestId":null,"durationMs":0,"error":{"name":"FyloMachineError","message":"machine session failed","code":"EUNKNOWN"}}"#
                .to_vec(),
        );
    }
    pack(output)
}

/// Hand a buffer to the host as a packed pointer and length.
fn pack(bytes: Vec<u8>) -> u64 {
    if bytes.is_empty() {
        return 0;
    }
    let len = bytes.len();
    let pointer = Box::into_raw(bytes.into_boxed_slice()) as *mut u8;
    // Released by `fylo_free`; see the SAFETY note there.
    ((pointer as u64) << 32) | len as u64
}

/// Install the imported host table once.
///
/// Idempotent: a second call is the "already installed" case, which is success
/// from the caller's point of view.
fn install() -> Result<(), &'static str> {
    if fylo_vfs::host_installed() {
        return Ok(());
    }
    // Without stdio a panic reaches the host as a bare `unreachable`. Routing
    // the message through the table turns that into something diagnosable.
    std::panic::set_hook(Box::new(|info| {
        fylo_vfs::host_log(&format!("FYLO panic: {info}"));
    }));
    match install_host(HostVfs {
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
        rename,
        read_dir,
        random,
        now_unix_ms,
        read_attrs,
        write_attrs,
        log,
    }) {
        Ok(()) => Ok(()),
        Err(_) if fylo_vfs::host_installed() => Ok(()),
        Err(message) => Err(message),
    }
}
