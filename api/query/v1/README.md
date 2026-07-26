# FYLO Portable Query Contract v1

The portable scanner consumes a validated, sorted, newline-delimited
`fylo.local-fs.index.v1` snapshot and an array of prefix/range constraints. It
returns unique encoded document identifiers, one per line.

The first constraint establishes result order. Later constraints filter that
order. Numeric less-than indexes are reverse-sortable, so `$lt` and `$lte`
compare encoded bytes in the same direction as `$gt` and `$gte`.

Resource limits apply to snapshot bytes, key bytes, query-frame bytes, term
bytes, constraint count, match count, and result bytes. Failures use stable
codes from `api/errors/v1.json`.

Unknown object fields are ignored in v1 input for compatibility with the
JavaScript-to-Wasm host. Unknown operators fail parsing.

`structured.schema.json` separately freezes the document predicate contract.
`$ops` is an OR of operation objects; fields inside one operation are ANDed.
The portable evaluator preserves JavaScript loose equality, numeric coercion,
UTF-16 LIKE wildcards, array `$contains`, nested dot/slash paths, canonical
creation/update ranges, stable input order, and the historical zero-limit
behavior. Projection, grouping, joins, and deleted-document timestamps remain
separate higher-layer contracts.

`fylo-query::prepare_sql` parses and plans the existing FYLO SQL subset without
executing mutations. Its compatibility AST and `EXPLAIN` access paths are
checked against the JavaScript parser and planner using
`tests/fixtures/rust-sql-v1.json`.
