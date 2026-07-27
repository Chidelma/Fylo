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
   dataset digest, workload parameters, latency distribution, and available
   peak-RSS data.

Each operation runs in-process so process startup does not dominate the
measurement. Latencies use nearest-rank p50, p95, and p99 summaries in
nanoseconds. The Rust-to-current ratios are descriptive and are not promotion
thresholds.

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
- Linux reports Rust peak RSS from `/proc/self/status`. Rust peak RSS is
  reported as `null` on macOS and Windows until a safe, stable platform
  collector is adopted. JavaScript reports process-wide current RSS because
  Bun's peak-RSS unit is not yet a stable cross-platform contract.
- CI runners are useful for regression evidence but not absolute product
  limits. Release thresholds require named, controlled reference environments.
