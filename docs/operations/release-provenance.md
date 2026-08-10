# Release provenance and SBOM

Every Release workflow produces checksums and an SPDX JSON software bill of
materials for the complete source tree, then signs GitHub artifact attestations
for every release asset. The workflow verifies each attestation before it
uploads the asset bundle used to create the draft release. Release publication
still rechecks every local checksum, every uploaded GitHub digest, the immutable
source commit, and the final tag target.

The privileged asset job is eligible only when the workflow ref is the
repository's default branch. This gate is evaluated before the runner receives
OIDC or attestation permissions and before repository build code runs. A manual
dispatch against a feature branch or tag cannot build or attest release assets;
the later publication gate independently rechecks the default branch and exact
source commit before creating a release.

The release is blocked by tests of the exact packaged Linux x64, macOS arm64,
macOS x64, and Windows x64 executables. Each executable must report release
build identity and pass the canonical-alias, simultaneous-owner, stale-metadata,
and crash-takeover root-lease contract before the artifact is passed to the
release job. The compiled-language interoperability suite is also mandatory.
Its executable digest, runtime identity, host/filesystem identity, and test
output are retained as release evidence.

## Verify an existing asset

Install and authenticate GitHub CLI, download the asset and `SHA256SUMS` from
the same release, verify the checksum, then verify provenance against this
repository:

```sh
sha256sum --check --ignore-missing SHA256SUMS
gh attestation verify ./fylo-linux-x64 --repo d31ma/Fylo
```

On macOS, use `shasum -a 256 fylo-macos-arm64` and compare it with the one
matching `SHA256SUMS` row before running the same `gh attestation verify`
command. On Windows:

```powershell
(Get-FileHash -Algorithm SHA256 .\fylo-windows-x64.exe).Hash
gh attestation verify .\fylo-windows-x64.exe --repo d31ma/Fylo
```

The release SBOM is named `fylo-<CalVer>.spdx.json`; it is itself covered by
the checksum file and signed provenance.

## Require provenance during installation

The normal installer always verifies the release checksum. Operators that also
require signed provenance can opt in. Download first so the environment flag
is applied to the installer process rather than only to `curl`:

```sh
curl -fsSL https://fylo.del.ma/install.sh -o /tmp/fylo-install.sh
FYLO_VERIFY_PROVENANCE=1 sh /tmp/fylo-install.sh
rm /tmp/fylo-install.sh
```

On Windows:

```powershell
$env:FYLO_VERIFY_PROVENANCE = '1'
irm https://fylo.del.ma/install.ps1 | iex
```

Both installers require `gh` when the option is enabled and abort before
replacing the installed executable if verification fails or GitHub CLI is
missing. CI and production image builds should pin a release version and verify
the downloaded asset directly rather than follow the mutable `latest` URL.
