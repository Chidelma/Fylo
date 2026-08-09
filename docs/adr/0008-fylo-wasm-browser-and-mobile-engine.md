# ADR 0008: `fylo-wasm`, a portable engine artifact

- Status: **Accepted**
- Date: **2026-08-03**
- Owners: **FYLO maintainers**
- Supersedes: the browser-product section of [ADR 0003](0003-native-and-browser-storage-boundaries.md)
- Amends: [ADR 0005](0005-narrow-wasm-linear-memory-boundary.md)

## Context

FYLO currently ships two engines. The Rust engine owns native storage,
recovery, indexing, querying, schema, permissions, encryption, and version
control in 9,972 lines of `fylo-storage-native` plus 3,022 of `fylo-engine`.
The browser runs a separate JavaScript engine of 5,833 lines that reimplements
the same semantics against OPFS and File System Access.

Three fixture scripts exist only to keep the two from drifting —
`verify-rust-query-fixture.mjs`, `verify-rust-predicate-fixture.mjs`, and
`verify-rust-sql-fixture.mjs` each compare Rust against "the JavaScript
oracle". Parity is asserted, not structural.

The duplication is not holding. The browser engine has no version control at
all, and only minimal schema and encryption support. Every feature is built
twice or is native-only, and a storage-format decision like
[ADR 0006](0006-shard-records-by-the-trailing-creation-characters.md) has to be
implemented twice to stay coherent.

ADR 0003 assigned all browser storage to the TypeScript host and confined
Rust/Wasm to bounded compute. That was the right call when the portable surface
was the query kernel. It stopped being the right call when the browser became a
first-class target for the whole product, including mobile embeddings.

SQLite is the reference case. `sqlite-wasm` did not port cleanly because it was
C; it ported cleanly because SQLite has always routed every byte through one
`sqlite3_vfs` interface, so a browser build meant writing one new VFS rather
than touching the engine. FYLO has no such layer: `fylo-storage-native` calls
`std::fs` in roughly 300 places.

## Decision

Build `fylo-wasm`: the FYLO engine compiled to WebAssembly, owning storage.

WebAssembly is not a browser technology. `wasm32-wasip1` has real files and
real stdio, so the same engine runs under any WASI runtime — server, edge, or
plugin host — and speaks the identical NDJSON machine protocol over the
identical argv. There are therefore three artifacts and one contract:

| Artifact | Target | Storage | Reached by |
| --- | --- | --- | --- |
| `fylo` | native triples | `std::fs` | a spawned process |
| `fylo.wasm` | `wasm32-wasip1` | `std::fs` over WASI preopens | any WASI runtime |
| `fylo-browser.wasm` | `wasm32-unknown-unknown` | host `HostVfs` table | an embedder that fills the table |

The first two are **interchangeable**: a shim spawns one or the other, writes
NDJSON to stdin, reads NDJSON from stdout, and cannot tell which it got.
`scripts/verify-artifact-interchange.mjs` drives one script through both and
fails on any difference outside a declared list. Where a platform genuinely
cannot offer something, the handshake capability says so rather than the
behavior silently differing — that is what makes the swap safe rather than
merely quiet.

1. **Introduce a VFS seam.** One module supplies the filesystem operations the
   engine uses, mirroring the `std::fs` names and signatures already in use, so
   the engine changes its import rather than its code. A native backend
   delegates to `std::fs`. A browser backend calls host functions.
2. **The host owns the bytes, the engine owns the format.** The browser backend
   imports a small set of `extern "C"` functions the JavaScript host
   implements over OPFS synchronous access handles in a dedicated Worker.
   Handles, permission prompts, and quota remain the host's; layout,
   transactions, recovery, and indexing become the engine's.
3. **`fylo-wasm` is a peer of `fylo-cli`, not of the query kernel.** The
   existing narrow kernel in `src/browser/wasm` stays exactly as ADR 0005
   describes it and keeps serving the JavaScript engine until `fylo-wasm`
   replaces it. Two Wasm artifacts coexist during the transition.
