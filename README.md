<p align="center">
  <strong style="font-size: 2em;">FYLO</strong><br/>
  <em>A single-binary document store with zero-payload prefix indexes and language shims for Python, Ruby, Node, Go, Rust, C#, Java, PHP, and Dart, plus local-first browser, mobile (iOS/Android), and Flutter clients.</em>
</p>

<p align="center">
  <a href="https://github.com/d31ma/Fylo/releases/latest"><img src="https://img.shields.io/github/v/release/d31ma/Fylo?label=latest&color=blue" alt="Latest Release"></a>
  <a href="https://github.com/d31ma/Fylo/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/d31ma/Fylo/ci.yml?branch=main&label=CI" alt="CI Status"></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/license-MIT-green" alt="License: MIT"></a>
  <a href="https://github.com/d31ma/Fylo/stargazers"><img src="https://img.shields.io/github/stars/d31ma/Fylo?style=flat" alt="GitHub Stars"></a>
</p>

<p align="center">
  <strong>One canonical file per document. Key-only indexes. No monolithic caches.</strong><br/>
  A single <code>fylo</code> binary, driven from 9 languages via thin shims.
</p>

---

## Table of Contents

- [Why FYLO?](#why-fylo)
- [Quick Start](#quick-start)
- [Architecture](#architecture)
- [Browser access](#browser-access)
- [Configuration](#configuration)
- [CRUD Operations](#crud-operations)
- [Querying](#querying)
- [Schema Versioning](#schema-versioning)
- [Encryption](#encryption)
- [POSTIX Access Control](#postix-access-control-uid-gid-and-mode)
- [Serverless Queue](#serverless-queue)
- [Remote Access](#remote-access)
- [CLI & Machine Interface](#cli--machine-interface)
- [Recovery & Rebuild](#recovery--rebuild)
- [Limitations](#limitations)
- [License](#license)

---

## Why FYLO?

FYLO trades complexity for clarity. Documents are plain JSON files on disk. Indexes are zero-byte key entries that accelerate queries without duplicating data. If the index ever drifts, FYLO rebuilds it from the documents — the files are always the source of truth.

| Principle                    | Implementation                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------ |
| **Documents are truth**      | One `.json` file per document, sharded by trailing TTID creation characters          |
| **Indexes are accelerators** | Zero-payload prefix keys in a sorted catalog file                                    |
| **Rebuildable, not sacred**  | `fylo.<collection>.rebuild()` reconstructs indexes from data                         |
| **Self-contained core**      | Rust storage, query, recovery, and machine protocol in one native executable         |
| **Filesystem-only**          | One local engine; mount, snapshot, and back up the root with filesystem-native tools |
| **Brokerless queues**        | Durable local topics, leases, retries, consumer groups, and dead letters             |
| **Browser: local-only**      | OPFS engine in the browser — each device owns its own store, fully offline           |

---

## Quick Start

FYLO ships as a single self-contained `fylo` binary via
[GitHub Releases](https://github.com/d31ma/Fylo/releases) — not npm. Install it
onto your `PATH`, together with the [`chex`](https://github.com/d31ma/CHEX) and
[`ttid`](https://github.com/d31ma/TTID) binaries it drives:

```bash
# fylo (macOS / Linux)
curl -fsSL https://github.com/d31ma/Fylo/releases/latest/download/install.sh | sh
# chex + ttid
sh ./scripts/install-vendor-bins.sh
```

Set `FYLO_VERIFY_PROVENANCE=1` before running the installer to require signed
GitHub artifact provenance in addition to the release checksum. This opt-in
requires an authenticated GitHub CLI and fails closed before installation; see
the [release provenance runbook](docs/operations/release-provenance.md).
Maintainers can reproduce the pull-request gates from the
[CI qualification runbook](docs/operations/ci-qualification.md).

Then drive it from your language through a thin, dependency-free
[client shim](clients/). Node example:

```ts
import { Fylo } from './clients/node/fylo.mjs' // spawns the `fylo` binary

const db = new Fylo('/mnt/fylo')
await db.createCollection('users')

const id = await db.putData('users', { name: 'Ada', role: 'admin' })
const doc = await db.getLatest('users', id)
console.log(doc) // { <id>: { name: 'Ada', role: 'admin' } }

await db.close()
```

Shims ship for Node, Python, Ruby, Go, Rust, C#, Java, PHP, and Dart (see
[`clients/`](clients/)). Browsers, mobile apps (iOS/Swift, Android/Kotlin), and
Flutter use local-only clients that embed the engine on-device (OPFS) — see
[Browser access](#browser-access) and [`clients/`](clients/).

### Web Applications

The marketing website and Fylo Explorer are separate Tachyon applications.
Run either one from its own root:

```bash
git clone https://github.com/d31ma/Fylo.git
cd Fylo/website && bun install --frozen-lockfile && bun run serve
cd ../explorer && bun install --frozen-lockfile && bun run serve
```

---

## Architecture

### Three artifacts, one engine

The same engine ships three ways. They share the source, the on-disk format,
and the NDJSON machine protocol, and differ only where a platform cannot supply
something — the handshake capabilities report which.

| Artifact            | Target                   | Storage                         | Driven by                         |
| ------------------- | ------------------------ | ------------------------------- | --------------------------------- |
| `fylo`              | native                   | `std::fs`                       | a spawned process                 |
| `fylo.wasm`         | `wasm32-wasip1`          | `std::fs` over WASI preopens    | any WASI runtime                  |
| `fylo-browser.wasm` | `wasm32-unknown-unknown` | a host table the embedder fills | a browser Worker, or any embedder |

`fylo` and `fylo.wasm` are **interchangeable**: a shim spawns either, writes
NDJSON to stdin, reads NDJSON from stdout, and cannot tell which it got.
WebAssembly is not a browser technology — `wasm32-wasip1` has real files and
real stdio, so the same engine runs under any WASI runtime on a server.

The browser build owns its storage rather than delegating to a JavaScript
engine, which is why version control, schema, and encryption reach the browser
at all. See the [artifact matrix](docs/releases/artifact-matrix.md) for what
each one can and cannot do, and why.

Document collections live under `.collections`; buckets (for raw files) live
under `.buckets`. The two are structurally identical — only the top-level
directory differs. Collections hold `Record` values; buckets hold `Blob`/`File`
values:

```text
<root>/.collections/<collection>/   ← documents (Record)
<root>/.buckets/<bucket>/           ← raw files (Blob / File), same internal layout:
  docs/                    ← one file per document/object (TTID-named)
    W/                     ← shard: trailing characters of the creation segment
      4UUB32VGUDW.json
  .deleted/                ← soft-deleted payloads (hidden sibling of docs/)
    W/
      4UUB32VGUDW.json
  index/                   ← local filesystem prefix index catalog
    manifest.json          ← format version marker
    keys.snapshot          ← sorted index keys, mmap'd for O(log n) lookup
    keys.wal               ← append-only mutation log (compacted once it outgrows the snapshot)
  events/
    <collection>.ndjson    ← append-only event journal
  locks/                   ← advisory file locks
```

FYLO keeps the logical transaction journal outside collection trees so it is
not mistaken for a document, indexed, versioned, or copied as record payload:

```text
<root>/.fylo-transactions/<namespace>/<collection>/
  state.json               ← stable/writing generation marker
  <transaction-id>/
    transaction.json       ← operation, commit phase, before-image manifest
    before/                 ← linked/copied files needed for rollback
```

Every transactional collection mutation publishes an odd `writing` generation
before changing records and the next even `stable` generation after commit.
Readers materialize against one stable generation and retry if it changes. On
startup or first access, an active transaction is rolled back; a transaction
with a durable committed marker is rolled forward. Index files remain derived
and are rebuilt when recovery needs them.

A collection's kind is recorded once in its catalog descriptor
(`.fylo-catalog/collections/<name>.json`); names are unique across both
namespaces, so `db.<name>` is unambiguous.

When document version control is initialized, FYLO also writes hidden repository
metadata beside `.collections`:

```text
<root>/.fylo-vcs/
  HEAD                     ← active branch ref
  refs/heads/<branch>.json ← branch metadata and latest commit id
  branches/<branch>/       ← hidden working tree for non-main branches
    .collections/...
  commits/<commit-id>/     ← commit metadata and root tree hash
  objects/<hh>/<hash>      ← verified content-addressed blobs and tree nodes
  staging/<transaction>/   ← durable restore/merge recovery transactions
    transaction.json
```

`main` uses the root `.collections` tree. Other branches use hidden working
trees under `.fylo-vcs/branches/`, so `fylo checkout -b feature` isolates
subsequent reads and writes without changing the base document layout. Commits
reference content-addressed trees. Unchanged blobs and subtrees are shared by
hash, and object hashes are verified before restore or merge. Restore and merge
materialization uses a durable staging transaction; startup deterministically
rolls an interrupted swap backward or forward before collections are opened.

**Index keys** are slash-delimited — field path, kind, value, doc ID:

```text
name/f/alice/4UUB32VGUDW
name/r/ecila/4UUB32VGUDW
age/n/c03e000000000000/4UUB32VGUDW
age/nr/3fc1ffffffffffff/4UUB32VGUDW
```

- `f` = forward prefix (LIKE 'ali%')
- `r` = reversed prefix (LIKE '%ice')
- `n` / `nr` = sortable numeric (range queries)
- `eq` = exact match
- `g3` = trigram (contains queries)

### Index

The prefix index is always **local**: an mmap'd sorted file + WAL (binary
search, zero JS heap). Documents are truth; the index is a local accelerator
that can always be rebuilt from them. Remote copies and sync hooks are never in
the query or transaction path.

---

## Browser access

The browser client is **local-only**: a bundled OPFS engine (`fylo-web.mjs`,
released as an asset) that reads and writes a browser-local store directly.
There is no network access and no backend — each browser (and each mobile app
hosting the engine in a WebView) owns its own database.

Add the version-pinned loader to the document head:

```html
<script src="https://d31ma.github.io/FYLO/version/26.33.02/fylo.js"></script>
```

```ts
const db = await Fylo.open()

const id = await db.users.put({ name: 'Ada', role: 'admin' })
await db.users.put(id).metadata({ source: 'browser', reviewed: false })
const metadata = await db.users.get(id).metadata()
const doc = await db.users.latest(id)
```

Use `https://d31ma.github.io/FYLO/version/latest/fylo.js` to track the newest
successful release. Direct ESM consumers can import
`https://d31ma.github.io/FYLO/version/26.33.02/fylo-web.mjs` instead.

Treat the loader as executable supply-chain input: it runs with the embedding
origin's authority, including access to that origin's FYLO data. Production
applications should use the immutable version URL, not the mutable
`version/latest/` alias. For higher-assurance deployments, download the loader
and every adjacent module, worker, and Wasm asset from the matching release,
verify them against `SHA256SUMS`, and serve them from your own origin. Restrict
the permitted script, module, worker, and asset origins with CSP; integrity on
`fylo.js` alone does not cover the modules it imports dynamically.

The browser index scanner also has an opt-in Wasm prototype. It keeps the
existing OPFS snapshot + WAL format: Wasm scans the immutable snapshot inside
the worker, while JavaScript applies live WAL additions/removals and falls back
automatically if the module cannot load. Build all adjacent browser assets with:

```bash
bun run build:web:wasm
```

```ts
const db = createBrowserClient({ storage: 'opfs', worker: true, wasm: true })
await db.ready()
```

Chromium can instead mount a user-selected FYLO root directly:

```ts
const handle = await showDirectoryPicker({ mode: 'readwrite' })
const db = createBrowserClient({
    storage: { type: 'fsa', handle, access: 'readwrite' },
    worker: true,
    wasm: true
})
await db.ready()
```

Set `access: 'overlay'` for read-only exploration. Reads fall through to the
selected directory while generated indexes, journals, and other writes remain
in memory.

Pass `wasm: { url: 'https://example.test/fylo-index.wasm' }` to override the
adjacent module URL. `collection.inspect()` reports `indexAcceleration` as
`active`, `fallback`, or `off`; the feature remains opt-in while the integration
prototype is benchmarked on representative stores.

### Fylo Explorer

The Explorer is a browser UI over a **real FYLO root on your disk** — no
server, no protocol. It opens the folder through the File System Access API:
pick the root once in the OS dialog, and later visits reopen it automatically
(the handle persists; Chromium's "Allow on every visit" makes it zero-click).
Chromium-only — Firefox and Safari do not implement real-folder access.

```bash
cd explorer && bun run seed     # optional: demo root at explorer/db (gitignored)
cd explorer && bun run serve    # http://localhost:8080
cd explorer && bun run bundle   # production bundle at explorer/dist/web
```

Every GitHub release also includes a versioned, checksum-covered
`fylo-explorer-<CalVer>.zip` containing the contents of `explorer/dist/web`.
Extract it directly into the root of a static host:

```bash
VERSION=26.33.02
curl -fLO "https://github.com/d31ma/Fylo/releases/download/v${VERSION}/fylo-explorer-${VERSION}.zip"
mkdir "fylo-explorer-${VERSION}"
unzip "fylo-explorer-${VERSION}.zip" -d "fylo-explorer-${VERSION}"
python3 -m http.server 8080 --directory "fylo-explorer-${VERSION}"
```

`index.html` is at the ZIP root. Production hosts should use a dedicated HTTPS
origin, serve the extracted tree at `/`, and preserve the generated MIME types
(especially `application/wasm` for `.wasm` files). `localhost` is suitable for
local evaluation.

- **Read-only by default.** Reads go straight to the folder; the engine's own
  writes (index rebuilds, journals) land in an in-memory overlay, so the root
  is never modified — indexes are accelerators, rebuilt in RAM per session.
- **Browse and query.** A sidebar split into **Collections** (documents) and
  **Buckets** (files), a document list, a JSON viewer, and a filter bar accepting
  SQL `WHERE` expressions (`role = 'admin' AND age >= 30`). Buckets browse as macOS-Finder-style Miller
  columns built from the plain-text key index (object keys live in xattrs, which
  browsers can't read — the index mirror makes them visible anyway), with image
  preview and byte download. A SQL console runs `SELECT` statements read-only
  (full SQL once writes are enabled).
- **Writes are opt-in.** "Enable writes" re-arms the folder as readwrite and
  drops the overlay: create/edit/delete/restore go through the engine into the
  real root (compat is tested in both directions — desktop reads what the
  browser wrote and vice versa). Buckets accept uploads into the current folder;
  the bytes and a `key` index entry are written immediately, but the
  key/checksum xattrs can't be set from a browser — a desktop `rebuild` or
  `verify` re-derives them. A banner warns when the root has live lock files;
  there is no cross-process locking from a browser, so concurrent writes are
  last-writer-wins.

The Explorer rejects oversized work before reading it into memory:
previews are limited to 32 MiB, imports to 16 MiB and 10,000 records, exports
to 64 MiB and 10,000 records, and bucket uploads to 64 MiB. Use the CLI for
larger operations. Explorer is a standalone Tachyon app under `explorer/`; it
builds directly at `/` for its dedicated origin and is not part of the marketing
website bundle. Tachyon's generated component runtime currently uses `eval` for
bindings and event dispatch, so the deployment CSP must retain `unsafe-eval`
until Tachyon offers a CSP-safe compiler mode. FYLO's own runtime import does
not use `eval` or `new Function`.

For production deployments, serve Explorer from a dedicated origin that hosts
no unrelated application code. A CSP limits what a compromised page can load,
but browser directory-handle grants and origin storage are shared by every
script on the same origin; the application cannot enforce DNS/hosting
separation in code. The marketing site may keep linking to that origin, but it
should not share its JavaScript execution boundary.

---

## Configuration

| Variable              | Purpose                                         | Default        |
| --------------------- | ----------------------------------------------- | -------------- |
| `FYLO_ROOT`           | Filesystem root for collections                 | `./.fylo-data` |
| `FYLO_SCHEMA`         | Directory containing JSON validation schemas    | —              |
| `FYLO_STRICT`         | Validate documents with chex before writes      | —              |
| `FYLO_SHARD_WIDTH`    | Shard width for newly created collections (1–4) | `1`            |
| `FYLO_ENCRYPTION_KEY` | AES-GCM key for `$encrypted` fields (≥32 chars) | —              |
| `FYLO_CIPHER_SALT`    | Salt for blind index derivation                 | —              |

Copy `.env.example` to `.env` and fill in your values.

Every binary-backed SDK shim can scope a `.env` file to one FYLO child. For
example, Node/TypeScript uses:

```js
const db = new Fylo('/mnt/fylo', {
    binary: '/opt/fylo/bin/fylo',
    env: './config/mail.fylo.env'
})
```

Each shim also accepts its language's native environment map/dictionary. In
Node/TypeScript, pass only the settings this child needs:

```js
const db = new Fylo('/mnt/fylo', {
    env: {
        FYLO_SCHEMA: '/srv/mail/schemas',
        FYLO_STRICT: '1'
    }
})
```

The configured values override inherited variables for that child without
mutating the host process environment. An explicit constructor root,
`shardWidth`, or enabled `strictSchema` is passed as a CLI flag and takes
precedence over its environment equivalent. A missing or malformed `.env` file
fails before FYLO is spawned. See [the SDK shim guide](clients/README.md) for
Python, Ruby, PHP, Go, Rust, Java, C#, and Dart syntax.

Treat both the environment file path and map as trusted bootstrap configuration.
Never accept either from a request, tenant setting, upload, or other untrusted
input: arbitrary environment keys can alter `PATH`, dynamic-loader behavior,
and the program that the child starts. Use an absolute, administrator-controlled
binary path; copy only explicitly approved `FYLO_*` values instead of spreading
`process.env`; and audit inherited variables, removing unrelated keys where the
shim supports null/nil removal. Keep populated files out of source control,
store secrets in a secret manager when possible, and make local secret files
owner-readable only (for example, `chmod 600`).

## CRUD Operations

Collections must be created explicitly before reads, writes, updates, deletes,
imports, rebuilds, or queries. Use `db.<collection>.inspect()` when you want a
safe existence check; it returns `exists: false` instead of throwing.

### Create

```ts
await db.users.create()

const id = await db.users.put({
    name: 'Jane Doe',
    age: 29,
    team: 'platform'
})
```

### Read

```ts
const doc = await db.users.get(id)
```

### Update (preserves the document TTID)

```ts
const sameId = await db.users.patch(id, { team: 'core-platform' })
```

### Delete

```ts
await db.users.delete(sameId) // moves payload to .deleted/W/4UUB32VGUDW.json
```

Soft-deleted files retain their TTID filename, use file `mtime` as `deletedAt`,
and become read-only (`0444`). They are excluded from ordinary queries.

### Recover Deleted Documents

```ts
const deleted = await db.findDeletedDocs('users', {
    $deleted: { $gte: Date.parse('2026-05-01T00:00:00Z') }
})

await db.users.restore(sameId)
```

Restore preserves the TTID, moves the payload back into `docs/`, restores
writable file permissions (`0644`), rebuilds its indexes, and records the
restoration as a live insert event. A tombstoned TTID cannot be written
directly; it must be restored.

### Raw Files (Buckets)

A **bucket** stores raw files: create it with `kind: 'file'`, then pass a
`Blob`, `File`, or `URL` to the normal `put()` method. The two collection kinds
differ only by value type — a document collection takes a `Record`, a bucket
takes a `Blob`/`File` — and the API is otherwise identical. Buckets are stored
on disk under `.buckets/<name>/` (documents live under `.collections/<name>/`);
the two share an identical internal layout. Databases written by older FYLO
versions, where file collections lived under `.collections/`, are migrated to
`.buckets/` automatically the first time the engine opens them.

```js
await db.assets.create({ kind: 'file' })

const id = await db.assets.put(new File(['hello'], 'greeting.txt', { type: 'text/plain' }))

const metadata = await db.assets.get(id).once()
const bytes = await db.assets.get(id).bytes()
const blob = await db.assets.get(id).blob()
const stream = await db.assets.get(id).stream()
```

File collections also support slash-delimited logical object keys. `/` is the default;
root and trailing-slash keys append the generated TTID filename, while an exact
key is preserved as supplied:

```js
const id = await db.assets.put(file, { key: '/reports/2026/summary.pdf' })

const exact = await db.assets
    .find({
        $ops: [{ key: { $eq: '/reports/2026/summary.pdf' } }]
    })
    .collect()

const reports = await db.assets
    .find({
        $ops: [{ key: { $like: '/reports/%' } }]
    })
    .collect()
```

Keys are unique among active files in a collection. They always begin with `/`,
may be at most 1024 UTF-8 bytes, and cannot contain backslashes, control
characters, or `.` / `..` path segments. A key is logical metadata, not a local
filesystem path; the raw bytes still use the TTID filename shown below.

Keys can be reassigned in place — no byte rewrite — and folder-style trees
derived from them can be browsed one level at a time:

```js
await db.assets.rekey(id, '/reports/2027/summary.pdf') // move one file
await db.assets.rekey.prefix('/reports/', '/archive/') // move a whole folder

const { files, folders } = await db.assets.folder('/archive/')
// files   → { [id]: manifest } for direct children
// folders → ['2026', '2027'] — immediate subfolder names
```

`folder()` reads only key metadata for deeper descendants (one xattr each), so
browsing stays cheap in large trees. Checksums are cached in a
`user.fylo.checksum` xattr stamped with (size, mtime), so listings and reads
do not re-hash file contents; the hash is recomputed automatically whenever
the stamp no longer matches the file.

The cache trusts its stamp, so silent corruption that preserves both size and
mtime is invisible to the fast path. `verify()` is the stamp-ignoring audit
that closes the gap — it re-hashes the full contents of every file (active
and soft-deleted), freshens matching stamps, and reports mismatches without
touching the corrupt file's original claim:

```js
const report = await db.assets.verify()
// { collection, filesScanned, verified, stamped, corrupt: [{ id, namespace, expected, actual }] }
```

Each mismatch also emits a `file.checksum-mismatch` event through `onEvent`.
The audit reads every byte, so it is slow by design — run it as a scheduled
background job, not per request. The CLI equivalent exits non-zero when
corruption is found, so a cron line is all a weekly audit needs:

```cron
# Weekly integrity audit, Sunday 03:00 — mail/alert fires on non-zero exit
0 3 * * 0  fylo verify assets --root /mnt/fylo --json || notify "fylo: corruption detected"
```

Machine-protocol callers use `{"op": "verifyCollection", "collection": "assets"}`.
Metadata has machine ops too: `putData` accepts a top-level `meta` record;
`{"op":"getMeta","collection":"...","id":"..."}` reads it, and
`{"op":"setMeta","collection":"...","id":"...","meta":{...}}` bulk-edits
it. Browser document collections persist metadata in a
durable internal OPFS sidecar and expose the same metadata API. Local-first
clients read and write that sidecar entirely on-device. There is no background
metadata transport or remote conflict clock; moving data between devices is an
application-level export, filesystem mount, or backup concern.

FYLO stores the bytes unchanged at:

```text
.buckets/assets/docs/<shard>/<TTID>.<original-extension>
```

**That path is internal and versioned, not an interface.** `<shard>` is derived
from the identifier by a rule that has already changed once
([ADR 0006](docs/adr/0006-shard-records-by-the-trailing-creation-characters.md))
and may change again. Read content through `getFileData` (below) or the client
API; do not compute the path.

No source path or URL is retained. Metadata is derived from the stored file,
with the logical `key` stored as a `user.fylo.key` extended attribute (xattr)
on the file itself, so it travels with the bytes across moves:
`name`, `key`, `extension`, `contentType`, `contentLength`, `etag`,
`checksumSHA256`, `createdAt`, and `lastModified`. `key` is the record's
logical name, not a location inside the bucket. These fields use the normal
prefix index and can be queried with `find()`.

Every timestamp FYLO returns is a **whole** number of epoch milliseconds.
`createdAt` is decoded from the TTID; `lastModified` — like `updatedAt`,
`mtime`, and `deletedAt` on documents — is the filesystem modification time,
truncated to the millisecond. The JavaScript engine passed Node's fractional
`fs.stat().mtimeMs` straight through, which meant one payload could mix
`1785784975586` and `1785784975653.6606` and break a client that typed epoch
milliseconds as an integer. Sub-millisecond filesystem precision is not
something FYLO orders records by, so the type is now uniform instead.

Developer-defined metadata rides along the same way, as `user.fylo.meta.*`
xattrs on the document or raw file. `put` has two metadata-focused forms:
`put(id, documentOrFile).metadata(record)` writes bytes and metadata together,
and `put(id).metadata(record)` bulk-edits an existing record (`null` removes an
entry). `get(id).metadata()` reads the complete canonical record plus custom
metadata. Every record includes `id`, `mtime`, `updatedAt`, and `createdAt`;
raw files also include their stored file descriptor:

```js
const id = await Fylo.uniqueTTID()
await db.assets
    .put(id, file, { key: '/pics/beach.jpg' })
    .metadata({ camera: 'A7 IV', rating: 5, starred: true })
await db.assets.put(id).metadata({ rating: 4, starred: null }) // update + remove
await db.assets.get(id).metadata()
// { id, name, key, extension, contentType, contentLength, etag, checksumSHA256,
//   lastModified, mtime, updatedAt, createdAt, camera: 'A7 IV', rating: 4 }
```

Canonical fields take precedence if a custom metadata key uses the same name.

Those fluent signatures belong to the browser collection facade. Native
language shims expose the same behavior as `getMeta(collection, id)` and
`setMeta(collection, id, record)`, with
language-specific casing and collection-scoped forms documented in
[`clients/README.md`](clients/README.md). All surfaces use the same `getMeta`,
`setMeta`, and metadata-bearing `putData` machine operations; the shims do not
invent a second metadata store or merge policy.

The existing generated-ID form (`put(dataOrFile, options)`) remains available.
The record must be a plain object. Names are 1-64 characters of letters, digits,
`.`, `_`, or `-`, starting with a letter or digit. Each value must be
JSON-serializable and at most 60 KiB after UTF-8 JSON encoding; strings, numbers,
booleans, arrays, and objects round-trip with their types. A top-level `null`
value is a deletion marker, not a storable metadata value. FYLO validates the
whole mutation before writing it and rolls back a filesystem xattr batch if a
later write fails. Browser sidecars enforce the same names, value types, and
size ceiling. On file collections, metadata is returned inside each manifest
(`manifest.meta`) and is indexed, so it can be queried — including numerically:

```js
await db.assets.find({ $ops: [{ ['meta/starred']: { $eq: true } }] })
await db.assets.find({ $ops: [{ ['meta/rating']: { $gte: 4 } }] })
```

Metadata survives soft delete, restore, and version-control
restores because it is snapshotted with each commit. If a store directory is ever copied by an xattr-dropping
tool, `rebuild()` repairs each stripped file to its default `/<filename>` key
(emitting a `file.key-repaired` event; custom keys are not recoverable from
bytes alone — use a version-control restore for full fidelity). Filesystem-backed
document and file collections use native xattrs on macOS/Linux and an NTFS
Alternate Data Stream manifest on Windows. Browser document collections use the
durable OPFS sidecar instead.
Metadata is per-version on filesystem-backed JSON documents. The machine ops
`getMeta` and `setMeta` cover it from every client shim; native metadata remains
an engine implementation detail rather than a package-level byte API.

`URL` ingestion snapshots the content at write time. `file:` URLs work
server-side; browser runtimes accept `Blob`, `File`, and network URLs. The
default ingestion limit is 50 MiB and can be changed per write:

```js
await db.assets.put(file, { maxBytes: 250 * 1024 * 1024 })
```

Compiled executable callers use a tagged absolute path:

```json
{
    "op": "putData",
    "root": "/mnt/fylo",
    "collection": "assets",
    "file": {
        "path": "/uploads/greeting.txt",
        "key": "/incoming/greeting.txt"
    }
}
```

`getDoc` answers a file collection with the manifest and no bytes. `getFileData`
returns the content, in either of the two shapes the handshake advertises as
`documentBuckets.getOutputs`:

```json
{ "op": "getFileData", "root": "/mnt/fylo", "collection": "assets", "id": "4VU2UX8MC3K" }
```

```json
{
    "id": "4VU2UX8MC3K",
    "contentLength": 12,
    "checksumSHA256": "a8359ee3…",
    "encoding": "base64",
    "data": "aGVsbG8gYnVja2V0"
}
```

Adding an absolute `path` writes the content there and returns only the
receipt, which is how an object larger than one response frame is read. The
path must not already exist — `getFileData` never replaces a file it did not
create — and an inline read that would not fit the frame is refused with
`EFRAME_RESPONSE_TOO_LARGE` naming `path` as the alternative.

```json
{
    "op": "getFileData",
    "root": "/mnt/fylo",
    "collection": "assets",
    "id": "4VU2UX8MC3K",
    "path": "/tmp/greeting.txt"
}
```

---

## Querying

FYLO queries use prefix indexes first, then hydrate only matching documents.

```ts
// Exact match
const results = await db.users.find({
    $ops: [{ name: { $eq: 'Alice' } }]
})

// Range query (numeric fields)
const adults = await db.users.find({
    $ops: [{ age: { $gte: 18 } }]
})

// Contains (array membership)
const engineers = await db.users.find({
    $ops: [{ tags: { $contains: 'engineering' } }]
})

// OR across conditions
const privileged = await db.users.find({
    $ops: [{ role: { $eq: 'admin' } }, { role: { $eq: 'owner' } }]
})
```

### SQL Support

```ts
const db = new Fylo('/mnt/fylo')

await db.sql`CREATE TABLE posts`
const id = await db.sql`INSERT INTO posts (title, published) VALUES (${'Hello'}, ${true})`
const posts = await db.sql`SELECT * FROM posts WHERE published = ${true}`
```

`UPDATE` and `DELETE` statements are atomic within their collection: either
every matched document, its native metadata, and index entries commit, or the
statement restores all before-images.

Use `EXPLAIN` to inspect the selected access path without executing the
statement, or `EXPLAIN ANALYZE` to execute it and include elapsed time and the
result:

```ts
const plan = await db.executeSQL("EXPLAIN SELECT * FROM posts WHERE title = 'Hello'")
// { operation: 'SELECT', collection: 'posts', access: [...], executed: false }
```

The CLI accepts the same syntax:

```bash
fylo sql "EXPLAIN SELECT * FROM posts WHERE published = true" --root /mnt/fylo
```

### POSTIX access control (UID, GID, and mode)

POSTIX replaces the former row-level security API with filesystem-native,
per-record access control. A document/file `put` or SQL `INSERT` can bind a
developer-supplied POSIX UID, GID, both, or only a mode. Any omitted identity
retains the new file's native owner/group; omitting `mode` uses `0o600`.

```js
const id = await db.documents.put({ title: 'private' }).as({ uid: 1001, mode: 0o600 })
const teamId = await db.documents.put({ title: 'team draft' }).as({ gid: editorsGid, mode: 0o660 })
const managedId = await db.documents
    .put({ title: 'managed' })
    .as({ uid: 1001, gid: editorsGid, mode: 0o660 })
const nativeOwnerId = await db.documents.put({ title: 'native owner' }).as({ mode: 0o600 })

await db.documents.get(id).as({ uid: 1001 })
await db.documents.patch(id, { title: 'updated' }).as({ uid: 1001 })
await db.documents.delete(id).as({ uid: 1001 })

// A trusted membership resolver proves that 1002 belongs to editorsGid.
await db.documents.patch(teamId, { title: 'reviewed' }).as({ uid: 1002 })
await db.documents.delete(teamId).as({ uid: 1002 })
```

SQL uses the same execution context without embedding credentials in the SQL
text:

```js
const sqlId = await db.sql`
    INSERT INTO documents (title) VALUES (${'team draft'})
`.as({ gid: editorsGid, mode: 0o660 })

await db.sql`UPDATE documents SET title = ${'updated'} WHERE title = ${'team draft'}`.as({
    uid: 1002
})
```

Fylo applies `chown` and `chmod` to the record and stores a portable access
descriptor in `user.fylo.access`. It evaluates mode classes with normal POSIX
precedence: owner bits for the owner UID, otherwise group bits for a member of
the record GID, otherwise other bits. Membership does not fall through to
`other` when the selected owner/group bits deny an operation. Group members can
modify and delete only when the group write bit is set, so use `0o660` rather
than `0o600` for a group-readable and group-writable record.

The binary supports application-authenticated virtual identities over its
local NDJSON boundary. Every document and raw-file
CRUD/query request accepts `access`; the shipped Node client exposes it through
the same fluent syntax:

```js
const teamId = await db.messages.put({ title: 'team draft' }).as({ gid: editorsGid, mode: 0o660 })

const actor = {
    uid: authenticatedUser.uid,
    groups: await identityProvider.groupIdsFor(authenticatedUser.uid)
}
await db.messages.patch(teamId, { title: 'reviewed' }).as(actor)
await db.attachments
    .putFile({ path: sourcePath, key: '/mail/attachment.pdf' })
    .as({ gid: editorsGid, mode: 0o660 })
```

`access.groups` is a trusted, request-scoped supplementary-GID assertion for
machine mode only. The cached binary clears it after each request and falls
back to the host POSIX group resolver when it is omitted. Treat stdin as a
privileged application boundary: derive both `uid` and `groups` from
authenticated server state and never copy either from an end-user payload. A
record written without `.as()` or machine `access` has no descriptor and
remains open to reads and writes.

The UID is still an authorization claim supplied by your application—Fylo does
not authenticate it. Validate the caller before passing a UID. The Fylo
process must also have permission to call `chown`; otherwise the put fails
atomically. Denied direct operations throw `FyloPermissionError` with
`code === 'EACCES'`, while queries and SQL omit unreadable records.

This API is available only when the native binary and its binary-backed shims
run on a POSIX host such as macOS or Linux. It is not a Windows authorization
boundary, even though Windows supports FYLO's local crash recovery. Browser,
Explorer, and WebView-based mobile clients (Swift/Kotlin/Flutter) cannot call
`chown`/`chmod`, so they do not expose `.as()` as an equivalent security
boundary; those clients must remain behind an authenticated native POSIX
gateway when POSTIX enforcement is required.

Canonical metadata includes `uid`, `gid`, and `mode` for protected records:

```js
const { uid, gid, mode, createdAt, updatedAt, mtime } = await db.documents
    .getMeta(id)
    .as({ uid: 1001 })
```

### Query Strategy

| Operator                     | Index used                        | Fallback                 |
| ---------------------------- | --------------------------------- | ------------------------ |
| `$eq`                        | Exact match key (`eq`)            | —                        |
| `$gt`, `$gte`, `$lt`, `$lte` | Sortable numeric key (`n`/`nr`)   | Full scan if non-numeric |
| `$contains`                  | Exact match on array members      | —                        |
| `$like "ali%"`               | Forward prefix (`f`)              | Full scan                |
| `$like "%ice"`               | Reversed prefix (`r`)             | Full scan                |
| `$like "%lic%"`              | Trigram (`g3`) → hydrate → verify | Full scan                |

---

## Schema Versioning

Schemas live under `FYLO_SCHEMA` in a per-collection layout:

```text
<FYLO_SCHEMA>/
  <collection>/
    manifest.json          ← { current, versions: [{v, sha256?, addedAt?}] }
    history/
      v1.schema.json       ← chex regex schema
      v2.schema.json       ← head is whichever manifest.current points at
    upgraders/
      v1-to-v2.js          ← export default async (doc) => upgradedDoc
```

`manifest.json`:

```json
{
    "current": "v2",
    "versions": [
        { "v": "v1", "addedAt": "2026-04-01T00:00:00Z" },
        { "v": "v2", "addedAt": "2026-04-27T00:00:00Z" }
    ]
}
```

Chex regex schemas (`history/v2.schema.json`):

```json
{
    "id": "^[0-9]+$",
    "title": "^.+$",
    "body": "^.+$",
    "slug": "^[a-z0-9-]+$"
}
```

Upgraders are pure functions:

```js
export default function upgrade(doc) {
    return {
        ...doc,
        slug:
            String(doc.title ?? '')
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-+|-+$/g, '') || 'untitled'
    }
}
```

Behavior:

- Documents carry `_v` (version label)
- Reads materialize old docs to head shape in memory
- Strict writes validate against head schema via the `chex` binary
- Documents missing `_v` are treated as oldest version (legacy upgrade on read)
- Any collection directory under `FYLO_SCHEMA` that contains a `manifest.json` is auto-created on `new Fylo(...)`; await `fylo.ready()` if you need the bootstrap to settle before issuing reads from a synchronous probe (mutation/query methods await internally)
- FYLO schemas do not support arrays of objects — declare each nested object as its own collection. A schema that would accept `items: [{ name: '...' }]` will throw `FYLO schema '...' does not support arrays of objects at '$.items'` on first read. Arrays of scalars and nested objects (as fields) are fine.

---

## Encryption

Fields declared in `$encrypted` arrays are stored with AES-GCM. Equality queries use HMAC blind indexes — lookups work without decrypting, but an attacker with index access can count repetitions.

```json
{
    "$encrypted": ["ssn", "email", "payload/verifier"],
    "id": "^[0-9]+$",
    "name": "^.+$",
    "email": "^.+$",
    "ssn?": "^[0-9-]+$",
    "payload?": { "verifier?": "^.+$" }
}
```

Nested fields use a **slash-separated** path (`payload/verifier`), matching the
index field-path format. A dotted path such as `payload.verifier` is accepted
as a literal field name, matches nothing, and silently leaves the field
unencrypted — check the stored document if a field is not being encrypted.

Requirements:

- `FYLO_ENCRYPTION_KEY` must be ≥32 characters
- `FYLO_CIPHER_SALT` is recommended
- Process-global: one key for all collections

Decryption is schema-driven and does not depend on write history: a read-only
process loads a collection's `$encrypted` registration on its first read, so
replicas, reporting jobs, and event-sourced startup replay decrypt correctly
without writing first.

Reads fail closed. If a field the schema declares `$encrypted` cannot be
decrypted — missing key, wrong key, a value that fails authentication, or a
value stored before the field was encrypted — the operation fails with
`EDECRYPTFAILED` naming the collection and field. FYLO never returns a stored
value to a caller as if it were plaintext when it cannot verify it. Adding a
field to `$encrypted` therefore requires rewriting the documents that already
hold a plaintext value for it.

---

## Remote Access

There is none — by design. FYLO has no server and speaks no network protocol.
Every client owns its database directly: the CLI and language shims drive the
`fylo` binary against a local root, and the browser/mobile clients embed the
engine over an on-device OPFS store (see [Browser access](#browser-access)).
If a root must be reached from another machine, that is a filesystem-layer
concern (a mounted drive, a synced directory) — not FYLO's.

The PostgREST-style filter grammar (`role=eq.admin&age=gte.30`) lives on as a
query front-end: `queryFromSearch` in `src/query/postgrest.js` translates it
into a `findDocs` query.

---

## CLI & Machine Interface

### CLI

```bash
# Query
fylo "SELECT * FROM posts WHERE published = true"
fylo sql "SELECT * FROM posts" --page-size 25

# Admin
fylo inspect posts --root /mnt/fylo --json
fylo rebuild posts --root /mnt/fylo
fylo reshard posts --width 2 --root /mnt/fylo --json  # move to a wider shard layout
fylo verify assets --root /mnt/fylo --json  # integrity audit; exits 1 on corruption
fylo get posts 4UUB32VGUDW --root /mnt/fylo --json
fylo deleted posts --root /mnt/fylo --json
fylo restore posts 4UUB32VGUDW --root /mnt/fylo --json

# Document version control
fylo checkout -b feature/docs --root /mnt/fylo
fylo commit -m "snapshot feature docs" --root /mnt/fylo
fylo branch --root /mnt/fylo
fylo log --root /mnt/fylo
fylo status --root /mnt/fylo
fylo diff --root /mnt/fylo
fylo restore-commit 4UUB32VGUDW --root /mnt/fylo --force
fylo merge feature/docs -m "merge feature docs" --root /mnt/fylo
fylo checkout main --root /mnt/fylo

# Schema
fylo schema inspect article --schema-dir ./schemas --json
fylo schema doctor article --schema-dir ./schemas
fylo schema validate article @article.json --schema-dir ./schemas --json
```

`status` and `diff` compare document payloads only (`docs/` and `.deleted/`),
so rebuilt indexes, event journals, lock files, and mtime-only changes do not
create noisy diffs.

Document writes are auto-committed by default. `put`, `patch`, `delete`, and
`restore` create commit snapshots after the local filesystem write succeeds;
failed writes and no-op mutations do not create empty commits.

Commit storage is content-addressed: each document version is stored once as a
deduplicated blob, so commits share unchanged bytes across history and branches
instead of copying whole collections. Bulk operations coalesce — `put.batch`,
`patch.many`, `delete.many`, and `import` each record a single commit covering
every document they touch, so large ingests stay fast. Prefer these over
per-document writes when loading data.

Disable auto-commit for manual Git-style working trees:

```js
const db = new Fylo('/mnt/fylo', {
    versioning: { autoCommit: false }
})
```

Version-control snapshots keep a full content-addressed copy of every raw
file, which doubles disk and write bandwidth for large media collections.
Exclude a collection from history entirely at creation time:

```js
await db.media.create({ kind: 'file', versioned: false })
```

Unversioned collections never appear in commits, diffs, or restores — their
working files are the only copy, and `restoreCommit` leaves them untouched.

Machine/executable callers can use the same option in JSON:

```json
{
    "op": "putData",
    "root": "/mnt/fylo",
    "collection": "posts",
    "versioning": { "autoCommit": false },
    "data": { "title": "manual commit later" }
}
```

`restore-commit` refuses to overwrite uncommitted working tree changes unless
`--force` is passed; commit snapshots themselves remain immutable. `merge`
supports fast-forward and three-way document-payload merges. If both sides
changed the same TTID payload differently, FYLO reports conflicts and leaves
the current branch untouched.

## Serverless Queue

FYLO includes a durable, brokerless queue in the Rust engine. It requires no
Redis, SQS-compatible service, queue daemon, account, or network connection.
Messages and consumer state live under the same filesystem root:

```text
<root>/.fylo-queue/v1/
  manifest.json
  receipt-key.json
  topics/<encoded-topic>/Q00000000000000000001.json
  consumers/<encoded-group>/<encoded-topic>.json
  dedupe/<encoded-topic>/<sha256-key>.json
  dead-letter/<encoded-group>/<encoded-topic>/<message-id>.json
```

The queue provides at-least-once delivery, publication-ordered scanning,
independent consumer groups, visibility leases, lease extension, delayed
publication and retries, bounded attempts, and group-specific dead letters.
Messages are immutable. A claim is persisted before its receipt is returned;
if the worker exits without acknowledging, the message becomes available after
the visibility timeout.

Every native SDK shim also provides an idiomatic consumer decorator, annotation,
or callable wrapper. Each invocation processes one bounded batch and
automatically acknowledges successes or negative-acknowledges handler failures,
which makes the same queue suitable for serverless functions and scheduled
workers without embedding an infinite polling loop. Automatic consumers store
the generic reason `queue handler failed`; they never persist exception text.
Trusted code that needs a diagnostic reason can pass one explicitly to
`queueNack`.

```js
const published = await db.queue.publish(
    'email.welcome',
    { userId: 'u-7' },
    { idempotencyKey: 'welcome:u-7' }
)

const deliveries = await db.queue.claim('email.welcome', 'email-service', {
    maxMessages: 10,
    visibilityTimeoutMs: 30_000,
    maxAttempts: 5
})

for (const delivery of deliveries) {
    try {
        await sendWelcomeEmail(delivery.payload)
        await db.queue.ack('email.welcome', 'email-service', delivery)
    } catch {
        await db.queue.nack('email.welcome', 'email-service', delivery, {
            delayMs: 5_000,
            reason: 'queue handler failed'
        })
    }
}
```

Publication is safe to retry only with the same non-empty `idempotencyKey`,
topic, and byte-equivalent JSON payload. A key reused with different content
returns `EQUEUE_INVALID`. Claiming is intentionally not retry-safe: a lost
claim response leaves leases that expire normally. Recent acknowledgement
retries are idempotent only with the exact receipt that completed the delivery;
each group retains the 1,000 most recently acknowledged ID/receipt pairs for
that validation.
“Serverless” means embedded and brokerless, not distributed multi-writer
storage. FYLO still enforces one owning engine process per root. Concurrent
worker tasks share that process and consumer group; another process can take
over after the owner exits and the filesystem lease is released. There is no
built-in forever-running worker—the application or its serverless invocation
polls, handles, and acknowledges deliveries.

Current limits are 127 UTF-8 bytes per topic or consumer-group name, 1 MiB per
stored message, 1,000 deliveries per claim, an 8 MiB aggregate claim or
dead-letter response budget, and a 64 MiB aggregate message scan budget per
queue request,
10,000 pending delivery states and 1,000 acknowledged ID/receipt pairs per
consumer group, 100 attempts, a 24-hour
visibility lease, a 30-day delay, and 1,000 dead letters returned per read.

### Machine Interface (cross-language)

```bash
echo '{"op":"inspectCollection","root":"/mnt/fylo","collection":"posts"}' | fylo exec --request -
```

```json
{
    "protocolVersion": 1,
    "ok": true,
    "op": "inspectCollection",
    "durationMs": 4,
    "result": { "collection": "posts", "exists": true }
}
```

Before sending ordinary operations, supervisors can identify the exact runtime
and discover its framing contract:

```bash
fylo --version
fylo version --output json
printf '%s\n' '{"op":"handshake"}' | fylo exec --loop --root /mnt/fylo
```

`version --output json` and the `handshake` result share one stable identity:
FYLO runtime and protocol versions, immutable release commit and target,
required CHEX/TTID versions plus their current availability, effective frame
limits, and supported capabilities. Source and locally compiled development
executions explicitly report an unknown commit; release builds embed the
immutable source revision and build target. A handshake is side-effect-free
and does not create the configured root or initialize a collection.

Capability records are versioned contracts. `documentBuckets.version === 1`
advertises raw-file collections (`kind: "file"`), their supported machine
operations, path/URL ingestion, `getFileData`'s base64 and path outputs, and
full-content SHA-256 verification.
`machineAccess.version === 1` advertises the operations that enforce trusted
POSTIX access, the accepted descriptor and actor fields, and the `EACCES` /
query-omission denial semantics. `machineAccess` is present only in macOS and
Linux builds; its absence means the runtime does not provide that authorization
boundary. Consumers should reject a missing or unknown capability version
before touching a production root.
`serverlessQueue.version === 1` advertises the embedded filesystem queue,
including its operation names, delivery model, message/claim limits, consumer
groups, visibility leases, delayed delivery, idempotent publication, and
group-specific dead letters.

Supported operations: `handshake`, `executeSQL`, `createCollection`, `dropCollection`, `inspectCollection`, `rebuildCollection`, `reshardCollection`, `verifyCollection`, `getDoc`, `getFileData`, `getLatest`, `getMeta`, `setMeta`, `findDocs`, `findDeletedDocs`, `restoreDoc`, `joinDocs`, `putData`, `batchPutData`, `patchDoc`, `patchDocs`, `delDoc`, `delDocs`, `importBulkData`, `checkout`, `branch`, `commit`, `log`, `status`, `diff`, `restoreCommit`, `merge`, `schemaInspect`, `schemaCurrent`, `schemaHistory`, `schemaDoctor`, `schemaValidate`, `schemaMaterialize`, `queuePublish`, `queueClaim`, `queueAck`, `queueNack`, `queueExtend`, `queueStats`, `queueDeadLetters`.

Document and raw-file CRUD/query operations accept an optional `access`
object. Puts accept `{ uid?, gid?, mode? }`; reads, metadata, queries, updates,
deletes, and restores accept `{ uid }`. A trusted binary-backed application
may additionally include `groups: number[]` with `uid` for virtual POSIX
membership. Denied direct operations return `error.code: "EACCES"`; collection
queries omit unreadable records.

#### Bounded NDJSON frames

Persistent loops use one UTF-8 JSON object per LF-delimited line. The secure
defaults are 1 MiB per request and 8 MiB per response; the LF delimiter does
not count. A supervisor may lower or raise them, up to 64 MiB, and then confirm
the effective values in the handshake:

```bash
fylo exec --loop --root /mnt/fylo \
  --max-request-bytes 1048576 \
  --max-response-bytes 8388608
```

FYLO uses a fixed-capacity input buffer. It rejects invalid UTF-8
(`EFRAME_UTF8`), malformed JSON (`EFRAME_JSON`), duplicate object keys
(`EFRAME_DUPLICATE_KEY`), and oversized requests
(`EFRAME_REQUEST_TOO_LARGE`). When an LF boundary is known, it emits one error
response and safely resumes with the next frame. An incomplete final frame
returns `EFRAME_TRUNCATED` at EOF and the loop ends; retry it only after
starting a new child.

Responses never silently cross the advertised maximum. `findDocs` and
`findDeletedDocs` support bounded continuation on a persistent loop:

```json
{"op":"findDocs","collection":"posts","query":{"$ops":[]},"page":{"limit":256}}
{"op":"findDocs","collection":"posts","query":{"$ops":[]},"page":{"limit":256,"cursor":"<opaque>"}}
```

The result is `{ items, nextCursor, page: { count, limit } }`. The first request
materializes an immutable, process-scoped snapshot ordered by TTID binary text, so
concurrent mutations cannot duplicate or skip entries. Cursors are scoped to
the operation, collection, query, and access identity; they expire after 15
minutes and become invalid when the loop exits. On `EINVALIDCURSOR` or child
restart, discard partial state and restart from page one. Snapshot state is
private to the native process, cleaned on completion/expiry/shutdown, and capped
at 1 GiB.

Unpaged operations that exceed the frame still return
`EFRAME_RESPONSE_TOO_LARGE` while preserving stream synchronization. A single
query item that cannot fit returns `EQUERYITEMTOOLARGE`; an oversized snapshot
returns `EQUERYSNAPSHOTTOOLARGE`. If a client observes an oversized or malformed
response despite the negotiated contract, it must kill and restart the child
because its framing can no longer be trusted.

#### Stable machine error codes

Every `ok: false` machine response carries a non-empty `error.code`. The set
is additive: new codes may appear in later releases, and an existing code
keeps its meaning. Clients should branch on `error.code`, never on message
text.

| Code                                                                   | Meaning                                                                    | Retry guidance                                                   |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `EBADREQUEST`                                                          | The request shape, field types, access object, or page options are invalid | Do not retry; fix the request                                    |
| `EUNSUPPORTEDOP`                                                       | The operation is unknown to this runtime                                   | Do not retry; check the handshake capabilities                   |
| `EINVALIDDOCID`                                                        | The supplied document ID is not a valid TTID                               | Do not retry; fix the ID                                         |
| `EARRAYOFOBJECTS`                                                      | The document contains an array of objects, which the data model rejects    | Do not retry; restructure per the document-model rule below      |
| `EACCES`                                                               | The access context is not permitted to perform the operation               | Do not retry with the same identity                              |
| `EQUEUE_INVALID`                                                       | A queue name, identity, option, or idempotency reuse is invalid            | Do not retry without correcting the request                      |
| `EQUEUE_RECEIPT`                                                       | A queue receipt is incorrect, expired, or already superseded               | Do not acknowledge as that worker                                |
| `EQUEUE_LIMIT`                                                         | A queue message, claim, delay, attempt, state, or read limit was exceeded  | Reduce the requested resource                                    |
| `EDECRYPTFAILED`                                                       | An `$encrypted` field could not be decrypted with the configured key       | Do not retry; fix the key configuration                          |
| `EINVALIDCURSOR`                                                       | The pagination cursor is invalid, expired, or from another process         | Restart the traversal from page one                              |
| `EROOTLOCKED` / `EROOTLEASELOST`                                       | Exclusive root ownership was unavailable or lost                           | Fail over per your supervisor policy                             |
| `EFRAME_*`                                                             | Frame-contract violations, as documented above                             | Per the framing rules above                                      |
| `EQUERYLOOPREQUIRED` / `EQUERYITEMTOOLARGE` / `EQUERYSNAPSHOTTOOLARGE` | Pagination contract violations, as documented above                        | Per the pagination rules above                                   |
| `ENATIVE_IO`                                                           | Native filesystem I/O failed, including disk pressure or xattr operations  | Treat a mutation as ambiguous; inspect the cause before retrying |
| `EUNKNOWN`                                                             | An engine failure without a more specific classification                   | Treat conservatively; inspect `error.message` diagnostically     |

Storage-level failures may carry additional stable codes (for example
`FYLO_COLLECTION_NOT_FOUND`); those retain their meaning across releases under
the same additive policy.

#### Document model: no arrays of objects

A stored document may contain scalars, nested objects, and arrays of scalars.
It may **not** contain an array of objects at any depth. FYLO treats an array
of objects as a sign the data wants to be its own collection, referenced by
key, so every field is independently indexable.

```json
{ "tags": ["draft", "review"], "author": { "name": "Ada" } }
{ "items": [{ "sku": "a" }] }
```

The first document is accepted; the second is rejected before any disk work
with `EARRAYOFOBJECTS` and a message naming the offending field path. The
rejection is deterministic and leaves no partial state—the write never starts.
This applies equally to `putData`, `batchPutData`, patches, and SQL.

To model a collection of records, store them in their own collection and
reference them by key or public ID. To keep an opaque payload that is never
field-queried, serialize it to a single string field.

#### Exclusive root owner

Long-lived supervisors that require exactly one authoritative process can opt
in to a root-wide lease:

```bash
fylo exec --loop --root /mnt/fylo --exclusive-root
```

FYLO canonicalizes the root, acquires a non-blocking kernel file lock before it
reads stdin, and holds it for the complete loop lifetime. A competing process
receives `EROOTLOCKED` and exits without executing a read or write. Normal
shutdown releases the lock. After a crash or `SIGKILL`, the operating system
releases it; persistent metadata is only diagnostic/fencing state and is not a
PID-file claim, so PID reuse and stale metadata cannot retain ownership. Every
request verifies the unique owner generation, and a replaced former owner
fails closed with `EROOTLEASELOST`.

The lease contract is supported on native local filesystems on macOS, Linux,
and Windows. Containers on the same host can share it only when they share the
same canonical bind-mounted root and host kernel lock domain. Network,
clustered, object-backed, and independently synchronized filesystems are not a
distributed lock service and are unsupported for `--exclusive-root`; use an
external lease/consensus service there. Windows UNC/network shares have the
same restriction.

### Compiled Executable

The `fylo` binary (installed from a release) runs the same machine interface:

```bash
fylo exec --request @request.json
```

Callable from any language that can spawn a process and read JSON: write a
machine request to stdin or `--request`, then read the JSON response from stdout.

The compiled executable interop contract is tested in CI against Python, Ruby,
PHP, Dart, Java, C#, C++, Swift, Kotlin, and Rust. Each language invokes the
same `fylo exec --request <json>` machine protocol, so non-JS callers do not
depend on JS-only conveniences such as `new Fylo(...)`, `sql` template tags, or
`db.<collection>` facades.

---

## Recovery & Rebuild

Documents are truth. Indexes are derived. When they drift:

```ts
const result = await db.posts.rebuild()
// {
//   collection: 'posts',
//   docsScanned: 42,
//   indexedDocs: 42
// }
```

```bash
fylo rebuild posts --root /mnt/fylo --json
```

Use `db.<collection>.rebuild()` after operator-level recovery or when external
processes have modified data files directly.

Version-control restore and merge operations maintain a durable transaction
under `.fylo-vcs/staging/`; ordinary mutations use `.fylo-transactions/`. The
native engine recovers both before opening a collection. An active transaction
rolls back, a committed transaction rolls forward, and derived indexes are
rebuilt when recovery changes documents. Reopening is idempotent.

Treat a failed startup recovery as an operator incident: stop writers, preserve
the root, and restore a verified snapshot rather than hand-editing journal or
generation files.

The same crash contract is release-gated on local macOS/Linux filesystems and
native x64 Windows on NTFS. On Windows, kernel-owned `LockFileEx` claims are
released when a process dies, and recovery uses directory handles while
rejecting junction/reparse-point traversal before rename or deletion. This does
not make arbitrary network shares, sync folders, or filesystems without local
atomic link/rename semantics supported storage targets.

---

## Limitations

| Limitation                           | Detail                                                                                                                                                                                               |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Filesystem-only engine**           | One engine writes to one supported local path. Snapshot, replication, and remote-copy tooling remain deployment concerns outside FYLO.                                                               |
| **Local-filesystem locking**         | PID-aware lock files plus kernel-owned takeover claims; live owners are never evicted by TTL. Use local POSIX filesystems or NTFS, not network/sync filesystems without equivalent atomic semantics. |
| **Indexes are derived**              | External writes to data files won't update indexes. Use `db.<collection>.rebuild()`.                                                                                                                 |
| **Frequency leaks on encryption**    | HMAC blind indexes for `$eq` reveal value repetition even without decryption.                                                                                                                        |
| **Process-global cipher**            | One key per process for all `$encrypted` fields. No per-collection key rotation built in.                                                                                                            |
| **No cross-collection transactions** | SQL mutations and ordinary writes are atomic within one collection; there is no atomic multi-collection commit.                                                                                      |
| **Timestamp metadata**               | `createdAt` comes from TTID; `updatedAt` comes from file modification metadata. Every timestamp is whole epoch milliseconds.                                                                         |
| **Canonical identifiers**            | TTID matches case-insensitively but FYLO names a file after the identifier, so a write with a non-canonical spelling is refused. `ttid canonicalize` repairs one.                                    |
| **Shard width is per collection**    | Recorded in the catalog descriptor and 1–4. A write configured for a different width fails with `ESHARDWIDTH`; `fylo reshard` moves the collection.                                                  |
| **Bulk import for trusted sources**  | SSRF guard blocks private addresses and caps at 50 MiB. Not for user-provided URLs.                                                                                                                  |

---

## License

MIT © D31MA
