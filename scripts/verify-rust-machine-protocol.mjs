import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { platform, tmpdir } from 'node:os'
import { join } from 'node:path'

import Fylo from '../src/index.js'
import { acquireRootLease } from '../src/cli/root-lease.js'

const workspace = await mkdtemp(join(tmpdir(), 'fylo-rust-machine-'))
const root = join(workspace, 'root')
const collection = 'users'
const identifier = '4VRNF52JPCO'

try {
    await mkdir(root, { recursive: true })
    const seed = new Fylo(root, { versioning: { autoCommit: false } })
    await seed[collection].create()
    await seed[collection].put(identifier, { name: 'Ada', active: true })
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
        'fylo-machine-preview'
    ])
    const binary = join(
        process.cwd(),
        'target',
        'debug',
        platform() === 'win32' ? 'fylo-machine-preview.exe' : 'fylo-machine-preview'
    )

    const registry = JSON.parse(await readFile('api/machine/v1/operations.json', 'utf8'))

    const handshake = (await session(binary, ['{"op":"handshake","requestId":"one"}']))[0]
    assert(handshake.ok === true, 'Rust handshake failed')
    assert(handshake.protocolVersion === registry.protocolVersion, 'Rust protocol version drift')
    assert(handshake.requestId === 'one', 'Rust dropped the request identifier')
    const machine = handshake.result.machine
    assert(machine.framing === 'ndjson' && machine.delimiter === 'LF', 'Rust framing drift')
    assert(machine.duplicateKeys === 'rejected', 'Rust duplicate-key policy drift')
    assert(
        machine.truncatedFrame === 'error-and-terminate' &&
            machine.malformedFrame === 'error-and-resume-at-next-LF',
        'Rust frame recovery policy drift'
    )

    const read = await session(binary, [
        JSON.stringify({ op: 'getDoc', requestId: 'get', collection, id: identifier }),
        JSON.stringify({
            op: 'findDocs',
            requestId: 'find',
            collection,
            query: { $ops: [{ active: { $eq: true } }] }
        }),
        JSON.stringify({ op: 'inspectCollection', requestId: 'inspect', collection })
    ])
    assert(read[0].result[identifier].name === 'Ada', 'Rust getDoc result shape drift')
    assert(read[1].result.length === 1, 'Rust findDocs did not return the indexed row')
    assert(read[1].result[0][identifier].active === true, 'Rust findDocs row shape drift')
    assert(Number(read[2].result.docsStored) === 1, 'Rust inspectCollection drift')

    const written = await session(binary, [
        JSON.stringify({ op: 'putData', requestId: 'put', collection, data: { name: 'Hopper' } }),
        JSON.stringify({
            op: 'setMeta',
            requestId: 'meta',
            collection,
            id: identifier,
            meta: { reviewer: 'storage' }
        }),
        JSON.stringify({
            op: 'patchDoc',
            requestId: 'patch',
            collection,
            id: identifier,
            newDoc: { active: false }
        }),
        JSON.stringify({ op: 'rebuildCollection', requestId: 'rebuild', collection }),
        JSON.stringify({
            op: 'executeSQL',
            requestId: 'sql',
            sql: `UPDATE ${collection} SET active = true WHERE name = 'Ada'`
        }),
        JSON.stringify({ op: 'delDoc', requestId: 'del', collection, id: identifier }),
        JSON.stringify({ op: 'backupStatus', requestId: 'backup' })
    ])
    for (const frame of written) {
        assert(frame.ok === true, `Rust write operation failed: ${JSON.stringify(frame.error)}`)
    }
    const createdId = written[0].result
    assert(
        typeof createdId === 'string' && createdId.length > 0,
        'Rust putData did not return a TTID'
    )
    assert(written[1].result.reviewer === 'storage', 'Rust setMeta did not return merged metadata')
    assert(written[1].result.id === identifier, 'Rust setMeta dropped canonical metadata')
    assert(written[4].result.affected === 1, 'Rust executeSQL mutation drift')
    assert(written[5].result.deleted === true, 'Rust delDoc result shape drift')
    assert(written[6].result.configured === false, 'Rust backupStatus should report disabled')

    const readback = new Fylo(root, { versioning: { autoCommit: false } })
    await readback.ready()
    const machineWritten = (await readback[collection].get(createdId).once())[createdId]
    assert(
        machineWritten.name === 'Hopper',
        'JavaScript could not read the machine-written document'
    )
    const inspection = await readback[collection].inspect()
    assert(Number(inspection.deletedDocs) === 1, 'Rust delDoc did not retain a tombstone')
    await readback.close()

    const bulk = await session(binary, [
        JSON.stringify({ op: 'getLatest', requestId: 'latest', collection, id: identifier }),
        JSON.stringify({
            op: 'findDeletedDocs',
            requestId: 'deleted',
            collection,
            query: { $ops: [{ name: { $eq: 'Ada' } }] }
        }),
        JSON.stringify({ op: 'restoreDoc', requestId: 'restore', collection, id: identifier }),
        JSON.stringify({
            op: 'batchPutData',
            requestId: 'batch',
            collection,
            batch: [{ name: 'Barbara' }, { name: 'Katherine' }]
        }),
        JSON.stringify({
            op: 'patchDocs',
            requestId: 'patchMany',
            collection,
            update: { $where: { $ops: [{ name: { $eq: 'Barbara' } }] }, $set: { active: false } }
        }),
        JSON.stringify({
            op: 'delDocs',
            requestId: 'delMany',
            collection,
            delete: { $ops: [{ name: { $eq: 'Katherine' } }] }
        })
    ])
    for (const frame of bulk) {
        assert(frame.ok === true, `Rust bulk operation failed: ${JSON.stringify(frame.error)}`)
    }
    assert(
        Object.keys(bulk[0].result).length === 0,
        'Rust getLatest should return an empty object for a deleted record'
    )
    assert(bulk[1].result.length === 1, 'Rust findDeletedDocs did not match the tombstone')
    assert(bulk[1].result[0].id === identifier, 'Rust findDeletedDocs row shape drift')
    assert(bulk[2].result.restored === true, 'Rust restoreDoc result shape drift')
    assert(bulk[3].result.length === 2, 'Rust batchPutData did not return both identifiers')
    assert(bulk[4].result.affected === 1, 'Rust patchDocs affected-count drift')
    assert(bulk[5].result.affected === 1, 'Rust delDocs affected-count drift')

    const bulkReader = new Fylo(root, { versioning: { autoCommit: false } })
    await bulkReader.ready()
    const restored = (await bulkReader[collection].get(identifier).once())[identifier]
    assert(restored?.name === 'Ada', 'JavaScript could not read the restored document')
    const patched = []
    for await (const record of bulkReader[collection]
        .find({ $ops: [{ name: { $eq: 'Barbara' } }] })
        .collect()) {
        patched.push(record)
    }
    assert(patched.length === 1, 'JavaScript could not query the bulk-written rows')
    assert(
        Object.values(patched[0])[0].active === false,
        'Rust patchDocs did not merge the assignment'
    )
    await bulkReader.close()

    // A natively created collection has to be legible to the JavaScript engine:
    // the descriptor names the namespace and the shard width, and a missing or
    // foreign index manifest would leave it unreadable rather than empty.
    const made = 'machine-made'
    const lifecycle = await session(binary, [
        JSON.stringify({ op: 'createCollection', requestId: 'create', collection: made }),
        JSON.stringify({
            op: 'putData',
            requestId: 'seed',
            collection: made,
            data: { name: 'Jean' }
        }),
        // Re-creating must complete a collection without touching one, or an
        // empty snapshot would replace the keys just written.
        JSON.stringify({ op: 'createCollection', requestId: 'again', collection: made }),
        JSON.stringify({
            op: 'createCollection',
            requestId: 'clash',
            collection: made,
            kind: 'file'
        }),
        JSON.stringify({
            op: 'createCollection',
            requestId: 'bucket',
            collection: 'machine-files',
            kind: 'file'
        })
    ])
    assert(
        lifecycle[0].ok === true,
        `Rust createCollection failed: ${JSON.stringify(lifecycle[0].error)}`
    )
    assert(lifecycle[0].result.kind === 'document', 'Rust createCollection kind drift')
    assert(lifecycle[1].ok === true, 'Rust could not write into the collection it created')
    assert(lifecycle[2].ok === true, 'Rust createCollection is not idempotent')
    assert(
        lifecycle[3].ok === false && lifecycle[3].error.code === 'ENATIVE_WRONG_TYPE',
        'Rust createCollection accepted a kind that contradicts the existing collection'
    )
    assert(lifecycle[4].result.kind === 'file', 'Rust createCollection file-kind drift')

    const madeReader = new Fylo(root, { versioning: { autoCommit: false } })
    await madeReader.ready()
    const seeded = lifecycle[1].result
    const seenRows = []
    for await (const record of madeReader[made]
        .find({ $ops: [{ name: { $eq: 'Jean' } }] })
        .collect()) {
        seenRows.push(record)
    }
    assert(seenRows.length === 1, 'JavaScript could not query the natively created collection')
    assert(
        (await madeReader[made].get(seeded).once())[seeded]?.name === 'Jean',
        'JavaScript could not read the document written after re-creation'
    )
    const bucket = await madeReader['machine-files'].inspect()
    assert(bucket.exists === true && bucket.kind === 'file', 'JavaScript misread the native bucket')
    await madeReader.close()

    // The width a collection is built with is what every later writer must
    // use. A native create that ignored the variable would produce a
    // collection the JavaScript engine refuses to write to, so it is read from
    // the same place by both engines.
    const wide = await session(
        binary,
        [JSON.stringify({ op: 'createCollection', requestId: 'wide', collection: 'machine-wide' })],
        { FYLO_SHARD_WIDTH: '3' }
    )
    assert(
        wide[0].ok === true,
        `Rust createCollection honouring the width failed: ${JSON.stringify(wide[0].error)}`
    )
    const recorded = JSON.parse(
        await readFile(join(root, '.fylo-catalog', 'collections', 'machine-wide.json'), 'utf8')
    )
    assert(recorded.shardWidth === 3, `Rust ignored FYLO_SHARD_WIDTH: ${JSON.stringify(recorded)}`)
    const rejected = await session(
        binary,
        [JSON.stringify({ op: 'createCollection', requestId: 'bad', collection: 'machine-bad' })],
        { FYLO_SHARD_WIDTH: '9' }
    )
    assert(rejected[0].ok === false, 'Rust accepted a shard width past the published maximum')

    const dropped = await session(binary, [
        JSON.stringify({ op: 'dropCollection', requestId: 'drop', collection: made }),
        JSON.stringify({ op: 'dropCollection', requestId: 'gone', collection: made })
    ])
    assert(
        dropped[0].ok === true,
        `Rust dropCollection failed: ${JSON.stringify(dropped[0].error)}`
    )
    assert(
        dropped[1].ok === false && dropped[1].error.code === 'ENATIVE_NOT_FOUND',
        'Rust dropped a collection that no longer exists'
    )
    const dropReader = new Fylo(root, { versioning: { autoCommit: false } })
    await dropReader.ready()
    assert(
        (await dropReader[made].inspect()).exists === false,
        'JavaScript still sees a dropped collection'
    )
    await dropReader.close()

    const repository = await session(binary, [
        JSON.stringify({ op: 'branch', requestId: 'branch' }),
        JSON.stringify({ op: 'status', requestId: 'status' })
    ])
    assert(
        repository[0].ok === false || repository[0].result.current === null,
        'Rust branch should report no repository for an unversioned root'
    )
    assert(
        repository[1].ok === false && repository[1].error.code === 'EUNSUPPORTEDOP',
        'Rust status should fail closed without a version repository'
    )

    const pageOne = (
        await session(binary, [
            JSON.stringify({
                op: 'findDocs',
                requestId: 'p1',
                collection,
                query: {},
                page: { limit: 1 }
            })
        ])
    )[0]
    assert(pageOne.ok === true, `Rust pagination failed: ${JSON.stringify(pageOne.error)}`)
    assert(pageOne.result.page.limit === 1, 'Rust page.limit drift')
    assert(pageOne.result.page.count === 1, 'Rust page.count drift')
    assert(typeof pageOne.result.nextCursor === 'string', 'Rust did not return a cursor')

    const paged = await session(binary, [
        JSON.stringify({ op: 'findDocs', collection, query: {}, page: { limit: 1 } }),
        JSON.stringify({
            op: 'findDocs',
            collection,
            query: {},
            page: { limit: 1, cursor: 'fqc1.0.0' }
        })
    ])
    const firstToken = paged[0].result.nextCursor
    assert(typeof firstToken === 'string', 'Rust did not return a cursor on the first page')
    assert(
        paged[1].ok === false && paged[1].error.code === 'EINVALIDCURSOR',
        'Rust accepted an unknown cursor'
    )

    const walk = interactive(binary)
    try {
        const seen = []
        let next = null
        for (let page = 0; page < 10; page++) {
            const frame = await walk.send({
                op: 'findDocs',
                collection,
                query: {},
                page: next ? { limit: 1, cursor: next } : { limit: 1 }
            })
            assert(frame.ok === true, `Rust pagination walk failed: ${JSON.stringify(frame.error)}`)
            assert(frame.result.page.count <= 1, 'Rust returned more rows than the page limit')
            seen.push(...Object.keys(frame.result.items))
            next = frame.result.nextCursor
            if (next === null) break
        }
        assert(next === null, 'Rust pagination did not terminate')
        assert(seen.length === new Set(seen).size, 'Rust pagination repeated a row')
        assert(seen.length === 3, `Rust pagination lost rows: ${JSON.stringify(seen)}`)
        assert(
            [...seen].sort().join(',') === seen.join(','),
            'Rust pagination is not TTID-ascending'
        )
    } finally {
        await walk.close()
    }

    const overLimit = (
        await session(binary, [
            JSON.stringify({ op: 'findDocs', collection, query: {}, page: { limit: 0 } })
        ])
    )[0]
    assert(
        overLimit.ok === false && overLimit.error.code === 'EBADREQUEST',
        'Rust accepted an out-of-range page limit'
    )

    assert(
        handshake.result.capabilities.queryPagination.ordering === 'ttid-binary-ascending',
        'Rust pagination capability drift'
    )

    const schemaRoot = join(workspace, 'schema')
    await mkdir(join(schemaRoot, collection, 'history'), { recursive: true })
    await writeFile(
        join(schemaRoot, collection, 'manifest.json'),
        JSON.stringify({ current: 'v2', versions: [{ v: 'v1' }, { v: 'v2' }] })
    )
    await writeFile(
        join(schemaRoot, collection, 'history', 'v2.schema.json'),
        JSON.stringify({ name: '^[A-Za-z ]+$' })
    )
    const schemaFrames = await session(
        binary,
        [
            JSON.stringify({ op: 'schemaInspect', requestId: 'si', collection }),
            JSON.stringify({ op: 'schemaCurrent', requestId: 'sc', collection }),
            JSON.stringify({ op: 'schemaHistory', requestId: 'sh', collection }),
            JSON.stringify({ op: 'schemaDoctor', requestId: 'sd', collection }),
            JSON.stringify({
                op: 'schemaValidate',
                requestId: 'sv',
                collection,
                document: { name: 'Ada' }
            }),
            JSON.stringify({
                op: 'schemaValidate',
                requestId: 'sx',
                collection,
                document: { name: '42' }
            })
        ],
        { FYLO_SCHEMA: schemaRoot }
    )
    assert(
        schemaFrames[0].ok === true,
        `Rust schemaInspect failed: ${JSON.stringify(schemaFrames[0])}`
    )
    assert(schemaFrames[0].result.versioned === true, 'Rust schemaInspect versioned drift')
    assert(schemaFrames[0].result.current === 'v2', 'Rust schemaInspect current drift')
    assert(schemaFrames[1].result.current === 'v2', 'Rust schemaCurrent drift')
    assert(schemaFrames[2].result.versions.length === 2, 'Rust schemaHistory version count drift')
    assert(schemaFrames[3].ok === true, 'Rust schemaDoctor failed')
    assert(schemaFrames[3].result.ok === false, 'Rust schemaDoctor missed the absent v1 file')
    assert(
        schemaFrames[3].result.issues.some((issue) => issue.includes('v1.schema.json')),
        `Rust schemaDoctor issue drift: ${JSON.stringify(schemaFrames[3].result.issues)}`
    )
    assert(schemaFrames[4].ok === true, `Rust schemaValidate rejected a valid document`)
    assert(schemaFrames[4].result.document._v === 'v2', 'Rust schemaValidate did not stamp _v')
    assert(
        schemaFrames[5].ok === false && schemaFrames[5].error.code === 'ESCHEMA',
        'Rust schemaValidate accepted a document CHEX rejects'
    )

    // Rust now holds a kernel lease, so exclusion works in both directions.
    const held = interactive(binary)
    try {
        const frame = await held.send({ op: 'inspectCollection', collection })
        assert(frame.ok === true, 'Rust could not take its own root lease')
        let javascriptRefused = false
        try {
            const contended = await acquireRootLease(root)
            await contended.release()
        } catch (error) {
            javascriptRefused = error?.code === 'EROOTLOCKED'
        }
        assert(javascriptRefused, 'JavaScript opened a root the Rust session holds')
    } finally {
        await held.close()
    }
    const reclaimed = await acquireRootLease(root)
    await reclaimed.release()

    const lease = await acquireRootLease(root)
    const locked = (
        await session(binary, [JSON.stringify({ op: 'getDoc', collection, id: identifier })])
    )[0]
    await lease.release()
    assert(
        locked.ok === false && locked.error.code === 'EROOTLOCKED',
        `Rust served a root owned by a live JavaScript process: ${JSON.stringify(locked)}`
    )
    const unlocked = (
        await session(binary, [JSON.stringify({ op: 'getDoc', collection, id: identifier })])
    )[0]
    assert(unlocked.ok === true, 'Rust did not reopen the root after the lease was released')

    const malformed = await session(binary, ['not json', '{"op":"handshake","requestId":"after"}'])
    assert(malformed[0].error.code === 'EFRAME_JSON', 'Rust malformed frame code drift')
    assert(malformed[1].requestId === 'after', 'Rust did not resume after a malformed frame')

    const duplicate = await session(binary, [
        '{"op":"handshake","op":"handshake"}',
        '{"op":"handshake","requestId":"after"}'
    ])
    assert(duplicate[0].error.code === 'EFRAME_DUPLICATE_KEY', 'Rust duplicate-key code drift')
    assert(duplicate[1].ok === true, 'Rust did not resume after a duplicate-key frame')

    const truncated = await raw(binary, '{"op":"handshake"}\n{"op":"hand')
    assert(truncated.length === 2, 'Rust did not answer the truncated frame')
    assert(truncated[1].error.code === 'EFRAME_TRUNCATED', 'Rust truncated frame code drift')

    const unsupported = await session(binary, ['{"op":"merge","source":"other"}'])
    assert(unsupported[0].error.code === 'EUNSUPPORTEDOP', 'Rust unimplemented-operation drift')

    const registryNames = registry.operations.map((operation) => operation.name)
    const advertised = handshake.result.capabilities.operations
    for (const name of advertised) {
        assert(registryNames.includes(name), `Rust advertised unregistered operation ${name}`)
    }
    for (const name of registryNames) {
        if (advertised.includes(name)) continue
        const response = (await session(binary, [JSON.stringify({ op: name })]))[0]
        assert(
            response.ok === false && response.error.code === 'EUNSUPPORTEDOP',
            `Rust did not report EUNSUPPORTEDOP for ${name}`
        )
    }

    const errors = JSON.parse(await readFile('api/errors/v1.json', 'utf8'))
    const known = new Set(errors.errors.map((entry) => entry.code))
    for (const frame of [...malformed, ...duplicate, ...truncated, ...unsupported]) {
        if (frame.ok !== false) continue
        assert(known.has(frame.error.code), `Rust emitted unregistered code ${frame.error.code}`)
    }

    console.log('Verified the Rust machine protocol against the canonical v1 contract')
} finally {
    await rm(workspace, { recursive: true, force: true })
}

