import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import Fylo from '../src/index.js'
import { BrowserPrefixIndexCodec } from '../src/browser/core/prefix-index.js'
import { VersionRepository } from '../src/versioning/repository.js'

const root = await mkdtemp(join(tmpdir(), 'fylo-rust-readonly-'))
const schemaRoot = `${root}-schema`
const previousEncryption = {
    schema: process.env.FYLO_SCHEMA,
    key: process.env.FYLO_ENCRYPTION_KEY,
    salt: process.env.FYLO_CIPHER_SALT
}
try {
    const encryptionKey = 'rust-readonly-interop-key-32-bytes-minimum'
    const cipherSalt = 'rust-readonly-interop-salt'
    await mkdir(join(schemaRoot, 'secrets', 'history'), { recursive: true })
    await writeFile(
        join(schemaRoot, 'secrets', 'manifest.json'),
        JSON.stringify({ current: 'v1', versions: [{ v: 'v1' }] })
    )
    await writeFile(
        join(schemaRoot, 'secrets', 'history', 'v1.schema.json'),
        JSON.stringify({ $encrypted: ['secret', 'nested/verifier'] })
    )
    process.env.FYLO_SCHEMA = schemaRoot
    process.env.FYLO_ENCRYPTION_KEY = encryptionKey
    process.env.FYLO_CIPHER_SALT = cipherSalt

    const database = new Fylo(root, { versioning: { autoCommit: false } })
    console.error('Seeding JavaScript compatibility root...')
    await database.users.create()
    await database.assets.create({ kind: 'file' })
    await database.secrets.create()
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
    const encryptedId = await database.secrets.put({
        kind: 'security-event',
        secret: 'correct horse battery staple',
        nested: { verifier: 42 }
    })
    await database.users.rebuild()
    await database.assets.rebuild()
    await database.close()
    const versionCommit = await new VersionRepository(root).commit('Rust read-only fixture')

    const before = await snapshot(root)
    console.error('Reading JavaScript root with fylo-rust...')
    const history = await rustJson(['log', '--root', root, '--limit', '10'])
    assert(history.enabled === true, 'Rust version-history enablement drift')
    assert(history.branch === 'main', 'Rust version-history branch drift')
    assert(history.head === versionCommit.id, 'Rust version-history head drift')
    assert(history.commits[0].message === 'Rust read-only fixture', 'Rust commit-message drift')
    assert(history.truncated === false, 'Rust version-history truncation drift')
    const versionVerification = await rustJson([
        'verify-history',
        '--root',
        root,
        '--limit',
        '10'
    ])
    assert(versionVerification.contentIntegrity === true, 'Rust version-object integrity drift')
    assert(versionVerification.historyComplete === true, 'Rust version-history coverage drift')
    assert(versionVerification.commitsVerified === 1, 'Rust verified commit count drift')
    assert(versionVerification.blobObjects > 0, 'Rust version blob traversal drift')
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

    const encrypted = await rustJson([
        'get',
        '--root',
        root,
        '--collection',
        'secrets',
        '--id',
        String(encryptedId)
    ])
    assert(
        encrypted.document.secret === 'correct horse battery staple',
        'Rust encrypted string decoding drift'
    )
    assert(encrypted.document.nested.verifier === 42, 'Rust encrypted typed-value decoding drift')
    const wrongKey = await rustFailure(
        ['get', '--root', root, '--collection', 'secrets', '--id', String(encryptedId)],
        { FYLO_ENCRYPTION_KEY: 'wrong-key-material-that-is-at-least-32-bytes' }
    )
    assert(wrongKey.includes('EENGINE_ENCRYPTION'), 'Rust wrong-key error-code drift')
    assert(!wrongKey.includes('v2.'), 'Rust wrong-key error leaked ciphertext')
    const missingKey = await rustFailure(
        ['get', '--root', root, '--collection', 'secrets', '--id', String(encryptedId)],
        { FYLO_ENCRYPTION_KEY: undefined }
    )
    assert(missingKey.includes('EENGINE_ENCRYPTION'), 'Rust missing-key error-code drift')
    assert(!missingKey.includes('v2.'), 'Rust missing-key error leaked ciphertext')
    const missingSchema = await rustFailure(
        ['get', '--root', root, '--collection', 'secrets', '--id', String(encryptedId)],
        { FYLO_SCHEMA: undefined }
    )
    assert(missingSchema.includes('EENGINE_ENCRYPTION'), 'Rust missing-schema error-code drift')
    assert(!missingSchema.includes('v2.'), 'Rust missing-schema error leaked ciphertext')

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
    const indexVerification = await rustJson([
        'verify-index',
        '--root',
        root,
        '--collection',
        'users'
    ])
    assert(indexVerification.referenceIntegrity === true, 'Rust index reference verification drift')
    assert(indexVerification.liveDocuments === 2, 'Rust index live-document count drift')
    assert(indexVerification.indexedDocuments === 2, 'Rust indexed-document count drift')
    assert(
        indexVerification.rebuildEquivalent === false,
        'Rust preview must not overclaim full rebuild equivalence'
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
    restoreEnvironment('FYLO_SCHEMA', previousEncryption.schema)
    restoreEnvironment('FYLO_ENCRYPTION_KEY', previousEncryption.key)
    restoreEnvironment('FYLO_CIPHER_SALT', previousEncryption.salt)
    await rm(root, { recursive: true, force: true })
    await rm(schemaRoot, { recursive: true, force: true })
}
process.exit(0)

async function rustJson(arguments_) {
    const result = await rustResult(arguments_)
    if (result.exitCode !== 0) throw new Error(`fylo-rust failed: ${result.stderr}`)
    return JSON.parse(result.stdout)
}

async function rustFailure(arguments_, environment) {
    const result = await rustResult(arguments_, environment)
    if (result.exitCode === 0) throw new Error('fylo-rust unexpectedly accepted invalid encryption')
    return result.stderr
}

async function rustResult(arguments_, overrides = {}) {
    const environment = { ...process.env }
    for (const [name, value] of Object.entries(overrides)) {
        if (value === undefined) delete environment[name]
        else environment[name] = value
    }
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
            stderr: 'pipe',
            env: environment
        }
    )
    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited
    ])
    return { stdout, stderr, exitCode }
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

function restoreEnvironment(name, value) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
}
