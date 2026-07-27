import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { platform, tmpdir } from 'node:os'
import { join } from 'node:path'

import Fylo from '../src/index.js'

const workspace = await mkdtemp(join(tmpdir(), 'fylo-rust-write-interop-'))
const root = join(workspace, 'root')
const collection = 'records'
const identifier = '4VRNF52JPCO'
const fileCollection = 'assets'
const fileIdentifier = '4VRNF52JPCP'

try {
    await mkdir(root, { recursive: true })
    const seed = new Fylo(root, { versioning: { autoCommit: false } })
    await seed[collection].create()
    await seed[fileCollection].create({ kind: 'file' })
    await seed.close()

    await command([
        process.execPath,
        './scripts/run-rust.mjs',
        'cargo',
        'build',
        '--locked',
        '-p',
        'fylo-cli',
        '--bin',
        'fylo-write-preview'
    ])
    const binary = join(
        process.cwd(),
        'target',
        'debug',
        platform() === 'win32' ? 'fylo-write-preview.exe' : 'fylo-write-preview'
    )

    const interrupted = await run(
        binary,
        [
            'put-document',
            '--root',
            root,
            '--collection',
            collection,
            '--id',
            identifier,
            '--document',
            '{"name":"interrupted"}'
        ],
        {
            FYLO_RUST_FAILPOINT: 'after-state-writing',
            FYLO_RUST_FAILPOINT_ACTION: 'abort'
        }
    )
    assert(interrupted.exitCode !== 0, 'Rust failpoint did not terminate the writer')
    await runRequired(binary, ['recover', '--root', root, '--collection', collection])

    await runRequired(binary, [
        'put-document',
        '--root',
        root,
        '--collection',
        collection,
        '--id',
        identifier,
        '--document',
        '{"name":"Ada","score":42}'
    ])
    await verifyCurrentDocument(root, { name: 'Ada', score: 42 })

    await runRequired(binary, [
        'patch-document',
        '--root',
        root,
        '--collection',
        collection,
        '--id',
        identifier,
        '--document',
        '{"name":"Grace","score":50}'
    ])
    await verifyCurrentDocument(root, { name: 'Grace', score: 50 })

    await runRequired(binary, [
        'put-file',
        '--root',
        root,
        '--collection',
        fileCollection,
        '--id',
        fileIdentifier,
        '--bytes-hex',
        '00010203ff',
        '--key',
        '/fixtures/sample.bin',
        '--extension',
        '.bin',
        '--metadata',
        '{"source":"rust","reviewed":true}'
    ])
    const fileReader = new Fylo(root, { versioning: { autoCommit: false } })
    await fileReader.ready()
    const file = (await fileReader[fileCollection].get(fileIdentifier).once())[fileIdentifier]
    assert(file.key === '/fixtures/sample.bin', 'JavaScript raw-file key drift')
    assert(file.contentLength === 5, 'JavaScript raw-file length drift')
    assert(file.meta.source === 'rust', 'JavaScript raw-file metadata drift')
    const fileMatches = []
    for await (const record of fileReader[fileCollection]
        .find({ $ops: [{ key: { $eq: '/fixtures/sample.bin' } }] })
        .collect()) {
        fileMatches.push(record)
    }
    assert(fileMatches.length === 1, 'JavaScript could not query the Rust raw-file index')
    await fileReader.close()

    const interruptedDelete = await run(
        binary,
        ['delete-document', '--root', root, '--collection', collection, '--id', identifier],
        {
            FYLO_RUST_FAILPOINT: 'after-delete-rename',
            FYLO_RUST_FAILPOINT_ACTION: 'abort'
        }
    )
    assert(interruptedDelete.exitCode !== 0, 'Rust delete failpoint did not terminate the writer')
    await verifyCurrentDocument(root, { name: 'Grace', score: 50 })

    const committedDelete = await run(
        binary,
        ['delete-document', '--root', root, '--collection', collection, '--id', identifier],
        {
            FYLO_RUST_FAILPOINT: 'after-commit-marker',
            FYLO_RUST_FAILPOINT_ACTION: 'abort'
        }
    )
    assert(committedDelete.exitCode !== 0, 'Rust commit failpoint did not terminate the writer')
    const current = new Fylo(root, { versioning: { autoCommit: false } })
    await current.ready()
    const inspection = await current[collection].inspect()
    assert(Number(inspection.docsStored) === 0, 'JavaScript did not roll forward Rust delete')
    assert(Number(inspection.deletedDocs) === 1, 'Rust tombstone was not retained')
    await current.close()

    console.log('Verified Rust writes and JavaScript recovery in both rollback directions')
} finally {
    await rm(workspace, { recursive: true, force: true })
}

async function verifyCurrentDocument(root, expected) {
    const current = new Fylo(root, { versioning: { autoCommit: false } })
    await current.ready()
    const document = (await current[collection].get(identifier).once())[identifier]
    assert(JSON.stringify(document) === JSON.stringify(expected), 'JavaScript document drift')
    const found = []
    for await (const record of current[collection]
        .find({ $ops: [{ name: { $eq: expected.name } }] })
        .collect()) {
        found.push(record)
    }
    assert(found.length === 1, 'JavaScript could not query the Rust-rebuilt index')
    await current.close()
}

async function runRequired(binary, arguments_) {
    const result = await run(binary, arguments_)
    if (result.exitCode !== 0) {
        throw new Error(`fylo-write-preview failed: ${result.stderr}`)
    }
    return result
}

async function run(binary, arguments_, overrides = {}) {
    const subprocess = Bun.spawn([binary, ...arguments_], {
        cwd: process.cwd(),
        env: { ...process.env, ...overrides },
        stdout: 'pipe',
        stderr: 'pipe'
    })
    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(subprocess.stdout).text(),
        new Response(subprocess.stderr).text(),
        subprocess.exited
    ])
    return { stdout, stderr, exitCode }
}

async function command(arguments_) {
    const subprocess = Bun.spawn(arguments_, {
        cwd: process.cwd(),
        env: process.env,
        stdout: 'inherit',
        stderr: 'inherit'
    })
    const exitCode = await subprocess.exited
    if (exitCode !== 0) throw new Error(`command failed (${exitCode}): ${arguments_.join(' ')}`)
}

function assert(condition, message) {
    if (!condition) throw new Error(message)
}
