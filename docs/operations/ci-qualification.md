# CI qualification

FYLO's main CI borrows TACHYON's qualification structure but keeps FYLO's
product-specific boundaries. The workflow is both event-driven and reusable
through `workflow_call`, cancels superseded runs, pins every external action to
a commit, and builds from the repository's exact Bun and Rust versions.

## Required gates

| Gate | What it proves |
| --- | --- |
| Quality | Formatting, locked all-target/all-feature compilation, Clippy, tests, contracts, host checks, and warning-free Rustdoc |
| Dependency policy | Advisories, licenses, sources, and bans pass the repository `deny.toml` policy with pinned `cargo-deny` |
| Coverage | Workspace line, function, and region coverage cannot fall below the measured ratchet |
| Provenance inputs | CycloneDX SBOMs and an auditable release binary can be generated from the locked graph |
| Portable artifacts | Native, WASI, and browser-Wasm interchange and size contracts remain compatible |
| Native matrix | Linux, macOS, Windows Server 2022, and Windows Server 2025 pass storage, crash-recovery, lease, and soak checks |
| Browser matrix | Chromium, Firefox, and WebKit pass real OPFS/Wasm restart and fallback tests |
| Binary interoperability | The compiled binary works through every published language shim and installer surface |
| Miri | Portable format and query kernels pass the pinned Miri toolchain |
| Scheduled qualification | Fuzzing plus address, leak, and thread sanitizers exercise parsers and native storage daily |

Release provenance remains the responsibility of the Release workflow, which
attests the exact assets it publishes. The CI provenance job creates retained
pre-release evidence; it does not claim that an ordinary pull-request artifact
is a public release.

## Coverage ratchet

The initial workspace measurement was 51.65% lines, 44.57% functions, and
50.12% regions. CI floors are intentionally below that observed baseline to
allow small instrumentation variance: 50% lines, 43% functions, and 48%
regions. Raise the floors as coverage improves. Lowering them requires an
explicitly documented reason in the same change.

The LCOV report is retained for 90 days as `rust-coverage-<commit>`. Native,
browser, soak, fuzz, and provenance evidence use the same retention period.

## Run the qualification gates locally

Install the Bun version in `.bun-version` and the Rust toolchain in
`rust-toolchain.toml`, then run:

```sh
bun install --frozen-lockfile
bun run contracts:verify
bun run rust:verify
bun run rust:fmt
bun run rust:check
bun run rust:clippy
bun run rust:test
RUSTDOCFLAGS='-D warnings' bun run rust:doc
bun run typecheck
bun run lint
bun test tests/browser/*.test.js --timeout 120000 --parallel=1
bun run test:interop
```

Supply-chain and coverage checks require their pinned Cargo tools:

```sh
bun ./scripts/run-rust.mjs cargo install cargo-deny --version 0.19.7 --locked
bun run rust:deny
bun ./scripts/run-rust.mjs cargo install cargo-llvm-cov --version 0.8.6 --locked
bun run rust:coverage
```

The sanitizer and fuzz suites intentionally stay in scheduled CI because they
require the pinned nightly toolchain and are substantially more expensive than
the pull-request feedback loop.
