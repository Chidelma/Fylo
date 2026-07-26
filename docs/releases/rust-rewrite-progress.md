# Rust Rewrite Progress

- Branch: `codex/rust-rewrite`
- Evidence date: 2026-07-26
- Rule: implementation state and promotion evidence are tracked separately

This ledger summarizes the accepted gates in `docs/RUST_ENGINE_PROJECT_PLAN.md`.
A local pass does not promote a platform or release tier.

| Phase                       | Implementation state                   | Evidence completed                                                                                                                                                             | Promotion blockers                                                                                                                           |
| --------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 0 — Foundation              | Implemented                            | Workspace, pinned toolchain, lints, deny policy, ADRs, governance, ownership, Rust CI definition                                                                               | Clean-checkout CI must pass on Linux, macOS, and Windows                                                                                     |
| 1 — Compatibility oracle    | Partial                                | Versioned machine/storage/error schemas; document, index, predicate, SQL, and machine fixtures; JavaScript verifiers                                                           | Released-binary recorder; complete roots for files, permissions, encryption, versions, tombstones, and interrupted transactions              |
| 2 — Portable kernel         | Implemented for current fixture corpus | Bounded format readers; TTID/metadata; index snapshot/WAL scans; structured predicates; SQL AST/planner; JS differential checks; fuzz target; Miri                             | Expand historical/malformed corpus, pagination/error cases, and retained fuzz evidence                                                       |
| 3 — Browser Wasm            | Partial                                | ABI v1, compiled Wasm scan path, warm snapshot/WAL reuse, compaction/restart, JS fallback reason, self-hosting guidance                                                        | Real OPFS I/O split, Chromium/Firefox/WebKit matrix, memory-pressure/cancellation proof, payload/init budgets, accepted end-to-end benchmark |
| 4 — Native read-only        | Partial                                | Canonical root, link rejection, bounded document reads, generation stability, index+WAL scan, predicates, SQL SELECT, inspect/get/find/scan CLI, no-mutation differential test | Raw files, xattrs/ADS, permissions, encryption, deleted/versioned data, rebuild verification, full path/platform matrix, benchmark           |
| 5 — Native writes           | Not started                            | SQL mutation plans parse but cannot execute                                                                                                                                    | Every transaction, failpoint, crash, recovery, permission, encryption, ownership, and cloned-root differential gate                          |
| 6 — S3 backup/restore       | Not started                            | Existing JavaScript behavior remains the oracle                                                                                                                                | Manifest reader, streaming backup, verify, restore-to-empty-root, MinIO/provider qualification, hostile endpoint tests                       |
| 7 — Machine/CLI replacement | Partial                                | Read-only preview CLI and version identity                                                                                                                                     | Bounded NDJSON server, full operation/error corpus, cancellation/signals/pressure, all language clients against exact compiled binaries      |
| 8 — Shadow qualification    | Not started                            | None                                                                                                                                                                           | Read shadow, cloned-root replay, controlled benchmarks, upgrade/restore/rollback, security review, 72-hour soak, candidate artifacts         |
| 9 — Rust default/retirement | Blocked by phases 5–8                  | None                                                                                                                                                                           | Two evidenced Rust release lines, client independence, second-operator drills, migration/deprecation completion                              |

## Latest local evidence

The following passed on macOS arm64:

- contract, query, predicate, and SQL JavaScript-oracle verifiers;
- `cargo fmt`, workspace Clippy, unit/integration/doc tests, and `cargo-deny`;
- compiled Wasm ABI/integration/fallback tests;
- Rust read-only interoperability against a JavaScript-created root with a
  before/after no-mutation snapshot;
- Miri for `fylo-format` and `fylo-query`.

The repository-wide TypeScript check did not complete within a five-minute
local window because the process remained asleep on the synchronized Dropbox
filesystem. No TypeScript error was emitted; this is an environmental
non-result and must be rerun on ordinary CI storage.

## Promotion discipline

Later phases may accumulate additive contracts and harnesses, but the native
writer does not begin promotion until the read-only matrix is complete. No
entry in this ledger changes the support vocabulary in
`docs/releases/support-tiers.md` without retained evidence for the exact
commit and artifact.
