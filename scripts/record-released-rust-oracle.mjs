import { createHash } from 'node:crypto'
import {
    chmod,
    cp,
    lstat,
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    rm,
    statfs,
    writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'

import { getXattr, listXattr } from '../src/storage/xattr.js'
import { hashRoot } from './rust-golden-root-lib.mjs'

const binary = resolve(requiredOption('--binary'))
const output = resolve(requiredOption('--output'))
const releaseTag = requiredOption('--release')
const expectedBinarySha256 = option('--expected-sha256')
const workspace = await mkdtemp(join(tmpdir(), 'fylo-released-oracle-'))
const root = join(output, 'root')
const schemaRoot = join(output, 'schema')
const operations = []
const encryption = {
    key: 'released-oracle-encryption-key-at-least-32-bytes',
    salt: 'released-oracle-encryption-salt'
}
const previousEnvironment = {
    schema: process.env.FYLO_SCHEMA,
    key: process.env.FYLO_ENCRYPTION_KEY,
    salt: process.env.FYLO_CIPHER_SALT
}

try {
    await mkdir(dirname(output), { recursive: true })
    await mkdir(output)
    await chmod(binary, 0o755).catch(() => {})
    const identity = await binaryJson(['version', '--output', 'json'])
    const binarySha256 = sha256(await readFile(binary))
    if (expectedBinarySha256 && binarySha256 !== expectedBinarySha256) {
        throw new Error(
            `oracle binary checksum drift: expected ${expectedBinarySha256}, received ${binarySha256}`
        )
    }
    assert(identity.buildKind === 'release', 'oracle binary is not a release build')
    assert(identity.runtimeVersion === releaseTag.replace(/^v/, ''), 'release tag/version drift')
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
    process.env.FYLO_ENCRYPTION_KEY = encryption.key
    process.env.FYLO_CIPHER_SALT = encryption.salt

    await record({ op: 'handshake' })
    await record({ op: 'createCollection', root, collection: 'people', kind: 'document' })
    await record({ op: 'createCollection', root, collection: 'assets', kind: 'file' })
    await record({ op: 'createCollection', root, collection: 'secrets', kind: 'document' })

    const adaId = await record({
        op: 'putData',
        root,
        collection: 'people',
        data: { name: 'Ada', role: 'admin', score: 42, nested: { active: true } },
        meta: { owner: 'engineering', priority: 2, canonicalCollision: 'custom' }
    })
    await record({
        op: 'patchDoc',
        root,
        collection: 'people',
        id: adaId,
        newDoc: { score: 43 }
    })

    const access = nativeAccess()
    const graceId = await record({
        op: 'putData',
        root,
        collection: 'people',
        data: { name: 'Grace', role: 'editor', score: 50 },
        ...(access ? { access } : {})
    })
    const deletedId = await record({
        op: 'putData',
        root,
        collection: 'people',
        data: { name: 'Linus', role: 'retired', score: 1 }
    })
    await record({ op: 'delDoc', root, collection: 'people', id: deletedId })

    const rawInput = join(workspace, 'sample.bin')
    const rawBytes = new Uint8Array([0, 1, 2, 3, 255])
    await writeFile(rawInput, rawBytes)
    const rawId = await record({
        op: 'putData',
        root,
        collection: 'assets',
        file: { path: rawInput, key: '/fixtures/sample.bin' },
        meta: { source: 'released-oracle-v1', reviewed: true }
    })
    const encryptedId = await record({
        op: 'putData',
        root,
        collection: 'secrets',
        data: {
            kind: 'security-event',
            secret: 'correct horse battery staple',
            nested: { verifier: 42 }
        }
    })
    await record({ op: 'rebuildCollection', root, collection: 'people' })
    await record({ op: 'rebuildCollection', root, collection: 'assets' })
    const commit = await record({
        op: 'commit',
        root,
        message: 'Released JavaScript compatibility oracle'
    })

    const probes = {
        document: {
            collection: 'people',
            id: adaId,
            value: await request({ op: 'getDoc', root, collection: 'people', id: adaId }),
            metadata: await request({ op: 'getMeta', root, collection: 'people', id: adaId })
        },
        protectedDocument: {
            collection: 'people',
            id: graceId,
            access,
            value: await request({
                op: 'getDoc',
                root,
                collection: 'people',
                id: graceId,
                ...(access ? { access: { uid: access.uid } } : {})
            })
        },
        query: {
            collection: 'people',
            query: { $ops: [{ score: { $gte: 43 } }] },
            value: await request({
                op: 'findDocs',
                root,
                collection: 'people',
                query: { $ops: [{ score: { $gte: 43 } }] }
            })
        },
        deleted: {
            collection: 'people',
            query: { $ops: [{ role: { $eq: 'retired' } }] },
            value: await request({
                op: 'findDeletedDocs',
                root,
                collection: 'people',
                query: { $ops: [{ role: { $eq: 'retired' } }] }
            })
        },
        file: {
            collection: 'assets',
            id: rawId,
            value: await request({ op: 'getDoc', root, collection: 'assets', id: rawId }),
            metadata: await request({ op: 'getMeta', root, collection: 'assets', id: rawId }),
            bytesBase64: Buffer.from(rawBytes).toString('base64')
        },
        version: {
            commit
        },
        encrypted: {
            collection: 'secrets',
            id: encryptedId,
            value: await request({
                op: 'getDoc',
                root,
                collection: 'secrets',
                id: encryptedId
            })
        }
    }

    const tree = await hashRoot(root)
    const schemaTree = await hashRoot(schemaRoot)
    const cases = {
        corruptDocument: await recordNegativeCase({
            name: 'corrupt-document',
            mutate: async (caseRoot) => {
                await writeFile(
                    join(
                        caseRoot,
                        '.collections',
                        'people',
                        'docs',
                        adaId.slice(0, 2),
                        `${adaId}.json`
                    ),
                    '{"name":'
                )
            },
            request: { op: 'getDoc', collection: 'people', id: adaId }
        }),
        interruptedTransaction: await recordNegativeCase({
            name: 'interrupted-transaction',
            mutate: async (caseRoot) => {
                const state = join(
                    caseRoot,
                    '.fylo-transactions',
                    '.collections',
                    'people',
                    'state.json'
                )
                await mkdir(dirname(state), { recursive: true })
                await writeFile(
                    state,
                    JSON.stringify({
                        format: 'fylo.collection-generation.v1',
                        generation: 999,
                        state: 'writing',
                        transactionId: 'released-oracle-interrupted'
                    })
                )
            },
            request: { op: 'getDoc', collection: 'people', id: adaId }
        }),
        corruptVersion: await recordNegativeCase({
            name: 'corrupt-version',
            mutate: async (caseRoot) => {
                await writeFile(
                    join(
                        caseRoot,
                        '.fylo-vcs',
                        'commits',
                        commit.id,
                        'manifest.json'
                    ),
                    '{"id":'
                )
            },
            request: { op: 'log' }
        })
    }
    const nativeMetadata = await captureNativeMetadata(root)
    const nativeMetadataText = `${nativeMetadata.map((entry) => JSON.stringify(entry)).join('\n')}\n`
    await writeFile(join(output, 'native-metadata.ndjson'), nativeMetadataText)
    await writeFile(
        join(output, 'operations.ndjson'),
        `${operations.map((entry) => JSON.stringify(entry)).join('\n')}\n`
    )
    const filesystem = await statfs(root)
    const manifest = {
        format: 'fylo.released-oracle.v1',
        producer: {
            engine: 'fylo-js-release-binary',
            releaseTag,
            version: identity.runtimeVersion,
            commit: identity.commit,
            buildTarget: identity.buildTarget,
            buildKind: identity.buildKind,
            binarySha256
        },
        recorder: {
            runtime: `bun ${Bun.version}`,
            protocolVersion: identity.protocolVersion
        },
        platform: {
            os: process.platform,
            architecture: process.arch,
            filesystemType: String(filesystem.type)
        },
        supportTier: 'released-compatibility-fixture',
        root: {
            path: 'root',
            digestAlgorithm: tree.algorithm,
            digest: tree.digest,
            entries: tree.entries.length,
            nativeMetadata: 'native-metadata.ndjson',
            nativeMetadataSha256: sha256(nativeMetadataText)
        },
        schema: {
            path: 'schema',
            digestAlgorithm: schemaTree.algorithm,
            digest: schemaTree.digest,
            entries: schemaTree.entries.length,
            testCredentials: encryption
        },
        operations: 'operations.ndjson',
        probes,
        cases
    }
    await writeFile(join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    console.log(
        JSON.stringify({
            output,
            releaseTag,
            buildTarget: identity.buildTarget,
            rootDigest: tree.digest,
            nativeMetadataEntries: nativeMetadata.length
        })
    )
} finally {
    restoreEnvironment('FYLO_SCHEMA', previousEnvironment.schema)
    restoreEnvironment('FYLO_ENCRYPTION_KEY', previousEnvironment.key)
    restoreEnvironment('FYLO_CIPHER_SALT', previousEnvironment.salt)
    await rm(workspace, { recursive: true, force: true })
}

async function record(requestFrame) {
    const result = await request(requestFrame)
    operations.push({ request: requestFrame, result })
    return result
}

async function request(requestFrame) {
    const response = await binaryJson(['exec', '--request', JSON.stringify(requestFrame)])
    if (!response.ok) {
        const error = new Error(`${response.error?.code ?? 'EUNKNOWN'}: ${response.error?.message}`)
        error.code = response.error?.code
        throw error
    }
    return response.result
}

async function requestOutcome(requestFrame) {
    const { stdout, stderr } = await runBinary([
        'exec',
        '--request',
        JSON.stringify(requestFrame)
    ])
    if (!stdout.trim()) throw new Error(stderr.trim() || 'released binary returned no response')
    return JSON.parse(stdout)
}

async function recordNegativeCase({ name, mutate, request: requestFrame }) {
    const caseDirectory = join(output, 'cases', name)
    const caseRoot = join(caseDirectory, 'root')
    await mkdir(caseDirectory, { recursive: true })
    await cp(root, caseRoot, { recursive: true, force: false, preserveTimestamps: true })
    await mutate(caseRoot)
    const response = await requestOutcome({ ...requestFrame, root: caseRoot })
    if (response.ok !== false || typeof response.error?.code !== 'string') {
        throw new Error(`released binary unexpectedly accepted negative case ${name}`)
    }
    const tree = await hashRoot(caseRoot)
    return {
        path: `cases/${name}/root`,
        digestAlgorithm: tree.algorithm,
        digest: tree.digest,
        entries: tree.entries.length,
        request: requestFrame,
        expectedError: response.error
    }
}

async function binaryJson(argumentsList) {
    const { stdout, stderr, exitCode } = await runBinary(argumentsList)
    if (exitCode !== 0) throw new Error(stderr.trim() || `binary exited with ${exitCode}`)
    return JSON.parse(stdout)
}

async function runBinary(argumentsList) {
    const subprocess = Bun.spawn([binary, ...argumentsList], {
        cwd: process.cwd(),
        env: process.env,
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

async function captureNativeMetadata(rootPath) {
    const entries = []
    await walk(rootPath)
    entries.sort((left, right) => left.path.localeCompare(right.path))
    return entries

    async function walk(directory) {
        const children = await readdir(directory, { withFileTypes: true })
        children.sort((left, right) => left.name.localeCompare(right.name))
        for (const child of children) {
            const path = join(directory, child.name)
            const metadata = await lstat(path, { bigint: true })
            const entry = {
                path: relative(rootPath, path).replaceAll('\\', '/'),
                kind: child.isDirectory() ? 'directory' : child.isSymbolicLink() ? 'symlink' : 'file',
                mode: Number(metadata.mode & 0o7777n),
                uid: metadata.uid.toString(),
                gid: metadata.gid.toString(),
                size: metadata.size.toString(),
                mtimeNs: metadata.mtimeNs.toString(),
                birthtimeNs: metadata.birthtimeNs.toString()
            }
            if (child.isFile()) entry.xattrs = await captureXattrs(path)
            entries.push(entry)
            if (child.isDirectory()) await walk(path)
        }
    }
}

async function captureXattrs(path) {
    const names = (await listXattr(path)).filter(
        (name) => name === 'user.fylo.access' || name.startsWith('user.fylo.')
    )
    names.sort()
    const attributes = {}
    for (const name of names) {
        const value = await getXattr(path, name)
        if (value !== null) attributes[name] = Buffer.from(value).toString('base64')
    }
    return attributes
}

function nativeAccess() {
    if (typeof process.getuid !== 'function' || typeof process.getgid !== 'function') return null
    return {
        uid: process.getuid(),
        gid: process.getgid(),
        mode: 0o640
    }
}

function requiredOption(name) {
    const value = option(name)
    if (!value) throw new Error(`missing required option ${name}`)
    return value
}

function option(name) {
    const index = process.argv.indexOf(name)
    const value = index === -1 ? undefined : process.argv[index + 1]
    if (index !== -1 && (!value || value.startsWith('--'))) {
        throw new Error(`missing value for ${name}`)
    }
    return value
}

function sha256(value) {
    return createHash('sha256').update(value).digest('hex')
}

function assert(value, message) {
    if (!value) throw new Error(message)
}

function restoreEnvironment(name, value) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
}
