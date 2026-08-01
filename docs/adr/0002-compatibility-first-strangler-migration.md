# ADR 0002: Compatibility-First Strangler Migration

- Status: **Accepted**
- Date: **2026-07-26**
- Owners: **FYLO maintainers**

## Context

FYLO already has released:

- persistent document, raw-file, metadata, index, transaction, encryption,
  versioning, and backup behavior;
- a CLI and bounded machine protocol;
- clients in multiple languages;
- a browser shim and standalone Explorer;
- platform-specific POSIX and Windows behavior.

A rewrite that begins from the API shape alone can appear correct while
silently changing bytes, metadata, query ordering, error codes, crash outcomes,
permissions, or rollback behavior. Storage compatibility must therefore be
proven through released behavior and data, not inferred from new Rust types.

The root-ownership contract also prohibits two write-capable engines from
opening the same root concurrently.

## Decision

Replace the existing engine through a compatibility-first strangler migration.

The current JavaScript/Bun engine remains:

- the behavioral oracle;
- the producer of historical golden fixtures;
- the production default until Rust promotion gates pass;
- the supported rollback implementation where the format compatibility
  manifest permits downgrade.

Migration order is:

1. extract and version public/storage contracts;
2. generate golden roots and operation logs with released JavaScript binaries;
3. implement portable read/query behavior in Rust;
4. integrate the browser Wasm kernel behind a tested fallback;
5. introduce a native read-only Rust path;
6. add Rust write operations one durable vertical slice at a time;
7. add backup/restore, machine protocol, and CLI behavior;
8. run shadow, compatibility, native, security, performance, and soak
   qualification;
9. promote Rust only when the complete scorecard passes.

No phase may change the on-disk format unless a separate ADR and migration RFC
define the version transition, interrupted-upgrade behavior, rollback policy,
and recovery procedure.

## Differential execution rules

- Never run two write-capable engines against one root.
- Read-only comparison may inspect the same stopped, immutable fixture.
- Write comparison clones a complete root or starts from independently created
  equivalent roots.
- An operation recorder may replay the same bounded operation log into separate
  roots.
- The comparison must retain meaningful platform differences rather than
  normalizing them away.
- Every mismatch is either fixed, documented as an accepted contract change
  through RFC, or blocks promotion.
- Discovered regressions become permanent minimized fixtures.

## Compatibility corpus

Fixtures record:

- producer engine version and artifact digest;
- OS, architecture, filesystem, and relevant mount behavior;
- storage, transaction, index, backup, and machine-protocol versions;
- exact operation log and deterministic inputs;
- expected bytes where canonical;
- expected rows, ordering, pagination, metadata, permissions, and stable
  errors;
- whether JavaScript-to-Rust and Rust-to-JavaScript reopening is required;
- known support limitations.

The corpus covers ordinary, malformed, denied, concurrent, interrupted,
corrupt, and resource-exhaustion paths.

## Promotion and rollback

Rust does not become the native default until:

- supported historical fixtures read correctly;
- Rust-written unchanged-format roots reopen correctly in both engines;
- query and machine-protocol differential results have no unexplained
  mismatch;
- crash and recovery matrices pass;
- native platform, security, operations, and performance evidence passes;
- exact release artifacts pass qualification.

Rollback is explicit:

- before a format change, select the previous compatible engine after stopping
  the current owner;
- after a non-downgrade-safe format change, restore a verified pre-upgrade
  backup into a new root;
- immutable release versions remain available;
- mutable browser `latest` pointers may move back without overwriting versioned
  assets.

## Consequences

Benefits:

- preserves operator data and client behavior;
- allows value to ship in vertical slices;
- makes stopping or reversing the rewrite possible;
- creates a permanent upgrade and regression corpus;
- prevents language enthusiasm from overriding storage evidence.

Costs:

- both engines require maintenance during migration;
- fixtures and differential normalization require careful ownership;
- some refactors are intentionally delayed until compatibility is established;
- migration takes longer than a feature-frozen big-bang rewrite.

## Rejected alternatives

### Big-bang replacement

Rejected because the first production comparison would occur too late and the
rollback surface would include the entire engine.

### Dual-write both engines into one root

Rejected because it violates exclusive root ownership and makes failure
attribution and transaction ordering unsafe.

### Recreate fixtures by hand

Rejected because hand-authored fixtures can encode the new implementation's
assumptions rather than the behavior of released binaries.

### Make a new format immediately

Rejected because a language migration and a storage migration must not be
conflated without separate evidence.

## Acceptance evidence

- Every implemented Rust slice has a JavaScript differential or documented
  reason it cannot.
- Golden fixtures identify their producer and environment.
- CI refuses concurrent writers during comparison.
- Release qualification includes upgrade, reopen, rollback/restore, and exact
  artifact identities.
- The current engine remains selectable until the published retirement gate
  passes.

## Related decisions

- [ADR 0001](0001-rust-native-engine-and-portable-wasm-kernel.md)
- [ADR 0003](0003-native-and-browser-storage-boundaries.md)
- [Support tiers](../releases/support-tiers.md)
- [Rust engine project plan](../RUST_ENGINE_PROJECT_PLAN.md)
