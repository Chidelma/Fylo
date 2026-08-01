# Security Policy

## Supported versions

The native Rust engine is the public executable implementation. The current
FYLO release follows the support window published with that release; security
fixes are prioritized on the default branch.

| Surface | Security support |
| --- | --- |
| Current FYLO release | Published release window |
| Unreleased Rust candidate | Best effort; no production claim |
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
query isolation, machine framing, subprocess lifecycle, browser storage, Wasm
memory boundaries, release provenance, filesystem snapshot/restore guidance,
and dependency compromise are in scope.

General support, feature requests, performance suggestions without a security
impact, and deployment questions belong in the public issue tracker.
