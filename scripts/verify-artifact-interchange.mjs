// Prove a shim cannot tell the native binary and the Wasm module apart.
//
// Every language shim drives FYLO the same way: spawn something, write NDJSON
// to its stdin, read NDJSON from its stdout. If the two artifacts answer one
// script identically, swapping them is invisible to all of them at once, and
// no per-language test is needed to say so.
//
// Values that must differ are canonicalized rather than ignored: identifiers,
// timestamps, durations, and paths are generated per run, and the build target
// is the whole point of having two artifacts. Everything else is compared
// exactly, including error codes and messages.
//
// Usage:
//   node scripts/verify-artifact-interchange.mjs \
//     --binary target/release/fylo-rust \
//     --wasm target/wasm32-wasip1/release/fylo-rust.wasm \
//     [--output target/interchange/report.json]

import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const binary = resolve(requiredOption('--binary'))
const wasm = resolve(requiredOption('--wasm'))
const output = resolve(option('--output') ?? 'target/interchange/artifact-interchange.json')
const runner = new URL('./run-wasi-machine.mjs', import.meta.url).pathname

// One script over every operation class a shim actually drives: collection
// lifecycle, document CRUD, developer metadata, query, SQL, buckets, deletion
// and restore, plus deliberate failures. The failures matter most — a shim
// switches on error codes, so they have to match too.
const SCRIPT = [
    { op: 'handshake' },
    { op: 'createCollection', collection: 'notes' },
    { op: 'putData', collection: 'notes', data: { name: 'Ada', score: 42, tag: 'x' } },
    { op: 'putData', collection: 'notes', data: { name: 'Grace', score: 7, tag: 'y' } },
    { op: 'findDocs', collection: 'notes', query: {} },
    { op: 'findDocs', collection: 'notes', query: { $ops: [{ name: { $eq: 'Ada' } }] } },
    { op: 'findDocs', collection: 'notes', query: { $ops: [{ score: { $gte: 10 } }] } },
    { op: 'inspectCollection', collection: 'notes' },
    { op: 'executeSQL', sql: "SELECT * FROM notes WHERE tag = 'y'" },
    { op: 'executeSQL', sql: "UPDATE notes SET tag = 'z' WHERE tag = 'x'" },
    { op: 'verifyCollection', collection: 'notes' },
    { op: 'rebuildCollection', collection: 'notes' },
    // Buckets: a raw-file record and its attribute sidecar resolve differently
    // on a platform without extended attributes, so the read-back paths matter
    // as much as the write.
    { op: 'createCollection', collection: 'files', kind: 'file' },
    { op: 'putData', collection: 'files', file: { path: '<source>' }, meta: { reviewed: true } },
    { op: 'findDocs', collection: 'files', query: {} },
    { op: 'inspectCollection', collection: 'files' },
    // Version control is pure filesystem work and must survive the swap too.
    { op: 'commit', message: 'first' },
    { op: 'branch' },
    { op: 'log' },
    { op: 'status' },
    // Deliberate failures: a shim maps these to its own exception types.
    { op: 'getDoc', collection: 'notes', id: 'NOTATTID' },
    { op: 'inspectCollection', collection: 'absent' },
    { op: 'putData', collection: 'notes' },
    { op: 'nosuchoperation' },
    { op: 'backupStatus' }
]

// Differences that are the point of shipping two artifacts, not defects.
const EXPECTED_DIVERGENCE = new Set([
    // The artifact identifies itself; that is the point of having two.
    'result.buildTarget',
    // WASI has no advisory locking, so the kernel does not refuse a second
    // writer and the capability says so.
    'result.capabilities.exclusiveRoot',
    // No TLS stack in the module: the host fetches and supplies bytes.
    'result.capabilities.documentBuckets.putInputs',
    // POSIX uid/gid/mode needs syscalls WASI does not have.
    'result.capabilities.machineAccess',
    // Schema validation shells out to the CHEX binary, and WebAssembly cannot
    // spawn a process.
    'result.dependencies.chex.available',
    'result.dependencies.ttid.available'
])

