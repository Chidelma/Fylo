# FYLO Support

## Getting help

Use GitHub Discussions or a focused GitHub issue for installation, API,
compatibility, and operational questions. Include the FYLO version, operating
system, architecture, filesystem, runtime version, minimal reproduction, and
the complete safe error code/message.

Do not attach production data, credentials, encryption keys, private endpoint
details, or unredacted roots. Suspected vulnerabilities must be reported
privately through `SECURITY.md`.

## Support boundaries

Support applies only to the exact release, artifact, platform, filesystem or
browser APIs, and deployment profile listed in its compatibility matrix.
Compiler target availability and cross-compilation do not prove runtime
support.

The Rust rewrite is currently experimental/read-only preview work. It must not
be used as an authoritative writer until its transaction, recovery,
compatibility, security, and native release gates pass. The existing
JavaScript engine remains the compatibility oracle during migration.

Network shares, synchronized folders, unqualified S3-compatible providers,
translated/emulated targets, and browser APIs outside the published matrix are
unsupported unless a release explicitly says otherwise.

## Data safety

Before upgrades or repair:

1. stop every writer for the root;
2. take and verify a backup;
3. retain the previous compatible executable;
4. test restore into a new empty root;
5. follow the release-specific upgrade and rollback guidance.

Never run JavaScript and Rust writers against the same root. Differential
write tests use cloned roots.

## Lifecycle

Support levels, deprecation windows, and compatibility claims use
`docs/releases/support-tiers.md`. CalVer identifies a release but does not by
itself promise a support tier or duration.
