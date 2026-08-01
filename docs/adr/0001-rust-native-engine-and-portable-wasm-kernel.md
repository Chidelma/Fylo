# ADR 0001: Rust Native Engine and Portable Wasm Kernel

- Status: **Accepted; S3 scope superseded by ADR 0007**
- Date: **2026-07-26**
- Owners: **FYLO maintainers**

## Context

FYLO directly queries and mutates filesystem-backed documents and files. Its
critical paths include:

- canonical file and metadata encoding;
- query parsing, planning, and index scans;
- transactions, crash recovery, and root ownership;
- native POSIX and Windows filesystem behavior;
- a bounded machine protocol used by thin language clients;
- a browser engine hosted by workers, File System Access, and OPFS.

The current JavaScript/Bun implementation established the product behavior and
remains the compatibility reference. A prior Rust/Wasm proof of concept found
that codec-only work did not justify integration, while warm snapshot scans
showed a meaningful larger-workload improvement. The project also needs a
native implementation language suited to explicit memory, concurrency,
platform, and binary-distribution control.

The browser and native environments do not expose the same storage facilities.
WebAssembly cannot turn browser code into a native filesystem process, and a
native binary cannot replace browser permission and storage APIs.

## Decision

Build the next FYLO engine generation in Rust with two deliverables:

1. a full native Rust engine and CLI for authoritative local-filesystem
   operation;
2. a portable Rust kernel compiled to `wasm32-unknown-unknown` for browser
   format, query, index, and deterministic state-transition work.

Keep the browser shim and Explorer host in TypeScript/JavaScript. They continue
to own browser API calls, worker lifecycle, FSA handles, OPFS persistence,
buffer transfer, fallback selection, and UI behavior.

The shared Rust surface is algorithms and versioned formats—not native I/O.
Native storage remains an adapter boundary unavailable to the Wasm crate.

Use one Cargo workspace and one lockfile. Begin with these intended crate
responsibilities, adding a crate only when its first working vertical slice is
implemented:

- `fylo-format`;
- `fylo-query`;
- `fylo-engine`;
- `fylo-storage-native`;
- `fylo-machine`;
- `fylo-cli`;
- `fylo-wasm`;
- `fylo-testkit` as a non-published test package.

Rust crates are internal implementation boundaries. This ADR does not promise a
stable Rust library API or crates.io publication.

## Dependency rules

- Portable crates do not depend on filesystem, process, network, or UI APIs.
- Native and browser adapters depend inward on portable contracts.
- The CLI is a composition root and is not imported by library crates.
- `fylo-wasm` never depends on `fylo-storage-native`.
- Language clients communicate through the versioned machine protocol and do
  not reimplement engine semantics.
- Cyclic crate dependencies are prohibited.

## Consequences

Benefits:

- one memory-safe implementation language for native engine internals;
- a shared query/index kernel across native and browser products;
- explicit platform adapters instead of scattered runtime checks;
- native executables without requiring Bun on operator machines;
- retained TypeScript integration where browser APIs and UI work are strongest.

Costs:

- JavaScript and Rust coexist throughout the migration;
- Wasm has initialization, transfer, payload, and debugging costs;
- contributors need both pinned Bun and Rust toolchains;
- compatibility and differential harnesses become permanent engineering
  assets;
- platform code still requires careful filesystem and operating-system review;
  Rust memory safety alone does not prove storage safety.

## Rejected alternatives

### Rewrite every surface in Rust

Rejected because Explorer and browser-host behavior are dominated by web APIs,
workers, permission UX, and UI integration. Rewriting those surfaces would add
risk without improving the authoritative native storage boundary.

### Ship one Wasm binary for every operating system

Rejected because Wasm does not supply the native filesystem, locking,
permissions, process, code-signing, or S3 runtime guarantees FYLO requires.

### Keep the engine entirely in JavaScript

Rejected as the long-term architecture because it does not provide the desired
native/Wasm shared kernel and platform-controlled engine foundation. It remains
the compatibility oracle and rollback implementation during migration.

### Use Rust only for isolated accelerators

Rejected as the final native architecture. It remains an acceptable migration
technique, particularly for the browser query kernel.

## Acceptance evidence

This decision remains accepted when:

- the Cargo dependency graph obeys the boundary rules;
- portable crates build for native and Wasm targets;
- native storage code cannot enter the Wasm dependency closure;
- the machine protocol remains implementation-language neutral;
- browser failure selects a tested JavaScript fallback;
- release artifacts report Rust, format, protocol, ABI, target, and commit
  identity;
- promotion follows the support tiers in
  [`docs/releases/support-tiers.md`](../releases/support-tiers.md).

## Related decisions

- [ADR 0002](0002-compatibility-first-strangler-migration.md)
- [ADR 0003](0003-native-and-browser-storage-boundaries.md)
- [ADR 0004](0004-unsafe-and-dependency-policy.md)
- [Rust engine project plan](../RUST_ENGINE_PROJECT_PLAN.md)
