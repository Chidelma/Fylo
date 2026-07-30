import { afterAll, describe, expect, test } from 'bun:test'
import { shardOf } from '../../src/core/doc-id.js'
import { mkdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import Fylo from '../../src/index.js'
import { VersionRepository } from '../../src/versioning/repository.js'
import { createTestRoot } from '../helpers/root.js'

const root = await createTestRoot('fylo-raw-files-')
const fylo = new Fylo(root, { versioning: { autoCommit: false } })

afterAll(async () => {
    await rm(root, { recursive: true, force: true })
})

describe('raw file collections', () => {
    test('stores File bytes unchanged under the TTID and original extension', async () => {
        await fylo.assets.create({ kind: 'file' })
        const source = new File(['hello raw file'], 'greeting.txt', { type: 'text/plain' })

        const id = await fylo.assets.put(source)
        const storedPath = path.join(root, '.buckets', 'assets', 'docs', shardOf(id), `${id}.txt`)

        expect(await Bun.file(storedPath).text()).toBe('hello raw file')
        expect((await fylo.assets.inspect()).kind).toBe('file')

        const result = fylo.assets.get(id)
        const manifest = await result.once()
        expect(manifest[id]).toMatchObject({
            name: `${id}.txt`,
            key: `/${id}.txt`,
            extension: '.txt',
            contentType: 'text/plain',
            contentLength: source.size
        })
        expect(manifest[id].checksumSHA256).toMatch(/^[0-9a-f]{64}$/)
        expect(manifest[id].etag).toBe(manifest[id].checksumSHA256)
        expect(new TextDecoder().decode(await result.bytes())).toBe('hello raw file')
        expect(await (await result.blob()).text()).toBe('hello raw file')
        expect(await new Response(await result.stream()).text()).toBe('hello raw file')
    })

    test('reading an absent raw file surfaces a clean not-found, not a raw ENOENT (#49)', async () => {
        // A real, valid TTID that lives in `assets`...
        const id = await fylo.assets.put(
            new File(['present'], 'present.txt', { type: 'text/plain' })
        )
        // ...but `empties` has never stored it, so its shard bucket directory does
        // not exist. findPath must return null (clean not-found) rather than
        // letting the raw ENOENT from listing a missing directory escape.
        await fylo.empties.create({ kind: 'file' })
        await expect(fylo.empties.get(id).bytes()).rejects.toThrow(/Raw file not found/)
    })

    test('rejects a valid-TTID raw-file symlink that escapes its collection', async () => {
        await fylo.links.create({ kind: 'file' })
        const id = await Fylo.uniqueTTID()
        const outside = path.join(root, 'outside-secret.txt')
        await writeFile(outside, 'must not escape')
        const bucket = path.join(root, '.buckets', 'links', 'docs', shardOf(id))
        await mkdir(bucket, { recursive: true })
        await symlink(outside, path.join(bucket, `${id}.txt`))

        await expect(fylo.links.get(id).bytes()).rejects.toThrow(/regular, non-link file/)
        await expect(fylo.links.get(id).once()).rejects.toThrow(/regular, non-link file/)
    })

    test('queries durable object keys and preserves them while rebuilding indexes', async () => {
        const id = await fylo.assets.put(
            new File([new Uint8Array([1, 2, 3, 4])], 'pixel.png', { type: 'image/png' }),
            { key: '/images/2026/pixel.png' }
        )

        const matches = await Array.fromAsync(
            fylo.assets
                .find({
                    $ops: [{ key: { $eq: '/images/2026/pixel.png' } }]
                })
                .collect()
        )
        expect(matches.some((entry) => Object.hasOwn(entry, id))).toBe(true)
        expect(matches[0]?.[id]?.key).toBe('/images/2026/pixel.png')

        const rebuilt = await fylo.assets.rebuild()
        expect(rebuilt.kind).toBe('file')
        expect(rebuilt.indexedDocs).toBeGreaterThanOrEqual(2)

        const afterRebuild = await Array.fromAsync(
            fylo.assets
                .find({
                    $ops: [{ key: { $like: '/images/%' } }]
                })
                .collect()
        )
        expect(afterRebuild.some((entry) => Object.hasOwn(entry, id))).toBe(true)
    })

    test('expands root and prefix keys and rejects duplicate active keys', async () => {
        const rootId = await fylo.assets.put(new File(['root'], 'root.bin'), { key: '/' })
        const prefixedId = await fylo.assets.put(new File(['prefixed'], 'report.pdf'), {
            key: '/reports/2026/'
        })

        expect((await fylo.assets.get(rootId).once())[rootId].key).toBe(`/${rootId}.bin`)
        expect((await fylo.assets.get(prefixedId).once())[prefixedId].key).toBe(
            `/reports/2026/${prefixedId}.pdf`
        )
        await expect(
            fylo.assets.put(new File(['collision'], 'other.pdf'), {
                key: `/reports/2026/${prefixedId}.pdf`
            })
        ).rejects.toThrow('Object key already exists')
    })

    test('enforces the key limit after expanding a trailing-slash prefix', async () => {
        const maximumPrefix = `/${'a'.repeat(1022)}/`

        await expect(
            fylo.assets.put(new File(['too long'], 'oversized.bin'), {
                key: maximumPrefix
            })
        ).rejects.toThrow('must not exceed 1024 UTF-8 bytes')
    })

    test('stores a raw JSON file without interpreting it as a document', async () => {
        const rawJson = '{"this":"remains raw"}'
        const id = await fylo.assets.put(
            new File([rawJson], 'payload.json', { type: 'application/json' })
        )

        expect(new TextDecoder().decode(await fylo.assets.get(id).bytes())).toBe(rawJson)
        expect((await fylo.assets.get(id).once())[id].extension).toBe('.json')
    })

    test('soft deletes and restores the unchanged raw file', async () => {
        const id = await fylo.assets.put(new File(['restore me'], 'restore.txt'), {
            key: '/archive/restore.txt'
        })
        const activePath = path.join(root, '.buckets', 'assets', 'docs', shardOf(id), `${id}.txt`)
        const deletedPath = path.join(
            root,
            '.buckets',
            'assets',
            '.deleted',
            shardOf(id),
            `${id}.txt`
        )

        await fylo.assets.delete(id)
        expect(await Bun.file(activePath).exists()).toBe(false)
        expect(await Bun.file(deletedPath).text()).toBe('restore me')
        expect(await fylo.assets.get(id).once()).toEqual({})
        const deleted = await Array.fromAsync(
            fylo.assets.find
                .deleted({
                    $ops: [{ key: { $eq: '/archive/restore.txt' } }]
                })
                .collect()
        )
        expect(deleted.some((entry) => entry[id]?.key === '/archive/restore.txt')).toBe(true)

        await fylo.assets.restore(id)
        expect(await Bun.file(deletedPath).exists()).toBe(false)
        expect(await Bun.file(activePath).text()).toBe('restore me')
        expect((await fylo.assets.get(id).once())[id].key).toBe('/archive/restore.txt')
    })

    test('ingests file URLs and rejects inputs sent to the wrong collection kind', async () => {
        const sourcePath = path.join(root, 'source.csv')
        await Bun.write(sourcePath, 'a,b\n1,2\n')
        const id = await fylo.assets.put(pathToFileURL(sourcePath))

        expect((await fylo.assets.get(id).once())[id]).toMatchObject({
            extension: '.csv',
            contentType: 'text/csv'
        })
        await fylo.records.create()
        await expect(fylo.records.put(new File(['no'], 'no.txt'))).rejects.toThrow(
            'document collection'
        )
        await expect(fylo.assets.put({ title: 'not a file' })).rejects.toThrow('file collection')
    })

    test('versions and restores raw bytes with the original extension', async () => {
        const versionRoot = await createTestRoot('fylo-raw-versioning-')
        try {
            const db = new Fylo(versionRoot)
            const repo = new VersionRepository(versionRoot)
            await db.media.create({ kind: 'file' })
            const id = await db.media.put(new File(['versioned bytes'], 'archive.zip'), {
                key: '/releases/archive.zip'
            })
            const [created] = await repo.log({ limit: 1 })

            expect(created.message).toBe(`put media/${id}`)
            expect((await repo.status()).clean).toBe(true)

            await db.media.delete(id)
            await repo.restoreCommit(created.id)

            const restored = new Fylo(versionRoot)
            expect(new TextDecoder().decode(await restored.media.get(id).bytes())).toBe(
                'versioned bytes'
            )
            expect((await restored.media.get(id).once())[id].extension).toBe('.zip')
            expect((await restored.media.get(id).once())[id].key).toBe('/releases/archive.zip')
        } finally {
            await rm(versionRoot, { recursive: true, force: true })
        }
    })

    test('keeps strict WORM raw files read-only and non-versioned', async () => {
        const wormRoot = await createTestRoot('fylo-raw-worm-')
        try {
            const db = new Fylo(wormRoot, { worm: { mode: 'strict' } })
            await db.evidence.create({ kind: 'file' })
            const id = await db.evidence.put(new File(['immutable'], 'evidence.bin'))
            const target = path.join(
                wormRoot,
                '.buckets',
                'evidence',
                'docs',
                shardOf(id),
                `${id}.bin`
            )

            expect((await stat(target)).mode & 0o777).toBe(0o444)
            expect(await Bun.file(path.join(wormRoot, '.fylo-vcs')).exists()).toBe(false)
            await expect(db.evidence.delete(id)).rejects.toThrow('Delete is not allowed')
        } finally {
            await rm(wormRoot, { recursive: true, force: true })
        }
    })
})
