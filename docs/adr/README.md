# FYLO Architecture Decision Records

Architecture Decision Records capture decisions that are expensive, risky, or
incompatible to reverse. They explain why a decision was made, the constraints
it protects, and the evidence required to keep it.

## Status vocabulary

- **Proposed**: open for review and not yet authoritative.
- **Accepted**: authoritative for new work.
- **Superseded**: replaced by a later ADR; retained for historical context.
- **Rejected**: considered but not selected.
- **Deprecated**: still present during a documented migration window.

Accepted ADRs are immutable except for status, supersession links, and
corrections that do not change the decision. A material change requires a new
ADR.

## Index

| ADR                                                         | Status   | Decision                                    |
| ----------------------------------------------------------- | -------- | ------------------------------------------- |
| [0001](0001-rust-native-engine-and-portable-wasm-kernel.md) | Accepted | Rust native engine and portable Wasm kernel |
| [0002](0002-compatibility-first-strangler-migration.md)     | Accepted | Compatibility-first strangler migration     |
| [0003](0003-native-and-browser-storage-boundaries.md)       | Accepted | Native and browser storage boundaries       |
| [0004](0004-unsafe-and-dependency-policy.md)                | Accepted | Unsafe-code and dependency policy           |

## When another ADR is required

Create an ADR before changing:

- the authoritative storage medium;
- disk, transaction, index, backup, or machine-protocol formats;
- durability or recovery guarantees;
- native/browser responsibility boundaries;
- multi-writer or distributed-coordination assumptions;
- cryptographic or key-custody boundaries;
- unsafe-code policy;
- supported platform or release-evidence policy;
- whether Rust crates become stable public APIs.

Public behavior also requires an RFC with compatibility, migration, security,
operations, and rollback analysis.
