# FYLO Queue Storage Contract v1

FYLO's embedded serverless queue is a brokerless, filesystem-backed queue. Its
durable records live under `<root>/.fylo-queue/v1` and use the envelopes in
[`schema.json`](schema.json).

| Record            | Format identifier           |
| ----------------- | --------------------------- |
| Sequence manifest | `fylo.queue.v1`             |
| Receipt key       | `fylo.queue-receipt-key.v1` |
| Message           | `fylo.queue-message.v1`     |
| Consumer group    | `fylo.queue-consumer.v1`    |
| Publish dedupe    | `fylo.queue-dedupe.v1`      |
| Dead letter       | `fylo.queue-dead-letter.v1` |

Message identifiers are `Q` followed by a zero-padded, 20-digit global
sequence. Messages are immutable. Consumer progress, visibility leases, retry
state, and dead letters are isolated by consumer group.

The format provides at-least-once delivery, receipt fencing, bounded retries,
delayed delivery, and idempotent publication. It does not provide consensus
between multiple root writers, exactly-once handler execution, automatic
retention, or an atomic transaction spanning documents and queue messages.

Topic and consumer-group names are limited to 127 UTF-8 bytes. Receipts are
keyed, unguessable capability tokens: an expired or incorrect token cannot
acknowledge, reject, or extend a delivery. A successful acknowledgement may be
retried only with the same receipt, and each group retains the 1,000 most
recently acknowledged ID/receipt pairs for strict duplicate validation.

Any incompatible record change requires a new format identifier, migration and
rollback policy, golden fixtures, and interrupted-upgrade tests.
