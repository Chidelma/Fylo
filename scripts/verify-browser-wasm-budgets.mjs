import { gzipSync } from 'node:zlib'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const MAX_WASM_BYTES = 128 * 1024
const MAX_WASM_GZIP_BYTES = 64 * 1024
const MAX_HOST_BYTES = 192 * 1024
const outputArgument = process.argv.indexOf('--output')
const output =
    outputArgument === -1
        ? null
        : resolve(process.argv[outputArgument + 1] ?? 'target/wasm-budget.json')

const assets = {
    wasm: await measure('dist-web/fylo-index.wasm'),
    host: await measure('dist-web/fylo.mjs')
}
const evidence = {
    schemaVersion: 1,
    budgets: {
        wasmBytes: MAX_WASM_BYTES,
        wasmGzipBytes: MAX_WASM_GZIP_BYTES,
        hostBytes: MAX_HOST_BYTES,
        initializationMs: 100,
        indexedQueryMinimumSpeedup: 1.2
    },
    assets
}

assertWithin('Wasm payload', assets.wasm.bytes, MAX_WASM_BYTES)
assertWithin('gzip Wasm payload', assets.wasm.gzipBytes, MAX_WASM_GZIP_BYTES)
assertWithin('browser host payload', assets.host.bytes, MAX_HOST_BYTES)

if (output) {
    await mkdir(dirname(output), { recursive: true })
    await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`)
}
console.log(JSON.stringify(evidence))

async function measure(path) {
    const bytes = await readFile(path)
    return { path, bytes: bytes.byteLength, gzipBytes: gzipSync(bytes, { level: 9 }).byteLength }
}

function assertWithin(name, actual, maximum) {
    if (actual > maximum) {
        throw new Error(`${name} is ${actual} bytes; budget is ${maximum} bytes`)
    }
}
