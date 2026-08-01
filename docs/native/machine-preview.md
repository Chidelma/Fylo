# Rust Native Machine Protocol Preview

The experimental `fylo-machine-preview` binary serves the canonical
`api/machine/v1` NDJSON contract from `fylo-machine` over the native Rust
engine. It does not replace the production JavaScript machine server.

## Framing

`fylo-machine` owns framing, limits, and stable error mapping:

- one UTF-8 JSON request and one UTF-8 JSON response per LF-delimited frame;
- default 1 MiB request and 8 MiB response frames, clamped to 64 MiB;
- the delimiter does not count toward the limit;
- duplicate JSON object keys are rejected at any depth, because two clients
  disagreeing on which value wins is the divergence the protocol exists to
  prevent;
- a malformed complete frame reports an error and the session resumes at the
  next LF;
- a truncated final frame reports an error and terminates the session;
- an oversized request frame is reported and its remainder is discarded up to
  the next LF, so the session survives it.

## Implemented operations

Reads: `handshake`, `getDoc`, `getLatest`, `getMeta`, `findDocs`,
`findDeletedDocs`, `inspectCollection`, `verifyCollection`, `log`, `branch`,
`status`, `backupStatus`, `schemaInspect`, `schemaCurrent`, `schemaHistory`,
`schemaDoctor`, `schemaValidate`, `joinDocs`, and `executeSQL` for `SELECT`.

Writes: `putData`, `batchPutData`, `patchDoc`, `patchDocs`, `delDoc`,
`delDocs`, `restoreDoc`, `setMeta`, `createCollection`, `dropCollection`,
`rebuildCollection`, `commit`, and
`executeSQL` for `INSERT`/`UPDATE`/`DELETE`. Every write runs through the same
native transaction journal the write preview uses, so a crash recovers
identically. `batchPutData`, `patchDocs`, and `delDocs` are loops over that
per-record path, not one atomic transaction — the registry already classifies
them as retry-unsafe for that reason. `patchDocs` and `delDocs` resolve their
target rows before writing any of them, so the selection cannot drift mid-batch.

`createCollection` writes the descriptor before the directories it describes.
A collection exists when its directory does, so an interrupted create leaves a
descriptor naming nothing — which reads as no such collection — rather than a
directory whose namespace and shard width nobody recorded, and re-running
finishes it. Re-creating never rewrites an index that exists, or a populated
collection would come back with an empty snapshot. The width comes from
`FYLO_SHARD_WIDTH`, read by both engines, and only for a collection that does
not exist yet: a native create that ignored it would produce a collection the
JavaScript engine fails closed on. `dropCollection` recovers the collection
before removing it, so it cannot discard a journal that still owes an
interrupted write.

WORM is a per-process option rather than a property of the root, so no native
write consults it — the same as a second JavaScript process opened without it.
A root that must enforce WORM cannot be handed to this preview.

Results use the published field names, not the Rust structures' names.
`backupStatus` always reports `disabled`, because S3 backup remains a
JavaScript capability.

Every other name in `api/machine/v1/operations.json` returns
`EUNSUPPORTEDOP`, and a name outside the registry returns `EBADREQUEST`, so a
client's capability probe stays meaningful as the surface grows. `handshake`
advertises the implemented set under `capabilities.operations`.

## Pagination

`findDocs` and `findDeletedDocs` accept `page: { limit, cursor }`. The first
page snapshots the whole result set under an opaque token, so a client paging
through a mutating collection sees a consistent set rather than a shifting
window. Rows are ordered TTID-ascending, the default page is 256 items, the
maximum is 4096, and a cursor lives 15 minutes. Cursors are process-scoped: a
restarted server answers `EINVALIDCURSOR` and the client restarts from the
first page. A page stops early rather than overflowing the response frame, and
a single row that cannot fit is reported as `EQUERYITEMTOOLARGE`.

## Root ownership

