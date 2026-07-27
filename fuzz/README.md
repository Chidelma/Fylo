# FYLO Rust Fuzzing

Install the pinned Rust nightly selected by release engineering and
`cargo-fuzz`, then run:

```bash
cargo fuzz run query_snapshot -- -max_len=2097152
cargo fuzz run portable_inputs -- -max_len=1048576
```

The target sends arbitrary snapshot and query bytes through the same bounded
safe kernel used by the browser Wasm adapter. Crashes, panics, hangs, and
sanitizer findings are release-blocking. Minimized regressions belong in the
versioned fixture corpus. The scheduled `rust-nightly.yml` workflow runs both
targets with pinned tooling and retains the corpus, exact toolchain identity,
and any findings for 90 days.
