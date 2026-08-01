import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { Fylo as MachineFylo } from '../clients/node/fylo.mjs'

const releasedBinary = resolve(requiredOption('--released-binary'))
const rustBinary = resolve(requiredOption('--rust-binary'))
const expectedRustCommit = option('--expected-rust-commit')
const output = resolve(option('--output') ?? 'target/rollback/released-compatibility.json')
const workspace = await mkdtemp(join(tmpdir(), 'fylo-rust-released-rollback-'))
const root = join(workspace, 'root')
const collection = 'records'
let identifier

try {
    await chmod(releasedBinary, 0o755).catch(() => {})
    await chmod(rustBinary, 0o755).catch(() => {})
    const releasedIdentity = await jsonCommand([releasedBinary, 'version', '--output', 'json'])
    const rustIdentity = await jsonCommand([rustBinary, 'version', '--output', 'json'])
    if (releasedIdentity.buildKind !== 'release') {
        throw new Error('rollback oracle must be an immutable released JavaScript binary')
    }
    if (expectedRustCommit && rustIdentity.commit !== expectedRustCommit) {
        throw new Error(
            `Rust rollback binary commit mismatch: expected ${expectedRustCommit}, received ${rustIdentity.commit}`
        )
    }

    const releasedWriter = await open(releasedBinary)
    try {
        await required(releasedWriter, { op: 'createCollection', collection, kind: 'document' })
        identifier = await required(releasedWriter, {
            op: 'putData',
            collection,
            data: { name: 'Ada', score: 1, source: 'released' }
        })
    } finally {
        await releasedWriter.close()
    }

    const rustWriter = await open(rustBinary)
    try {
        await required(rustWriter, {
            op: 'patchDoc',
            collection,
            id: identifier,
            newDoc: { score: 2, upgradedBy: 'rust' }
        })
        await required(rustWriter, {
            op: 'setMeta',
            collection,
            id: identifier,
            meta: { compatibility: 'released-rollback' }
        })
    } finally {
        await rustWriter.close()
    }

    const releasedReaderWriter = await open(releasedBinary)
    try {
        const document = await required(releasedReaderWriter, {
            op: 'getDoc',
            collection,
            id: identifier
        })
        const metadata = await required(releasedReaderWriter, {
            op: 'getMeta',
            collection,
            id: identifier
        })
        const found = await required(releasedReaderWriter, {
            op: 'findDocs',
            collection,
            query: { $ops: [{ upgradedBy: { $eq: 'rust' } }] }
        })
        assert(document[identifier]?.score === 2, 'released binary could not read the Rust patch')
        assert(
            metadata.compatibility === 'released-rollback',
            'released binary could not read Rust metadata'
        )
        assert(Object.hasOwn(found, identifier), 'released binary could not query the Rust patch')
        await required(releasedReaderWriter, {
            op: 'patchDoc',
            collection,
            id: identifier,
            newDoc: { score: 3, rolledBackBy: 'released' }
        })
    } finally {
        await releasedReaderWriter.close()
    }

    const rustReader = await open(rustBinary)
    try {
        const document = await required(rustReader, {
            op: 'getDoc',
            collection,
            id: identifier
        })
        assert(
            document[identifier]?.score === 3 && document[identifier]?.rolledBackBy === 'released',
            'Rust could not read the post-rollback released-binary patch'
        )
    } finally {
        await rustReader.close()
    }

    const report = {
        format: 'fylo.rust-released-rollback.v1',
        generatedAt: new Date().toISOString(),
        released: {
            identity: releasedIdentity,
            sha256: await sha256File(releasedBinary)
        },
        rust: { identity: rustIdentity, sha256: await sha256File(rustBinary) },
        rootOwnership: 'sequential-exclusive',
        identifier,
        checks: {
            releasedRootReadByRust: true,
            rustPatchReadAndQueriedByReleased: true,
            rustMetadataReadByReleased: true,
            releasedRollbackPatchReadByRust: true
        },
        passed: true
    }
    await mkdir(dirname(output), { recursive: true })
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`)
    console.log(`Verified released/Rust upgrade and rollback interoperability: ${output}`)
} finally {
    await rm(workspace, { recursive: true, force: true })
}

async function open(binary) {
    const client = new MachineFylo(root, { binary, exclusiveRoot: true })
    await client.ready
    return client
}

async function required(client, request) {
    const response = await client.request(request)
    if (!response.ok) {
        throw new Error(
            `${request.op} failed (${response.error?.code}): ${response.error?.message}`
        )
    }
    return response.result
}

async function jsonCommand(arguments_) {
    const child = Bun.spawn(arguments_, { stdout: 'pipe', stderr: 'pipe' })
    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited
    ])
    if (exitCode !== 0) {
        throw new Error(`${arguments_.join(' ')} failed (${exitCode}): ${stderr.trim()}`)
    }
    return JSON.parse(stdout)
}

async function sha256File(path) {
    return createHash('sha256')
        .update(await readFile(path))
        .digest('hex')
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
