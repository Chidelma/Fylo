# FYLO Machine Protocol v1

FYLO's machine interface is a local, bounded NDJSON protocol. One UTF-8 JSON
request and one UTF-8 JSON response occupy one LF-delimited frame.

The canonical artifacts are:

- [`schema.json`](schema.json): request and response envelope;
- [`operations.json`](operations.json): operation names, mutability, and retry
  classification;
- [`fixtures.ndjson`](fixtures.ndjson): transport-level conformance examples;
- [`../../errors/v1.json`](../../errors/v1.json): stable public error codes.

## Framing

- Protocol version: `1`
- Encoding: UTF-8
- Delimiter: LF (`0x0a`)
- Delimiter counts toward limit: no
- Default maximum request: 1 MiB
- Default maximum response: 8 MiB
- Maximum configured frame: 64 MiB
- Duplicate JSON keys: rejected
- Truncated final frame: error and terminate
- Malformed complete frame: error and resume at the next LF

Requests do not include `protocolVersion`; compatibility is established through
`handshake`. Every response includes `protocolVersion`.

## Errors

Error responses have a stable `error.code`. The human-readable
`error.message` is diagnostic and must not be parsed. Clients may retry only
when the operation registry says retry is safe and the concrete error is
documented as transient.

## Compatibility

Within protocol v1:

- operation names and stable error codes are preserved;
- additive result fields are allowed;
- clients must ignore unknown result fields;
- request fields remain operation-specific;
- changing idempotency, durability, or retry behavior requires a new protocol
  version or an explicit compatibility RFC.

## Embedded serverless queue

Protocol v1 exposes a brokerless filesystem queue through `queuePublish`,
`queueClaim`, `queueAck`, `queueNack`, `queueExtend`, `queueStats`, and
`queueDeadLetters`. Delivery is at least once. A claim is durable before its
receipt is returned; workers must acknowledge with that receipt or the message
becomes visible after its lease. Producer retries are idempotent only when the
same `idempotencyKey`, topic, and payload are supplied.
Topic and consumer-group names contain at most 127 UTF-8 bytes. Queue reads are
bounded before the engine leases or aggregates records so the response frame
limit cannot strand an unreturnable delivery. Header discovery and queue stats
also stop at 64 MiB of message-file scan work per request.
