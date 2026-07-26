import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import Fylo from '../src/index.js'
import { BrowserPrefixIndexCodec } from '../src/browser/core/prefix-index.js'

const root = await mkdtemp(join(tmpdir(), 'fylo-rust-readonly-'))
try {
    const database = new Fylo(root, { versioning: { autoCommit: false } })
    console.error('Seeding JavaScript compatibility root...')
    await database.users.create()
    const id = await database.users.put({ name: 'Ada', score: 42 })
    await database.users.rebuild()
    await database.close()

    const before = await snapshot(root)
    console.error('Reading JavaScript root with fylo-rust...')
    const record = await rustJson([
        'get',
        '--root',
        root,
        '--collection',
        'users',
        '--id',
        String(id)
    ])
    assert(record.metadata.id === id, 'Rust canonical document ID drift')
    assert(record.document.name === 'Ada', 'Rust document body drift')
    assert(record.document.score === 42, 'Rust numeric value drift')

    const inspection = await rustJson(['inspect', '--root', root, '--collection', 'users'])
    assert(inspection.documentCount === 1, 'Rust inspection count drift')
    assert(inspection.readOnly === true, 'Rust preview must report read-only')

    const [planned] = await BrowserPrefixIndexCodec.queryPrefixes('users', 'name', { $eq: 'Ada' })
    const prefix = BrowserPrefixIndexCodec.prefix('name', planned.kind, planned.valuePrefix)
    const ids = await rustJson([
        'scan-index',
        '--root',
        root,
        '--collection',
        'users',
        '--queries',
        JSON.stringify([{ prefix }])
    ])
    assert(
        JSON.stringify(ids) === JSON.stringify([id]),
        `Rust prefix scan drift for ${prefix}: ${JSON.stringify(ids)}`
    )
    assert(
        JSON.stringify(await snapshot(root)) === JSON.stringify(before),
        'Rust preview mutated root'
    )
    console.log(`Verified Rust read-only interoperability for JavaScript document ${id}`)
} finally {
    await rm(root, { recursive: true, force: true })
}
process.exit(0)

async function rustJson(arguments_) {
    const child = Bun.spawn(
        [
            process.execPath,
            './scripts/run-rust.mjs',
            'cargo',
            'run',
            '--quiet',
            '--locked',
            '-p',
            'fylo-cli',
            '--bin',
            'fylo-rust',
            '--',
            ...arguments_
        ],
        {
            cwd: fileURLToPath(new URL('../', import.meta.url)),
            stdout: 'pipe',
            stderr: 'pipe'
        }
    )
    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited
    ])
    if (exitCode !== 0) throw new Error(`fylo-rust failed: ${stderr}`)
    return JSON.parse(stdout)
}

async function snapshot(rootPath) {
    const entries = []
    async function walk(directory) {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
            const path = join(directory, entry.name)
            const metadata = await stat(path)
            entries.push([path.slice(rootPath.length), metadata.size, Math.floor(metadata.mtimeMs)])
            if (entry.isDirectory()) await walk(path)
        }
    }
    await walk(rootPath)
    return entries.sort(([left], [right]) => left.localeCompare(right))
}

function assert(value, message) {
    if (!value) throw new Error(message)
}
