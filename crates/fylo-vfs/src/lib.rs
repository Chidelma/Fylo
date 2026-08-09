//! The filesystem seam the storage engine calls instead of `std::fs`.
//!
//! FYLO's engine was written directly against `std::fs`, which made the engine
//! and the platform inseparable. `SQLite` has been portable for decades because
//! every byte it reads or writes goes through one `sqlite3_vfs`; this module is
//! that layer, arrived at late.
//!
//! # Backends
//!
//! On every target with a real filesystem the seam *is* `std::fs` — the names
//! and signatures below are re-exports, so a native, iOS, or Android build
//! compiles to exactly the calls it made before. That matters more than
//! elegance: the native path is the one guarded by the crash matrix, and a
//! re-export cannot change its behavior.
//!
//! Only `wasm32-unknown-unknown` has no filesystem, and only there does the
//! seam route to a host. WebAssembly is not a browser: `wasm32-wasip1` has
//! real files and real stdio, so a server-side Wasm build takes the same
//! `std::fs` path a native binary does. The host supplies a [`HostVfs`] table of plain
//! `extern "C"` functions, so the embedder can be a JavaScript worker driving
//! OPFS, or anything else that can fill a C function table.
//!
//! # Embedders
//!
//! Swift, Kotlin, and Dart reach FYLO on a device where a real filesystem
//! exists, so they link the native backend and need nothing from this module.
//! They only supply a [`HostVfs`] when they *want* to intercept storage — a
//! Flutter web build, or an app that keeps its root inside a container the
//! process cannot open by path.

#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
mod native;
#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
pub use native::*;

// Compiled natively under `test` as well, so the host backend's logic is
// exercised against a std-backed table rather than only type-checked.
#[cfg(any(all(target_arch = "wasm32", target_os = "unknown"), test))]
#[allow(
    unsafe_code,
    reason = "ADR 0008 confines the host boundary to this module"
)]
pub mod host;
#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
pub use host::*;

// The reference host is itself a host implementation, so it lives under the
// same ADR 0008 allowance as the boundary it drives.
#[cfg(test)]
#[allow(
    unsafe_code,
    reason = "a test host fills the same C table a browser does"
)]
mod host_tests;