4. **The browser is a different root, not a different format.** A browser root
   uses the same shard layout, the same canonical document encoding, and the
   same index format as a native root. Where a browser cannot supply a native
   facility, the difference is recorded in the root, not improvised per read.

### Accepted losses

These were the blockers. They are accepted rather than solved, and each is a
documented difference in the browser support tier.

| Native facility | Browser answer |
| --- | --- |
| Extended attributes (logical `key`, checksum, access, developer metadata) | A host-owned manifest reached through `read_attrs` / `write_attrs`. WASI uses a sidecar with the same JSON-and-base64 encoding; OPFS keeps one manifest per root rather than doubling its handle count. |
| `hard_link` lock creation, `ps` owner liveness | One origin owns one OPFS root. Web Locks plus exclusive access handles replace the PID-aware lock file, which is strictly simpler. |
| POSIX uid/gid/mode (13 sites) | Not offered. `machineAccess` is already absent outside macOS and Linux, so the capability set already expresses this. |
| Setting and reading mtime | Stored explicitly. Narrowing `updatedAt`, `mtime`, `lastModified`, and `deletedAt` to whole milliseconds made these plain stored integers rather than filesystem-precision floats. |
| Subprocess schema validation (`FYLO_CHEX_BINARY`) | Not offered in the browser build; schema validation there requires an in-process validator or is unavailable. |
| `fsync` | `FileSystemSyncAccessHandle.flush()`. |
| Symlink containment checks (22 sites) | No-ops. OPFS has no links, so the class of attack does not exist. |

### Unsafe policy

ADR 0005 permits unsafe Rust in exactly three functions of the query kernel.
`fylo-wasm` adds one further category: the host-import boundary, where calls
into JavaScript-provided functions and views over host-written buffers cannot
be expressed as safe Rust. That boundary lives in one module, every block
carries a `SAFETY:` justification naming its pointer, length, and lifetime
invariant, and `docs/security/unsafe-inventory.md` enumerates it. No other
crate gains unsafe; `fylo-query` and `fylo-format` remain
`unsafe_code = "forbid"`.

### Configuration

An engine that runs where there is no process environment cannot read one.
Every runtime knob is now an explicit value in `RootConfig`, and the process
environment is consulted at exactly one place — `RootConfig::from_env`, called
only by the CLI. `serve_configured` is the entry point for a host that supplies
the knobs directly.

## Consequences

One engine, one format, one set of semantics. The three JavaScript-oracle
fixture scripts stop guarding a second implementation and become format
conformance tests. Version control, schema, and encryption reach the browser
because they are no longer a second port.

The costs are real. The Wasm artifact is much larger than the current query
kernel and must carry a size budget. Debugging crosses a language boundary. The
JavaScript engine must keep working until `fylo-wasm` passes the same recovery,
crash, and soak gates the native engine does, which means maintaining both for
a period rather than fewer things at once. A browser cannot be trusted to
persist storage, so eviction remains a first-class case rather than an error.

This does not authorize replacing the JavaScript browser engine before those
gates pass, changing the native on-disk format, or adding a remote storage
backend.

## Acceptance evidence

- Complete: `fylo-wasm` builds for `wasm32-unknown-unknown` under the pinned
  toolchain.
- Complete: no crate outside the kernel and the host-import module permits
  unsafe.
- Complete: the real-OPFS corpus stores and queries through the Rust engine in
  Chromium and Firefox.
- Pending before replacing the JavaScript engine: browser recovery and soak
  pass the same failpoint matrix and duration gates as the native engine.
- Complete: the support matrix names every accepted loss above.

## Related decisions

- [ADR 0001](0001-rust-native-engine-and-portable-wasm-kernel.md)
- [ADR 0003](0003-native-and-browser-storage-boundaries.md)
- [ADR 0005](0005-narrow-wasm-linear-memory-boundary.md)
- [ADR 0006](0006-shard-records-by-the-trailing-creation-characters.md)
