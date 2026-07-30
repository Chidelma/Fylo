import { describe, expect, test } from 'bun:test'
import { shardOf } from '../../src/core/doc-id.js'
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
})
