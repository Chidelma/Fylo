import { afterAll, describe, expect, test } from 'bun:test'
import { shardOf } from '../../src/core/doc-id.js'
import { appendFile, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import Fylo from '../../src/index.js'
import { tryAcquireFileLock } from '../../src/storage/fs-lock.js'
import { createTestRoot } from '../helpers/root.js'

const root = await createTestRoot('fylo-crash-')
const KILL_WORKER = path.join(import.meta.dir, 'crash-recovery.worker.js')

describe('crash recovery and concurrency', () => {
    afterAll(async () => {
        await rm(root, { recursive: true, force: true })
    })

    test('in-process parallel putData calls preserve every entry', async () => {
        const collection = `parallel-${Date.now()}`
        const fylo = new Fylo(root)
        await fylo[collection].create()
        const parallelism = 50
        const ids = await Promise.all(
            Array.from({ length: parallelism }, (_, i) =>
                fylo[collection].put({ title: `p-${i}`, n: i })
            )
        )
        expect(new Set(ids).size).toBe(parallelism)
        /** @type {string[]} */
        const titles = []
        for await (const data of fylo[collection].find().collect()) {
            for (const doc of Object.values(data)) {
                titles.push(/** @type {any} */ (doc).title)
            }
        }
        titles.sort()
        const expected = Array.from({ length: parallelism }, (_, i) => `p-${i}`).sort()
        expect(titles).toEqual(expected)
    })

    test('stale files in the local index root are ignored by reads and subsequent writes', async () => {
        const collection = `stale-tmp-${Date.now()}`
        const fylo = new Fylo(root)
        await fylo[collection].create()
        await fylo[collection].put({ title: 'before' })

        const indexDir = path.join(root, '.collections', collection, 'index')
        await writeFile(path.join(indexDir, `leftover.tmp`), 'garbage')
        await appendFile(path.join(indexDir, 'keys.wal'), '+\ttitle/eq/anything')

        // Read works:
        /** @type {string[]} */
        const beforeTitles = []
        for await (const data of fylo[collection].find().collect()) {
            for (const doc of Object.values(data)) {
                beforeTitles.push(/** @type {any} */ (doc).title)
            }
        }
        expect(beforeTitles).toEqual(['before'])

        // Subsequent writes work:
        await fylo[collection].put({ title: 'after' })
        /** @type {string[]} */
        const allTitles = []
        for await (const data of fylo[collection].find().collect()) {
            for (const doc of Object.values(data)) {
                allTitles.push(/** @type {any} */ (doc).title)
            }
        }
        expect(allTitles.sort()).toEqual(['after', 'before'])
    })

    test('rebuildCollection recovers deleted prefix index entries from documents', async () => {
        const collection = `recover-index-${Date.now()}`
        const fylo = new Fylo(root)
        await fylo[collection].create()
        await fylo[collection].put({ title: 'original' })

        await rm(path.join(root, '.collections', collection, 'index'), {
            recursive: true,
            force: true
        })
        const before = []
        for await (const data of fylo[collection]
            .find({
                $ops: [{ title: { $eq: 'original' } }]
            })
            .collect()) {
            before.push(data)
        }
        expect(before).toHaveLength(0)

        const recovered = new Fylo(root)
        const result = await recovered[collection].rebuild()
        expect(result.indexedDocs).toBe(1)

        /** @type {string[]} */
        const titles = []
        for await (const data of recovered[collection].find().collect()) {
            for (const doc of Object.values(data)) {
                titles.push(/** @type {any} */ (doc).title)
            }
        }
        expect(titles).toEqual(['original'])
    })

    test('SIGKILL during writes leaves on-disk docs atomic (no partial reads)', async () => {
        const collection = `sigkill-${Date.now()}`
        const writeRoot = await createTestRoot('fylo-sigkill-')
        try {
            const ready = path.join(writeRoot, 'worker.ready')
            const proc = Bun.spawn(['bun', KILL_WORKER, writeRoot, collection, '500', ready], {
                stdout: 'pipe',
                stderr: 'pipe'
            })
            const deadline = Date.now() + 10_000
            while (!(await Bun.file(ready).exists()) && Date.now() < deadline) await Bun.sleep(5)
            expect(await Bun.file(ready).exists()).toBe(true)
            proc.kill('SIGKILL')
            await proc.exited

            const docsRoot = path.join(writeRoot, '.collections', collection, 'docs')
            /** @type {string[]} */
            const docFiles = []
            try {
                const buckets = await readdir(docsRoot, { withFileTypes: true })
                for (const bucket of buckets) {
                    if (!bucket.isDirectory()) continue
                    const entries = await readdir(path.join(docsRoot, bucket.name))
                    for (const entry of entries) {
                        if (entry.endsWith('.json')) docFiles.push(entry)
                    }
                }
            } catch (err) {
                const error = /** @type {NodeJS.ErrnoException} */ (err)
                if (error.code !== 'ENOENT') throw err
            }

            // Atomic-rename guarantee: every committed .json file must be valid JSON.
            // A partial write would be a .json.tmp or simply absent; the committed
            // target is never half-written.
            expect(docFiles.length).toBeGreaterThan(0)
            for (const file of docFiles) {
                const bucket = shardOf(path.parse(file).name)
                const raw = await Bun.file(path.join(docsRoot, bucket, file)).text()
                const parsed = JSON.parse(raw)
                expect(typeof parsed).toBe('object')
                expect(parsed).not.toBeNull()
            }
        } finally {
            await rm(writeRoot, { recursive: true, force: true })
        }
    }, 10_000)

    test('stale collection write-lock is reclaimed after TTL expires', async () => {
        const lockRoot = await mkdtemp(path.join(os.tmpdir(), 'fylo-stalelock-'))
        try {
            const lockPath = path.join(lockRoot, 'collection.lock')
            // Legacy abandoned lock, within TTL -> blocks.
            await writeFile(lockPath, JSON.stringify({ owner: 'dead-owner', ts: Date.now() }))
            expect(await tryAcquireFileLock(lockPath, 'new-owner', 60_000)).toBe(false)
            // After TTL elapses, a new acquirer may take over.
            await Bun.sleep(80)
            expect(await tryAcquireFileLock(lockPath, 'new-owner', 50)).toBe(true)
        } finally {
            await rm(lockRoot, { recursive: true, force: true })
        }
    })
})
