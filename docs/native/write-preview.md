# Rust Native Write Preview

The experimental `fylo-write-preview` binary exercises the native transaction
writer without replacing the production JavaScript CLI.

Implemented operations:

- create-only `put-document` with an explicit TTID;
- create-only `put-file` with an explicit TTID, durable key, extension, bytes,
  and typed custom metadata;
- full-body `patch-document` while preserving the TTID and inode metadata;
- shallow merge `patch-fields`, matching the JavaScript `patch(id, changes)`
  top-level replacement contract;
- bounded `sql` `INSERT`, `UPDATE`, and `DELETE` mutations, where a multi-record
  `UPDATE`/`DELETE` commits under one transaction manifest;
- `set-metadata` developer-metadata merge on documents and raw files, where a
  JSON `null` removes a name and `user.fylo.meta-updated-at` advances strictly;
- `set-access` UID/GID/mode projection onto an existing record;
- schema-declared AES-256-GCM field encryption with the head `_v` stamp when a
  schema root and both credentials are configured;
- `commit` content-addressed auto-commit for versioned roots;
- `reshard` moving every record to a new shard width, idempotently and
  resumably, under the same transaction journal;
- retained soft delete;
- UID/GID/mode projection on POSIX at put time;
- UID plus trusted supplementary groups for patch/delete authorization;
- exact prefix-index rebuild after every mutation; and
- explicit collection recovery.

Every mutation uses the existing
`fylo.collection-transaction.v1`/`fylo.collection-generation.v1` records.
Before-images are bounded and stored as segmented captures. An active manifest
rolls back; a durable committed marker rolls forward. In either case recovery
rebuilds the derived index before publishing the next even-numbered stable
generation.

The collection lock uses the JavaScript lock payload and process-incarnation
identity. Rust and JavaScript therefore serialize the same collection write
lane and can reclaim a lock only after its exact owner process has exited.

## Qualification

`bun run rust:interop:writes` creates the root with JavaScript, mutates it with
the Rust binary, and reads/queries it again with JavaScript. The corpus kills
Rust:

1. immediately after publishing the writing generation;
2. after moving a document into the tombstone tree, before commit; and
3. after the durable commit marker but before the stable generation.

JavaScript must roll back the first two states and roll forward the third.

`INSERT` allocates a monotonic TTID from this process. It is not the JavaScript
TTID generator, so cross-process identifier ordering is only guaranteed by the
clock, and a collision retries up to sixteen times before failing closed.

`set-metadata` merges by default and `--replace` is authoritative, matching
`replaceDocMetadata`: a name the record omits is removed rather than left
behind, so a caller does not have to know what is stored to state what should
be.

Before-images capture developer metadata on both platforms. FYLO keeps that
metadata in per-name xattrs on POSIX and in one JSON manifest stream on NTFS,
whose values are already base64, so the stream maps directly onto the captured
form. A rollback replaces the stream wholesale and removes it when the
before-image had none, so it can neither keep a value a mutation replaced nor
leave behind a name it added.

Encryption and schema validation run in `fylo-engine` before any byte reaches
the journal, so an interrupted encrypted write can never leave plaintext behind.
Documents are validated by the same compiled CHEX binary the JavaScript engine
drives, and — like the JavaScript writer — only when `FYLO_STRICT` is set to a
non-empty value; that is also when `_v` is stamped. Reading a document written
under an older schema version still requires the JavaScript upgraders.

`repository_status` hashes the same tree without persisting a single object, so
a clean/dirty answer never mutates the object store.

`commit` reproduces `commitIfDirty`'s full-scan path: blobs, four-level tree
objects, an immutable commit, and a ref update, but only when the root hash
moved. It supports the default branch worktree only; other branches live in
hidden worktrees the JavaScript engine owns.

On Windows, writing an alternate data stream updates the file's last-write
time, where a POSIX xattr write leaves it alone. The native writer therefore
writes every attribute before computing the checksum stamp, so the recorded
mtime matches the file a later reader stats: otherwise the checksum cache would
be permanently invalid and every read would rehash the whole file. Writing the stamp is itself a stream write on
Windows, so both engines now restore the recorded modification time afterwards
and the stamp stays self-consistent. A root written by an older release still
carries a stamp taken before its stream write, so its mtime-derived index keys
legitimately differ from a rebuild.

## Crash matrix

`bun run rust:crash:matrix` interrupts the writer at every durable transition
the binary declares and proves the root still recovers. The failpoint list comes
from `fylo-write-preview failpoints`, not from the harness, and every declared
point must be reached by some scenario — so a new failpoint cannot be added
without either being exercised or failing this gate.

A transition guarding a capability the platform lacks cannot be reached, so
the gate exempts it and prints why: raw-file transitions need extended
attributes, which some filesystems do not carry, and the ownership transitions
need POSIX ownership, which Windows does not offer. Reduced coverage is
therefore visible in the log rather than implied by a pass.

Each transition is interrupted two ways. `abort` loses the process, so the next
opener must recover the journal. `enospc` injects a real full-volume error
number, which is an ordinary I/O failure rather than a lost process: the writer
has to roll back in place and leave recovery nothing to do, and the gate asserts
that a following recovery reports no work. The crash case cannot make that
distinction, which is why both run.

Resharding is covered here too: interrupting a record move leaves the
collection readable, because the descriptor names the destination and the width
being left before the first rename.

For each interrupted mutation the gate asserts that recovery succeeds, that a
second recovery reports no remaining work, that both collections read back with
an index matching their documents, and that an untouched document survived.
Whether the mutation applied or rolled back is deliberately not asserted: both
are valid outcomes of a crash, and only the recovered state has to be one of
them.

## Differential replay

`bun run rust:replay` clones one seeded root twice, replays a fixed operation
log through the JavaScript engine into one clone and the native writer into the
other, and requires the results to agree. No two writers ever touch one root,
which the plan forbids. Both roots are then described by the same reader, so a
difference can only come from what was written, and the log's outcome is also
stated outright — agreement alone would be satisfied by two engines wrong in
the same way.

This is not a supported writer. Quota-specific behaviour beyond a full volume,
and native retained release evidence, remain Phase 5 gates.
