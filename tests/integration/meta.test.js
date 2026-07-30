import { afterAll, describe, expect, test } from 'bun:test'
import { shardOf } from '../../src/core/doc-id.js'
import { readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import Fylo from '../../src/index.js'
import { VersionRepository } from '../../src/versioning/repository.js'
import { createTestRoot } from '../helpers/root.js'

const root = await createTestRoot('fylo-meta-')
const fylo = new Fylo(root, { versioning: { autoCommit: false } })

afterAll(async () => {
    await rm(root, { recursive: true, force: true })
})

/** @param {Record<string, any>} metadata @param {Record<string, any>} expected */
function expectCustomMetadata(metadata, expected) {
    expect(metadata).toMatchObject(expected)
}

describe('developer metadata (xattrs)', () => {
    test('get(id).metadata() combines system timestamps with custom document metadata', async () => {
        await fylo.notes.create()
        const id = await Fylo.uniqueTTID()
        await fylo.notes.put(id, { title: 'hello' }).metadata({
            owner: 'chidelma',
            source: 'import-batch-7',
            id: 'custom-id',
            createdAt: 0,
            updatedAt: 0,
            mtime: 0
        })
        const metadata = await fylo.notes.get(id).metadata()
        expect(metadata).toMatchObject({
            owner: 'chidelma',
            source: 'import-batch-7'
        })
        expect(metadata.id).toBe(id)
        expect(metadata.createdAt).toBeNumber()
        expect(metadata.createdAt).toBeGreaterThan(0)
        expect(metadata.mtime).toBeNumber()
        expect(metadata.updatedAt).toBe(metadata.mtime)

        await fylo.notes.put(id, { title: 'hello again' })
        expect(await fylo.notes.get(id).metadata()).toMatchObject({
            owner: 'chidelma',
            source: 'import-batch-7'
        })
    })

    test('put(id).metadata(record) bulk-writes; null removes; get(id).metadata() reads', async () => {
        const id = await fylo.notes.put({ title: 'bulk' })
        await fylo.notes.put(id).metadata({ owner: 'chidelma', stage: 'draft', priority: 2 })
        expectCustomMetadata(await fylo.notes.get(id).metadata(), {
            owner: 'chidelma',
            stage: 'draft',
            priority: 2
        })

        await fylo.notes.put(id).metadata({ stage: null, priority: 3 })
        expectCustomMetadata(await fylo.notes.get(id).metadata(), {
            owner: 'chidelma',
            priority: 3
        })
    })

    test('put(id, file).metadata() writes initial raw-file metadata', async () => {
        await fylo.assets.create({ kind: 'file' })
        const id = await Fylo.uniqueTTID()
        await fylo.assets
            .put(id, new File(['bytes'], 'a.txt', { type: 'text/plain' }))
            .metadata({ camera: 'A7 IV' })
        const metadata = await fylo.assets.get(id).metadata()
        expect(metadata).toMatchObject({
            id,
            name: `${id}.txt`,
            key: `/${id}.txt`,
            extension: '.txt',
            contentType: 'text/plain',
            contentLength: 5,
            camera: 'A7 IV'
        })
        expect(metadata.etag).toBeString()
        expect(metadata.checksumSHA256).toBe(metadata.etag)
        expect(metadata.lastModified).toBe(metadata.updatedAt)
    })

    test('initial raw-file metadata rolls bytes, xattrs, and partial indexes back together', async () => {
        await fylo['atomic-assets'].create({ kind: 'file' })
        const id = await Fylo.uniqueTTID()
        const index = fylo.engine.index
        const originalPut = index.putDocument
        index.putDocument = /** @type {typeof index.putDocument} */ (
            async function (...args) {
                await originalPut.apply(this, args)
                throw new Error('injected initial raw index failure')
            }
        )
        try {
            await expect(
                fylo['atomic-assets']
                    .put(id, new File(['must disappear'], 'atomic.bin'))
                    .metadata({ owner: 'rollback' })
            ).rejects.toThrow('injected initial raw index failure')
        } finally {
            index.putDocument = originalPut
        }

        expect(await fylo['atomic-assets'].get(id).once()).toEqual({})
        await expect(fylo['atomic-assets'].get(id).metadata()).rejects.toThrow('Raw file not found')
        const bucket = path.join(root, '.buckets', 'atomic-assets', 'docs', shardOf(id))
        expect(await readdir(bucket).catch(() => [])).toEqual([])
        expect(
            await Array.fromAsync(
                fylo['atomic-assets']
                    .find({ $ops: [{ ['meta/owner']: { $eq: 'rollback' } }] })
                    .collect()
            )
        ).toEqual([])
    })

    test('initial raw-file put reports an AggregateError when rollback is incomplete', async () => {
        await fylo['atomic-failure'].create({ kind: 'file' })
        const id = await Fylo.uniqueTTID()
        const index = fylo.engine.index
        const storage = fylo.engine.storage
        const originalPut = index.putDocument
        const originalDelete = storage.delete
        index.putDocument = /** @type {typeof index.putDocument} */ (
            async function (...args) {
                await originalPut.apply(this, args)
                throw new Error('injected initial index failure')
            }
        )
        storage.delete = /** @type {typeof storage.delete} */ (
            async () => {
                throw new Error('injected rollback delete failure')
            }
        )
        let failure
        try {
            failure = await fylo['atomic-failure']
                .put(id, new File(['left behind'], 'failure.bin'))
                .metadata({ state: 'partial' })
                .then(
                    () => null,
                    (error) => error
                )
        } finally {
            index.putDocument = originalPut
            storage.delete = originalDelete
        }
        expect(failure).toBeInstanceOf(AggregateError)
        expect(failure.message).toBe('Raw file put failed and rollback was incomplete')
        const target = path.join(
            root,
            '.buckets',
            'atomic-failure',
            'docs',
            shardOf(id),
            `${id}.bin`
        )
        await storage.delete(target)
    })

    test('values round-trip typed: numbers, booleans, arrays, objects', async () => {
        const id = await fylo.notes.put({ title: 'typed' })
        const record = {
            rating: 4.5,
            starred: true,
            tags: ['a', 'b'],
            geo: { lat: 6.5, lng: 3.4 }
        }
        await fylo.notes.put(id).metadata(record)
        expectCustomMetadata(await fylo.notes.get(id).metadata(), record)
    })

    test('hostile-looking strings round-trip as inert metadata values', async () => {
        const id = await fylo.notes.put({ title: 'untrusted metadata' })
        const record = {
            payload: '</script><script>alert("fylo")</script>\u0000\n../etc/passwd',
            nested: { __proto__: 'literal', constructor: '<img src=x onerror=alert(1)>' }
        }
        await fylo.notes.put(id).metadata(record)
        expectCustomMetadata(await fylo.notes.get(id).metadata(), record)
    })

    test('a failed native metadata write restores the prior record and timestamp', async () => {
        const id = await fylo.notes.put({ title: 'atomic metadata' })
        const original = { owner: 'chidelma', priority: 2 }
        await fylo.notes.put(id).metadata(original)
        const originalUpdatedAt = await fylo.engine.docMetaUpdatedAt('notes', id)

        // Cross-platform preflight rejects values that cannot safely fit in a
        // Linux user xattr before any mutation reaches the filesystem.
        await expect(
            fylo.notes.put(id).metadata({
                owner: 'changed-before-failure',
                oversized: 'x'.repeat(1024 * 1024)
            })
        ).rejects.toThrow(/60 KiB/)

        expectCustomMetadata(await fylo.notes.get(id).metadata(), original)
        expect(await fylo.engine.docMetaUpdatedAt('notes', id)).toBe(originalUpdatedAt)
    })

    test('initial metadata failure does not create or overwrite a native document', async () => {
        const id = await Fylo.uniqueTTID()
        const invalid = { oversized: 'x'.repeat(1024 * 1024) }
        await expect(
            fylo.notes.put(id, { title: 'must not persist' }).metadata(invalid)
        ).rejects.toThrow(/60 KiB/)
        expect(await fylo.notes.get(id).once()).toEqual({})

        await fylo.notes.put(id, { title: 'original' })
        await expect(fylo.notes.put(id, { title: 'changed' }).metadata(invalid)).rejects.toThrow(
            /60 KiB/
        )
        expect((await fylo.notes.get(id).once())[id]).toEqual({ title: 'original' })

        const undefinedId = await Fylo.uniqueTTID()
        await expect(
            fylo.notes
                .put(undefinedId, { title: 'explicit undefined' })
                .metadata(/** @type {any} */ (undefined))
        ).rejects.toThrow('plain object')
        expect(await fylo.notes.get(undefinedId).once()).toEqual({})

        await expect(
            fylo.notes
                .put(id, { title: 'undefined overwrite' })
                .metadata(/** @type {any} */ (undefined))
        ).rejects.toThrow('plain object')
        expect((await fylo.notes.get(id).once())[id]).toEqual({ title: 'original' })

        const fileId = await Fylo.uniqueTTID()
        await expect(
            fylo.assets
                .put(fileId, new File(['bytes'], 'undefined.txt'))
                .metadata(/** @type {any} */ (undefined))
        ).rejects.toThrow('plain object')
        expect(await fylo.assets.get(fileId).once()).toEqual({})
    })

    test('native metadata timestamps advance monotonically within one clock tick', async () => {
        const id = await fylo.notes.put({ title: 'monotonic metadata' })
        const originalNow = Date.now
        Date.now = () => 1_800_000_000_000
        try {
            await fylo.notes.put(id).metadata({ owner: 'first' })
            const first = await fylo.engine.docMetaUpdatedAt('notes', id)
            await fylo.notes.put(id).metadata({ owner: 'second' })
            const second = await fylo.engine.docMetaUpdatedAt('notes', id)
            expect(second).toBeGreaterThan(first)
        } finally {
            Date.now = originalNow
        }
    })

    test('document rewrites and metadata mutations serialize without losing xattrs', async () => {
        const id = await fylo.notes.put({ title: 'concurrent metadata' })
        for (let revision = 0; revision < 12; revision++) {
            await Promise.all([
                fylo.notes.put(id, { title: `revision ${revision}` }),
                fylo.notes.put(id).metadata({ owner: 'preserved', revision })
            ])
            expectCustomMetadata(await fylo.notes.get(id).metadata(), {
                owner: 'preserved',
                revision
            })
        }
    })

    test('metadata on a raw file survives soft delete and restore', async () => {
        const id = await fylo.assets.put(new File(['bytes'], 'a.txt', { type: 'text/plain' }))
        await fylo.assets.put(id).metadata({ camera: 'A7 IV' })

        await fylo.assets.delete(id)
        await fylo.assets.restore(id)
        expectCustomMetadata(await fylo.assets.get(id).metadata(), { camera: 'A7 IV' })
    })

    test('rejects invalid metadata names, shapes, and unserializable values', async () => {
        const id = await fylo.notes.put({ title: 'strict' })
        await expect(fylo.notes.put(id).metadata({ 'bad name': 'x' })).rejects.toThrow(
            'Metadata name must be'
        )
        await expect(
            fylo.notes.put(id).metadata(/** @type {any} */ (['not', 'a', 'record']))
        ).rejects.toThrow('Metadata must be a plain object')
        await expect(
            fylo.notes.put(id).metadata({ fn: /** @type {any} */ (() => {}) })
        ).rejects.toThrow('JSON-serializable')
        await expect(fylo.notes.put('01unknown').metadata({ ok: 'x' })).rejects.toThrow()
    })

    test('machine interface supports meta on putData plus getMeta/setMeta ops', async () => {
        const { runMachineRequest } = await import('../../src/cli/machine.js')
        const overrides = { root }

        const created = await runMachineRequest(
            {
                op: 'putData',
                collection: 'notes',
                data: { title: 'machine' },
                meta: { origin: 'exec', rating: 3 }
            },
            overrides
        )
        expect(created.ok).toBe(true)
        const id = created.result

        const read = await runMachineRequest({ op: 'getMeta', collection: 'notes', id }, overrides)
        expectCustomMetadata(read.result, { origin: 'exec', rating: 3 })

        const updated = await runMachineRequest(
            { op: 'setMeta', collection: 'notes', id, meta: { rating: 4, origin: null } },
            overrides
        )
        expectCustomMetadata(updated.result, { rating: 4 })
    })

    test('browser clients persist metadata in the portable sidecar store', async () => {
        const { createBrowserClient } = await import('../../src/browser/index.js')
        const browser = createBrowserClient({ storage: 'memory' })
        await browser.people.create()
        const id = await browser.people.put({ name: 'Ada' })

        await browser.people.put(id).metadata({ starred: true, rating: 5 })
        const initialMetadata = await browser.people.get(id).metadata()
        expectCustomMetadata(initialMetadata, { starred: true, rating: 5 })
        expect(initialMetadata).toMatchObject({ id, createdAt: expect.any(Number) })
        expect(initialMetadata.updatedAt).toBe(initialMetadata.mtime)
        await browser.people.put(id).metadata({ starred: null })
        expectCustomMetadata(await browser.people.get(id).metadata(), { rating: 5 })

        const failedId = await Fylo.uniqueTTID()
        await expect(
            browser.people
                .put(failedId, { name: 'Must not persist' })
                .metadata({ oversized: 'x'.repeat(1024 * 1024) })
        ).rejects.toThrow(/60 KiB/)
        expect(await browser.people.get(failedId).once()).toEqual({})

        const invalidShapeId = await Fylo.uniqueTTID()
        await expect(
            browser.people
                .put(invalidShapeId, { name: 'Invalid metadata shape' })
                .metadata(/** @type {any} */ (null))
        ).rejects.toThrow('must be an object')
        expect(await browser.people.get(invalidShapeId).once()).toEqual({})

        const undefinedId = await Fylo.uniqueTTID()
        await expect(
            browser.people
                .put(undefinedId, { name: 'Explicit undefined metadata' })
                .metadata(/** @type {any} */ (undefined))
        ).rejects.toThrow('must be an object')
        expect(await browser.people.get(undefinedId).once()).toEqual({})
    })

    test('metadata survives a versioning commit and restore', async () => {
        const versionRoot = await createTestRoot('fylo-meta-vcs-')
        try {
            const db = new Fylo(versionRoot)
            const repo = new VersionRepository(versionRoot)
            await db.media.create({ kind: 'file' })
            const id = await Fylo.uniqueTTID()
            await db.media
                .put(id, new File(['snap'], 'snap.jpg'), { key: '/pics/snap.jpg' })
                .metadata({ camera: 'A7 IV' })
            expect((await repo.status()).clean).toBe(true)

            const [head] = await repo.log({ limit: 1 })
            await db.media.delete(id)
            await repo.restoreCommit(head.id)

            const restored = new Fylo(versionRoot)
            expectCustomMetadata(await restored.media.get(id).metadata(), { camera: 'A7 IV' })
            expect((await restored.media.get(id).once())[id].key).toBe('/pics/snap.jpg')
        } finally {
            await rm(versionRoot, { recursive: true, force: true })
        }
    })

    test('corrupt committed metadata cannot partially restore files, xattrs, or refs', async () => {
        const versionRoot = await createTestRoot('fylo-meta-vcs-corrupt-')
        try {
            const db = new Fylo(versionRoot)
            const repo = new VersionRepository(versionRoot)
            await db.media.create({ kind: 'file' })
            const id = await Fylo.uniqueTTID()
            await db.media
                .put(id, new File(['immutable bytes'], 'image.jpg'), { key: '/image.jpg' })
                .metadata({ camera: 'original' })
            const [original] = await repo.log({ limit: 1 })

            await db.media.put(id).metadata({ camera: 'working-copy' })
            const beforeRef = await repo.readRef('main')
            const originalTree = await repo.readCommitTree(original.id)
            const metadata = [...originalTree.values()].find(
                (entry) => entry.id === id && entry.kind === 'metadata'
            )
            expect(metadata).toBeDefined()
            await writeFile(
                repo.objectPath(/** @type {NonNullable<typeof metadata>} */ (metadata).hash),
                '{"version":2,"xattrs":{"user.fylo.meta.camera":"not-base64"}}\n'
            )

            await expect(repo.restoreCommit(original.id, { force: true })).rejects.toThrow(
                'Corrupt version object'
            )
            expect((await repo.readRef('main')).head).toBe(beforeRef.head)
            const unchanged = new Fylo(versionRoot, { versioning: { autoCommit: false } })
            expectCustomMetadata(await unchanged.media.get(id).metadata(), {
                camera: 'working-copy'
            })
            expect(new TextDecoder().decode(await unchanged.media.get(id).bytes())).toBe(
                'immutable bytes'
            )
        } finally {
            await rm(versionRoot, { recursive: true, force: true })
        }
    })
})
