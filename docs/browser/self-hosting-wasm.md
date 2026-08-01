# Self-hosting the FYLO Browser Wasm Kernel

The browser shim keeps JavaScript as a compatible fallback. Enabling Wasm
accelerates warm immutable prefix-index scans; it does not change documents,
OPFS/FSA layout, WAL contents, or the worker protocol.

## Assets

Serve `fylo.mjs`, the selected worker script, and `fylo-index.wasm` from the
same immutable release. The JavaScript host accepts only Wasm ABI version 1.
Do not mix `latest` JavaScript with a separately cached immutable Wasm file.

The server must send:

```text
fylo-index.wasm  Content-Type: application/wasm
*.mjs            Content-Type: text/javascript
```

The default loader uses `fetch` followed by `WebAssembly.compile`, so streaming
compilation is not required.

## Content Security Policy

A same-origin deployment commonly needs:

```text
default-src 'self';
script-src 'self' 'wasm-unsafe-eval';
worker-src 'self';
connect-src 'self';
```

Test the exact policy on every supported browser. Some older browsers use
`'unsafe-eval'` instead of the narrower `'wasm-unsafe-eval'`; FYLO does not
recommend broadening policy silently. Cross-origin assets additionally require
correct CORS headers and should be integrity-pinned by the deployment.

## Failure and fallback

Fetch, compile, instantiate, ABI, snapshot, query, and memory failures carry
stable `EWASM_*` reason codes in their messages. The browser index host disables
acceleration for the worker lifetime and continues with the JavaScript scanner.
Stored data is unchanged, so operators can also disable Wasm at configuration
time without migration.

The kernel rejects snapshots over 256 MiB, query frames over 1 MiB, and results
over 64 MiB. Applications approaching those bounds should compact, narrow the
query, or use the native engine rather than increasing limits without a memory
budget.

`accelerationStatus()` exposes separate cumulative measurements for OPFS
snapshot reads, snapshot copies/validation, and Wasm scans. A fallback also
includes its stable `reasonCode`. These values are diagnostics, not a
cross-browser high-resolution profiler.

## Payload and initialization budgets

The release build is gated by these uncompressed transfer budgets:

| Asset                  |  Budget |
| ---------------------- | ------: |
| `fylo-index.wasm`      | 128 KiB |
| gzip `fylo-index.wasm` |  64 KiB |
| `fylo.mjs` host        | 192 KiB |

Cold fetch, compilation, instantiation, and `BrowserCore.ready()` are budgeted
per engine on the CI browser reference runners:

| Engine   | Budget |
| -------- | -----: |
| Chromium | 100 ms |
| WebKit   | 100 ms |
| Firefox  | 250 ms |

Firefox compiles and instantiates the module measurably slower than the other
engines, and a single shared 100 ms budget sat close enough to its real cost
that the gate passed or failed on noise. A budget that flaps proves nothing, so
each engine carries the limit it can be held to, and every one still fails on a
regression of roughly two times. The retained browser evidence records the
measured initialization time rather than inferring it from individual API
availability.

The accepted portable-kernel workload reads a 500-key snapshot from OPFS,
loads it into Wasm, and scans a 100-key range. I/O and snapshot-load time are
recorded separately; three alternating warm JavaScript and Wasm scans after one
warmups must show at least a 1.2x median speedup in Chromium. A separate
120-document workload resolving five IDs records full-query and integrated-index timings without
using them as the kernel promotion threshold because OPFS document reads are
outside the portable index kernel.

## Qualification status

The repository attempts the same real-OPFS corpus in Chromium, Firefox, and
WebKit: exact/prefix/range/reverse/intersection parity, WAL
additions/removals, compaction, restart, CSP, payload, initialization,
memory-pressure, and fetch fallback. The fixture first opens the OPFS root; a
browser that exposes the API but rejects that operation records
`EOPFS_UNAVAILABLE` and is not counted as qualified. A browser is promoted only
when the retained job for the exact commit passes; the existence of
WebAssembly or OPFS APIs alone is not a FYLO support claim.
