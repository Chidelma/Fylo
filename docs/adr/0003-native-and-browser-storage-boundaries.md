# ADR 0003: Native and Browser Storage Boundaries

- Status: **Accepted**
- Date: **2026-07-26**
- Owners: **FYLO maintainers**

## Context

FYLO's native product is a local-filesystem-primary document store. Users may
place the root on a locally mounted filesystem that supplies the required
locking, atomic replacement, durability, metadata, and security semantics.
S3-compatible clients provide additive backup, verification, and restore.

The browser cannot open arbitrary native paths through Rust's filesystem API.
It has:

- File System Access (FSA) handles selected and authorized by the user;
- Origin Private File System (OPFS) storage private to the web origin;
- workers and asynchronous browser I/O;
- browser-specific quota, eviction, permission, and lifecycle behavior.

Documents/files must remain inspectable through the Explorer, while derived
indexes and caches should not require the user to manage additional visible
files.

## Decision

### Native product

- The local filesystem is authoritative.
- Documents and raw files are the source of truth.
- Indexes, caches, and query acceleration are derived and rebuildable.
- Exactly one process owns a root for writes.
- Native adapters implement platform-specific locking, safe open, atomic
  replacement, sync, metadata, permissions, and recovery.
- S3-compatible storage is a backup/verify/restore destination, not a primary
  query or transaction path.
- Network shares and synchronized folders are unsupported unless their exact
  filesystem semantics pass a separate native qualification profile.

### Browser product

- FSA is the user-visible document and raw-file boundary.
- OPFS stores private indexes, caches, snapshots, and WAL/compaction state.
- The TypeScript browser host owns all FSA and OPFS calls.
- The Rust/Wasm kernel receives bounded bytes and operations; it does not own
  browser handles or permission prompts.
- An FSA document tree remains authoritative over derived OPFS state.
- Lost, corrupt, stale, or evicted OPFS state is rebuilt from the authorized
  document tree.
- Browser persistence and permission limitations are surfaced honestly in the
  support matrix.

### Explorer

- Explorer views the root the user explicitly authorized.
- Recent-root records are browser convenience state, not additional roots.
- Removing a recent-root entry does not delete the underlying data.
- Explorer does not gain privileged access beyond the browser shim's public
  contracts.
- A self-hosted Explorer uses the same versioned browser engine assets and
  compatibility checks.

## Storage adapter requirements

Native and browser adapters must expose enough information to prove:

- canonical root identity;
- file identity and containment;
- metadata support and limitations;
- atomic/durable replacement capabilities;
- exclusive ownership capabilities;
- maximum safe object and operation sizes;
- permission and quota state;
- format and platform compatibility.

A least-common-denominator abstraction must not erase platform differences.
Unsupported semantics fail with stable errors or lower the support tier.

## Canonical metadata

The public metadata contract includes:

- custom FYLO metadata;
- canonical timestamps such as `mtime`, `updatedAt`, and `createdAt` where the
  platform can supply or persist them;
- size, content type, and other canonical fields defined by the versioned
  contract;
- POSIX UID, GID, and mode where supported;
- explicit Windows behavior rather than pretending Windows ACLs are POSIX
  ownership.

Backup/restore records which metadata is preserved, translated, rejected, or
unsupported. It never silently claims cross-platform permission equivalence.

## Consequences

Benefits:

- native FYLO retains direct-disk performance and real-time mounted-filesystem
  behavior;
- browser users get user-controlled documents with private derived indexes;
- OPFS loss is recoverable;
- S3-compatible providers remain interchangeable backup boundaries;
- the portable Rust kernel is not distorted by incompatible I/O models.

Costs:

- native and browser orchestration remain different;
- browser queries may require an initial or repeated rebuild;
- FSA support and behavior vary by browser;
- platform metadata and permission support require explicit matrices;
- S3-compatible backup cannot provide direct multi-user query coordination.

## Rejected alternatives

### Make S3-compatible storage primary

Rejected for this generation because it changes transaction, consistency,
latency, metadata, and offline semantics. It is not required for the accepted
local-filesystem-primary product.

### Put browser documents and indexes only in OPFS

Rejected as the universal Explorer model because users need to authorize and
inspect an existing document tree. OPFS remains appropriate for private
derived state.

### Put browser indexes beside user documents

Rejected as the default because derived implementation files would pollute the
user-visible root and complicate permissions, sync, and cleanup.

### Hide platform differences behind one storage claim

Rejected because support must reflect real locking, durability, metadata, and
permissions evidence.

## Acceptance evidence

- Native root ownership and recovery pass on every supported filesystem.
- Browser tests prove OPFS deletion followed by deterministic rebuild.
- Wasm loading failure selects a tested JavaScript fallback.
- FSA permission loss and reauthorization are explicit.
- S3-compatible restore always targets a new or explicitly empty root.
- Metadata and permission matrices match released behavior.
- No browser or S3 adapter enters the native source-of-truth decision.

## Related decisions

- [ADR 0001](0001-rust-native-engine-and-portable-wasm-kernel.md)
- [ADR 0002](0002-compatibility-first-strangler-migration.md)
- [Support tiers](../releases/support-tiers.md)
- [Rust engine project plan](../RUST_ENGINE_PROJECT_PLAN.md)
