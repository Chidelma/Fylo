# ADR 0007: Filesystem-only native storage

- Status: **Accepted**
- Date: **2026-08-01**
- Owners: **FYLO maintainers**
- Supersedes in part: ADR 0001 and ADR 0003 S3-compatible backup scope

## Context

FYLO's source of truth is a mounted filesystem. The previous design also
included a built-in S3-compatible backup, verify, reconcile, and restore
adapter. That adapter expanded the trusted network, credential, provider, and
release surface even though object storage was never part of query execution or
transaction ownership.

Deployments can already place a FYLO root on an operator-qualified mounted
filesystem and can snapshot or replicate that filesystem with their normal
infrastructure. Application-specific post-write notifications are also useful,
but they do not need to make a remote service part of FYLO's storage model.

## Decision

The native product supports one authoritative storage boundary: the local or
mounted filesystem root supplied by the developer.

- Remove the built-in S3 client, scheduler, backup, reconcile, verify, and
  restore APIs, machine operations, CLI commands, tests, and release jobs.
- Keep generic `sync.onWrite` and `sync.onDelete` notification hooks. They run
  after a successful local mutation and do not participate in durability,
  authorization, recovery, or query results.
- Treat snapshots, replication, and disaster recovery as filesystem deployment
  concerns. Restores target a new or explicitly empty root and must pass FYLO's
  integrity verification before use.
- Do not introduce another built-in object-storage provider under a different
  name. A future remote adapter requires a new ADR and cannot become an
  authoritative query or transaction backend implicitly.
- Web-release artifact upload may still use infrastructure object storage. It
  is release plumbing, not a FYLO data-storage capability.

## Consequences

Benefits:

- one ownership, locking, metadata, permission, and recovery model;
- a smaller credential and hostile-endpoint attack surface;
- fewer provider-specific dependencies and qualification matrices;
- release behavior matches the fast filesystem-first engine users selected.

Costs:

- FYLO no longer supplies application-level remote backup orchestration;
- operators must qualify their mount, snapshot, replication, retention, and
  restore procedures;
- older code using the removed S3 APIs needs an explicit migration.

## Migration

Remove `sync.s3`, `backup`, `backupStatus`, `reconcile`, and `FyloS3Restore`
usage. Replace notification-only behavior with `sync.onWrite`/`sync.onDelete`.
Use the platform's filesystem snapshot or replication system for disaster
recovery, restore into a separate root, and run the normal FYLO verification
gate before switching traffic.

## Verification

- repository scans contain no built-in S3 product implementation or protocol
  operation;
- machine and language-client corpora use the 36-operation filesystem-only
  registry;
- release workflows contain no S3 product credentials or live-provider tests;
- filesystem snapshot/restore drills preserve bytes, metadata, permissions,
  encryption envelopes, version history, and trailing-TTID shard placement.

## Operations

- [Filesystem snapshot and restore](../operations/filesystem-snapshot-restore.md)
