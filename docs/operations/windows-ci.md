# Windows storage release gate

FYLO treats native Windows storage validation as a release requirement. The `windows-storage`
job in both CI and Release runs on GitHub-hosted x64 Windows Server 2022 and Windows Server 2025
runners. Both matrix entries must pass before a release can publish artifacts.

The gate uses the Bun version in `.bun-version` and fails immediately unless Bun reports
`win32/x64`. The Windows vendor installer downloads fixed TTID and CHEX v26.28.02 assets and
verifies them against SHA-256 digests anchored in the FYLO repository before execution. It never
executes a remote installer or trusts a checksum fetched beside the binary. The gate verifies:

- process-owned file-lock exclusion, crash release, and abandoned-lock reclamation;
- rollback and recovery after a transaction process is forcibly terminated;
- NTFS junction and reparse-point rejection at document and recovery boundaries;
- Windows metadata, durability, filesystem, collection-lock, raw-file, and version-recovery
  regressions;
- a freshly compiled `fylo.exe` persisting and reading a document through the public machine
  protocol.

Do not skip or replace this job with a Linux result. A Windows artifact is releasable only after
both native Windows matrix entries succeed. The Release workflow gives the executable its final
`fylo-windows-x64.exe` name before testing, uploads the exact Windows Server 2022-tested bytes, and
packages that artifact without rebuilding it on Linux. Windows Server 2025 independently builds
and tests the same source and final executable path as an additional compatibility gate.

The production contract covered by this gate is local x64 Windows on NTFS. FYLO uses a
kernel-owned `LockFileEx` claim so process termination releases stale takeover ownership, then
performs recovery through pinned directory handles and rejects junction/reparse-point traversal
before rooted rename or deletion. POSIX UID/GID ownership enforcement remains a POSIX-only
capability. It does not translate NTFS permissions into POSIX ownership. Network shares and synchronized folders are outside the storage guarantee because they
may not preserve the required local locking and atomic filesystem semantics.

## Local execution from Apple Silicon macOS

The development host currently has `act` 0.2.87 and Docker Desktop. `act --list` can parse and
list the Windows job, but it cannot execute it faithfully: Docker Desktop exposes a Linux/aarch64
engine, and `act` runs Actions jobs in Linux containers. Choosing or mapping an image for
`windows-2022` or `windows-2025` would therefore exercise Linux kernel and filesystem behavior,
not Windows process locks, NTFS, reparse points, or a native Windows executable.

Use `act` locally only for workflow discovery or Linux-job approximation:

```sh
act pull_request -W .github/workflows/ci.yml --list
```

Do not map a Windows label to an Ubuntu image and treat the result as Windows validation. Run the
authoritative job by pushing a branch or pull request to GitHub. For interactive failures, use an
x64 Windows Server VM with the repository checkout on an NTFS volume, then run the same commands
shown in the `windows-storage` job.
