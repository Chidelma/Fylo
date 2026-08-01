# FYLO Storage Contract v1

FYLO v1 stores one compact JSON object per document. The local filesystem is
authoritative; indexes, caches, and query snapshots are derived.

Canonical identifiers:

| Boundary             | Identifier                           |
| -------------------- | ------------------------------------ |
| Document body        | `fylo.document.json.v1`              |
| Prefix index         | `fylo.local-fs.index.v1`             |
| Transaction journal  | `fylo.collection-transaction.v1`     |
| Generation state     | `fylo.collection-generation.v1`      |
| Backup file manifest | numeric version `2`, platform tagged |

The schemas in this directory describe envelopes with explicit manifests.
Existing v1 document bodies do not contain a wrapper or version field; their
format identity comes from the release/storage compatibility manifest.

## Document rules

- root must be a JSON object;
- nested objects are allowed;
- arrays may contain scalar values;
- arrays of objects are rejected with `EARRAYOFOBJECTS`;
- encoded and decoded resource limits are applied before storage/query work;
- JSON object insertion order is preserved when unchanged bytes are required;
- encrypted values remain part of the document representation and fail closed
  when they cannot be decrypted.

## Canonical metadata

Custom metadata and canonical storage metadata are returned together.
Canonical fields win collisions:

- `id`;
- `createdAt`;
- `updatedAt`;
- `mtime`;
- raw-file descriptors;
- supported native `uid`, `gid`, and `mode`.

## Compatibility

Any new writer format requires an ADR, migration RFC, interrupted-upgrade
tests, rollback/restore policy, and golden fixtures. A Rust language migration
does not by itself change these formats.
