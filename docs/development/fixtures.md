# Compatibility Fixtures

The JavaScript engine remains the compatibility oracle until each Rust phase
passes its promotion gate. Fixtures record exact producer and platform
identity instead of relying on Rust types to redefine behavior.

## Golden-root recorder

Generate a fresh black-box root into a new directory:

```bash
bun run golden:generate --output /tmp/fylo-golden-v1
bun run golden:verify --input /tmp/fylo-golden-v1
```

The output contains:

- `root/`: an ordinary FYLO filesystem root;
- `operations.ndjson`: the public operations used to construct it;
- `manifest.json`: producer/runtime/platform identity, a deterministic tree
  digest, and read probes.

The current recorder covers live and deleted documents, structured queries,
canonical/custom metadata, a platform access descriptor where UID/GID exist,
raw bytes and object keys, and rebuilt document/file indexes.

Run `bun run golden:smoke` to create the root in a temporary directory, verify
it with the JavaScript oracle, inspect it with the compiled Rust read-only
engine, and remove it.

## Fixture policy

- Never generate against production or synchronized user roots.
- A fixture manifest records the FYLO version, Bun version, OS, architecture,
  filesystem identifier, operation log, and digest.
- Platform-specific roots are separate fixtures; normalization must not erase
  meaningful mode, xattr/ADS, timestamp, or path behavior.
- Generated roots and large archives are retained as CI/release artifacts.
  Only intentionally small, reviewed contract fixtures belong in Git.
- A changed expected result requires an accepted compatibility decision, not
  a blind fixture regeneration.
- Interrupted-transaction and corruption roots are constructed by dedicated
  failpoint/corruption tools, never by editing a production root.
