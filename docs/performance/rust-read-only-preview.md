# Rust Read-Only Preview Benchmark

This controlled harness compares the current JavaScript engine with the native
Rust read-only preview against the same JavaScript-created FYLO root.

```bash
bun run rust:benchmark:readonly
```

Generated reports are written under `target/benchmarks/`, which is already
excluded with the rest of Cargo's `target/` output. Reports are evidence, not
source: CI retains one report per native operating system for the exact commit.

## Workload

The harness:

1. creates a temporary root with deterministic documents;
2. rebuilds the collection index using the current engine;
3. records a content hash of the closed root;
4. warms up and samples point `get`, filtered `find`, and `inspect` operations
   in each engine;
5. separately samples Rust's full `verify-index` operation;
6. verifies that neither read path changed the root; and
7. records the OS, architecture, CPU, filesystem identifier, runtime version,
   dataset digest/bytes, workload parameters, latency distribution, and
   cross-platform peak-RSS data;
8. fails the qualification job if a published preview limit is exceeded.

Each operation runs in-process so process startup does not dominate the
measurement. Latencies use nearest-rank p50, p95, and p99 summaries in
nanoseconds.

## Preview qualification limits

The versioned `fylo.read-only-benchmark.v2` report applies these deliberately
wide regression limits on every native CI runner:

- Rust peak RSS must be observable and no greater than 512 MiB;
- the Rust/current p95 ratio for `get`, `find`, and `inspect` must be no greater
  than 10x; and
- result parity and the before/after root digest must match.

These are preview regression bounds, not production service-level objectives.
Tighter release limits require controlled, named hardware and filesystem
profiles. CI retains the report for 90 days even when a limit fails.

## Reproduction

Use explicit parameters for a repeatable local run:

```bash
bun ./scripts/benchmark-rust-readonly.mjs \
  --documents 500 \
  --iterations 100 \
  --warmup 20 \
  --output target/benchmarks/read-only.json
```

Run on an idle machine, ordinary local storage, and a release build. Compare
reports only when the dataset digest, parameters, architecture, filesystem,
and thermal/power conditions are equivalent.

## Limits

- The harness measures read-only preview operations; it does not qualify
  writes, recovery, browser Wasm, backup/restore, or client protocol overhead.
- The current engine's query path and Rust's bounded scan may use different
  physical plans while preserving the same result.
- Linux reads its high-water RSS from `/proc/self/status`. macOS and Windows
  read the benchmark process working set through their native `ps` and
  PowerShell process surfaces. The parent harness also samples the child and
  records the larger value. JavaScript records process-wide RSS before and
  after its workload because Bun does not expose a stable cross-platform
  high-water contract.
- CI runners are useful for regression evidence but not absolute product
  limits. Release thresholds require named, controlled reference environments.
