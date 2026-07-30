import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { shardOf } from '../../src/core/doc-id.js'
import { rm, stat, writeFile } from 'node:fs/promises'
import { readdirSync } from 'node:fs'
import path from 'node:path'
import TTID from '../helpers/ttid.js'
import Fylo, { CollectionNotFoundError, FyloBatchWriteError } from '../../src/index.js'
import { createTestRoot } from '../helpers/root.js'
import { VersionRepository } from '../../src/versioning/repository.js'

const root = await createTestRoot('fylo-filesystem-')
const fylo = new Fylo(root)
const POSTS = 'filesystem-posts'
const USERS = 'filesystem-users'

async function isDirectory(target) {
    try {
        return (await stat(target)).isDirectory()
    } catch (err) {
        const error = /** @type {NodeJS.ErrnoException} */ (err)
        if (error.code === 'ENOENT') return false
        throw err
    }
}

async function readLocalIndex(collection) {
    const indexRoot = path.join(root, '.collections', collection, 'index')
    const snapshot = await Bun.file(path.join(indexRoot, 'keys.snapshot')).text()
    const wal = await Bun.file(path.join(indexRoot, 'keys.wal')).text()
    return `${snapshot}${wal}`
}

describe('filesystem engine', () => {
    beforeAll(async () => {
        await fylo[POSTS].create()
        await fylo[USERS].create()
    })
    afterAll(async () => {
        await rm(root, { recursive: true, force: true })
    })
    test('put/get/patch/delete works without Redis or cloud adapters', async () => {
        const id = await fylo[POSTS].put({
            title: 'Hello',
            tags: ['bun', 'storage'],
            meta: { score: 1 }
        })
        const activePath = path.join(root, '.collections', POSTS, 'docs', shardOf(id), `${id}.json`)
        const createdTime = (await stat(activePath)).mtimeMs
        const created = await fylo[POSTS].get(id).once()
        expect(created[id].title).toBe('Hello')
        expect(created[id].tags).toEqual(['bun', 'storage'])
        await Bun.sleep(10)
        const nextId = await fylo[POSTS].patch(id, {
            title: 'Hello 2',
            meta: { score: 2 }
        })
        expect(nextId).toBe(id)
        const updated = await fylo[POSTS].get(nextId).once()
        expect(updated[nextId].title).toBe('Hello 2')
        expect(updated[nextId].meta.score).toBe(2)
        expect((await stat(activePath)).mtimeMs).toBeGreaterThan(createdTime)
        await fylo[POSTS].delete(nextId)
        expect(await fylo[POSTS].get(nextId).once()).toEqual({})
        const deletedPath = path.join(
            root,
            '.collections',
            POSTS,
            '.deleted',
            shardOf(id),
            `${id}.json`
        )
        expect(await Bun.file(activePath).exists()).toBe(false)
        expect(await Bun.file(deletedPath).exists()).toBe(true)
    })

    test('collection facades fail closed when the collection does not exist', async () => {
        const missing = `missing-${Date.now()}`
        const id = TTID.generate()

        expect((await fylo[missing].inspect()).exists).toBe(false)
        await expect(fylo[missing].put({ name: 'No collection' })).rejects.toBeInstanceOf(
            CollectionNotFoundError
        )
        await expect(fylo[missing].get(id).once()).rejects.toBeInstanceOf(CollectionNotFoundError)
        await expect(Array.fromAsync(fylo[missing].find({}).collect())).rejects.toBeInstanceOf(
            CollectionNotFoundError
        )
        await expect(fylo[missing].patch(id, { name: 'Nope' })).rejects.toBeInstanceOf(
            CollectionNotFoundError
        )
        await expect(fylo[missing].delete(id)).rejects.toBeInstanceOf(CollectionNotFoundError)
        await fylo[missing].create()
        await expect(fylo[missing].create()).resolves.toBeUndefined()
        expect((await fylo[missing].inspect()).exists).toBe(true)
    })

    test('document writes auto-commit by default and can be disabled', async () => {
        const autoRoot = await createTestRoot('fylo-auto-commit-')
        try {
            const auto = new Fylo(autoRoot)
            const repo = new VersionRepository(autoRoot)
            await auto['auto-posts'].create()

            const id = await auto['auto-posts'].put({ title: 'v1' })
            await auto['auto-posts'].patch(id, { title: 'v2' })
            await auto['auto-posts'].delete(id)
            await auto['auto-posts'].restore(id)

            expect((await repo.status()).clean).toBe(true)
            expect((await repo.log({ limit: 4 })).map((commit) => commit.message)).toEqual([
                `restore auto-posts/${id}`,
                `delete auto-posts/${id}`,
                `patch auto-posts/${id}`,
                `put auto-posts/${id}`
            ])
        } finally {
            await rm(autoRoot, { recursive: true, force: true })
        }

        const manualRoot = await createTestRoot('fylo-manual-commit-')
        try {
            const manual = new Fylo(manualRoot, { versioning: { autoCommit: false } })
            const repo = new VersionRepository(manualRoot)
            await manual['manual-posts'].create()
            await repo.commit('baseline')
            await manual['manual-posts'].put({ title: 'manual' })

            const status = await repo.status()
            expect(status.clean).toBe(false)
            expect(status.diff.counts.added).toBe(1)
        } finally {
            await rm(manualRoot, { recursive: true, force: true })
        }
    })

    test('bulk operations coalesce into a single version-control commit', async () => {
        const bulkRoot = await createTestRoot('fylo-coalesce-')
        try {
            const fylo = new Fylo(bulkRoot)
            const repo = new VersionRepository(bulkRoot)
            await fylo['bulk-posts'].create()

            const ids = await fylo['bulk-posts'].put.batch(
                Array.from({ length: 12 }, (_, i) => ({ title: `post ${i}` }))
            )
            expect(ids).toHaveLength(12)
            expect((await repo.log({ limit: 10 })).map((commit) => commit.message)).toEqual([
                'put bulk-posts (12 documents)'
            ])
            expect((await repo.status()).clean).toBe(true)

            await fylo['bulk-posts'].patch.many({ $set: { pinned: true } })
            await fylo['bulk-posts'].delete.many({})
            expect((await repo.log({ limit: 10 })).map((commit) => commit.message)).toEqual([
                'delete bulk-posts (12 documents)',
                'patch bulk-posts (12 documents)',
                'put bulk-posts (12 documents)'
            ])
            expect((await repo.status()).clean).toBe(true)
        } finally {
            await rm(bulkRoot, { recursive: true, force: true })
        }
    })

    test('put.batch surfaces per-item failures instead of dropping them silently', async () => {
        const batchRoot = await createTestRoot('fylo-batch-fail-')
        try {
            const fylo = new Fylo(batchRoot)
            await fylo['batch-fail'].create()
            // A null entry is malformed and rejects; the valid documents around
            // it must still be written, committed, and reported back.
            const batch = /** @type {Record<string, any>[]} */ (
                /** @type {unknown} */ ([{ title: 'ok-1' }, null, { title: 'ok-2' }])
            )
            const error = await fylo['batch-fail'].put.batch(batch).then(
                () => null,
                (err) => err
            )
            expect(error).toBeInstanceOf(FyloBatchWriteError)
            const failure = /** @type {FyloBatchWriteError} */ (error)
            expect(failure.code).toBe('FYLO_BATCH_WRITE_FAILED')
            expect(failure.writtenIds).toHaveLength(2)
            expect(failure.failures).toHaveLength(1)
            expect(failure.failures[0].index).toBe(1)

            const seen = []
            for await (const doc of fylo['batch-fail'].find({}).collect()) seen.push(doc)
            expect(seen).toHaveLength(2)
        } finally {
            await rm(batchRoot, { recursive: true, force: true })
        }
    })

    test('single-document commits do bounded work as the collection grows', async () => {
        const scaleRoot = await createTestRoot('fylo-vcs-scale-')
        try {
            const fylo = new Fylo(scaleRoot)
            const repo = new VersionRepository(scaleRoot)
            await fylo.scale.create()

            const latestTreeBytes = async () => {
                const [latest] = await repo.log({ limit: 1 })
                const treePath = path.join(
                    scaleRoot,
                    '.fylo-vcs',
                    'commits',
                    latest.id,
                    'tree.json'
                )
                return (await stat(treePath)).size
            }
            const objectCount = () =>
                readdirSync(path.join(scaleRoot, '.fylo-vcs', 'objects'), {
                    recursive: true,
                    withFileTypes: true
                }).filter((entry) => entry.isFile()).length

            let made = 0
            const fillTo = async (target) => {
                while (made < target) await fylo.scale.put({ n: made++ })
            }

            await fillTo(20)
            const smallTree = await latestTreeBytes()
            const beforeSmall = objectCount()
            await fylo.scale.put({ probe: 'small' })
            const smallDelta = objectCount() - beforeSmall

            await fillTo(220) // an order of magnitude larger
            const largeTree = await latestTreeBytes()
            const beforeLarge = objectCount()
            await fylo.scale.put({ probe: 'large' })
            const largeDelta = objectCount() - beforeLarge

            // tree.json references the root tree by hash, so its size is constant
            // no matter how many documents the collection holds.
            expect(largeTree).toBe(smallTree)
            // A single write rewrites only the path from its blob to the root
            // (blob + bucket + namespace + collection + root) — a fixed number of
            // new objects, independent of collection size.
            expect(smallDelta).toBeLessThanOrEqual(8)
            expect(largeDelta).toBe(smallDelta)
        } finally {
            await rm(scaleRoot, { recursive: true, force: true })
        }
    })

    test('auto-commit records writes on the active version branch', async () => {
        const branchRoot = await createTestRoot('fylo-auto-branch-')
        try {
            const repo = new VersionRepository(branchRoot)
            const main = new Fylo(branchRoot)
            await main['branch-posts'].create()
            const mainId = await main['branch-posts'].put({ title: 'main' })

            await repo.checkout('feature/auto', { create: true })
            const feature = new Fylo(branchRoot)
            const featureId = await feature['branch-posts'].put({ title: 'feature' })

            const [latest] = await repo.log({ limit: 1 })
            expect(latest.branch).toBe('feature/auto')
            expect(latest.message).toBe(`put branch-posts/${featureId}`)
            expect((await repo.status()).clean).toBe(true)

            await repo.checkout('main')
            expect(await main['branch-posts'].get(mainId).once()).toEqual({
                [mainId]: { title: 'main' }
            })
            expect(await main['branch-posts'].get(featureId).once()).toEqual({})
        } finally {
            await rm(branchRoot, { recursive: true, force: true })
        }
    })

    test('path constructor exposes SQL tag and collection-first facades', async () => {
        const fylo = new Fylo(root)
        await fylo.sql`CREATE TABLE apiusers`
        const id =
            await fylo.sql`INSERT INTO apiusers (name, role) VALUES (${"O'Brien"}, ${'admin'})`

        const queried = await fylo.sql`SELECT * FROM apiusers WHERE name = ${"O'Brien"}`
        expect(queried[id].role).toBe('admin')

        const viaFacade = await fylo['apiusers'].get(id).once()
        expect(viaFacade[id].name).toBe("O'Brien")
        await fylo['apiusers'].patch(id, { role: 'owner' })
        expect((await fylo['apiusers'].get(id).once())[id].role).toBe('owner')
        await expect(
            fylo.sql`SELECT * FROM apiusers WHERE name = ${{ nested: true }}`
        ).rejects.toThrow('SQL parameters must be scalar values')
        expect(() => new Fylo(`fylo://${root}`)).toThrow('remove fylo://')
    })
    test('memory query cache stores TTID lists and invalidates on writes', async () => {
        const cached = new Fylo(root, { cache: true })
        const collection = 'cache-users'
        await cached[collection].create()

        const firstId = await cached[collection].put({ name: 'Ada', team: 'platform' })
        const query = { $ops: [{ name: { $eq: 'Ada' } }] }
        const firstResults = {}
        for await (const doc of cached[collection].find(query).collect()) {
            Object.assign(firstResults, doc)
        }
        expect(Object.keys(firstResults)).toEqual([firstId])

        const secondId = await cached[collection].put({ name: 'Ada', team: 'runtime' })
        const secondResults = {}
        for await (const doc of cached[collection].find(query).collect()) {
            Object.assign(secondResults, doc)
        }
        expect(Object.keys(secondResults).sort()).toEqual([firstId, secondId].sort())
    })
    test('query cache stampede protection single-flights concurrent misses', async () => {
        const cached = new Fylo(root, { cache: true })
        const collection = 'cache-stampede-users'
        await cached[collection].create()
        await cached[collection].put({ name: 'Grace' })

        const originalListQueryableDocIds = cached.engine.listQueryableDocIds.bind(cached.engine)
        let calls = 0
        cached.engine.listQueryableDocIds = async (targetCollection) => {
            calls++
            await Bun.sleep(10)
            return await originalListQueryableDocIds(targetCollection)
        }

        await Promise.all([
            Array.fromAsync(cached[collection].find({}).collect()),
            Array.fromAsync(cached[collection].find({}).collect())
        ])

        expect(calls).toBe(1)
    })
    test('write-through query cache surfaces cache-version failures on writes', async () => {
        const cached = new Fylo(root, { cache: { method: 'write-through' } })
        const collection = 'cache-write-through-users'
        await cached[collection].create()
        if (!cached.engine.queryCache) throw new Error('missing query cache')
        cached.engine.queryCache.bumpCollection = async () => {
            throw new Error('cache unavailable')
        }

        await expect(cached[collection].put({ name: 'Linus' })).rejects.toThrow('cache unavailable')
    })
    test('stores collection data under .collections', async () => {
        expect(await isDirectory(path.join(root, '.collections', POSTS, 'docs'))).toBe(true)
        expect(await isDirectory(path.join(root, '.collections', POSTS, 'index'))).toBe(true)
        expect(await isDirectory(path.join(root, POSTS))).toBe(false)
    })
    test('queries updatedAt from the stable document file modification time', async () => {
        const id = await fylo[POSTS].put({ title: 'Timestamp v1' })
        await Bun.sleep(10)
        await fylo[POSTS].patch(id, { title: 'Timestamp v2' })
        const target = path.join(root, '.collections', POSTS, 'docs', shardOf(id), `${id}.json`)
        const updatedAt = (await stat(target)).mtimeMs
        const results = []
        for await (const doc of fylo[POSTS].find({ $updated: { $gte: updatedAt } }).collect()) {
            results.push(doc)
        }
        expect(results.some((doc) => Object.hasOwn(doc, id))).toBe(true)
    })
    test('delete listeners filter using stored document timestamps', async () => {
        const id = await fylo[POSTS].put({ title: 'Deleted timestamp' })
        const target = path.join(root, '.collections', POSTS, 'docs', shardOf(id), `${id}.json`)
        const updatedAt = (await stat(target)).mtimeMs
        const deletes = fylo[POSTS].find({
            $ops: [{ title: { $eq: 'Deleted timestamp' } }],
            $updated: { $lte: updatedAt }
        })
            .onDelete()
            [Symbol.asyncIterator]()
        const pending = deletes.next()

        await Bun.sleep(10)
        await fylo[POSTS].delete(id)

        expect((await pending).value).toBe(id)
        await deletes.return?.()
    })
    test('soft deletes are read-only and queryable by deletion time, then restorable', async () => {
        const id = await fylo[POSTS].put({ title: 'Restore me', status: 'archived' })
        const deletedAtFloor = Date.now()

        await fylo[POSTS].delete(id)

        const deletedPath = path.join(
            root,
            '.collections',
            POSTS,
            '.deleted',
            shardOf(id),
            `${id}.json`
        )
        const deletedMetadata = await stat(deletedPath)
        expect(deletedMetadata.mtimeMs).toBeGreaterThanOrEqual(deletedAtFloor)
        expect(deletedMetadata.mode & 0o777).toBe(0o444)

        const deleted = []
        for await (const doc of fylo[POSTS].find
            .deleted({
                $ops: [{ title: { $eq: 'Restore me' } }],
                $deleted: { $gte: deletedAtFloor }
            })
            .collect()) {
            deleted.push(doc)
        }
        expect(deleted).toEqual([{ [id]: { title: 'Restore me', status: 'archived' } }])
        await expect(
            fylo[POSTS].put({ [id]: { title: 'Bypass restore', status: 'archived' } })
        ).rejects.toThrow('soft-deleted')

        await fylo[POSTS].restore(id)

        const activePath = path.join(root, '.collections', POSTS, 'docs', shardOf(id), `${id}.json`)
        expect(await Bun.file(deletedPath).exists()).toBe(false)
        const restoredMode = (await stat(activePath)).mode & 0o777
        expect(restoredMode & 0o222).not.toBe(0)
        expect(restoredMode & 0o111).toBe(0)
        expect(await fylo[POSTS].get(id).once()).toEqual({
            [id]: { title: 'Restore me', status: 'archived' }
        })
        const queried = []
        for await (const doc of fylo[POSTS].find({
            $ops: [{ status: { $eq: 'archived' } }]
        }).collect()) {
            queried.push(doc)
        }
        expect(queried.some((doc) => Object.hasOwn(doc, id))).toBe(true)
    })
    test('findDocs listener is backed by the filesystem event journal', async () => {
        const iter = fylo[POSTS].find({
            $ops: [{ title: { $eq: 'Live event' } }]
        })[Symbol.asyncIterator]()
        const pending = iter.next()
        await Bun.sleep(100)
        const id = await fylo[POSTS].put({ title: 'Live event' })
        const { value } = await pending
        expect(value).toEqual({ [id]: { title: 'Live event' } })
        await iter.return?.()
    })
    test('supports long values without path-length issues', async () => {
        const longBody = 'x'.repeat(5000)
        const id = await fylo[POSTS].put({
            title: 'Long payload',
            body: longBody
        })
        const result = await fylo[POSTS].get(id).once()
        expect(result[id].body).toBe(longBody)
    })
    test('importBulkData rejects oversized responses and private-network URLs by default', async () => {
        const tooLarge = new URL('data:application/json,%5B%7B%22title%22%3A%22x%22%7D%5D')
        await expect(fylo[POSTS].import(tooLarge, { maxBytes: 4 })).rejects.toThrow('exceeded')
        await expect(fylo[POSTS].import(new URL('http://127.0.0.1/data.json'))).rejects.toThrow(
            'private address'
        )
    })
    test('importBulkData reports malformed JSON with a sanitized error', async () => {
        const invalidJson = new URL('data:application/json,%5Bnot-json')
        await expect(fylo[POSTS].import(invalidJson)).rejects.toThrow(
            'Invalid JSON in import response'
        )
    })
    test('stores only user document data in the file body', async () => {
        const id = await fylo[POSTS].put({
            title: 'Lean doc',
            body: 'payload only'
        })
        const raw = await Bun.file(
            path.join(root, '.collections', POSTS, 'docs', shardOf(id), `${id}.json`)
        ).json()

        expect(raw).toEqual({
            title: 'Lean doc',
            body: 'payload only'
        })
        expect(raw.id).toBeUndefined()
        expect(raw.createdAt).toBeUndefined()
        expect(raw.updatedAt).toBeUndefined()
    })
    test('stores query indexes as compact local object keys', async () => {
        const id = await fylo[POSTS].put({
            title: 'Prefix doc',
            tags: ['bun', 'prefix']
        })
        const index = await readLocalIndex(POSTS)
        expect(index).toContain(`+\ttitle/eq/Prefix%20doc/${id}`)
        expect(index).toContain(`+\ttags/eq/prefix/${id}`)
        expect(await Bun.file(path.join(root, '.collections', POSTS, 'index.db')).exists()).toBe(
            false
        )
        expect(
            await Bun.file(
                path.join(root, '.collections', POSTS, 'index', 'manifest.json')
            ).exists()
        ).toBe(true)
    })
    test('reads CRLF-terminated local index lines', async () => {
        const collection = 'filesystem-crlf-index'
        await fylo[collection].create()
        const id = await fylo[collection].put({ title: 'Windows index' })
        const walPath = path.join(root, '.collections', collection, 'index', 'keys.wal')
        const wal = await Bun.file(walPath).text()
        await writeFile(walPath, wal.replace(/\n/g, '\r\n'))

        let results = {}
        for await (const data of fylo[collection]
            .find({
                $ops: [{ title: { $eq: 'Windows index' } }]
            })
            .collect()) {
            results = { ...results, ...data }
        }

        expect(Object.keys(results)).toEqual([id])
    })
    test('uses prefix indexes to support exact, range, like, and contains queries', async () => {
        const queryCollection = 'filesystem-query'
        await fylo[queryCollection].create()

        const bunId = await fylo[queryCollection].put({
            title: 'Bun launch',
            tags: ['bun', 'storage'],
            meta: { score: 10 }
        })
        const nodeId = await fylo[queryCollection].put({
            title: 'Node launch',
            tags: ['node'],
            meta: { score: 2 }
        })

        let eqResults = {}
        for await (const data of fylo[queryCollection]
            .find({
                $ops: [{ title: { $eq: 'Bun launch' } }]
            })
            .collect()) {
            eqResults = { ...eqResults, ...data }
        }
        expect(Object.keys(eqResults)).toEqual([bunId])

        let rangeResults = {}
        for await (const data of fylo[queryCollection]
            .find({
                $ops: [{ ['meta.score']: { $gte: 5 } }]
            })
            .collect()) {
            rangeResults = { ...rangeResults, ...data }
        }
        expect(Object.keys(rangeResults)).toEqual([bunId])

        let containsResults = {}
        for await (const data of fylo[queryCollection]
            .find({
                $ops: [{ tags: { $contains: 'storage' } }]
            })
            .collect()) {
            containsResults = { ...containsResults, ...data }
        }
        expect(Object.keys(containsResults)).toEqual([bunId])
        expect(containsResults[nodeId]).toBeUndefined()

        let prefixResults = {}
        for await (const data of fylo[queryCollection]
            .find({
                $ops: [{ title: { $like: 'Bun%' } }]
            })
            .collect()) {
            prefixResults = { ...prefixResults, ...data }
        }
        expect(Object.keys(prefixResults)).toEqual([bunId])

        let suffixResults = {}
        for await (const data of fylo[queryCollection]
            .find({
                $ops: [{ title: { $like: '%launch' } }]
            })
            .collect()) {
            suffixResults = { ...suffixResults, ...data }
        }
        expect(Object.keys(suffixResults).sort()).toEqual([bunId, nodeId].sort())

        let containsLikeResults = {}
        for await (const data of fylo[queryCollection]
            .find({
                $ops: [{ title: { $like: '%un l%' } }]
            })
            .collect()) {
            containsLikeResults = { ...containsLikeResults, ...data }
        }
        expect(Object.keys(containsLikeResults)).toEqual([bunId])

        const index = await readLocalIndex(queryCollection)
        expect(index).toContain(`+\ttitle/eq/Bun%20launch/${bunId}`)
        expect(index).toContain(`+\ttags/eq/storage/${bunId}`)
        expect(index).toContain(`+\tmeta/score/n/`)
    })
    test('array index entries shrink and expand with document changes', async () => {
        const collection = 'filesystem-array-index'
        await fylo[collection].create()
        const firstId = await fylo[collection].put({ tags: ['alpha', 'beta'] })
        const secondId = await fylo[collection].patch(firstId, { tags: ['beta', 'gamma'] })
        expect(secondId).toBe(firstId)

        let oldResults = {}
        for await (const data of fylo[collection]
            .find({
                $ops: [{ tags: { $contains: 'alpha' } }]
            })
            .collect()) {
            oldResults = { ...oldResults, ...data }
        }

        let newResults = {}
        for await (const data of fylo[collection]
            .find({
                $ops: [{ tags: { $contains: 'gamma' } }]
            })
            .collect()) {
            newResults = { ...newResults, ...data }
        }

        expect(oldResults).toEqual({})
        expect(Object.keys(newResults)).toEqual([secondId])
    })
    test('joins work in filesystem mode', async () => {
        const userId = await fylo[USERS].put({ id: 42, name: 'Ada' })
        const postId = await fylo[POSTS].put({ id: 42, title: 'Shared', content: 'join me' })
        const joined = await fylo.join({
            $leftCollection: USERS,
            $rightCollection: POSTS,
            $mode: 'inner',
            $on: {
                id: { $eq: 'id' }
            }
        })
        expect(joined[`${userId}, ${postId}`]).toBeDefined()
    })
    test('rejects collection names that are unsafe for cross-platform filesystems', async () => {
        await expect(fylo['bad/name'].create()).rejects.toThrow('Invalid collection name')
        await expect(fylo['bad\\name'].create()).rejects.toThrow('Invalid collection name')
        await expect(fylo['bad:name'].create()).rejects.toThrow('Invalid collection name')
    })
    test('static helpers can use filesystem root env defaults', async () => {
        const prevFyloRoot = process.env.FYLO_ROOT
        process.env.FYLO_ROOT = root
        const collection = 'filesystem-static'
        await fylo[collection].create()
        const id = await fylo[collection].put({ title: 'Static path' })
        const result = await fylo[collection].get(id).once()
        expect(result[id].title).toBe('Static path')
        if (prevFyloRoot === undefined) delete process.env.FYLO_ROOT
        else process.env.FYLO_ROOT = prevFyloRoot
    })
})
