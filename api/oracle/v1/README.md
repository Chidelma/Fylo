# Released JavaScript Oracle Sources

`releases.json` pins immutable FYLO JavaScript-engine release binaries used to
generate compatibility roots. Each entry records the release tag, embedded
source commit, target asset, and release checksum.

The recorder rejects development builds, version/tag drift, and checksum
drift. Generated roots record:

- exact producer and binary identity;
- platform and filesystem identity;
- operations and observable probes;
- a content digest;
- native modes, ownership, timestamps, and xattrs/ADS in a sidecar manifest.

CI generates and immediately verifies each root with both the released binary
contract and the Rust reader. Generated roots are retained as evidence
artifacts rather than committed to Git.

After downloading an artifact, restore the portable metadata sidecar before
running compatibility checks:

```bash
bun run rust:oracle:restore --input /path/to/oracle --ownership best-effort
```

Use `--ownership require` in privileged qualification environments where
numeric UID/GID preservation is part of the support contract.
