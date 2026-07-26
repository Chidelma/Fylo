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

## Qualification status

Chromium-compatible execution, restart, compaction, WAL reconciliation,
invalid snapshot rejection, and fallback are covered by the repository corpus.
Firefox and WebKit remain preview until their browser jobs run the same corpus;
the existence of WebAssembly support alone is not a FYLO support claim.
