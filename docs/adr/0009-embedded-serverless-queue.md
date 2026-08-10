# ADR 0009: Embedded durable serverless queue

- Status: **Accepted**
- Date: **2026-08-09**
- Owners: **FYLO maintainers**
- Extends: [ADR 0007](0007-filesystem-only-native-storage.md)

## Context

The pre-Rust FYLO engine included a local queue backed by append-only topic
logs, consumer checkpoints, advisory leases, retries, and dead letters. The
Rust cutover deliberately removed that JavaScript native engine and therefore
removed the queue. What remained were an in-memory client response FIFO, the
collection transaction journal, and browser event buffers. None is an
application delivery queue.

FYLO should support event-driven local and edge applications without requiring
a network broker. Calling the feature serverless must not imply a managed
cloud service, distributed consensus, or concurrent filesystem writers that
violate FYLO's one-root-owner invariant.

## Decision

Add a versioned, brokerless queue to the Rust storage engine and machine
protocol. Its state lives under `.fylo-queue/v1`; it is not a collection and is
not indexed or version-controlled with documents.

Messages are immutable files allocated from a durable, monotonically
increasing root sequence. Each consumer group has an atomically replaced state
file with:

- a compacted acknowledged cursor;
- a scan frontier;
- bounded states between the two;
- visibility receipts, expirations, attempt counts, and retry availability.

The public operations are `queuePublish`, `queueClaim`, `queueAck`,
`queueNack`, `queueExtend`, `queueStats`, and `queueDeadLetters`.

The guarantees are:

1. **At-least-once delivery.** Claim state is durable before returning. A
   crash before acknowledgement causes redelivery after lease expiry.
2. **Independent consumer groups.** Retirement or dead-lettering in one group
   does not consume the message for another.
3. **Receipt fencing.** Only the active receipt can acknowledge, reject, or
   extend a delivery. Stale workers receive `EQUEUE_RECEIPT`.
4. **Bounded retries.** A negative acknowledgement at the final attempt, or a
   final expired lease, creates a durable group-specific dead letter before
   advancing the group.
5. **Conditional idempotent publication.** A producer key is durably associated
   with the intended message before the message is installed. Retrying the
   same topic and byte-equivalent JSON payload returns the original ID; changing
   content fails closed.
6. **Filesystem containment.** Topic and group names are encoded before use as
   paths. Every created/read directory remains below the canonical root and
   linked components are rejected.
7. **One root owner.** Queue workers are concurrent tasks using one engine
   process. Separate writers do not coordinate through queue state and may not
   open the same root simultaneously.

## Durable transitions

- Publish reserves and syncs a sequence, persists an idempotency intent when
  present, then installs and syncs the immutable message.
- Claim updates and syncs consumer state before returning receipts.
- Ack marks the delivery complete, compacts contiguous completion, and syncs
  the state before success.
- Dead-lettering installs and syncs the DLQ record before retiring the source
  delivery. Repeating recovery is idempotent because the DLQ path is the source
  message ID.

A process failure can make a caller uncertain whether publish or claim
succeeded. Idempotency keys resolve publish ambiguity. Visibility expiry
resolves claim ambiguity. Handlers must remain idempotent because delivery is
at least once.

Automatic consumer adapters treat handler exceptions as an untrusted
diagnostic boundary. They persist only `queue handler failed`; exception types,
messages, and stack traces are not copied into queue state. Applications that
have sanitized a diagnostic may opt in by calling `queueNack` with an explicit
reason.

## Limits and non-goals

All messages, names, delays, leases, claims, attempts, pending states, reasons,
and DLQ reads are bounded. The handshake publishes the important limits.

This decision does not add:

- a network listener or managed control plane;
- multi-host consensus or multi-process writers;
- exactly-once execution of user handlers;
- automatic worker scheduling or scaling;
- automatic message retention or destructive compaction;
- atomic commit spanning a document mutation and queue publication.

The final item requires a separately designed transactional outbox because two
independent durable operations cannot truthfully claim atomicity.

## Consequences

Applications can run durable background work in a function, desktop process,
mobile host, WASI runtime, or edge process without provisioning a broker. The
same bounded machine operations are available to every native binary shim.

Disk use grows until operators apply a future retention mechanism or snapshot
and retire the root. One owner limits horizontal write scaling. Those are
intentional consequences of brokerless local storage, not undocumented cloud
queue semantics.

## Acceptance evidence

- Storage tests cover group independence, restart durability, idempotent
  publication, retries, dead letters, stale receipts, and lease extension.
- Machine tests exercise the real protocol lifecycle and capability record.
- The operation registry and stable error registry classify retry behavior.
- Client shims expose the same seven operations.
- Native, Wasm, interop, lint, format, and release matrices remain required.
