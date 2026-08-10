//! FYLO as a WebAssembly module for a host that owns storage.
//!
//! The WASI build already runs the whole engine wherever there are files and
//! stdio. This crate is for the one environment that has neither: a browser,
//! or any embedder that wants to supply storage itself. It exports the same
//! NDJSON machine protocol the binary speaks over stdin and stdout, as a
//! buffer in and a buffer out.
//!
//! # Contract
//!
//! The host provides twelve filesystem functions as imports from the
//! `fylo_host` module — the `fylo_vfs::HostVfs` table — and calls:
//!
//! 1. `fylo_abi_version` and refuses an unrecognized answer;
//! 2. `fylo_alloc` to obtain a buffer, writing the NDJSON request into it;
//! 3. `fylo_exec`, which returns the response buffer packed as
//!    `(pointer << 32) | length`;
//! 4. `fylo_free` on both buffers.
//!
//! `fylo_exec` takes a batch of newline-delimited frames and answers all of
//! them, which is `exec --loop` in one call. Query cursors live for the length
//! of the batch, so a paged read is one call rather than a session the host
//! has to keep alive.

#![cfg(target_arch = "wasm32")]

mod boundary;

pub use boundary::{fylo_abi_version, fylo_alloc, fylo_exec, fylo_free};
