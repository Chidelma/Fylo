# Unsafe Rust Inventory

Unsafe Rust is denied by default. Release qualification fails when source and
this inventory diverge.

## Active exceptions

| Boundary              | Functions                                                                                                                                                | Owner            | Invariants                                                                                                                                                                                                      | Evidence                                                       |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Wasm exported symbols | `abi_version`, `allocate`, `deallocate`, `load_snapshot`, `scan_queries` in `src/browser/wasm/src/lib.rs`; only the last three contain unsafe operations | FYLO maintainers | Export names are unique in the module; pointers and capacities originate from the current Wasm instance; host buffers remain valid and unaliased for each call; guest output capacity is checked before copying | ADR 0005, Rust unit tests, compiled-Wasm browser tests, Clippy |

## Review rules

- A new row requires an accepted ADR.
- Every listed function must contain a local `SAFETY:` comment.
- Portable format and query crates remain entirely safe Rust.
- Shared-memory and threaded Wasm are outside the current ABI.
