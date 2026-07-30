// Decryption registration is lazy and process-global, so these cases only
// reproduce across process boundaries: a reader that never wrote must still
// decrypt, and a reader that cannot decrypt must fail instead of returning
// ciphertext (#84).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { shardOf } from '../../src/core/doc-id.js'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const COLLECTION = 'vault'
const KEY = '0123456789abcdef0123456789abcdef01'
const SALT = 'fylo-encrypted-read-isolation-salt'
const MARKER = 'ARGONMARKER'

let workspace
let schemaDir
let root

/**
 * Runs one NDJSON request in a dedicated `fylo exec --loop` process, so no
 * decryption state can survive from an earlier operation.
 * @param {Record<string, any>} request
 * @param {Record<string, string | undefined>} env
 */
async function runIsolated(request, env = {}) {
    const childEnv = {
        ...process.env,
        FYLO_SCHEMA: schemaDir,
        FYLO_ENCRYPTION_KEY: KEY,
        FYLO_CIPHER_SALT: SALT,
        ...env
    }
    for (const [name, value] of Object.entries(childEnv)) {
        if (value === undefined) delete childEnv[name]
    }
    const proc = Bun.spawn(['bun', 'src/cli/index.js', 'exec', '--loop', '--root', root], {
        cwd: process.cwd(),
        env: /** @type {Record<string, string>} */ (childEnv),
        stdin: new Blob([`${JSON.stringify(request)}\n`]),
        stdout: 'pipe',
        stderr: 'pipe'
    })
    const [stdout] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    return JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}')
}

const findRequest = {
    op: 'findDocs',
    collection: COLLECTION,
    query: { $ops: [{ kind: { $eq: 'security-event' } }] }
}

beforeAll(async () => {
    workspace = await mkdtemp(path.join(os.tmpdir(), 'fylo-encrypted-read-'))
    schemaDir = path.join(workspace, 'schema')
    root = path.join(workspace, 'db')
    await mkdir(path.join(schemaDir, COLLECTION, 'history'), { recursive: true })
    await writeFile(
        path.join(schemaDir, COLLECTION, 'history', 'v1.schema.json'),
        JSON.stringify({ $encrypted: ['payload/verifier'], kind: '^.+$' })
    )
    await writeFile(
        path.join(schemaDir, COLLECTION, 'manifest.json'),
        JSON.stringify({ current: 'v1', versions: [{ v: 'v1' }] })
    )
})

afterAll(async () => {
    await rm(workspace, { recursive: true, force: true })
})

describe('encrypted reads without a prior write in the process (#84)', () => {
    test('a writing process stores ciphertext on disk', async () => {
        const created = await runIsolated({ op: 'createCollection', collection: COLLECTION })
        expect(created.ok).toBe(true)

        const written = await runIsolated({
            op: 'putData',
            collection: COLLECTION,
            data: { kind: 'security-event', payload: { verifier: MARKER } }
        })
        expect(written.ok).toBe(true)

        const docId = String(written.result)
        const stored = await Bun.file(
            path.join(root, '.collections', COLLECTION, 'docs', shardOf(docId), `${docId}.json`)
        ).text()
        expect(stored).not.toContain(MARKER)
        expect(stored).toContain('v2.')
    })

    test('a read-only process decrypts with the correct key', async () => {
        const response = await runIsolated(findRequest)
        expect(response.ok).toBe(true)
        const doc = Object.values(response.result)[0]
        expect(doc.payload.verifier).toBe(MARKER)
    })

    test('a read-only process fails closed when the key is absent', async () => {
        const response = await runIsolated(findRequest, { FYLO_ENCRYPTION_KEY: undefined })
        expect(response.ok).toBe(false)
        expect(response.error.code).toBe('EDECRYPTFAILED')
        expect(JSON.stringify(response)).not.toContain('v2.')
    })

    test('a read-only process fails closed when the key is wrong', async () => {
        const response = await runIsolated(findRequest, {
            FYLO_ENCRYPTION_KEY: 'wrongkeywrongkeywrongkeywrongkey99'
        })
        expect(response.ok).toBe(false)
        expect(response.error.code).toBe('EDECRYPTFAILED')
        expect(response.error.message).toContain('payload/verifier')
        expect(JSON.stringify(response)).not.toContain('v2.')
    })

    test('a read-only getDoc decrypts on the direct read path too', async () => {
        const ids = await runIsolated({ ...findRequest, query: { $ops: [], $onlyIds: true } })
        expect(ids.ok).toBe(true)

        const response = await runIsolated({
            op: 'getDoc',
            collection: COLLECTION,
            id: ids.result[0]
        })
        expect(response.ok).toBe(true)
        expect(Object.values(response.result)[0].payload.verifier).toBe(MARKER)
    })
})
