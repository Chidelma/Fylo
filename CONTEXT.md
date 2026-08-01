# FYLO Domain Context

## Purpose

FYLO is a local-filesystem-first document and file database. Documents remain
ordinary files that users can mount, inspect, back up, and synchronize with
their chosen infrastructure. Rebuildable prefix indexes make direct disk data
queryable without turning SQLite or an object-store catalog into the source of
truth.

## Core terms

- **Root**: the canonical filesystem boundary owned by one FYLO writer.
- **Collection**: a named set of JSON documents.
- **Bucket**: a named set of raw files.
- **Document ID**: a TTID whose lifecycle segments encode creation, update, and
  deletion time.
- **Document body**: one JSON object stored in a sharded `.json` file.
- **Canonical metadata**: identity, timestamps, raw-file descriptors, and
  access fields derived from storage and protected system state.
- **Developer metadata**: typed custom values stored as xattrs or the qualified
  Windows ADS equivalent.
- **Prefix index**: zero-payload sorted keys plus WAL; document values are not
  duplicated into the index.
- **Generation**: monotonic collection state used to detect reads concurrent
  with a transaction.
- **Transaction journal**: durable captures and state that make logical
  multi-file operations recoverable.
- **Machine protocol**: bounded versioned NDJSON operations consumed by CLI and
  language shims.
- **Browser shim**: a JavaScript host using OPFS/FSA and an optional portable
  Rust/Wasm query kernel.
- **Explorer**: a separately hostable UI that views a user-selected FYLO root.
- **S3 client**: any compatible object-storage client used for additive
  backup/restore; it does not replace the authoritative local root.

## Invariants

- The local filesystem is authoritative; indexes and caches are rebuildable.
- One writer owns one canonical root through all known aliases.
- Acknowledged writes satisfy the documented durability model.
- Recovery is bounded, idempotent, and never guesses past corruption.
- Canonical metadata overrides colliding custom metadata.
- UID/GID/mode and encryption checks fail closed when configured.
- Paths below a trusted root reject symlinks, reparse points, traversal, and
  type confusion.
- Public machine, storage, backup, and Wasm contracts are independently
  versioned.
- Rust remains a compatibility-checked replacement; JavaScript is the oracle
  until each promotion gate passes.
- Browser APIs stay in JavaScript; portable deterministic computation may live
  in Rust/Wasm.
- Immutable release assets are never overwritten.

## Explicit ambiguities

These remain open until their phase gate or ADR is accepted:

- multi-writer and distributed coordination;
- support tiers for network and synchronized filesystems;
- the long-term encrypted-field browser design;
- production support for file collections in the Rust engine;
- S3-provider qualification beyond the named test profiles;
- JavaScript native-engine retirement date;
- whether any Rust crate becomes a stable public library API.