The session takes a real kernel-held lease on the first request that names a
root and holds it until the session ends. `std::fs::File::try_lock` is `flock`
on Unix and `LockFileEx` on Windows in safe Rust, which is the same primitive
the JavaScript lease uses, so the two engines contend for one lock and no
platform `unsafe` boundary is needed.

Exclusion therefore works in both directions: a native session refuses a root a
live JavaScript owner holds, and `acquireRootLease` refuses a root a live
native session holds — both with `EROOTLOCKED`. The kernel releases the lock on
close, crash, or `SIGKILL`, so a dead owner never blocks a successor. The
recorded owner generation is re-checked per frame and reports
`EROOTLEASELOST` if a successor replaced the sentinel.

## Schema validation

FYLO consumes CHEX as a compiled binary driven over NDJSON, not as a library,
so the native engine drives that same process instead of embedding a second
JSON Schema implementation that would validate the same documents differently.
One warm `chex exec --loop` subprocess is spawned lazily per engine and
respawned if it dies; `FYLO_CHEX_BINARY` overrides the executable.

Validation and the `_v` stamp are strict-mode behaviour in both engines: the
JavaScript writer calls `validateAgainstHead` only when `FYLO_STRICT` is set,
so the native writer does the same. An empty `FYLO_STRICT`, `FYLO_SCHEMA`,
`FYLO_ENCRYPTION_KEY`, or `FYLO_CIPHER_SALT` counts as unset, because those
names are falsy-but-present in a typical repository `.env`.

`schemaMaterialize` stays unimplemented: upgrading a document across schema
versions runs the collection's JavaScript upgrader modules, which the native
engine cannot execute.

## Qualification

`bun run rust:interop:machine` seeds a root with JavaScript, then drives the
Rust server through the canonical registry: handshake identity, result shapes,
malformed-frame resume, duplicate-key rejection, truncated-frame termination,
`EUNSUPPORTEDOP` for every unimplemented registered operation, and a check that
no emitted code is missing from `api/errors/v1.json`.

The collection lifecycle is qualified by handing the result back: the gate
creates a collection natively, writes into it, re-creates it, and then has the
JavaScript engine query the collection and read the document written after the
re-create. A collection JavaScript cannot read is a collection this preview did
not create. It also asserts that a contradicting kind is refused, that dropping
twice reports `ENATIVE_NOT_FOUND`, and that `FYLO_SHARD_WIDTH` reaches the
descriptor — with a width past the published maximum refused.

`findDocs` is qualified differentially too, because it narrows through the
prefix index and a wrong candidate set loses rows silently instead of erroring.
Ten query shapes run through both engines on one root: shapes the index answers
(single field, two fields intersecting, two operations unioning, a nested path),
shapes it cannot answer and must fall back on (`$gt`, `$like`, an empty query),
and the values most likely to be planned wrongly — a string `"7"` against a
numeric `7`, an explicit `null`, and an array field, where the index offers a
candidate that `$eq` must then reject.

`joinDocs` is qualified differentially, because a join is answered from
documents rather than from the index: eight joins run through both engines on
one root and the results must agree — any-comparison matching, each mode,
`$select` then `$rename`, `$groupby`, and `$onlyIds`. Every case must match
something, since two empty results also compare equal. The comparison sorts
keys: row order follows each engine's document enumeration — Rust walks
TTID-ascending, JavaScript walks the directory — and that order is not part of
the contract. For `$limit` only the row count is compared, because which rows a
truncation keeps follows from that same order.

## Limitations

Cancellation, timeouts, signal handling, and stderr back-pressure are open
Phase 7 gates, as are the seven operations this preview still answers with
`EUNSUPPORTEDOP`: bulk import, repository checkout/diff/restore/merge,
`schemaMaterialize`, and S3 backup reconciliation. Until the client corpus runs against exact compiled binaries,
this is not a substitute for the JavaScript server in a client's binary
selection.
