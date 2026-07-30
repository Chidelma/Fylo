import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { shardOf } from '../../src/core/doc-id.js'
import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import Fylo from '../../src/index.js'
import { createTestRoot } from '../helpers/root.js'

const COLLECTION = 'worm-posts'
const root = await createTestRoot('fylo-worm-')
const fylo = new Fylo(root, {
    worm: {
        mode: 'strict'
    }
})

beforeAll(async () => {
    await fylo[COLLECTION].create()
})

afterAll(async () => {
    await rm(root, { recursive: true, force: true })
})

describe('strict WORM mode', () => {
    test('writes one read-only immutable document with no version history artifacts', async () => {
        const id = await fylo[COLLECTION].put({ title: 'Retain me' })
        const documentPath = path.join(
            root,
            '.collections',
            COLLECTION,
            'docs',
            shardOf(id),
            `${id}.json`
        )
        const mode = (await stat(documentPath)).mode & 0o777
        expect(mode).toBe(0o444)
        expect(await Bun.file(path.join(root, '.collections', COLLECTION, 'heads')).exists()).toBe(
            false
        )
        expect(
            await Bun.file(path.join(root, '.collections', COLLECTION, 'versions')).exists()
        ).toBe(false)
        expect(await Bun.file(path.join(root, '.fylo-vcs')).exists()).toBe(false)

        const stored = await fylo[COLLECTION].get(id).once()
        expect(stored[id].title).toBe('Retain me')
    })

    test('rejects patch, versioned put, and delete after first write', async () => {
        const id = await fylo[COLLECTION].put({ title: 'Locked' })

        await expect(fylo[COLLECTION].patch(id, { title: 'Changed' })).rejects.toThrow(
            'Update is not allowed in WORM mode'
        )
        await expect(fylo[COLLECTION].put({ [id]: { title: 'Changed' } })).rejects.toThrow(
            'Update is not allowed in WORM mode'
        )
        await expect(fylo[COLLECTION].delete(id)).rejects.toThrow(
            'Delete is not allowed in WORM mode'
        )
        await expect(fylo[COLLECTION].restore(id)).rejects.toThrow(
            'Restore is not allowed in WORM mode'
        )
        await expect(fylo[COLLECTION].drop()).rejects.toThrow(
            'Drop is not allowed for a non-empty WORM collection'
        )

        const stored = await fylo[COLLECTION].get(id).once()
        expect(stored[id].title).toBe('Locked')
    })

    test('explicitly rejects metadata and rekey mutations', async () => {
        const documentId = await fylo[COLLECTION].put({ title: 'Metadata stays fixed' })
        await expect(
            fylo[COLLECTION].put(documentId).metadata({ owner: 'changed' })
        ).rejects.toThrow('Metadata update is not allowed in WORM mode')
        expect(await fylo[COLLECTION].get(documentId).metadata()).toMatchObject({ id: documentId })

        const files = 'worm-files'
        await fylo[files].create({ kind: 'file' })
        const fileId = await fylo[files].put(new File(['fixed'], 'fixed.txt'), {
            key: '/fixed.txt',
            meta: { retention: 'locked' }
        })
        await expect(fylo[files].put(fileId).metadata({ retention: 'changed' })).rejects.toThrow(
            'Metadata update is not allowed in WORM mode'
        )
        await expect(fylo[files].rekey(fileId, '/moved.txt')).rejects.toThrow(
            'Rekey is not allowed in WORM mode'
        )
        expect(await fylo[files].get(fileId).metadata()).toMatchObject({ retention: 'locked' })
        expect((await fylo[files].get(fileId).once())[fileId].key).toBe('/fixed.txt')
    })

    test('fails closed when legacy version-history metadata is present', async () => {
        const legacyCollection = 'legacy-worm'
        const headRoot = path.join(root, '.collections', legacyCollection, 'heads')
        await mkdir(headRoot, { recursive: true })
        await writeFile(path.join(headRoot, 'legacy.json'), '{}')

        await expect(fylo[legacyCollection].create()).rejects.toThrow(
            'unsupported legacy WORM heads metadata'
        )
    })
})
