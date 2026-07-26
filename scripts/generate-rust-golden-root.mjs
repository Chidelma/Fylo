import { mkdir, readFile, statfs, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import Fylo from '../src/index.js'
import { hashRoot } from './rust-golden-root-lib.mjs'

const output = option('--output')
if (!output) throw new Error('Usage: generate-rust-golden-root.mjs --output <new-directory>')

const destination = resolve(output)
await mkdir(dirname(destination), { recursive: true })
await mkdir(destination)
const root = join(destination, 'root')
const operations = []
const database = new Fylo(root, { versioning: { autoCommit: false } })

try {
    await record('create documents', { kind: 'document' }, () => database.people.create())
    await record('create raw files', { kind: 'file' }, () =>
        database.assets.create({ kind: 'file' })
    )

    const adaId = await database.people
        .put({ name: 'Ada', role: 'admin', score: 42, nested: { active: true } })
        .metadata({ owner: 'engineering', priority: 2, canonicalCollision: 'custom' })
    operations.push({
        operation: 'put-document',
        collection: 'people',
        id: String(adaId)
    })
    await record(
        'patch document',
        { collection: 'people', id: String(adaId), changes: { score: 43 } },
        () => database.people.patch(adaId, { score: 43 })
    )

    let protectedPut = database.people.put({
        name: 'Grace',
        role: 'editor',
        score: 50
    })
    const access = nativeAccess()
    if (access) protectedPut = protectedPut.as(access)
    const graceId = await protectedPut
    operations.push({
        operation: 'put-protected-document',
        collection: 'people',
        id: String(graceId),
        access
    })

    const deletedId = await database.people.put({
        name: 'Linus',
        role: 'retired',
        score: 1
    })
    await record('delete document', { collection: 'people', id: String(deletedId) }, () =>
        database.people.delete(deletedId)
    )

    const rawId = await database.assets
        .put(new File([new Uint8Array([0, 1, 2, 3, 255])], 'sample.bin'), {
            key: '/fixtures/sample.bin'
        })
        .metadata({ source: 'rust-golden-v1', reviewed: true })
    operations.push({
        operation: 'put-file',
        collection: 'assets',
        id: String(rawId)
    })

    await record('rebuild document index', { collection: 'people' }, () =>
        database.people.rebuild()
    )
    await record('rebuild file index', { collection: 'assets' }, () => database.assets.rebuild())

    const probes = {
        document: {
            collection: 'people',
            id: String(adaId),
            value: await database.people.get(adaId).once(),
            metadata: await database.people.get(adaId).metadata()
        },
        protectedDocument: {
            collection: 'people',
            id: String(graceId),
            access,
            value: access
                ? await database.people.get(graceId).as({ uid: access.uid })
                : await database.people.get(graceId).once()
        },
        query: {
            collection: 'people',
            query: { $ops: [{ score: { $gte: 43 } }] },
            value: await collect(database.people.find({ $ops: [{ score: { $gte: 43 } }] }))
        },
        deleted: {
            collection: 'people',
            query: { $ops: [{ role: { $eq: 'retired' } }] },
            value: await collect(
                database.people.find.deleted({
                    $ops: [{ role: { $eq: 'retired' } }]
                })
            )
        },
        file: {
            collection: 'assets',
            id: String(rawId),
            value: await database.assets.get(rawId).once(),
            metadata: await database.assets.get(rawId).metadata(),
            bytesBase64: Buffer.from(await database.assets.get(rawId).bytes()).toString('base64')
        }
    }
    await database.close()

    const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url)))
    const filesystem = await statfs(root)
    const tree = await hashRoot(root)
    const manifest = {
        format: 'fylo.rust-golden-root.v1',
        producer: {
            engine: 'fylo-js',
            version: packageJson.version,
            runtime: `bun ${Bun.version}`
        },
        platform: {
            os: process.platform,
            architecture: process.arch,
            filesystemType: String(filesystem.type)
        },
        supportTier: 'compatibility-fixture',
        root: {
            path: 'root',
            digestAlgorithm: tree.algorithm,
            digest: tree.digest,
            entries: tree.entries.length
        },
        operations: 'operations.ndjson',
        probes
    }
    await writeFile(
        join(destination, 'operations.ndjson'),
        `${operations.map((entry) => JSON.stringify(entry)).join('\n')}\n`
    )
    await writeFile(join(destination, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    console.log(
        `Generated ${manifest.format} with ${tree.entries.length} entries at ${destination}`
    )
} catch (error) {
    await database.close().catch(() => {})
    throw error
}

async function record(operation, input, execute) {
    const result = await execute()
    operations.push({ operation, input, result: result ?? null })
    return result
}

async function collect(cursor) {
    const values = []
    for await (const value of cursor.collect()) values.push(value)
    return values
}

function nativeAccess() {
    if (typeof process.getuid !== 'function' || typeof process.getgid !== 'function') return null
    return {
        uid: process.getuid(),
        gid: process.getgid(),
        mode: 0o640
    }
}

function option(name) {
    const index = process.argv.indexOf(name)
    return index === -1 ? null : process.argv[index + 1]
}
