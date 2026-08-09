# Downgrading a root below v26.31.06

v26.31.06 shards documents and raw files by the **trailing** two characters of
the identifier's creation segment ([ADR 0006](../adr/0006-shard-records-by-the-trailing-creation-characters.md)).
Releases up to v26.30.06 shard by the **leading** two characters and know
nothing else.

The upgrade direction needs no action: v26.31.06 and later read both layouts.

The downgrade direction does. An older binary looks only under the leading
characters, finds nothing, and returns `ok: true` with an empty result —
`inspectCollection` still counts the records it cannot reach. **A root written
by v26.31.06 or later will present to an older binary as healthy and empty, not
as an error.** Verify the record count after any rollback rather than trusting a
successful start.

## Relocating a root back to the superseded layout

Records move; nothing about them is rewritten. Stop every writer first — the
relocation is not coordinated with the root lease.

```bash
ROOT=/path/to/root
find "$ROOT/.collections" "$ROOT/.buckets" -type d -name docs -o -type d -name .deleted 2>/dev/null |
  while read -r namespace; do
    find "$namespace" -mindepth 2 -maxdepth 2 -type f | while read -r record; do
      name=$(basename "$record")
      shard="$namespace/$(echo "$name" | cut -c1-2)"
      mkdir -p "$shard"
      [ "$record" = "$shard/$name" ] || mv "$record" "$shard/$name"
    done
    find "$namespace" -mindepth 1 -maxdepth 1 -type d -empty -delete
  done
```

The relocation is idempotent and resumable: a record is findable under one
shard or the other at every point, and both are layouts v26.31.06 accepts, so
an interrupted run leaves the root readable by the current binary and finishes
on a re-run.

A collection created with a non-default `FYLO_SHARD_WIDTH` has no downgrade
path at all — an older binary only understands a width of exactly 2.

## After relocating

Roll back the binary, then confirm the count the older binary reports matches
what the newer one reported before the move:

```bash
printf '%s\n' '{"op":"inspectCollection","collection":"<name>"}' | fylo exec --loop --root "$ROOT"
```

`scripts/verify-rust-released-rollback.mjs` always exercises rollback against
the previously published binary. When that binary predates v26.31.06 it also
exercises the relocation above; newer rollback oracles already understand the
trailing layout and must read a newly created record directly.
