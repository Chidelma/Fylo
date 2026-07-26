# Rust Native Read-only Preview

`fylo-rust` opens the current JavaScript filesystem layout without creating or
changing files. It is an inspection and compatibility tool, not yet the default
FYLO binary.

```bash
cargo run -p fylo-cli --bin fylo-rust -- version
cargo run -p fylo-cli --bin fylo-rust -- \
  inspect --root /path/to/root --collection users
cargo run -p fylo-cli --bin fylo-rust -- \
  get --root /path/to/root --collection users --id 4VRNF52JPCO
cargo run -p fylo-cli --bin fylo-rust -- \
  scan-index --root /path/to/root --collection users \
  --queries '[{"prefix":"name/eq/Ada/"}]'
```

The preview:

- canonicalizes root identity;
- rejects symlinks below the trusted root;
- validates collection names, TTIDs, descriptors, generation state,
  documents, and index snapshots;
- bounds every file and query read;
- reads the collection generation before and after the operation;
- retries only stable generations and fails if a writer remains active;
- exposes only `version`, `inspect`, `get`, and `scan-index`.

It currently supports JSON document reads and prefix-index scans. File
collection payloads, custom xattrs, permissions, encryption, deleted
documents, WAL overlays, rebuilds, full structured queries, and all mutations
remain on the JavaScript engine. Those are promotion blockers, not implicit
support.

Opening a root through this preview does not acquire a writer lock and does not
recover interrupted transactions. A `writing` generation fails closed so the
authoritative JavaScript recovery path can run.
