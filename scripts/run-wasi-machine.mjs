// Run the WASI build of FYLO as if it were the native binary.
//
// A shim spawns `fylo exec --loop --root <path>` and speaks NDJSON over stdio.
// This gives the Wasm module the same shape: same argv, same stdin, same
// stdout, so the shim's own code needs no branch. Any WASI runtime works —
// `wasmtime --dir <root> fylo.wasm exec --loop --root <root>` is the same
// invocation; Node is used here only because it ships one.
//
// Usage: node scripts/run-wasi-machine.mjs <module.wasm> [...arguments]

import { WASI } from 'node:wasi'
import { readFile } from 'node:fs/promises'

const [, , modulePath, ...args] = process.argv
if (!modulePath) throw new Error('usage: run-wasi-machine.mjs <module.wasm> [...arguments]')

// A guest sees only what is preopened. The root the arguments name is mapped at
// its own path so `--root` needs no rewriting, and `/` is preopened because the
// engine canonicalizes the root before locking it, which walks from the top.
const rootIndex = args.indexOf('--root')
const root = rootIndex === -1 ? undefined : args[rootIndex + 1]
const preopens = { '/': '/' }
if (root) preopens[root] = root

// WASI has an environment even though a browser does not, so a supervisor can
// pass the same variables it would give the native binary.
const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => name.startsWith('FYLO_'))
)

const wasi = new WASI({
    version: 'preview1',
    args: ['fylo', ...args],
    env,
    preopens,
    returnOnExit: true
})

const module_ = await WebAssembly.compile(await readFile(modulePath))
const instance = await WebAssembly.instantiate(module_, wasi.getImportObject())
process.exitCode = wasi.start(instance)