/// One long-lived server process, so cursor state survives between frames.
function interactive(binary) {
    const subprocess = Bun.spawn([binary, '--root', root], {
        cwd: process.cwd(),
        env: process.env,
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe'
    })
    const reader = subprocess.stdout.getReader()
    const decoder = new TextDecoder()
    let buffered = ''
    return {
        async send(request) {
            subprocess.stdin.write(`${JSON.stringify(request)}\n`)
            await subprocess.stdin.flush()
            while (!buffered.includes('\n')) {
                const { value, done } = await reader.read()
                if (done) throw new Error('machine session ended before answering')
                buffered += decoder.decode(value, { stream: true })
            }
            const index = buffered.indexOf('\n')
            const line = buffered.slice(0, index)
            buffered = buffered.slice(index + 1)
            return JSON.parse(line)
        },
        async close() {
            reader.cancel().catch(() => {})
            await subprocess.stdin.end()
            await subprocess.exited
        }
    }
}

async function session(binary, frames, overrides = {}) {
    return await raw(binary, `${frames.join('\n')}\n`, overrides)
}

async function raw(binary, input, overrides = {}) {
    const subprocess = Bun.spawn([binary, '--root', root], {
        cwd: process.cwd(),
        env: { ...process.env, ...overrides },
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe'
    })
    subprocess.stdin.write(input)
    await subprocess.stdin.end()
    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(subprocess.stdout).text(),
        new Response(subprocess.stderr).text(),
        subprocess.exited
    ])
    if (exitCode !== 0) throw new Error(`fylo-machine-preview failed: ${stderr}`)
    return stdout
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line))
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
