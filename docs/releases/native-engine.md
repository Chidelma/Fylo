# Native Rust engine

FYLO has one native implementation: the Rust workspace under `crates/`. The
`fylo` executable owns filesystem access, transactions, recovery, queries,
permissions, encryption, version control, and the bounded machine protocol.

JavaScript remains only where the platform requires it:

- `clients/node/fylo.mjs` and the other language shims drive the executable;
- `src/browser/` hosts FSA, OPFS, workers, and the Rust/Wasm portable kernel;
- `explorer/` and `website/` are web applications.

No JavaScript module opens a native FYLO root directly. `src/index.js` is a
thin re-export of the Node machine-protocol client.

## CI contract

`.github/workflows/ci.yml` is the required pre-merge workflow. It runs:

- formatting, Clippy, cross-target Clippy, workspace tests, Miri, and
  dependency policy;
- the versioned protocol, error, query, predicate, SQL, and format contracts;
- native storage tests and the full failpoint crash matrix on Linux, macOS,
  Windows Server 2022, and Windows Server 2025;
- exact-binary root ownership and model-checked soak smoke tests;
- Chromium, Firefox, and WebKit Wasm/OPFS qualification;
- compiled-binary, installer, Explorer, website, and published-client interop.

Every external action is pinned to a full commit. Native candidates include an
embedded source commit, checksum, build identity, and retained evidence.

## Compatibility

The immutable v26.30.06 executable remains a downloaded compatibility oracle;
its source implementation is not retained in the repository. Release CI runs
all 36 canonical machine operations against that binary and the new Rust
artifact, then performs the upgrade/rollback drill. This preserves stored-data
and protocol compatibility without shipping two engines.

## Long-running qualification

`bun run rust:soak:smoke` runs a model-checked native workload. The release
profile refuses durations below 72 hours, requires at least 100,000 machine
operations, enforces memory and disk-growth ceilings, restarts the engine, and
writes atomic evidence under `target/soak/`.

## Browser boundary

The browser host is intentionally not replaced by a native filesystem binary.
FSA supplies selected documents/files, OPFS supplies private indexes/cache/WAL,
and the Wasm kernel owns portable deterministic work. JavaScript fallback code
inside the browser bundle is a browser capability fallback, not a second native
FYLO engine.
