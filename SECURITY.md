# Security Policy

## Supported versions

The Rust engine is a preview and makes no production-support claim. The current
JavaScript engine follows the release support window published with each FYLO
release; security fixes are prioritized on the default branch.

| Surface | Security support |
| --- | --- |
| Current JavaScript release | Published release window |
| Rust read-only preview | Best effort; no production claim |
| Historical previews | No guaranteed backports |

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use the repository's
[private vulnerability reporting form](https://github.com/d31ma/Fylo/security/advisories/new).

Include:

- affected version, commit, operating system, and filesystem;
- impact and attacker prerequisites;
- a minimal reproduction that does not contain real user data;
- whether the issue is already public;
- a suggested remediation, if known.

Do not submit credentials, encryption keys, production roots, personal data,
or private endpoint details. Maintainers will coordinate validation,
remediation, disclosure, and credit with the reporter.

## Scope

Path traversal and link races, root ownership, transaction durability,
recovery, permission bypass, UID/GID/mode handling, xattrs/ADS, encryption,
query isolation, machine framing, subprocess lifecycle, S3-compatible
backup/restore, browser storage, Wasm memory boundaries, release provenance,
and dependency compromise are in scope.

General support, feature requests, performance suggestions without a security
impact, and deployment questions belong in the public issue tracker.
