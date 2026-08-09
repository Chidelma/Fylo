# Unsafe Rust Inventory

Unsafe Rust is denied by default. Release qualification fails when source and
this inventory diverge.

## Active exceptions

| Boundary              | Functions                                                                                                                                                | Owner            | Invariants                                                                                                                                                                                                      | Evidence                                                       |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Wasm exported symbols | `abi_version`, `allocate`, `deallocate`, `load_snapshot`, `scan_queries` in `src/browser/wasm/src/lib.rs`; only the last three contain unsafe operations | FYLO maintainers | Export names are unique in the module; pointers and capacities originate from the current Wasm instance; host buffers remain valid and unaliased for each call; guest output capacity is checked before copying | ADR 0005, Rust unit tests, compiled-Wasm browser tests, Clippy |
| Host filesystem table | `host_read_attrs`, `host_write_attrs`, `host_log`, `host_now_unix_ms`, `host_random`, `File::{open_with, set_len, sync_all, drop, read, write}`, `stat`, `make_dir`, `remove_file`, `drop_dir`, `rename`, and `read_dir` in `crates/fylo-vfs/src/host.rs`; plus the reference host in `crates/fylo-vfs/src/host_tests.rs` | FYLO maintainers | The table is installed once and never replaced, so no handle is stranded; every pointer is passed with its length and is live only for the call; the host may not retain one; attribute manifests and directory listings report the length needed rather than truncating; handles come from this table's `open` and are closed exactly once | ADR 0008, `fylo-vfs` host tests against a std-backed table, Clippy |
| Browser module boundary | `fylo_abi_version`, `fylo_alloc`, `fylo_free`, `fylo_exec`, `__getrandom_v03_custom`, and the `fylo_host` imports in `crates/fylo-wasm/src/boundary.rs` | FYLO maintainers | A buffer from `fylo_alloc` is returned to `fylo_free` with the length that produced it, reconstructing a boxed slice rather than guessing a `Vec` capacity; the packed pointer/length addresses one live allocation the module has handed to the host; host-written request bytes are copied before use and not aliased during the call; entropy never falls back to a guess | ADR 0008, `verify-browser-wasm-host.mjs`, Clippy |

## Review rules

- A new row requires an accepted ADR.
- Every listed function must contain a local `SAFETY:` comment.
- Portable format and query crates remain entirely safe Rust.
- `fylo-vfs` denies unsafe outside its host module; the native backend is a
  re-export of `std::fs` and contains none.
- The Wasm module's own linear memory is not shared. The browser host may use a
  separate `SharedArrayBuffer` between its engine and OPFS bridge Workers; that
  buffer never crosses the Rust ABI.
