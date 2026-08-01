# ADR 0006: Shard records by the trailing creation characters

- Status: **accepted**
- Date: **2026-07-28**
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

Shard on the **last two characters of the identifier's creation segment**.

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

`FYLO_SHARD_WIDTH` chooses the width for collections that do not exist yet,
defaulting to 2 and capped at 4 — 36^4 is already 1.7 million directories, past
which enumeration costs more than the fan-out saves. A width of 0 is a flat
collection, allowed explicitly but never the default, because that is the
failure mode this ADR exists to remove.

The variable is deliberately not consulted for a collection that already
exists. An environment variable is per process while the layout is a property
of the root, so letting it decide would allow two processes to disagree and
relocate every record back and forth indefinitely. A write into a collection
whose recorded width differs from the configured one fails closed with
`ESHARDWIDTH` and names the command that fixes it; reads are unaffected.
Relocating every record is bounded only by collection size, so it never happens
implicitly inside a write.

## Consequences

The layout yields 1296 uniformly used buckets. Write locality is lost:
consecutive writes scatter instead of landing together. FYLO tolerates this
because queries are answered from the prefix index rather than by walking
directories, and full scans are index rebuilds that are linear regardless. The
cost lands on snapshot and replication tooling, whose copied objects now spread
across shards rather than concentrating in the newest directory.

This is a storage-format change. For the published compatibility window a
point lookup tries the canonical shard and then the superseded one, so a root
written before this change stays readable and a partly migrated root — the
state a crash during migration leaves — is readable throughout. Enumeration is
unaffected either way, because it walks whichever shard directories exist.

Writers always use the shard recorded for the collection. `reshard` moves an
existing collection to a new width: it records the destination and the width
being left _before_ moving a single record, so an interrupted run leaves every
record findable under one candidate or the other, and re-running finishes what
remains. It is therefore both idempotent and resumable. Because documents are
the source of truth and indexes are derived, it renames files and rebuilds the
index without rewriting a record's contents, and it removes the shard
directories it empties. Resharding is the one write the width guard lets
through, since it is the operation that resolves the mismatch.

Rollback to a release predating this ADR is safe for any root whose records
still sit in the superseded layout. A root that has moved needs `reshard` run
back to the width the older release expects.
