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
    await database.assets.create({ kind: 'file' })
    const id = await database.users.put({ name: 'Ada', score: 42, role: 'admin' })
    const graceId = await database.users.put({ name: 'Grace', score: 50, role: 'editor' })
    const rawId = await database.assets
        .put(new File([new Uint8Array([0, 1, 2, 3, 255])], 'sample.bin'), {
            key: '/fixtures/sample.bin'
        })
        .metadata({ source: 'rust-readonly', reviewed: true })
    const deletedId = await database.users.put({ name: 'Linus', score: 1, role: 'retired' })
    await database.users.delete(deletedId)
    const deletedRawId = await database.assets.put(
        new File([new Uint8Array([9, 8, 7])], 'deleted.bin'),
        { key: '/fixtures/deleted.bin' }
    )
    await database.assets.delete(deletedRawId)
    await database.users.rebuild()
    await database.assets.rebuild()
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
    assert(inspection.documentCount === 2, 'Rust inspection count drift')
    assert(inspection.readOnly === true, 'Rust preview must report read-only')

    const raw = await rustJson([
        'get-file',
        '--root',
        root,
        '--collection',
        'assets',
        '--id',
        String(rawId)
    ])
    assert(raw.metadata.id === rawId, 'Rust raw-file canonical ID drift')
    assert(raw.file.key === '/fixtures/sample.bin', 'Rust raw-file key drift')
    assert(raw.file.extension === '.bin', 'Rust raw-file extension drift')
    assert(raw.file.contentLength === 5, 'Rust raw-file length drift')
    assert(raw.bytesHex === '00010203ff', 'Rust raw-file bytes drift')
    assert(raw.customMetadata.source === 'rust-readonly', 'Rust raw-file metadata drift')
    assert(raw.customMetadata.reviewed === true, 'Rust typed raw-file metadata drift')
    assert(raw.file.etag === raw.file.checksumSHA256, 'Rust raw-file checksum/etag drift')
    const fileInspection = await rustJson([
        'inspect',
        '--root',
        root,
        '--collection',
        'assets'
    ])
    assert(fileInspection.fileCount === 1, 'Rust raw-file inspection count drift')
    assert(fileInspection.deletedCount === 1, 'Rust raw-file tombstone count drift')

    const deleted = await rustJson([
        'get-deleted',
        '--root',
        root,
        '--collection',
        'users',
        '--id',
        String(deletedId)
    ])
    assert(deleted.id === deletedId, 'Rust deleted-document ID drift')
    assert(deleted.document.role === 'retired', 'Rust deleted-document body drift')
    assert(deleted.deletedAt >= deleted.createdAt, 'Rust deleted-document timestamp drift')

    const deletedRaw = await rustJson([
        'get-deleted-file',
        '--root',
        root,
        '--collection',
        'assets',
        '--id',
        String(deletedRawId)
    ])
    assert(deletedRaw.file.key === '/fixtures/deleted.bin', 'Rust deleted raw-file key drift')
    assert(deletedRaw.bytesHex === '090807', 'Rust deleted raw-file bytes drift')
    assert(
        deletedRaw.deletedAt === deletedRaw.metadata.updatedAt,
        'Rust deleted raw-file timestamp drift'
    )

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
    const found = await rustJson([
        'find',
        '--root',
        root,
        '--collection',
        'users',
        '--query',
        JSON.stringify({ $ops: [{ role: { $eq: 'editor' } }] })
    ])
    assert(found.length === 1, 'Rust structured query count drift')
    assert(found[0].metadata.id === graceId, 'Rust structured query result drift')
    const selected = await rustJson([
        'sql',
        '--root',
        root,
        '--statement',
        "SELECT name FROM users WHERE role = 'editor'"
    ])
    assert(
        JSON.stringify(selected) === JSON.stringify({ [graceId]: { name: 'Grace' } }),
        'Rust SQL SELECT result drift'
    )
    assert(
        JSON.stringify(await snapshot(root)) === JSON.stringify(before),
        'Rust preview mutated root'
    )
    console.log(
        `Verified Rust read-only interoperability for live/deleted documents and raw files (${id}, ${graceId}, ${rawId})`
    )
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
