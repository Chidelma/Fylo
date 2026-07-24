<p align="center">
  <strong style="font-size: 2em;">FYLO</strong><br/>
  <em>A single-binary document store with zero-payload prefix indexes and language shims for Python, Ruby, Node, Go, Rust, C#, Java, PHP, and Dart, plus local-first browser, mobile (iOS/Android), and Flutter clients.</em>
</p>

<p align="center">
  <a href="https://github.com/d31ma/Fylo/releases/latest"><img src="https://img.shields.io/github/v/release/d31ma/Fylo?label=latest&color=blue" alt="Latest Release"></a>
  <a href="https://github.com/d31ma/Fylo/actions"><img src="https://img.shields.io/github/actions/workflow/status/d31ma/Fylo/publish.yml?label=build" alt="Build Status"></a>
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
- [WORM Mode](#worm-mode)
- [Syncing & Replication](#syncing--replication)
- [Remote Access](#remote-access)
- [Local Queue](#local-queue)
- [CLI & Machine Interface](#cli--machine-interface)
- [Recovery & Rebuild](#recovery--rebuild)
- [Limitations](#limitations)
- [License](#license)

---

## Why FYLO?

FYLO trades complexity for clarity. Documents are plain JSON files on disk. Indexes are zero-byte key entries that accelerate queries without duplicating data. If the index ever drifts, FYLO rebuilds it from the documents — the files are always the source of truth.

| Principle                    | Implementation                                                                           |
| ---------------------------- | ---------------------------------------------------------------------------------------- |
| **Documents are truth**      | One `.json` file per document, sharded by TTID prefix                                    |
| **Indexes are accelerators** | Zero-payload prefix keys in a sorted catalog file                                        |
| **Rebuildable, not sacred**  | `fylo.<collection>.rebuild()` reconstructs indexes from data                             |
| **Zero-dependency core**     | Embedded SQLite catalog, memory-mapped I/O, native S3 backup — one self-contained binary |
| **Filesystem-first**         | One engine. Back up to S3 or attach custom sync hooks when needed                        |
| **Browser: local-only**      | OPFS engine in the browser — each device owns its own store, fully offline               |

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

Document collections live under `.collections`; buckets (for raw files) live
under `.buckets`. The two are structurally identical — only the top-level
directory differs. Collections hold `Record` values; buckets hold `Blob`/`File`
values:

```text
<root>/.collections/<collection>/   ← documents (Record)
<root>/.buckets/<bucket>/           ← raw files (Blob / File), same internal layout:
  docs/                    ← one file per document/object (TTID-named)
    4U/
      4UUB32VGUDW.json
  .deleted/                ← soft-deleted payloads (hidden sibling of docs/)
    4U/
      4UUB32VGUDW.json
  index/                   ← local filesystem prefix index catalog
    manifest.json          ← format version marker
    keys.snapshot          ← sorted index keys, mmap'd for O(log n) lookup
    keys.wal               ← append-only mutation log (compacted at 1 MiB)
  events/
    <collection>.ndjson    ← append-only event journal
  locks/                   ← advisory file locks
```

FYLO keeps the logical transaction journal outside collection trees so it is
not mistaken for a document, indexed, versioned, or mirrored to S3:

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

**Index keys** look like S3 object keys — field path, kind, value, doc ID:

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
that can always be rebuilt from them. S3 is never in the query hot path — it is
only a [backup target](#syncing--replication).

---

## Browser access

The browser client is **local-only**: a bundled OPFS engine (`fylo-web.mjs`,
released as an asset) that reads and writes a browser-local store directly.
There is no network access and no backend — each browser (and each mobile app
hosting the engine in a WebView) owns its own database.

Add the version-pinned loader to the document head:

```html
<script src="https://d31ma.github.io/FYLO/version/26.30.04/fylo.js"></script>
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
`https://d31ma.github.io/FYLO/version/26.30.04/fylo-web.mjs` instead.

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
VERSION=26.30.04
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
| `FYLO_ENCRYPTION_KEY` | AES-GCM key for `$encrypted` fields (≥32 chars) | —              |
| `FYLO_CIPHER_SALT`    | Salt for blind index derivation                 | —              |
| `FYLO_LOGGING`        | Enable logging (`"1"`)                          | —              |
| `FYLO_REDIS_URL`      | FYLO-specific Redis URL for query caching       | —              |

S3 backup credentials (resolved in order: explicit options → `AWS_*` → `FYLO_S3_*`):

| Variable                    | AWS equivalent                             |
| --------------------------- | ------------------------------------------ |
| `FYLO_S3_ACCESS_KEY_ID`     | `AWS_ACCESS_KEY_ID`                        |
| `FYLO_S3_SECRET_ACCESS_KEY` | `AWS_SECRET_ACCESS_KEY`                    |
| `FYLO_S3_SESSION_TOKEN`     | `AWS_SESSION_TOKEN`                        |
| `FYLO_S3_ENDPOINT`          | `AWS_ENDPOINT_URL_S3` / `AWS_ENDPOINT_URL` |
| `FYLO_S3_REGION`            | `AWS_REGION` / `AWS_DEFAULT_REGION`        |

Copy `.env.example` to `.env` and fill in your values.

### Query Cache

Query caching is off by default. When enabled, FYLO caches matched TTID lists
and still hydrates documents from the canonical storage files.

```ts
const fylo = new Fylo('/mnt/fylo', {
    cache: true // memory cache, method: 'cache-aside', ttl: 30
})
```

Use a Redis client for shared production caches:

```ts
const fylo = new Fylo('/mnt/fylo', {
    cache: {
        backend: 'redis',
        method: 'cache-aside',
        ttl: 60,
        redis: {
            url: process.env.FYLO_REDIS_URL
        }
    }
})
```

If `cache.redis.url` is omitted, FYLO checks `FYLO_REDIS_URL`; otherwise the
Redis client resolves its own defaults (`REDIS_URL`, `VALKEY_URL`, then local
Redis). Cache invalidation is version-based per collection, so writes bump the
collection version and old Redis keys expire naturally by TTL.

Supported cache methods:

| Method          | FYLO behavior                                                                |
| --------------- | ---------------------------------------------------------------------------- |
| `cache-aside`   | Read checks cache first, loads from FYLO storage on miss, then caches TTIDs. |
| `read-through`  | Same storage path as cache-aside, exposed as a cache-fronted read strategy.  |
| `write-through` | Writes require the cache version bump to succeed before the call returns.    |
| `write-around`  | Writes avoid payload caching and only bump the collection cache version.     |

FYLO currently caches TTID result lists, not full document payloads. This keeps
Redis free of decrypted user documents while still avoiding repeated index
lookups on hot queries. Identical in-process misses are single-flighted to avoid
local cache stampedes.

---

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
const doc = await db.users.get(id).once()
```

### Update (preserves the document TTID)

```ts
const sameId = await db.users.patch(id, { team: 'core-platform' })
```

### Delete

```ts
await db.users.delete(sameId) // moves payload to .deleted/4U/4UUB32VGUDW.json
```

Soft-deleted files retain their TTID filename, use file `mtime` as `deletedAt`,
and become read-only (`0444`). They are excluded from ordinary queries.

### Recover Deleted Documents

```ts
const deleted = {}
for await (const doc of db.users.find
    .deleted({
        $deleted: { $gte: Date.parse('2026-05-01T00:00:00Z') }
    })
    .collect()) {
    Object.assign(deleted, doc)
}

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

File collections also support S3-style logical object keys. `/` is the default;
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
.buckets/assets/docs/<TTID-prefix>/<TTID>.<original-extension>
```

No source path or URL is retained. Metadata is derived from the stored file,
with the logical `key` stored as a `user.fylo.key` extended attribute (xattr)
on the file itself, so it travels with the bytes across moves:
`name`, `key`, `extension`, `contentType`, `contentLength`, `etag`,
`checksumSHA256`, `createdAt`, and `lastModified`. These fields use the normal
prefix index and can be queried with `find()`.

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

Those fluent signatures belong to the native JavaScript and browser collection
facades. Binary-backed language shims expose the same behavior as
`getMeta(collection, id)` and `setMeta(collection, id, record)`, with
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
restores (it is snapshotted with each commit), and is frozen alongside the
bytes in WORM mode. If a store directory is ever copied by an xattr-dropping
tool, `rebuild()` repairs each stripped file to its default `/<filename>` key
(emitting a `file.key-repaired` event; custom keys are not recoverable from
bytes alone — use a version-control restore for full fidelity). Filesystem-backed
document and file collections use native xattrs on macOS/Linux and an NTFS
Alternate Data Stream manifest on Windows. Browser document collections use the
durable OPFS sidecar instead.
Metadata is per-version on filesystem-backed JSON documents (a `patch` writes
a new version file). The machine ops `getMeta`/`setMeta` cover it from any
client shim. The low-level helpers `getXattr` / `setXattr` / `listXattr` /
`removeXattr` are exported from the package for raw byte-level access.

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

---

## Querying

FYLO queries use prefix indexes first, then hydrate only matching documents.

```ts
// Exact match
const results = {}
for await (const doc of db.users
    .find({
        $ops: [{ name: { $eq: 'Alice' } }]
    })
    .collect()) {
    Object.assign(results, doc)
}

// Range query (numeric fields)
for await (const doc of db.users
    .find({
        $ops: [{ age: { $gte: 18 } }]
    })
    .collect()) {
    Object.assign(results, doc)
}

// Contains (array membership)
for await (const doc of db.users
    .find({
        $ops: [{ tags: { $contains: 'engineering' } }]
    })
    .collect()) {
    Object.assign(results, doc)
}

// OR across conditions
for await (const doc of db.users
    .find({
        $ops: [{ role: { $eq: 'admin' } }, { role: { $eq: 'owner' } }]
    })
    .collect()) {
    Object.assign(results, doc)
}
```

### SQL Support

```ts
const { sql } = new Fylo('/mnt/fylo')

await sql`CREATE TABLE posts`
const id = await sql`INSERT INTO posts (title, published) VALUES (${'Hello'}, ${true})`
const posts = await sql`SELECT * FROM posts WHERE published = ${true}`
```

`UPDATE` and `DELETE` statements are atomic within their collection: either
every matched document, its xattrs, index entries, and local event records
commit, or the statement restores all before-images. External sync hooks and
queue publication run only after the local commit is durable.

Use `EXPLAIN` to inspect the selected access path without executing the
statement, or `EXPLAIN ANALYZE` to execute it and include elapsed time and the
result:

```ts
const plan = await db._sql("EXPLAIN SELECT * FROM posts WHERE title = 'Hello'")
// { operation: 'SELECT', collection: 'posts', access: [...], executed: false }

const prepared = db.prepare('SELECT * FROM posts WHERE published = true')
prepared.explain() // synchronous plan description
const first = await prepared.execute()
const second = await prepared.execute() // reuses the parsed plan
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

By default Fylo resolves membership from the host POSIX group database. An
application using virtual users or an external identity provider can supply a
trusted resolver when it opens the database:

```js
const db = new Fylo('/mnt/fylo', {
    access: {
        groupsForUid: async (uid) => identityProvider.groupIdsFor(uid)
    }
})
```

In-process operation callers provide only `{ uid }`; they cannot assert their
own group membership. Resolver failures fail closed.

The standalone binary also supports application-authenticated virtual
identities over its local NDJSON boundary. Every document and raw-file
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
    .get(id)
    .as({ uid: 1001 })
    .metadata()
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
    "$encrypted": ["ssn", "email"],
    "id": "^[0-9]+$",
    "name": "^.+$",
    "email": "^.+$",
    "ssn?": "^[0-9-]+$"
}
```

Requirements:

- `FYLO_ENCRYPTION_KEY` must be ≥32 characters
- `FYLO_CIPHER_SALT` is recommended
- Process-global: one key for all collections

---

## WORM Mode

Strict write-once storage for immutable documents:

```ts
const db = new Fylo('/mnt/fylo', {
    worm: {
        mode: 'strict'
    }
})

const id = await db.posts.put({ title: 'retain me' })
await db.posts.patch(id, { title: 'changed' }) // throws
await db.posts.delete(id) // throws
```

- A WORM document is written once and its local file is changed to read-only (`0444`)
- Update, delete, and dropping a non-empty WORM collection are rejected
- WORM does not create document versions or document history
- `createdAt` is derived from the TTID; `updatedAt` is derived from file metadata
- Collections containing legacy `heads/` or `versions/` WORM metadata fail closed and must be migrated before use

---

## Syncing & Replication

FYLO owns document storage and querying. **You** own how the root directory reaches remote storage.

Sync hooks let FYLO notify your storage client:

```ts
const fylo = new Fylo('/mnt/fylo', {
    syncMode: 'await-sync', // or 'fire-and-forget'
    sync: {
        async onWrite(event) {
            await s3.putObject({
                key: `${event.collection}/${event.docId}.json`,
                body: await readFile(event.path)
            })
        },
        async onDelete(event) {
            await s3.deleteObject({
                key: `${event.collection}/${event.docId}.json`
            })
        }
    }
})
```

| Mode              | Behavior                                       |
| ----------------- | ---------------------------------------------- |
| `await-sync`      | Waits for hook, throws if sync fails           |
| `fire-and-forget` | Commits locally first, runs hook in background |

Strict WORM mode emits its initial write sync event only; mutation callbacks cannot occur because updates and deletes are rejected.

### Built-in S3 backup

Instead of writing hooks, point `sync.s3` at a bucket and FYLO mirrors the
**whole root** (documents, buckets, index, catalog, vcs) to S3 as a backup. The
local filesystem stays the source of truth; S3 is a copy, never queried.

```ts
const fylo = new Fylo('/mnt/fylo', {
    sync: {
        s3: {
            bucket: 'fylo-backup',
            prefix: 'prod/fylo', // required safety boundary in a shared bucket
            region: 'us-east-1',
            reconcileIntervalMs: 60_000, // minimum 1 second; omit to disable
            concurrency: 4, // maximum simultaneous S3 requests
            maxFileBytes: 64 * 1024 * 1024,
            maxManifestBytes: 1024 * 1024,
            maxReconcileSnapshotBytes: 512 * 1024 * 1024, // default whole-pass snapshot cap
            retry: { attempts: 3, baseDelayMs: 100, maxDelayMs: 5_000 }
        }
    }
})

await fylo.reconcile() // force a full whole-root reconcile on demand (alias: backup())
console.log(fylo.backupStatus()) // state, attempted runs, and last pass details
await fylo.close() // cancels pending passes and drains active remote work
```

Two passes work together: touched files are **mirrored after local commit**
(under the same `syncMode`), and `reconcile()` walks the whole root to make S3 match
exactly — uploading changed files and deleting objects with no local
counterpart. Credentials resolve from explicit options, then `AWS_*` env vars,
then `FYLO_S3_*` aliases. `sync.s3` and custom `onWrite`/`onDelete` hooks can be
used together. The local `.fylo-transactions/` recovery journal is intentionally
excluded from backup; only committed data and durable database metadata belong
in the remote mirror.

`backupStatus()` returns `undefined` when S3 backup is not configured. Otherwise
its `runs` count includes both successful and failed reconcile attempts; inspect
`state`, `lastSuccessAt`, `lastFailureAt`, and `lastError` together.

Only one reconcile pass runs at a time. Requests received during a pass coalesce
into at most one pending pass, while mirror, delete, and reconcile mutations
share one ordered lane. Transient throttling, timeout, network, and 5xx failures
use bounded exponential backoff with jitter; permanent 4xx failures fail
immediately. Files larger than `maxFileBytes` and remote metadata manifests
larger than `maxManifestBytes` are rejected before processing. Reconciliation
also materializes one immutable view of the local root before changing S3;
`maxReconcileSnapshotBytes` caps the sum of file bytes and encoded xattr values
held for that view (default 512 MiB). The cap is an accounting guard, not a
process RSS ceiling: allow additional memory for object/map overhead, one more
file validation snapshot up to `maxFileBytes`, S3 requests, and the Bun runtime.
Each pass emits
`backup.reconcile.started`, `.succeeded`, or `.failed`;
individual retry attempts emit `backup.retry`. See
[`ops/s3-backup.md`](ops/s3-backup.md) for inspection and recovery guidance.

`prefix` is required by default because reconciliation deletes stale objects
inside its scope. Use a dedicated bucket or a unique prefix per FYLO root and
grant only `s3:ListBucket` for that prefix plus `s3:GetObject`, `s3:PutObject`,
and `s3:DeleteObject` for `arn:aws:s3:::BUCKET/PREFIX/*`. Bucket-root backup is
available only as the explicit `allowBucketRoot: true` opt-in and should be used
only with a dedicated bucket and a least-privilege IAM identity.

```json
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Action": "s3:ListBucket",
            "Resource": "arn:aws:s3:::BUCKET",
            "Condition": {
                "StringLike": { "s3:prefix": ["prod/fylo", "prod/fylo/*"] }
            }
        },
        {
            "Effect": "Allow",
            "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
            "Resource": "arn:aws:s3:::BUCKET/prod/fylo/*"
        }
    ]
}
```

Every data object has a versioned, platform-specific recovery manifest under
`.fylo-backup/xattrs/<base64url-object-key>.json`. The manifest records the data
key, byte length, SHA-256 digest, native mode/mtime, and FYLO metadata from the
same pinned descriptor as the bytes. POSIX manifests preserve xattrs, including
access descriptors and `user.fylo.meta.*` developer metadata. NTFS manifests
preserve FYLO alternate-data-stream metadata and the native read-only/writeable
mode projection. Recovery rejects a manifest created for a different platform
family instead of silently dropping ownership or access semantics.

#### S3 recovery runbook

Recovery always targets a **new, nonexistent directory**. It lists every S3
page, validates the key and sidecar before accepting bytes, streams with bounded
memory and concurrency, restores xattrs, and atomically renames a complete
staging root into place. It never merges into or overwrites an existing root.

1. Stop writers to the affected root. Preserve the failed root separately; do
   not point recovery at its path.
2. Give the recovery identity only `s3:ListBucket` on the selected prefix and
   `s3:GetObject` on `BUCKET/PREFIX/*`.
3. Verify first. The command exits nonzero on a missing/invalid manifest,
   unsafe key, empty prefix, size mismatch, checksum mismatch, cancellation, or
   exhausted S3 retry.

```bash
fylo backup verify \
  --backup-bucket fylo-backup \
  --backup-prefix prod/fylo \
  --backup-region us-east-1 \
  --json
```

4. Restore to a new sibling path. Progress is emitted as NDJSON on stderr and
   the final result as JSON on stdout.

```bash
fylo backup restore \
  --backup-bucket fylo-backup \
  --backup-prefix prod/fylo \
  --backup-region us-east-1 \
  --destination /mnt/fylo-restored \
  --backup-concurrency 4 \
  --json
```

5. With application writers still stopped, open the restored root and run
   collection verification. Switch the application mount/service configuration
   during a maintenance window. Keep the old root and S3 backup until
   post-recovery validation completes.

The same workflow is available programmatically:

```js
import { FyloS3Restore } from '@d31ma/fylo'

const recovery = new FyloS3Restore(
    { bucket: 'fylo-backup', prefix: 'prod/fylo', region: 'us-east-1' },
    '/mnt/fylo-restored'
)
await recovery.verify()
await recovery.restore({ concurrency: 4, signal: abortController.signal })
```

The binary also accepts `--backup-endpoint` for any S3-compatible provider.
Credentials are read from `AWS_*` or `FYLO_S3_*` environment variables and are
never placed in machine requests, handshakes, logs, or status results. A restore
holds the same canonical root reservation used by an exclusive machine loop;
an active owner returns `EROOTLOCKED` before any remote request.

Windows backup and restore require local x64 Windows on NTFS. Native Windows CI
tests the exact descriptor/ADS path and restored FYLO access metadata. POSIX and
NTFS manifests are intentionally not portable across families because neither
native UID/GID ownership nor NTFS access semantics can be translated without
loss.

An interrupted or failed restore removes its uniquely named staging directory.
If the process is killed before cleanup runs, remove only a matching
`<destination>.fylo-restore-*.tmp` directory after confirming no recovery
process is active; never rename an unverified staging directory into service.

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

## Local Queue

Opt-in durable local queue for event-driven workflows. This is an in-process
API — use it when embedding FYLO from source (`src/`):

```ts
import Fylo from './src/index.js'
import { consume, publish } from './src/queue/local.js'

const db = new Fylo('/mnt/fylo', { queue: true })

class UserConsumer {
    @consume('users.insert', { group: 'email-service', autoAck: false })
    async welcome(message, context) {
        await sendWelcomeEmail(message.payload.doc.email)
        context.ack()
    }
}

class UserService {
    @publish('users.created')
    async createUser(input) {
        return { id: 'u1', email: input.email }
    }
}

await db.queue.drainRegistered(new UserConsumer())
```

Queue files:

```text
<root>/.queue/topics/<topic>.ndjson
<root>/.queue/consumers/<group>/<topic>.json
<root>/.queue/dlq/<topic>.ndjson
```

At-least-once delivery, consumer-group checkpoints, advisory leases, retry tracking, dead-letter files. Handlers should be idempotent.

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
failed writes and no-op mutations do not create empty commits. Strict WORM
collections are excluded so WORM remains write-once without version history.

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

Supported operations: `handshake`, `executeSQL`, `createCollection`, `dropCollection`, `inspectCollection`, `rebuildCollection`, `getDoc`, `getLatest`, `getMeta`, `setMeta`, `findDocs`, `findDeletedDocs`, `restoreDoc`, `joinDocs`, `putData`, `batchPutData`, `patchDoc`, `patchDocs`, `delDoc`, `delDocs`, `importBulkData`, `backupStatus`, `backupReconcile`, `checkout`, `branch`, `commit`, `log`, `status`, `diff`, `restoreCommit`, `merge`, `schemaInspect`, `schemaCurrent`, `schemaHistory`, `schemaDoctor`, `schemaValidate`, `schemaMaterialize`.

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
materializes an immutable, disk-backed snapshot ordered by TTID binary text, so
concurrent mutations cannot duplicate or skip entries. Cursors are scoped to
the operation, collection, query, and access identity; they expire after 15
minutes and become invalid when the loop exits. On `EINVALIDCURSOR` or child
restart, discard partial state and restart from page one. Snapshot storage is
private, cleaned on completion/expiry/shutdown, capped at 1 GiB, and never
loads the complete result into the JavaScript heap.

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

| Code                                                                   | Meaning                                                                    | Retry guidance                                               |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `EBADREQUEST`                                                          | The request shape, field types, access object, or page options are invalid | Do not retry; fix the request                                |
| `EUNSUPPORTEDOP`                                                       | The operation is unknown to this runtime                                   | Do not retry; check the handshake capabilities               |
| `EINVALIDDOCID`                                                        | The supplied document ID is not a valid TTID                               | Do not retry; fix the ID                                     |
| `EARRAYOFOBJECTS`                                                      | The document contains an array of objects, which the data model rejects    | Do not retry; restructure per the document-model rule below  |
| `EACCES`                                                               | The access context is not permitted to perform the operation               | Do not retry with the same identity                          |
| `EINVALIDCURSOR`                                                       | The pagination cursor is invalid, expired, or from another process         | Restart the traversal from page one                          |
| `EROOTLOCKED` / `EROOTLEASELOST`                                       | Exclusive root ownership was unavailable or lost                           | Fail over per your supervisor policy                         |
| `EBACKUPNOTCONFIGURED`                                                 | A backup operation was sent to a loop without backup configuration         | Do not retry without configuration                           |
| `EFRAME_*`                                                             | Frame-contract violations, as documented above                             | Per the framing rules above                                  |
| `EQUERYLOOPREQUIRED` / `EQUERYITEMTOOLARGE` / `EQUERYSNAPSHOTTOOLARGE` | Pagination contract violations, as documented above                        | Per the pagination rules above                               |
| `EUNKNOWN`                                                             | An engine failure without a more specific classification                   | Treat conservatively; inspect `error.message` diagnostically |

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
rejection is deterministic and leaves no partial state — the write never
starts. This applies equally to `putData`, `batchPutData`, patches, and the
in-process API.

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
//   worm: true,
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
under `.fylo-vcs/staging/`. `VersionRepository.init()` recovers interrupted
transactions before collection bootstrap. The shared staging directory is a
permanent coordination root; completed transaction directories are removed.
Multiple processes may initialize concurrently: one recovery owner performs the
work while the others wait and then observe the recovered tree and ref.

Ordinary collection writes use a separate logical journal under
`.fylo-transactions/`. If a process dies before the commit marker, recovery
restores document bytes, file modes, mtimes, xattrs, and the event-journal
offset, then rebuilds the derived index. If it dies after the marker, recovery
keeps the committed files and completes publication of the stable generation.

Inspect a collection without reading journal files directly:

```js
const status = await fylo.recoveryStatus('posts')
// {
//   collection: 'posts',
//   generation: 7,
//   state: 'stable', // or 'writing' / 'corrupt'
//   activity: { status: 'idle', lastAction: 'recovery', ... }
// }
```

`state` and `generation` come from the durable collection-generation record;
`transactionId` is also present while that record is `writing`. `activity`
reports the latest rollback or startup recovery observed by the current FYLO
instance: `rolling-back`, `recovering`, `idle`, or `failed`, with transaction,
operation, phase, timestamps, and failure detail when available. A malformed
durable record returns `state: 'corrupt'` with `detail`. Treat `writing`,
when no collection transaction is currently in flight, `corrupt`, or
`activity.status === 'failed'` after initialization as an operator incident:
stop writers, preserve the root, inspect the emitted error, and repair the
filesystem or restore a verified backup. Do not hand-edit the journal or
generation record.

Configure `onEvent` to forward recovery lifecycle events:

- `transaction.rollback.started|succeeded|failed` covers rollback in the
  process that attempted the operation;
- `transaction.recovery.started|succeeded|failed` covers reopening an
  interrupted journal; `phase: 'active'` rolls back and `phase: 'committed'`
  rolls forward;
- `index.rebuilt` confirms the derived index was regenerated during rollback
  or recovery.

Alert on every `.failed` event and record elapsed time from the paired
timestamps. Event handlers are best-effort observability hooks, not a durable
audit log; FYLO catches handler failures so monitoring code cannot break the
storage operation.

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
| **Filesystem-first engine**          | One engine writes to a local path. S3 is a backup mirror, not a query or transaction backend.                                                                                                        |
| **Local-filesystem locking**         | PID-aware lock files plus kernel-owned takeover claims; live owners are never evicted by TTL. Use local POSIX filesystems or NTFS, not network/sync filesystems without equivalent atomic semantics. |
| **Indexes are derived**              | External writes to data files won't update indexes. Use `db.<collection>.rebuild()`.                                                                                                                 |
| **Local strict WORM**                | FYLO rejects mutation and applies `0444`; privileged filesystem administrators can bypass it.                                                                                                        |
| **Frequency leaks on encryption**    | HMAC blind indexes for `$eq` reveal value repetition even without decryption.                                                                                                                        |
| **Process-global cipher**            | One key per process for all `$encrypted` fields. No per-collection key rotation built in.                                                                                                            |
| **No cross-collection transactions** | SQL mutations and ordinary writes are atomic within one collection; there is no atomic multi-collection commit.                                                                                      |
| **Timestamp metadata**               | `createdAt` comes from TTID; `updatedAt` comes from file modification metadata.                                                                                                                      |
| **Bulk import for trusted sources**  | SSRF guard blocks private addresses and caps at 50 MiB. Not for user-provided URLs.                                                                                                                  |

---

## License

MIT © D31MA
