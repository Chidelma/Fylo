# ADR 0005: Narrow Wasm Linear-Memory Boundary

- Status: **Accepted**
- Date: **2026-07-26**
- Owners: **FYLO maintainers**
- Amends: [ADR 0004](0004-unsafe-and-dependency-policy.md)

## Context

The portable format and query kernels are safe Rust. The browser host still
needs a stable, dependency-light way to copy snapshots, query frames, and
results across WebAssembly linear memory. A raw C ABI requires reconstructing
Rust allocations and viewing host-provided pointer/length pairs as slices.
Those three operations cannot be expressed as safe Rust.

Switching to a generated binding layer would move the same unsafe operations
into a dependency and would change the existing browser asset contract. It
would not remove the memory boundary.

## Decision

Permit unsafe Rust only in the three exported memory-boundary functions in
`src/browser/wasm/src/lib.rs`:

- `deallocate`;
- `load_snapshot`;
- `scan_queries`.

The crate denies unsafe code globally and lowers that lint on only those
functions. Every unsafe block documents its pointer, capacity, lifetime, and
aliasing invariant. All format validation and query behavior remain in safe
portable crates.

The ABI is explicitly versioned. The JavaScript host rejects an unknown ABI
before transferring data. Snapshot, term, query-count, match-count, and output
bounds are enforced inside the safe kernel.

Adding another unsafe function, supporting shared memory, accepting
host-mutated aliases, or changing allocation ownership requires a new ADR.

## Consequences

The browser build retains its compact existing ABI and keeps unsafe code out of
query logic. Reviewers must still reason about three raw memory operations, and
Miri cannot execute the complete `wasm32-unknown-unknown` host boundary.
Native unit tests cover the allocator ownership rules where practical, while
browser integration tests exercise the compiled module.

## Acceptance evidence

- the Wasm crate denies unsafe code outside the listed functions;
- each unsafe block has a local `SAFETY:` justification;
- `docs/security/unsafe-inventory.md` matches the source;
- the host verifies ABI version 1;
- malformed and oversized snapshots and queries fail closed;
- the safe `fylo-query` crate remains `unsafe_code = "forbid"`.

## Related decisions

- [ADR 0001](0001-rust-native-engine-and-portable-wasm-kernel.md)
- [ADR 0004](0004-unsafe-and-dependency-policy.md)
- [Rust engine project plan](../RUST_ENGINE_PROJECT_PLAN.md)
