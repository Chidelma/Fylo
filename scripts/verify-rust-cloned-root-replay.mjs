// Phase 5 differential gate: replay one operation log into two cloned roots,
// one driven by the JavaScript engine and one by the native writer, and require
// the results to agree.
//
// The plan forbids pointing two writers at a single root, so the comparison is
// made between clones of the same starting state rather than between two
// processes racing on one. Identifiers and timestamps are chosen up front so
// the only thing that can differ is what the engines actually did.
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { platform, tmpdir } from 'node:os'
import { join } from 'node:path'

import Fylo from '../src/index.js'

const workspace = await mkdtemp(join(tmpdir(), 'fylo-replay-'))
const template = join(workspace, 'template')
const collection = 'records'
const files = 'assets'

// One fixed log, applied by both engines. Fixed identifiers are what make the
// two roots comparable at all: a generated TTID would differ by construction.
const LOG = [
    { op: 'put', id: '4VRNF52JPD1', document: { name: 'Ada', score: 42, active: true } },
    { op: 'put', id: '4VRNF52JPD2', document: { name: 'Grace', score: 50, active: true } },
    { op: 'put', id: '4VRNF52JPD3', document: { name: 'Linus', score: 7, active: false } },
    { op: 'patch', id: '4VRNF52JPD1', changes: { score: 43 } },
    { op: 'metadata', id: '4VRNF52JPD2', record: { reviewer: 'storage', draft: true } },
    { op: 'metadata', id: '4VRNF52JPD2', record: { draft: null } },
    { op: 'delete', id: '4VRNF52JPD3' },
    { op: 'sql', statement: `UPDATE ${collection} SET active = false WHERE name = 'Grace'` }
]

try {
    await mkdir(template, { recursive: true })
    const seed = new Fylo(template, { versioning: { autoCommit: false } })
    await seed[collection].create()
    await seed[files].create({ kind: 'file' })
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

    const javascriptRoot = join(workspace, 'javascript')
    const nativeRoot = join(workspace, 'native')
    await cp(template, javascriptRoot, { recursive: true })
    await cp(template, nativeRoot, { recursive: true })

    await replayWithJavaScript(javascriptRoot)
    await replayWithNative(binary, nativeRoot)

    const left = await observe(javascriptRoot)
    const right = await observe(nativeRoot)
    const differences = compare(left, right)
    if (differences.length > 0) {
        throw new Error(`replayed roots disagree:\n${differences.join('\n')}`)
    }

    // Agreement alone would also be satisfied by two engines that are wrong in
    // the same way, so the log's outcome is stated outright.
    const EXPECTED = {
        documents: {
            '4VRNF52JPD1': { name: 'Ada', score: 43, active: true },
            '4VRNF52JPD2': { name: 'Grace', score: 50, active: false }
        },
        metadata: { '4VRNF52JPD1': {}, '4VRNF52JPD2': { reviewer: 'storage' } },
        inactive: ['4VRNF52JPD2'],
        docsStored: 2,
        deletedDocs: 1,
        indexedDocs: 2
    }
    const wrong = compare(EXPECTED, left)
    if (wrong.length > 0) {
        throw new Error(`replay did not produce the expected state:\n${wrong.join('\n')}`)
    }

    console.log(
        `Replayed ${LOG.length} operations into cloned roots; JavaScript and native agree on ${Object.keys(left.documents).length} documents`
    )
} finally {
    await rm(workspace, { recursive: true, force: true })
}

async function replayWithJavaScript(root) {
    const fylo = new Fylo(root, { versioning: { autoCommit: false } })
    await fylo.ready()
    for (const entry of LOG) {
        if (entry.op === 'put') await fylo[collection].put(entry.id, entry.document)
        else if (entry.op === 'patch') await fylo[collection].patch(entry.id, entry.changes)
        else if (entry.op === 'metadata')
            await fylo[collection].put(entry.id).metadata(entry.record)
        else if (entry.op === 'delete') await fylo[collection].delete(entry.id)
        else if (entry.op === 'sql') await fylo._sql(entry.statement)
        else throw new Error(`unknown operation: ${entry.op}`)
    }
    await fylo.close()
}

async function replayWithNative(binary, root) {
    for (const entry of LOG) {
        if (entry.op === 'put') {
            await required(binary, [
                'put-document',
                '--root',
                root,
                '--collection',
                collection,
                '--id',
                entry.id,
                '--document',
                JSON.stringify(entry.document)
            ])
        } else if (entry.op === 'patch') {
            await required(binary, [
                'patch-fields',
                '--root',
                root,
                '--collection',
                collection,
                '--id',
                entry.id,
                '--changes',
                JSON.stringify(entry.changes)
            ])
        } else if (entry.op === 'metadata') {
            await required(binary, [
                'set-metadata',
                '--root',
                root,
                '--collection',
                collection,
                '--id',
                entry.id,
                '--record',
                JSON.stringify(entry.record)
            ])
        } else if (entry.op === 'delete') {
            await required(binary, [
                'delete-document',
                '--root',
                root,
                '--collection',
                collection,
                '--id',
                entry.id
            ])
        } else if (entry.op === 'sql') {
            await required(binary, ['sql', '--root', root, '--statement', entry.statement])
        } else {
            throw new Error(`unknown operation: ${entry.op}`)
        }
    }
}

/**
 * Read a root's observable state through the JavaScript engine, so both sides
 * are described by the same reader and a difference can only come from what was
 * written.
 */
async function observe(root) {
    const fylo = new Fylo(root, { versioning: { autoCommit: false } })
    await fylo.ready()
    try {
        const documents = {}
        const metadata = {}
        for (const id of LOG.filter((entry) => entry.op === 'put').map((entry) => entry.id)) {
            const record = (await fylo[collection].get(id).once())[id]
            if (record === undefined) continue
            documents[id] = record
            const meta = await fylo[collection].get(id).metadata()
            // Timestamps are wall-clock and legitimately differ between runs.
            const { id: _id, createdAt, updatedAt, mtime, ...rest } = meta
            metadata[id] = rest
        }
        const matches = []
        for await (const row of fylo[collection]
            .find({ $ops: [{ active: { $eq: false } }] })
            .collect()) {
            matches.push(Object.keys(row)[0])
        }
        const inspection = await fylo[collection].inspect()
        return {
            documents,
            metadata,
            inactive: matches.sort(),
            docsStored: Number(inspection.docsStored),
            deletedDocs: Number(inspection.deletedDocs),
            indexedDocs: Number(inspection.indexedDocs)
        }
    } finally {
        await fylo.close()
    }
}

function compare(left, right) {
    const differences = []
    for (const key of Object.keys(left)) {
        const a = JSON.stringify(left[key])
        const b = JSON.stringify(right[key])
        if (a !== b) differences.push(`  ${key}:\n    left  ${a}\n    right ${b}`)
    }
    return differences
}

async function required(binary, arguments_) {
    const subprocess = Bun.spawn([binary, ...arguments_], {
        cwd: process.cwd(),
        env: process.env,
        stdout: 'pipe',
        stderr: 'pipe'
    })
    const [stderr, exitCode] = await Promise.all([
        new Response(subprocess.stderr).text(),
        subprocess.exited
    ])
    if (exitCode !== 0) {
        throw new Error(`fylo-write-preview failed (${arguments_[0]}): ${stderr}`)
    }
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
