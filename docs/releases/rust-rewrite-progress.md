# Rust Rewrite Progress

- Branch: `codex/rust-rewrite`
- Evidence date: 2026-07-26
- Rule: implementation state and promotion evidence are tracked separately

This ledger summarizes the accepted gates in `docs/RUST_ENGINE_PROJECT_PLAN.md`.
A local pass does not promote a platform or release tier.

| Phase                       | Implementation state          | Evidence completed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Promotion blockers                                                                                                                                                                                                                                                    |
| --------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0 — Foundation              | Implemented                   | Workspace, pinned toolchain, lints, deny policy, ADRs, governance, ownership, Rust CI definition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Clean-checkout CI must pass on Linux, macOS, and Windows                                                                                                                                                                                                              |
| 1 — Compatibility oracle    | Implemented; evidence pending | Versioned machine/storage/error schemas; document, raw-file, metadata, permission, encryption, tombstone, commit-history, index, predicate, SQL, and machine fixture generator/verifiers; checksum-pinned v26.30.06 released-binary recorder; restorable native metadata sidecar; encrypted and wrong-key probes; interrupted-transaction, corrupt-document, and corrupt-version cases with explicit error mapping; current/Rust verifiers; retained Linux/macOS/Windows CI generation configured                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Native CI execution and retained Linux/macOS/Windows oracle artifacts for the exact commit                                                                                                                                                                            |
| 2 — Portable kernel         | Implemented; evidence pending | Bounded format readers; TTID/metadata; canonical byte round trips; index snapshot/WAL scans; structured predicates; SQL AST/planner; JavaScript differential rows/order/limit/zero-limit checks; versioned malformed-format and stable-error corpus; two seeded fuzz targets; scheduled retained fuzz workflow; Miri                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Retained scheduled fuzz artifact and native CI execution for the exact commit                                                                                                                                                                                         |
| 3 — Browser Wasm            | Implemented; evidence pending | ABI v1 behind the dedicated/shared worker contract; compiled snapshot scan; incremental WAL overlay; exact/prefix/range/reverse/intersection parity; compaction/restart; real OPFS corpus; separate I/O/load/scan metrics; stable fetch/compile/instantiate/ABI/snapshot/query/memory fallback reasons; memory-pressure regression; CSP/MIME guidance; payload/init budgets; 500-key portable-kernel benchmark with 1.2x Chromium threshold; configured Chromium/Firefox/WebKit retained CI matrix and explicit unusable-OPFS evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Retained Chromium and Firefox execution, accepted Chromium benchmark evidence, and a WebKit pass on a runner where its OPFS root is usable                                                                                                                            |
| 4 — Native read-only        | Implemented; evidence pending | Canonical root, link/reparse rejection, exact component spelling, native opened-handle identity checks with path-replacement regression coverage, Unicode-root/case-alias/Unix-permission tests, bounded live/tombstone document and raw-file reads, canonical/custom metadata, Unix xattrs and UID/GID/mode, Windows ADS parser, schema-driven AES-256-GCM/PBKDF2 field decryption and blind-index derivation with fail-closed errors, bounded first-parent log plus cycle-rejecting full reachable commit-DAG/content-addressed tree/blob verification, generation stability, exact document-derived index+WAL rebuild equivalence, predicates, SQL SELECT, inspect/get/get-file/get-deleted/find/scan/verify-index/log/verify-history CLI, Unicode/long-root no-mutation differential test, controlled same-root current-vs-Rust benchmark with retained native-platform CI reports, 512 MiB RSS and 10x p95 regression gates, cross-platform RSS collection                                       | Retained Linux/macOS/Windows filesystem, handle-identity, interoperability, and benchmark evidence for the exact commit                                                                                                                                               |
| 5 — Native writes           | Partial                       | JavaScript-compatible transaction/generation journal; cross-runtime collection lock identity; bounded before-images; active rollback/committed roll-forward recovery; create-only document and raw-file put; durable raw-file key/custom metadata/checksum plus exact manifest-derived indexes; full-body patch; retained delete; exact index rebuild; POSIX UID/GID/mode projection; trusted group authorization; experimental write CLI; JavaScript recovery of Rust failpoint crashes before mutation, after delete move, and after commit marker; shallow merge patch; bounded SQL `INSERT`/`UPDATE`/`DELETE` committing many records under one transaction manifest; developer-metadata merge/removal with a strictly advancing update stamp on documents and raw files; UID/GID/mode projection onto existing records; schema-declared field encryption with head `_v` stamping and a fail-closed refusal of schemas it cannot validate; content-addressed auto-commit with an O(1) dirty check | Authoritative metadata replace; Windows ADS before-images; non-default branch worktrees; disk-full and quota cases; version history; complete durability/failpoint matrix; disk/quota/permission/corruption/process-kill cases; Windows semantics; cloned-root replay |
| 6 — S3 backup/restore       | Not started                   | Existing JavaScript behavior remains the oracle                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Manifest reader, streaming backup, verify, restore-to-empty-root, MinIO/provider qualification, hostile endpoint tests                                                                                                                                                |
| 7 — Machine/CLI replacement | Partial                       | Read-only preview CLI and version identity; `fylo-machine` bounded NDJSON framing with LF delimiting, request/response limits, nested duplicate-key rejection, malformed-frame resume, truncated-frame termination, oversized-frame recovery; twenty-eight of the thirty-eight registered operations in published result shapes, covering handshake identity, document/metadata/index/tombstone reads, SQL select and mutation, journalled single and bulk writes, restore, and commit; snapshot query pagination with TTID-ascending order, published limits, frame-budget trimming, and `EINVALIDCURSOR` on restart; a kernel-held root lease over `std::fs::File::try_lock`, excluding a live JavaScript owner and being excluded by one, with `EROOTLEASELOST` on a replaced sentinel; non-mutating repository status reporting working-tree cleanliness; `EUNSUPPORTEDOP` for every other registered operation; registry and error-registry conformance harness                                  | The remaining ten operations, `schemaMaterialize` upgraders, session root leases, cancellation/signals/pressure, all language clients against exact compiled binaries                                                                                                 |
| 8 — Shadow qualification    | Not started                   | None                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Read shadow, cloned-root replay, controlled benchmarks, upgrade/restore/rollback, security review, 72-hour soak, candidate artifacts                                                                                                                                  |
| 9 — Rust default/retirement | Blocked by phases 5–8         | None                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Two evidenced Rust release lines, client independence, second-operator drills, migration/deprecation completion                                                                                                                                                       |

