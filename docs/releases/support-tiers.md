# FYLO Support Tiers and Evidence Vocabulary

- Status: **Accepted**
- Date: **2026-07-26**

## Purpose

This vocabulary prevents build results, test results, preview artifacts, and
production support from being described as the same thing. A claim applies to
an exact FYLO version, artifact, operating system, architecture, filesystem,
browser/storage API, protocol, and documented deployment profile.

Rust target availability, a successful cross-compile, or a passing unit suite
is never by itself a platform support claim.

## Artifact evidence

| Term                 | Meaning                                                                                                           |
| -------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **Buildable**        | The pinned compiler emitted an artifact for the target. The artifact may never have run.                          |
| **Cross-built**      | An artifact was built for a target different from the builder. This proves buildability only.                     |
| **Native-tested**    | The exact artifact passed the named test profile on its target OS and architecture.                               |
| **Packaged**         | The native-tested artifact was signed where required, archived, checksummed, and accompanied by a manifest.       |
| **Release-verified** | The downloadable packaged bytes passed checksum, signature/provenance, identity, install, and smoke verification. |

## Product support tiers

### Unsupported

No compatibility or operational commitment exists. The project may reject the
configuration, and maintainers may be unable to reproduce defects.

### Experimental

The capability is available only for engineering evaluation:

- behavior or format may change;
- migration may not exist;
- performance is not a commitment;
- production data must not rely on it;
- known missing evidence is published.

### Developer preview

The primary contract works for development use:

- basic implementation and contract tests pass;
- artifacts identify their version and target;
- limitations and data-safety gaps are explicit;
- production support, recovery, and compatibility are not claimed.

### Production preview

The capability is a candidate for production qualification:

- native contract, negative-path, crash, recovery, and compatibility evidence
  substantially pass;
- security and operations documentation exists;
- release bytes are verifiable;
- remaining promotion gaps and affected guarantees are explicit;
- operators accept preview risk and maintain tested backups.

### Supported

The exact release/profile passes every applicable gate:

- production implementation;
- unit, property/model, and negative-path evidence;
- native OS/architecture/filesystem or browser/API evidence;
- crash consistency and idempotent recovery;
- stored-data, machine-protocol, and client compatibility;
- permissions, metadata, and encryption behavior;
- backup, verify, restore, upgrade, and rollback/restore drills;
- security threat-model and dependency controls;
- named performance/resource limits;
- operator and reference documentation;
- exact release-asset checksum, signing, SBOM, provenance, and download smoke;
- required soak and independent review for the published tier.

Supported does not mean every use is supported. The deployment must remain
inside the published compatibility and operations matrix.

### Deprecated

The capability remains supported only through a published end-of-support date:

- replacement and migration path exist;
- compatibility window is explicit;
- security support is defined;
- removal requires the announced window and release notes.

## Evidence profiles

| Profile     | Intended use                                                                                                  | May support a release claim?   |
| ----------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `smoke`     | Local development and harness validation                                                                      | No                             |
| `candidate` | Native artifact, package, crash, recovery, interop, and performance qualification                             | Only preview                   |
| `release`   | Immutable artifacts, explicit thresholds, compatibility, restore, rollback, provider proof, and required soak | Yes, when all other gates pass |

The release evidence runner must refuse a stronger profile when:

- an artifact has development identity;
- source, tag, version, or digest disagree;
- previous/current artifacts are identical in an upgrade test;
- an emulated or translated run is described as native;
- duration or operation counts are below policy;
- observed metrics lack explicit pass/fail thresholds;
- required compatibility, security, recovery, or provider evidence is absent.

## Initial Rust rewrite status

| Surface                               | Current rewrite status                      | Reason                                                            |
| ------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------- |
| Existing JavaScript/Bun native engine | Unchanged from its current published matrix | The rewrite branch does not alter current support                 |
| Rust portable crates                  | Experimental; local corpus passes           | Cross-platform retained evidence and broader fixtures are pending |
| Rust native engine                    | Developer read-only preview; not a writer   | Document/file/tombstone/encrypted reads pass locally; Phase 4 is incomplete |
| Rust/Wasm production kernel           | Experimental acceleration path              | Compiled integration/fallback passes; browser matrix is pending   |
| JavaScript browser fallback           | Unchanged from its current published matrix | Remains required during migration                                 |

No accepted ADR or local test promotes a Rust surface by itself. Current
implementation and evidence gaps are tracked in
[`rust-rewrite-progress.md`](rust-rewrite-progress.md).

## Platform claim format

Every published support row identifies:

- FYLO version and artifact digest;
- OS and architecture;
- target triple;
- filesystem or browser plus required storage APIs;
- storage, backup, machine, and Wasm ABI versions;
- native/cross-build status;
- evidence report;
- known exclusions such as network shares, synchronized folders, unsupported
  metadata, or unavailable browser APIs.

Example:

```text
FYLO <version>, native-tested, Windows x86_64 MSVC, Windows Server 2022/2025,
local NTFS, machine protocol v1, storage format v1, evidence <report digest>.
Network shares and synchronized folders excluded.
```

## Feature support checklist

A material feature is not labeled supported until all applicable evidence
exists:

| Evidence       | Required proof                                                        |
| -------------- | --------------------------------------------------------------------- |
| Implementation | Production path behind a documented contract                          |
| Unit/model     | Deterministic invariants and state transitions                        |
| Negative path  | Malformed, denied, stale, exhausted, and concurrent behavior          |
| Native/browser | Claimed target and storage APIs                                       |
| Crash/recovery | Valid durable outcomes around every acknowledgement boundary          |
| Compatibility  | Stored data, clients, formats, and errors inside the published window |
| Operations     | Backup, restore, repair, upgrade, and rollback/restore                |
| Security       | Threat-model controls, dependencies, secrets, and unsafe-code policy  |
| Performance    | Named reference environment and explicit limits                       |
| Documentation  | User, operator, protocol, support, and limitation material            |
| Release        | Exact downloadable bytes verified with identity and provenance        |

If one row is missing, the published tier is lowered rather than the gate being
silently skipped.

## Relationship to CalVer

FYLO's CalVer identifies a release; it does not encode support level.
Support-level and compatibility changes are stated in:

- the release manifest;
- compatibility matrices;
- release notes and changelog;
- retained evidence reports;
- deprecation notices where applicable.

Immutable versioned artifacts and browser paths are never overwritten to change
a support claim. A correction receives a new CalVer.

## Related decisions

- [ADR 0001](../adr/0001-rust-native-engine-and-portable-wasm-kernel.md)
- [ADR 0002](../adr/0002-compatibility-first-strangler-migration.md)
- [ADR 0003](../adr/0003-native-and-browser-storage-boundaries.md)
- [ADR 0004](../adr/0004-unsafe-and-dependency-policy.md)
- [Rust engine project plan](../RUST_ENGINE_PROJECT_PLAN.md)
