# Rust Native Read-only Preview

`fylo-rust` opens the current JavaScript filesystem layout without creating or
changing files. It is an inspection and compatibility tool, not yet the default
FYLO binary.

```bash
cargo run -p fylo-cli --bin fylo-rust -- version
cargo run -p fylo-cli --bin fylo-rust -- \
  inspect --root /path/to/root --collection users
cargo run -p fylo-cli --bin fylo-rust -- \
  log --root /path/to/root --limit 50
cargo run -p fylo-cli --bin fylo-rust -- \
  verify-history --root /path/to/root --limit 50
cargo run -p fylo-cli --bin fylo-rust -- \
  get --root /path/to/root --collection users --id 4VRNF52JPCO
cargo run -p fylo-cli --bin fylo-rust -- \
  get-file --root /path/to/root --collection assets --id 4VRNF52JPCO
cargo run -p fylo-cli --bin fylo-rust -- \
  get-deleted --root /path/to/root --collection users --id 4VRNF52JPCO
cargo run -p fylo-cli --bin fylo-rust -- \
  scan-index --root /path/to/root --collection users \
  --queries '[{"prefix":"name/eq/Ada/"}]'
cargo run -p fylo-cli --bin fylo-rust -- \
  verify-index --root /path/to/root --collection users
cargo run -p fylo-cli --bin fylo-rust -- \
  find --root /path/to/root --collection users \
  --query '{"$ops":[{"score":{"$gte":40}}],"$limit":10}'
cargo run -p fylo-cli --bin fylo-rust -- \
  sql --root /path/to/root \
  --statement "SELECT name FROM users WHERE score >= 40 LIMIT 10"
```

The preview:

- canonicalizes root identity;
- rejects symlinks and Windows reparse points below the trusted root;
- validates collection names, TTIDs, descriptors, generation state,
  documents, and index snapshots;
- bounds every file and query read;
- reads the collection generation before and after the operation;
- retries only stable generations and fails if a writer remains active;
- exposes only `version`, `inspect`, `get`, `scan-index`, `verify-index`,
  `find`, `log`, `verify-history`, and read-only `sql`, plus `get-file`,
  `get-deleted`, and `get-deleted-file`.

It currently supports live and retained-deleted JSON documents and raw files,
canonical/custom metadata, Unix xattrs and UID/GID/mode, the existing Windows
ADS manifest representation, schema-driven encrypted-field reads, portable
structured predicates, SQL SELECT projection/grouping, and prefix-index scans
with WAL overlays. `verify-index` rejects orphaned references, independently
rebuilds JavaScript-compatible keys from authoritative documents/raw-file
manifests, and reports exact missing/extra key counts. Its portable builder
covers ECMAScript number formatting/coercion, URI encoding, numeric sort keys,
reverse strings, trigrams, and schema-encrypted blind-index tokens. `log`
validates and reads the active branch’s bounded first-parent commit manifests
without materializing a version. `verify-history` traverses every parent in the
active head’s reachable commit DAG and hashes and structurally validates every
unique content-addressed tree and blob. It rejects cycles, reports whether the
commit limit covered the whole graph, and never materializes historical data.
Every native file read compares the opened handle with a newly opened identity
for the validated path before consuming bytes. The reviewed safe adapter uses
device/inode identity on Unix and volume/file identity on Windows, avoiding the
unstable standard-library `windows_by_handle` APIs. Raw-file reads repeat that
comparison after ADS/xattr and body access. Native Windows execution evidence
for that race boundary, joins, and all mutations remain promotion blockers.

Historical object verification is deliberately bounded to 1,000,000 unique
objects, 16 GiB aggregate bytes, 16 MiB per tree node, and 256 MiB per blob in
this preview.

Encrypted reads use the same environment contract as JavaScript:

```bash
export FYLO_SCHEMA=/path/to/schemas
export FYLO_ENCRYPTION_KEY='at-least-32-characters-of-secret-material'
export FYLO_CIPHER_SALT='deployment-specific-random-salt'
```

The preview reads the schema manifest’s current `$encrypted` field list,
derives the AES-256-GCM key with the existing PBKDF2 parameters, and fails
closed if the schema/key is missing, the key is wrong, or an envelope is
corrupt. Ciphertext is not included in its errors.

Opening a root through this preview does not acquire a writer lock and does not
recover interrupted transactions. A `writing` generation fails closed so the
authoritative JavaScript recovery path can run.