## Latest local evidence

The following passed on macOS arm64:

- contract, query, predicate, and SQL JavaScript-oracle verifiers;
- `cargo fmt`, workspace Clippy, unit/integration/doc tests, and `cargo-deny`;
- compiled Wasm ABI/integration/fallback tests;
- Rust read-only interoperability against a JavaScript-created root with a
  before/after no-mutation snapshot, including live/deleted documents and raw
  files, durable keys, typed custom metadata, checksums, and native access
  metadata;
- JavaScript-written encrypted fields decode with the correct key and fail
  closed without a schema/key or with a wrong key, without returning
  ciphertext in diagnostics;
- Windows-target compilation of the read-only storage, engine, and CLI crates;
- a checksum-pinned macOS arm64 v26.30.06 release binary produced a retained
  oracle root that the current engine and Rust reader both verified; the
  fixture exposed and now covers UID/GID/mode query filtering and direct-read
  denial, encrypted reads/wrong-key failure, interrupted transactions,
  document corruption, version corruption, and metadata-sidecar restoration;
- a locally reproducible same-root latency harness with before/after
  no-mutation verification, explicit p95/RSS gates, and cross-platform RSS
  collection; CI is configured to retain Linux, macOS, and Windows reports for
  the exact commit;
- Miri for `fylo-format` and `fylo-query`.
- portable format/query malformed inputs, stable error codes, result ordering,
  timestamp-before-limit pagination, and historical zero-limit behavior;