try {
    const nativeFrames = await drive([binary], SCRIPT)
    const wasmFrames = await drive(['node', runner, wasm], SCRIPT)

    assert(
        nativeFrames.length === wasmFrames.length,
        `frame count differs: native ${nativeFrames.length}, wasm ${wasmFrames.length}`
    )

    const divergences = []
    for (const [index, request] of SCRIPT.entries()) {
        const left = canonicalize(nativeFrames[index])
        const right = canonicalize(wasmFrames[index])
        for (const path of difference(left, right)) {
            if (EXPECTED_DIVERGENCE.has(path)) continue
            divergences.push({ frame: index, op: request.op, path })
        }
    }

    assert(
        divergences.length === 0,
        `a shim would notice these differences:\n${divergences
            .map(({ frame, op, path }) => `  frame ${frame} (${op}): ${path}`)
            .join('\n')}`
    )

    const report = {
        format: 'fylo.artifact-interchange.v1',
        binary,
        wasm,
        frames: SCRIPT.length,
        comparedOperations: [...new Set(SCRIPT.map(({ op }) => op))].sort(),
        expectedDivergence: [...EXPECTED_DIVERGENCE].sort(),
        passed: true
    }
    await mkdir(dirname(output), { recursive: true })
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`)
    console.log(
        `Verified the native binary and the Wasm module answer ${SCRIPT.length} frames identically: ${output}`
    )
} catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
}

/** Run one NDJSON script through one artifact in a fresh root. */
async function drive(command, script) {
    const root = await mkdtemp(join(tmpdir(), 'fylo-interchange-'))
    try {
        // Bucket ingestion reads a real path, so seed one inside the root and
        // let the script reference it by placeholder.
        const source = join(root, 'source.bin')
        await writeFile(source, 'hello bucket')
        const input = `${script
            .map((request) =>
                JSON.stringify({ ...request, root })
                    .split('<source>')
                    .join(source)
            )
            .join('\n')}\n`
        const child = spawn(command[0], [...command.slice(1), 'exec', '--loop', '--root', root], {
            stdio: ['pipe', 'pipe', 'pipe']
        })
        child.stdin.end(input)
        const [stdout] = await Promise.all([
            collect(child.stdout),
            collect(child.stderr),
            new Promise((resolveExit) => child.once('close', resolveExit))
        ])
        const frames = stdout
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line))
        return frames.map((frame) => ({ ...frame, __root: root }))
    } finally {
        await rm(root, { recursive: true, force: true })
    }
}

async function collect(stream) {
    let text = ''
    for await (const chunk of stream) text += chunk
    return text
}

/**
 * Replace values that are legitimately per-run with a marker, so what remains
 * is the contract a shim depends on.
 */
function canonicalize(frame) {
    const root = frame.__root
    const walk = (value, key) => {
        if (typeof value === 'string') {
            // Version-control timestamps are ISO strings rather than numbers.
            if (isTimestampKey(key) && !Number.isNaN(Date.parse(value))) return '<timestamp>'
            // Commit and object ids are content hashes, fresh every run.
            if (/^[0-9a-f]{40,64}$/.test(value)) return '<hash>'
            if (/^[0-9][0-9A-Z]{7,}(?:-[0-9A-Z]+)*$/.test(value)) return '<id>'
            let text = root ? value.split(root).join('<root>') : value
            text = text.replace(/\/[0-9A-Z]{2,4}\/(?=<id>)/g, '/<shard>/')
            // Identifiers are embedded in messages and paths too.
            return text.replace(/\b[0-9][0-9A-Z]{9,}\b/g, '<id>')
        }
        if (typeof value === 'number') {
            return isTimestampKey(key) ? '<timestamp>' : value
        }
        if (Array.isArray(value)) return value.map((item) => walk(item, key))
        if (value && typeof value === 'object') {
            // Document ids are object keys, and every run generates different
            // ones. Numbering them by sorted position keeps a multi-document
            // result comparable — and keeps result *order* comparable, which is
            // the `ttid-binary-ascending` contract a cursor depends on.
            const names = Object.keys(value).filter((name) => isIdentifier(name))
            const position = new Map(names.map((name, index) => [name, index]))
            const mapped = {}
            for (const [name, child] of Object.entries(value)) {
                if (name === '__root' || name === 'durationMs') continue
                const key = position.has(name) ? `<id:${position.get(name)}>` : name
                mapped[key] = walk(child, name)
            }
            return mapped
        }
        return value
    }
    return walk(frame, '')
}

function isIdentifier(name) {
    return /^[0-9][0-9A-Z]{7,}(?:-[0-9A-Z]+)*$/.test(name)
}

function isTimestampKey(key) {
    return /(?:^|_)(?:time|timestamp)$|(?:At|Ms|mtime|lastModified)$/i.test(key)
}

/** Every dotted path where two canonicalized frames disagree. */
function difference(left, right, prefix = '') {
    const paths = []
    const names = new Set([...keysOf(left), ...keysOf(right)])
    if (names.size === 0) {
        if (JSON.stringify(left) !== JSON.stringify(right)) paths.push(prefix || '<value>')
        return paths
    }
    for (const name of names) {
        const path = prefix ? `${prefix}.${name}` : name
        const a = left?.[name]
        const b = right?.[name]
        if (isBranch(a) && isBranch(b)) {
            paths.push(...difference(a, b, path))
        } else if (JSON.stringify(a) !== JSON.stringify(b)) {
            paths.push(path)
        }
    }
    return paths
}

function isBranch(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function keysOf(value) {
    return isBranch(value) ? Object.keys(value) : []
}

function assert(value, message) {
    if (!value) throw new Error(message)
}

function requiredOption(name) {
    const value = option(name)
    if (value === undefined) throw new Error(`missing ${name}`)
    return value
}

function option(name) {
    const index = process.argv.indexOf(name)
    if (index === -1) return undefined
    const value = process.argv[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${name}`)
    return value
}
