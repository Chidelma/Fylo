# FYLO Governance

## Decision model

FYLO is maintainer-led. Maintainers are responsible for product direction,
storage compatibility, security, releases, and the final decision to accept or
reject a change. Discussion and evidence are encouraged; silence does not
constitute approval.

Routine, reversible implementation decisions may be resolved in pull-request
review. Hard-to-reverse architecture and storage decisions require an ADR.
Externally observable API, query, permission, migration, or compatibility
changes require an RFC as defined in `docs/RUST_ENGINE_PROJECT_PLAN.md`.

## Roles

- Contributors propose issues, code, tests, documentation, and reviews.
- Code owners review their assigned contract or subsystem.
- Maintainers approve changes and assign support labels.
- Release approvers verify evidence and authorize publication.
- Security responders coordinate private vulnerability handling.

One person may hold several roles during development, but production release
work separates author, required reviewers, workflow identity, protected
environment approval, and signing identities where infrastructure permits.

## Change approval

All changes target the default branch through a pull request. Storage,
security, native platform, and release changes require review from their
CODEOWNERS. A change may merge only when required checks are current, review
threads are resolved, compatibility and rollback impact are explicit, and no
unowned critical security finding remains.

Experimental implementation does not create a support promise. Promotion uses
the vocabulary and evidence in `docs/releases/support-tiers.md`.

## Releases

FYLO uses its documented CalVer policy. Release assets are produced and
verified by protected workflows from an exact source commit. Immutable tags
and versioned artifacts are not overwritten. A faulty release is corrected
with a new version and, where safe, mutable pointers are moved through a
reviewed change.

## Amendments

Governance changes use the same review process as production code and require
maintainer approval. Accepted ADRs remain historical records and are
superseded, not rewritten.
