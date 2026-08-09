# ADR 0006: Shard records by the trailing creation characters

- Status: **accepted**
- Date: **2026-07-28**
- Amended: **2026-08-09** — default width 1, width 0 removed, `reshard` exposed
  on the CLI and machine protocol, the `ESHARDWIDTH` guard implemented, and the
  enumeration-ordering consequence recorded
- Supersedes: the leading-character shard layout used since the first release

## Context

Documents and raw files are stored under a two-character shard directory
derived from their TTID. That shard was the identifier's first two characters.

A TTID is base36 of 100 ns ticks. Its characters therefore roll over at wildly
different rates:

| Character | Rolls over every |
| --------- | ---------------: |
| 1         |       11.6 years |
| 2         |         117 days |
| 10        |           3.6 µs |
| 11        |           100 ns |

The first two characters are effectively constant, so every record written in a
roughly four-month window shared one directory. Generating 4000 consecutive
TTIDs produces exactly **one** distinct leading pair and **646** distinct
trailing pairs, with 1 to 16 records per trailing bucket.

The layout therefore carried the whole cost of sharding — an extra path
component, a directory level to traverse, a shard to compute — while providing
none of its benefit. Every filesystem limit sharding exists to avoid was still
directly ahead, and would arrive as a single unbounded directory.

## Decision

Shard on the **trailing characters of the identifier's creation segment**. How
many is the collection's shard width, configurable and recorded per collection;
this ADR originally fixed it at two.

The shard must be taken from the creation segment rather than the raw string.
An identifier may carry `created-updated-deleted` lifecycle segments, so
sharding the whole string would move a record between directories when it is
updated or deleted, silently orphaning it.

Content-addressed version objects keep their leading-character shard. A
SHA-256 hex digest is already uniform, so the leading characters are the
correct choice there and nothing about them changes.

## Configurable width

The right number of buckets depends on collection size, so the width is
configurable. A collection records its width in its catalog descriptor, and
that descriptor is the authority: readers derive the shard from it and never
guess.

The width for collections that do not exist yet comes from `RootConfig`,
which the CLI fills from `--shard-width` or `FYLO_SHARD_WIDTH`. It defaults to
**1** and is capped at 4 — 36^4 is already 1.7 million directories, past which
enumeration costs more than the fan-out saves. It is validated where the
collection is created, not only where the CLI parses it, because a host that
builds `RootConfig` directly would otherwise write an out-of-range width into
the descriptor and make it that collection's permanent layout.

The default was 2 until measurement showed it was too wide for the common case.
Sharding exists to stop one directory growing unbounded; it never speeds a
lookup up, because the prefix index yields identifiers and the path is computed
from them rather than searched. Enumeration, meanwhile, costs one `read_dir`
per shard. On 400 documents, width 2 produced 303 directories holding 1.3
records each and took 2.3x as long to walk as width 1's 18 directories. One
character is 36 buckets, which keeps a directory bounded well past the point
most collections reach; anything larger sets its own width and `reshard` moves
it without changing identity.

A descriptor that pins no width falls back to whatever the default is, so
changing it moves those collections. The previous default stays a read
candidate for exactly that reason, alongside the layout this ADR superseded.

A width of 0 was once allowed as a flat collection with no shard directory.
Nothing could read one back: enumeration walks `docs/` expecting each entry to
be a shard directory and refuses a file, so a flat collection accepted writes
and then failed every read, `rebuildCollection` included. It is refused at the
boundary rather than repaired, because a single unbounded directory is the
failure this ADR exists to remove. The supported range is 1 to 4.

The configured width is deliberately not consulted for a collection that
already exists. Configuration is per process while the layout is a property of
the root, so letting it decide would allow two processes to disagree and
relocate every record back and forth indefinitely.

A record write into a collection whose recorded width differs from the
configured one therefore fails closed with `ESHARDWIDTH`, naming the
`fylo reshard <collection> --width <n>` that resolves it. Relocating every
record is bounded only by collection size, so it never happens implicitly
inside a write.

The guard covers record mutations only. Reads are unaffected, and so are
recovery, `rebuildCollection`, and `reshardCollection`: the first two are how a
root is repaired, and the third is the operation that resolves the mismatch.

## Consequences

The layout yields uniformly used buckets — 36 at the default width, 1296 at
width 2. Write locality is lost: consecutive writes scatter instead of landing
together. FYLO tolerates this
because queries are answered from the prefix index rather than by walking
directories, and full scans are index rebuilds that are linear regardless. The
cost lands on snapshot and replication tooling, whose copied objects now spread
across shards rather than concentrating in the newest directory.

This is a storage-format change. For the published compatibility window a
point lookup tries the canonical shard, then the previous default width, then
the superseded leading-character layout, so a root written before this change
stays readable and a partly migrated root — the state a crash during migration
leaves — is readable throughout.

Enumeration walks whichever shard directories exist, but **its order changed
and that was missed**. Directory order is (shard, identifier); while the shard
was the identifier's leading characters the two orders coincided, so nothing
sorted explicitly. Making the shard a *suffix* broke that, and every query
returned records in shard order while the handshake continued to advertise
`ttid-binary-ascending` — which query cursors depend on. Enumeration now sorts
by identifier before returning. Any layout change that alters the relationship
between a record's path and its identifier has to answer this question.

Writers always use the shard recorded for the collection. `reshardCollection`
— a machine operation and the `fylo reshard` CLI command — moves an existing
collection to a new width: it records the destination and the width
being left _before_ moving a single record, so an interrupted run leaves every
record findable under one candidate or the other, and re-running finishes what
remains. It is therefore both idempotent and resumable. Because documents are
the source of truth and indexes are derived, it renames files and rebuilds the
index without rewriting a record's contents. It moves documents, tombstones,
and raw files alike, and removes the shard directories it empties — a widening
would otherwise leave behind as many empty directories as it created, and
enumeration costs one directory read per shard, so the collection would stay
slow to walk forever afterwards. Resharding is the one write the width guard
lets through, since it is the operation that resolves the mismatch.

Rollback to a release predating this ADR is safe for any root whose records
still sit in the superseded layout.

A root that has been **written to** by a release carrying this ADR is not. The
superseded layout is a different shard *position*, not a different width, so
`reshard` cannot produce it — every width it can target is a trailing-character
shard. An older release finding no record under the leading-character shard
reports an empty collection rather than an error, because the check that fails
this closed (`document identifier does not match its shard`) arrived with this
ADR and cannot be backported into a published binary. Downgrading therefore
presents as a healthy, empty database, which is worse than a refusal.

Relocating the records back is the downgrade path, and it is a rename per
record with no format change: see
[downgrading a root below v26.31.06](../operations/shard-layout-downgrade.md).
