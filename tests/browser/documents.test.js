import { describe, expect, test } from 'bun:test'
import { legacyShardOf, shardOf } from '../../src/core/shard.js'
import TTID from '../../src/browser/vendor/ttid.mjs'
import { createMemoryFilesystem } from '../../src/browser/core/memory-filesystem.js'
import { BrowserCore } from '../../src/browser/core/engine.js'

describe('BrowserDocuments through BrowserCore', () => {
    test('uses FYLO per-document layout and keeps active document bodies pure', async () => {
        const fs = createMemoryFilesystem()
        const fylo = new BrowserCore({ fs, root: '/' })
        await fylo['users'].create()
        const id = await fylo['users'].put({ name: 'Ada', role: 'admin' })
        const path = `/.collections/users/docs/${shardOf(id)}/${id}.json`

        expect(await fs.readText(path)).toBe('{"name":"Ada","role":"admin"}')
        expect(await fs.exists('/.collections/users/collection.json')).toBe(false)
    })

    test('soft delete writes hidden tombstone with deletion metadata and restores the same TTID', async () => {
        const fs = createMemoryFilesystem()
        const fylo = new BrowserCore({ fs, root: '/' })
        const id = /** @type {string} */ (TTID.generate())

        await fylo['users'].create()
        await fylo['users'].put({ [id]: { name: 'Grace' } })
        await fylo['users'].delete(id)

        const livePath = `/.collections/users/docs/${shardOf(id)}/${id}.json`
        const deletedPath = `/.collections/users/.deleted/${shardOf(id)}/${id}.json`
        expect(await fs.exists(livePath)).toBe(false)
        const tombstone = JSON.parse(await fs.readText(deletedPath))
        expect(tombstone).toMatchObject({ name: 'Grace' })
        expect(tombstone._deletedAt).toBeNumber()

        await fylo['users'].restore(id)
        expect(await fs.exists(deletedPath)).toBe(false)
        expect(await fs.readText(livePath)).toBe('{"name":"Grace"}')
    })

    test('rejects malformed JSON document text on read', async () => {
        const fs = createMemoryFilesystem()
        const fylo = new BrowserCore({ fs, root: '/' })
        await fylo['users'].create()
        const id = await fylo['users'].put({ name: 'Ada' })
        const path = `/.collections/users/docs/${shardOf(id)}/${id}.json`

        await fs.writeText(path, '{"name":@}')

        await expect(fylo['users'].get(id).once()).rejects.toThrow()
    })

    test('rejects non-object JSON document bodies', async () => {
        const fs = createMemoryFilesystem()
        const fylo = new BrowserCore({ fs, root: '/' })
        await fylo['users'].create()
        const id = await fylo['users'].put({ name: 'Ada' })
        const path = `/.collections/users/docs/${shardOf(id)}/${id}.json`

        await fs.writeText(path, '["not","a","document"]')

        await expect(fylo['users'].get(id).once()).rejects.toThrow(
            'FYLO document body must be a JSON object'
        )
    })

    test('reads released leading shards and converges documents and metadata on mutation', async () => {
        const fs = createMemoryFilesystem()
        const fylo = new BrowserCore({ fs, root: '/' })
        const id = '4VRNF52JPCO'
        const legacy = legacyShardOf(id)
        const canonical = shardOf(id)
        expect(legacy).not.toBe(canonical)

        await fylo['users'].create()
        await fs.mkdir(`/.collections/users/docs/${legacy}`, { recursive: true })
        await fs.mkdir(`/.collections/users/.metadata/${legacy}`, { recursive: true })
        const legacyDocument = `/.collections/users/docs/${legacy}/${id}.json`
        const canonicalDocument = `/.collections/users/docs/${canonical}/${id}.json`
        const legacyMetadata = `/.collections/users/.metadata/${legacy}/${id}.json`
        const canonicalMetadata = `/.collections/users/.metadata/${canonical}/${id}.json`
        await fs.writeText(legacyDocument, '{"name":"Released"}')
        await fs.writeText(
            legacyMetadata,
            JSON.stringify({ values: { source: 'v26.30.06' }, updatedAt: 1 })
        )

        expect(await fylo['users'].get(id).once()).toEqual({ [id]: { name: 'Released' } })
        expect((await fylo.getDocMeta('users', id)).source).toBe('v26.30.06')

        await fylo['users'].patch(id, { migrated: true })
        await fylo.setDocMetaRecord('users', id, { reviewed: true })
        expect(await fs.exists(legacyDocument)).toBe(false)
        expect(await fs.exists(canonicalDocument)).toBe(true)
        expect(await fs.exists(legacyMetadata)).toBe(false)
        expect(await fs.exists(canonicalMetadata)).toBe(true)
        expect(await fylo['users'].get(id).once()).toEqual({
            [id]: { name: 'Released', migrated: true }
        })
    })

    test('restores a released leading-shard tombstone into the trailing shard', async () => {
        const fs = createMemoryFilesystem()
        const fylo = new BrowserCore({ fs, root: '/' })
        const id = '4VRNF52JPCO'
        const legacyTombstone = `/.collections/users/.deleted/${legacyShardOf(id)}/${id}.json`
        const canonicalDocument = `/.collections/users/docs/${shardOf(id)}/${id}.json`

        await fylo['users'].create()
        await fs.mkdir(`/.collections/users/.deleted/${legacyShardOf(id)}`, { recursive: true })
        await fs.writeText(legacyTombstone, '{"name":"Released","_deletedAt":1}')

        await fylo['users'].restore(id)
        expect(await fs.exists(legacyTombstone)).toBe(false)
        expect(await fs.readText(canonicalDocument)).toBe('{"name":"Released"}')
    })
})
