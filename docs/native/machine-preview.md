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
`schemaDoctor`, `schemaValidate`, and `executeSQL` for `SELECT`.

Writes: `putData`, `batchPutData`, `patchDoc`, `patchDocs`, `delDoc`,
`delDocs`, `restoreDoc`, `setMeta`, `rebuildCollection`, `commit`, and
`executeSQL` for `INSERT`/`UPDATE`/`DELETE`. Every write runs through the same
native transaction journal the write preview uses, so a crash recovers
identically. `batchPutData`, `patchDocs`, and `delDocs` are loops over that
per-record path, not one atomic transaction — the registry already classifies
them as retry-unsafe for that reason. `patchDocs` and `delDocs` resolve their
target rows before writing any of them, so the selection cannot drift mid-batch.

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

Opening a root whose JavaScript lease sidecar names a live process fails with
`EROOTLOCKED`, and the check is memoised per session. This is fail-closed
_detection_, not a kernel-held lease: it stops a native process from opening a
root a live JavaScript owner holds, but two native processes are still
serialized only by the per-collection lock. Holding the kernel lease itself
needs `flock`/`LockFileEx`, which is an ADR-gated `unsafe` boundary.

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

## Limitations

Cancellation, timeouts, signal handling, and stderr back-pressure are open
Phase 7 gates, as are the ten operations this preview still answers with
`EUNSUPPORTEDOP`: collection creation and drop, joins, bulk import, repository
checkout/diff/restore/merge, `schemaMaterialize`, and S3 backup
reconciliation. `status` reports branch and head identity only; a clean/dirty
answer needs the working-tree diff. Until the kernel lease and the client
corpus land, this is not a substitute for the JavaScript server in a client's
binary selection.