- both portable fuzz targets compile under the pinned nightly toolchain; CI is
  configured to retain seeded corpus identity and findings for 90 days.
- real-OPFS/Wasm qualification passed in Chromium and Firefox, including
  compaction/restart and stable fallback reasons; the Chromium portable-kernel
  median was 4.57x its JavaScript equivalent;
- Playwright WebKit exposed `navigator.storage.getDirectory` but rejected the
  root operation, which is retained as `EOPFS_UNAVAILABLE` rather than counted
  as a browser pass.
- Rust document put/patch/delete writes round-trip through the current
  JavaScript engine, and JavaScript recovers Rust journals in both rollback and
  committed roll-forward directions after process-abort failpoints.
- Rust raw-file puts preserve bytes, durable keys, typed custom metadata,
  checksums, and derived indexes when read and queried by the current
  JavaScript engine.
- Rust shallow merge patch and Rust SQL `INSERT`/`UPDATE`/`DELETE` round-trip
  through the current JavaScript engine, including index queries over the
  inserted record and tombstone retention for the deleted record.
- Rust `set-metadata` merges, removes, and preserves untouched developer
  metadata on a raw file that the current JavaScript engine then reads through
  its canonical metadata API.
- Rust writes `v2.` AES-256-GCM envelopes that the current JavaScript engine
  decrypts to the original typed values, stamps the head schema version, fails
  closed on a short key without leaking plaintext, and refuses a collection
  whose schema declares constraints it cannot validate.
- the Rust machine server answers the canonical v1 registry with the published
  framing policy, resumes after malformed and duplicate-key frames, terminates
  on a truncated frame, and emits only codes registered in `api/errors/v1.json`;
  its writes round-trip through the current JavaScript engine, a live
  JavaScript root lease makes it refuse to serve, and a live session pages a
  snapshot TTID-ascending without repeats or losses; a live native session makes
  the JavaScript `acquireRootLease` fail with `EROOTLOCKED` and releases it
  cleanly on exit, and Rust and JavaScript agree on working-tree cleanliness.
- schema inspection, history, doctor, and validation run through the same CHEX
  binary the JavaScript engine drives; a document CHEX rejects fails closed with
  `ESCHEMA` without leaking its contents, and validation plus the `_v` stamp
  activate only under a non-empty `FYLO_STRICT`, matching `validateAgainstHead`.
- every one of the fourteen declared durable transitions was interrupted by an
  aborted writer across eleven mutation scenarios — 82 interrupted mutations —
  and each root recovered, recovered idempotently, and read back with an index
  matching its documents.
- Rust auto-commits reproduce the JavaScript content-addressed tree: the
  JavaScript repository reports a clean status and an empty commit-to-worktree
  diff, the commit records its parent, the Rust verifier re-hashes every commit,
  tree, and blob, and repeating the commit is a no-op.

The repository-wide TypeScript check did not complete within a five-minute
local window because the process remained asleep on the synchronized Dropbox
filesystem. No TypeScript error was emitted; this is an environmental
non-result and must be rerun on ordinary CI storage.

## Open format work

ADR 0006 changed record sharding from the leading to the trailing characters of
an identifier's creation segment. Measured: 4000 consecutive TTIDs produced one
leading-pair bucket and 646 trailing-pair buckets. Both engines write the
canonical shard and read either, so an existing root stays readable and
converges as records are rewritten. The width is configurable per collection through
`FYLO_SHARD_WIDTH` for newly created collections, recorded in the catalog
descriptor and read from there by both engines; a write whose configured width
disagrees with the record fails closed with `ESHARDWIDTH`. `reshard` moves an existing collection to a new
width, idempotently and resumably, and the regression corpus covers an
interrupted run remaining readable and finishing on a second pass. The native
engine has no `reshard` of its own, so the operation is currently a JavaScript
one.

## Promotion discipline

Later phases may accumulate additive contracts and harnesses, but the native
writer does not begin promotion until the read-only matrix is complete. No
entry in this ledger changes the support vocabulary in
`docs/releases/support-tiers.md` without retained evidence for the exact
commit and artifact.
