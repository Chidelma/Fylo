# ADR 0004: Unsafe-Code and Dependency Policy

- Status: **Accepted**
- Date: **2026-07-26**
- Owners: **FYLO maintainers**

## Context

Rust prevents broad classes of memory errors, but FYLO still operates across
untrusted data, filesystem races, platform APIs, memory mapping, process
boundaries, Wasm buffers, cryptography, and S3-compatible endpoints.

Native filesystem correctness may eventually require small platform-specific
FFI or unsafe abstractions. Dependencies and CI actions also become executable
supply-chain inputs. An enterprise engine needs explicit ownership and
evidence rather than an unreviewed accumulation of unsafe blocks, crates, and
features.

## Decision

### Unsafe code

- Workspace policy is `unsafe_code = "forbid"`.
- Portable format, query, engine, machine, S3, CLI, Wasm, and test utility code
  remain safe Rust unless a new ADR changes a specific boundary.
- Only a narrowly scoped platform module may lower the lint after a reviewed
  exception.
- Every unsafe function or block requires:
    - a `SAFETY:` comment stating all invariants;
    - the smallest practical scope;
    - a safe wrapper that validates caller obligations;
    - focused unit, property, native, and negative tests;
    - Miri coverage where the operation is supported;
    - sanitizer coverage where applicable;
    - an entry in `docs/security/unsafe-inventory.md`;
    - designated code ownership.
- Unsafe code cannot be introduced solely for a benchmark improvement without
  measured end-to-end benefit and a safe alternative analysis.
- Unowned or undocumented unsafe code blocks release promotion.

### Dependencies

- Commit one root `Cargo.lock`.
- Pin the full Rust toolchain in `rust-toolchain.toml`.
- Release builds use the committed graph with locked/frozen resolution.
- Prefer the standard library for small security-sensitive behavior.
- Every direct dependency pull request documents:
    - purpose and owning crate;
    - enabled features and why;
    - license and source;
    - security/maintenance posture;
    - binary, compile-time, and target impact;
    - feasible replacement or removal path.
- Disable default features unless every enabled default is intentional.
- Release branches prohibit floating Git dependencies.
- Git dependencies require an immutable revision and temporary accepted
  exception.
- Unknown registries and unapproved sources fail CI.
- Advisory exceptions require a reason, reachability analysis, owner, tracking
  issue, and expiry.
- Duplicate versions are reported and reviewed; they are not automatically
  forbidden when a justified dependency graph needs them.
- Public release binaries embed auditable dependency metadata.

### Enforcement

Required checks include:

- inherited workspace Rust/Clippy lints;
- `cargo fmt`;
- `cargo clippy --workspace --all-targets --all-features -- -D warnings`;
- workspace tests and documentation tests;
- `cargo-deny` advisories, licenses, bans, and sources;
- vulnerability/advisory scanning of the lockfile and final binaries;
- unsafe inventory drift;
- secret scanning;
- pinned GitHub Actions by full commit SHA;
- SBOM and provenance generation for releases.

Tool versions used by CI are pinned. Policy configuration is reviewed as code;
a disabled or weakened check is a security-impacting change.

## Dependency review criteria

Reviewers consider:

- whether the capability belongs in FYLO;
- transitive dependency count and duplicate graph;
- use of unsafe code, build scripts, proc macros, native libraries, and network
  access;
- supported targets, including Wasm;
- maintenance and disclosure history;
- license compatibility;
- input/resource bounds;
- deterministic and reproducible-build impact;
- whether the dependency handles secrets or untrusted bytes.

A popular crate is not automatically acceptable, and a small crate is not
automatically safer.

## Release behavior

Every native release records:

- compiler and Cargo identity;
- lockfile digest;
- enabled features and target;
- direct and transitive dependency inventory;
- SBOM digest;
- artifact checksum and provenance.

The release workflow verifies the final downloadable artifact, not only the
source lockfile.

## Consequences

Benefits:

- most of the engine remains statically prevented from using unsafe Rust;
- platform exceptions are visible and auditable;
- dependency growth is intentional;
- vulnerability response can identify affected shipped binaries;
- release consumers can verify provenance and dependency identity.

Costs:

- dependency additions require more review;
- some platform optimizations may be delayed;
- Miri/sanitizer jobs add CI time and may need pinned nightly toolchains;
- advisory exceptions require active maintenance.

## Rejected alternatives

### Forbid all unsafe code without exception

Rejected as an absolute rule because precise native platform primitives may
require FFI. The default remains forbid; any exception is narrow and evidenced.

### Allow unsafe anywhere with comments

Rejected because comments alone do not establish ownership, test coverage, or
release visibility.

### Depend only on automated vulnerability alerts

Rejected because advisories do not evaluate licenses, sources, features,
maintenance, unsafe code, build scripts, or suitability for FYLO.

### Vendor every dependency immediately

Rejected as the default because vendoring transfers update responsibility
without eliminating review or vulnerability risk. Reproducible vendor bundles
may be added when offline enterprise builds require them.

## Acceptance evidence

- New crates inherit workspace lint and dependency policy.
- Only inventory-listed modules can compile unsafe code.
- Dependency and unsafe-policy checks are required in branch protection.
- Release qualification can map a final artifact back to its dependency graph.
- Exceptions are machine-detectable and expire.

## Related decisions

- [ADR 0001](0001-rust-native-engine-and-portable-wasm-kernel.md)
- [ADR 0002](0002-compatibility-first-strangler-migration.md)
- [Support tiers](../releases/support-tiers.md)
- [Rust engine project plan](../RUST_ENGINE_PROJECT_PLAN.md)
