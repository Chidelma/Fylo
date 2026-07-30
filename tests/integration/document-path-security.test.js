import { afterAll, describe, expect, test } from 'bun:test'
import { shardOf } from '../../src/core/doc-id.js'
import { mkdir, readFile, rm, rmdir, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import Fylo from '../../src/index.js'
import { getXattr } from '../../src/storage/xattr.js'
import { VersionRepository } from '../../src/versioning/repository.js'
import { createTestRoot } from '../helpers/root.js'

const root = await createTestRoot('fylo-document-path-security-')
const outside = await createTestRoot('fylo-document-path-outside-')

afterAll(async () => {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
})

describe('document path security', () => {
    test('read, write, metadata, and versioning reject a symlinked shard directory', async () => {
        const fylo = new Fylo(root, { versioning: { autoCommit: false } })
        await fylo.documents.create()
        const id = await Fylo.uniqueTTID()
        const outsideTarget = path.join(outside, `${id}.json`)
        const sentinel = '{"outside":"unchanged"}'
        await writeFile(outsideTarget, sentinel)

        const docsRoot = path.join(root, '.collections', 'documents', 'docs')
        await mkdir(docsRoot, { recursive: true })
        await symlink(outside, path.join(docsRoot, shardOf(id)), 'junction')

        await expect(fylo.documents.get(id).once()).rejects.toThrow(/symbolic link|reparse point/)
        await expect(
            Promise.resolve(fylo.documents.put(id, { outside: 'overwritten' }))
        ).rejects.toThrow(/symbolic link|reparse point/)
        expect(await fylo.engine.transactions.state('documents')).toMatchObject({
            state: 'stable'
        })
        await expect(fylo.documents.put(id).metadata({ owner: 'attacker' })).rejects.toThrow(
            /symbolic link|reparse point/
        )
        await expect(new VersionRepository(root).commit('must not follow links')).rejects.toThrow(
            /symbolic link/
        )

        expect(await readFile(outsideTarget, 'utf8')).toBe(sentinel)
        expect(getXattr(outsideTarget, 'user.fylo.meta.owner')).toBeNull()

        const shardLink = path.join(docsRoot, shardOf(id))
        if (process.platform === 'win32') await rmdir(shardLink)
        else await rm(shardLink)
        await fylo.documents.put(id, { inside: 'retry-succeeded' })
        expect((await fylo.documents.get(id).once())[id]).toEqual({
            inside: 'retry-succeeded'
        })
        expect(await readFile(outsideTarget, 'utf8')).toBe(sentinel)
    })
})
