# Rust Native Write Preview

The experimental `fylo-write-preview` binary exercises the native transaction
writer without replacing the production JavaScript CLI.

Implemented operations:

- create-only `put-document` with an explicit TTID;
- create-only `put-file` with an explicit TTID, durable key, extension, bytes,
  and typed custom metadata;
- full-body `patch-document` while preserving the TTID and inode metadata;
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

This is not a supported writer. Metadata mutations, encrypted writes,
schema/history integration, SQL mutations, exhaustive failpoints, and native
retained release evidence remain Phase 5 gates.
