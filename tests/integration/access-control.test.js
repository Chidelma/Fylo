import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { shardOf } from '../../src/core/doc-id.js'
import { rm, stat } from 'node:fs/promises'
import path from 'node:path'
import Fylo, { FyloPermissionError } from '../../src/index.js'
import { descriptorAllows } from '../../src/security/access.js'
import { VersionRepository } from '../../src/versioning/repository.js'
import { createTestRoot } from '../helpers/root.js'

const root = await createTestRoot('fylo-access-control-')
const uid = process.getuid?.()
const otherUid = uid === undefined ? undefined : uid + 1
const outsiderUid = uid === undefined ? undefined : uid + 2
const gid = process.getgroups?.()[0] ?? process.getgid?.()
const fylo = new Fylo(root, {
    versioning: { autoCommit: false },
    access: {
        groupsForUid(actorUid) {
            return (actorUid === uid || actorUid === otherUid) && gid !== undefined ? [gid] : []
        }
    }
})

function documentPath(collection, id) {
    return path.join(root, '.collections', collection, 'docs', shardOf(id), `${id}.json`)
}

describe.skipIf(uid === undefined)('per-document POSIX access control', () => {
    beforeAll(async () => {
        await fylo.documents.create()
        await fylo.files.create({ kind: 'file' })
    })

    afterAll(async () => {
        await rm(root, { recursive: true, force: true })
    })

    test('put.as applies UID and mode and get.as returns the document', async () => {
        const id = await fylo.documents.put({ title: 'private' }).as({ uid, mode: 0o600 })

        const metadata = await stat(documentPath('documents', id))
        expect(metadata.uid).toBe(uid)
        expect(metadata.mode & 0o777).toBe(0o600)
        expect(await fylo.documents.get(id).as({ uid })).toEqual({
            [id]: { title: 'private' }
        })
    })

    test('uid-only put defaults to owner read/write and protects later operations', async () => {
        const id = await fylo.documents.put({ title: 'owner only' }).as({ uid })

        expect((await stat(documentPath('documents', id))).mode & 0o777).toBe(0o600)
        await expect(
            Promise.resolve(fylo.documents.get(id).as({ uid: otherUid }))
        ).rejects.toBeInstanceOf(FyloPermissionError)
        await expect(fylo.documents.get(id).once()).rejects.toBeInstanceOf(FyloPermissionError)
        await expect(
            Promise.resolve(fylo.documents.patch(id, { title: 'denied' }).as({ uid: otherUid }))
        ).rejects.toBeInstanceOf(FyloPermissionError)
        await expect(
            Promise.resolve(fylo.documents.delete(id).as({ uid: otherUid }))
        ).rejects.toBeInstanceOf(FyloPermissionError)

        await fylo.documents.patch(id, { title: 'updated' }).as({ uid })
        expect(await fylo.documents.get(id).as({ uid })).toEqual({
            [id]: { title: 'updated' }
        })
    })

    test('gid-only put keeps the native owner and grants group members write access', async () => {
        const id = await fylo.documents.put({ title: 'team draft' }).as({ gid, mode: 0o660 })
        const target = documentPath('documents', id)
        const native = await stat(target)

        expect(native.uid).toBe(uid)
        expect(native.gid).toBe(gid)
        expect(native.mode & 0o777).toBe(0o660)
        expect(await fylo.documents.get(id).as({ uid: otherUid })).toEqual({
            [id]: { title: 'team draft' }
        })

        await fylo.documents.patch(id, { title: 'team update' }).as({ uid: otherUid })
        expect(await fylo.documents.get(id).as({ uid })).toEqual({
            [id]: { title: 'team update' }
        })
        await expect(
            Promise.resolve(fylo.documents.delete(id).as({ uid: outsiderUid }))
        ).rejects.toBeInstanceOf(FyloPermissionError)
        await fylo.documents.delete(id).as({ uid: otherUid })
    })

    test('uid and gid can be assigned together while mode controls each class', async () => {
        const id = await fylo.documents
            .put({ title: 'owned team record' })
            .as({ uid, gid, mode: 0o640 })

        expect(await fylo.documents.get(id).as({ uid })).toEqual({
            [id]: { title: 'owned team record' }
        })
        expect(await fylo.documents.get(id).as({ uid: otherUid })).toEqual({
            [id]: { title: 'owned team record' }
        })
        await expect(
            Promise.resolve(
                fylo.documents.patch(id, { title: 'group denied' }).as({ uid: otherUid })
            )
        ).rejects.toBeInstanceOf(FyloPermissionError)
    })

    test('mode-only put protects the native owner and group projection', async () => {
        const id = await fylo.documents.put({ title: 'native owner' }).as({ mode: 0o600 })
        const native = await stat(documentPath('documents', id))
        const metadata = await fylo.documents.get(id).as({ uid }).metadata()

        expect(metadata).toMatchObject({
            uid: native.uid,
            gid: native.gid,
            mode: 0o600
        })
        await expect(
            Promise.resolve(fylo.documents.get(id).as({ uid: otherUid }))
        ).rejects.toBeInstanceOf(FyloPermissionError)
    })

    test('group membership never overrides owner precedence or missing group bits', async () => {
        expect(
            descriptorAllows({ version: 1, uid, gid, mode: 0o040 }, uid, new Set([gid]), 'read')
        ).toBe(false)

        const groupWithoutWrite = await fylo.documents
            .put({ title: 'group read only' })
            .as({ gid, mode: 0o640 })
        await expect(
            Promise.resolve(
                fylo.documents.patch(groupWithoutWrite, { title: 'denied' }).as({ uid: otherUid })
            )
        ).rejects.toBeInstanceOf(FyloPermissionError)
    })

    test('other mode bits permit non-owner reads without granting writes', async () => {
        const id = await fylo.documents.put({ title: 'shared' }).as({ uid, mode: 0o604 })

        expect(await fylo.documents.get(id).as({ uid: outsiderUid })).toEqual({
            [id]: { title: 'shared' }
        })
        expect(await fylo.documents.get(id).once()).toEqual({ [id]: { title: 'shared' } })
        await expect(
            Promise.resolve(fylo.documents.patch(id, { title: 'denied' }).as({ uid: outsiderUid }))
        ).rejects.toBeInstanceOf(FyloPermissionError)
    })

    test('records written without as remain open', async () => {
        const id = await fylo.documents.put({ title: 'open' })

        await fylo.documents.patch(id, { title: 'open update' }).as({ uid: otherUid })
        expect(await fylo.documents.get(id).as({ uid: otherUid })).toEqual({
            [id]: { title: 'open update' }
        })
        await fylo.documents.delete(id).as({ uid: otherUid })
        expect(await fylo.documents.get(id).once()).toEqual({})
    })

    test('mode is rejected outside put operations', async () => {
        const id = await fylo.documents.put({ title: 'mode scope' }).as({ uid })

        await expect(
            Promise.resolve(fylo.documents.get(id).as({ uid, mode: 0o600 }))
        ).rejects.toThrow(/mode.*put/i)
        await expect(
            Promise.resolve(fylo.documents.patch(id, { title: 'no' }).as({ uid, mode: 0o600 }))
        ).rejects.toThrow(/mode.*put/i)
        await expect(
            Promise.resolve(fylo.documents.delete(id).as({ uid, mode: 0o600 }))
        ).rejects.toThrow(/mode.*put/i)
        await expect(
            Promise.resolve(
                fylo.documents.put(id).metadata({ owner: 'no' }).as({ uid, mode: 0o600 })
            )
        ).rejects.toThrow(/mode.*put/i)
        await expect(Promise.resolve(fylo.documents.get(id).as({ uid, gid }))).rejects.toThrow(
            /gid.*put/i
        )
        await expect(
            Promise.resolve(fylo.documents.put({ title: 'empty' }).as({}))
        ).rejects.toThrow(/at least one/i)
        await expect(
            Promise.resolve(fylo.documents.put({ title: 'invalid gid' }).as({ gid: -1 }))
        ).rejects.toThrow(/gid.*integer/i)
        await expect(fylo.sql`SELECT * FROM documents`.as({ gid })).rejects.toThrow(/gid.*INSERT/i)
    })

    test('owner can replace data and metadata while access remains record-scoped', async () => {
        const id = await fylo.documents.put({ title: 'before' }).as({ uid, mode: 0o600 })

        await expect(
            Promise.resolve(
                fylo.documents.put(id, { title: 'denied' }).as({ uid: otherUid, mode: 0o604 })
            )
        ).rejects.toBeInstanceOf(FyloPermissionError)

        await fylo.documents.put(id, { title: 'after' }).as({ uid, mode: 0o604 })
        await fylo.documents.put(id).metadata({ owner: 'developer' }).as({ uid })
        const metadata = await fylo.documents.get(id).as({ uid }).metadata()
        expect(metadata).toMatchObject({ owner: 'developer', uid, mode: 0o604 })
        expect(await fylo.documents.get(id).once()).toEqual({ [id]: { title: 'after' } })
    })

    test('raw files receive the same UID, mode, and read enforcement', async () => {
        const id = await fylo.files
            .put(new File(['private bytes'], 'private.txt', { type: 'text/plain' }))
            .as({ uid, mode: 0o600 })
        const target = path.join(root, '.buckets', 'files', 'docs', shardOf(id), `${id}.txt`)
        const metadata = await stat(target)

        expect(metadata.uid).toBe(uid)
        expect(metadata.mode & 0o777).toBe(0o600)
        expect(new TextDecoder().decode(await fylo.files.get(id).as({ uid }).bytes())).toBe(
            'private bytes'
        )
        await expect(fylo.files.get(id).as({ uid: otherUid }).bytes()).rejects.toBeInstanceOf(
            FyloPermissionError
        )

        const groupId = await fylo.files
            .put(new File(['team bytes'], 'team.txt', { type: 'text/plain' }))
            .as({ gid, mode: 0o660 })
        expect(
            new TextDecoder().decode(await fylo.files.get(groupId).as({ uid: otherUid }).bytes())
        ).toBe('team bytes')
        await fylo.files.delete(groupId).as({ uid: otherUid })
    })

    test('find and SQL omit records that the caller cannot read', async () => {
        const openId = await fylo.documents.put({ scope: 'query-access', value: 'open' })
        const privateId = await fylo.documents
            .put({ scope: 'query-access', value: 'private' })
            .as({ uid, mode: 0o600 })
        const sharedId = await fylo.documents
            .put({ scope: 'query-access', value: 'shared' })
            .as({ uid, mode: 0o604 })
        const query = { $ops: [{ scope: { $eq: 'query-access' } }] }

        const anonymous = await Array.fromAsync(fylo.documents.find(query).collect())
        expect(anonymous.some((entry) => Object.hasOwn(entry, openId))).toBe(true)
        expect(anonymous.some((entry) => Object.hasOwn(entry, sharedId))).toBe(true)
        expect(anonymous.some((entry) => Object.hasOwn(entry, privateId))).toBe(false)

        const owner = await Array.fromAsync(fylo.documents.find(query).as({ uid }).collect())
        expect(owner.some((entry) => Object.hasOwn(entry, privateId))).toBe(true)

        const sql = /** @type {Record<string, any>} */ (
            await fylo._sql("SELECT * FROM documents WHERE scope = 'query-access'")
        )
        expect(Object.hasOwn(sql, openId)).toBe(true)
        expect(Object.hasOwn(sql, sharedId)).toBe(true)
        expect(Object.hasOwn(sql, privateId)).toBe(false)
    })

    test('SQL binds UID to SELECT/UPDATE/DELETE and mode only to INSERT', async () => {
        const id = await fylo.sql`
            INSERT INTO documents (scope, title)
            VALUES (${'sql-access'}, ${'private SQL'})
        `.as({ uid, mode: 0o600 })
        const target = documentPath('documents', id)
        expect((await stat(target)).mode & 0o777).toBe(0o600)

        const anonymous = /** @type {Record<string, any>} */ (
            await fylo.sql`SELECT * FROM documents WHERE scope = ${'sql-access'}`
        )
        expect(Object.hasOwn(anonymous, id)).toBe(false)
        const owner = /** @type {Record<string, any>} */ (
            await fylo.sql`SELECT * FROM documents WHERE scope = ${'sql-access'}`.as({ uid })
        )
        expect(owner[id].title).toBe('private SQL')

        expect(
            await fylo.sql`
                UPDATE documents SET title = ${'updated SQL'}
                WHERE scope = ${'sql-access'}
            `.as({ uid })
        ).toBe(1)
        await expect(
            fylo.sql`UPDATE documents SET title = ${'denied'} WHERE scope = ${'sql-access'}`.as({
                uid,
                mode: 0o600
            })
        ).rejects.toThrow(/mode.*INSERT/i)

        expect(
            await fylo.sql`DELETE FROM documents WHERE scope = ${'sql-access'}`.as({ uid })
        ).toBe(1)
        expect(await fylo.documents.get(id).once()).toEqual({})

        const groupId = await fylo.sql`
            INSERT INTO documents (scope, title)
            VALUES (${'sql-group-access'}, ${'group SQL'})
        `.as({ gid, mode: 0o660 })
        expect(await fylo.documents.get(groupId).as({ uid: otherUid })).toEqual({
            [groupId]: { scope: 'sql-group-access', title: 'group SQL' }
        })
        expect(
            await fylo.sql`
                UPDATE documents SET title = ${'group SQL updated'}
                WHERE scope = ${'sql-group-access'}
            `.as({ uid: otherUid })
        ).toBe(1)
    })

    test('group resolver failures fail closed', async () => {
        const resolverRoot = await createTestRoot('fylo-access-resolver-')
        const resolverFailure = new Error('identity provider unavailable')
        const db = new Fylo(resolverRoot, {
            versioning: { autoCommit: false },
            access: {
                groupsForUid() {
                    throw resolverFailure
                }
            }
        })
        try {
            await db.documents.create()
            const id = await db.documents.put({ title: 'protected' }).as({ gid, mode: 0o660 })
            await expect(Promise.resolve(db.documents.get(id).as({ uid: otherUid }))).rejects.toBe(
                resolverFailure
            )
        } finally {
            await db.close()
            await rm(resolverRoot, { recursive: true, force: true })
        }
    })

    test('patch preserves protected ownership and mode, and the owner can delete', async () => {
        const id = await fylo.documents.put({ title: 'preserve access' }).as({ uid, mode: 0o604 })

        await fylo.documents.patch(id, { title: 'still protected' }).as({ uid })
        const metadata = await stat(documentPath('documents', id))
        expect(metadata.uid).toBe(uid)
        expect(metadata.mode & 0o777).toBe(0o604)

        await fylo.documents.delete(id).as({ uid })
        expect(await fylo.documents.get(id).once()).toEqual({})

        await expect(
            Promise.resolve(fylo.documents.restore(id).as({ uid: otherUid }))
        ).rejects.toBeInstanceOf(FyloPermissionError)
        await fylo.documents.restore(id).as({ uid })
        expect(await fylo.documents.latest(id).as({ uid })).toEqual({
            [id]: { title: 'still protected' }
        })
    })

    test('folder and export omit records the caller cannot read', async () => {
        const openFileId = await fylo.files.put(
            new File(['open'], 'open-listing.txt', { type: 'text/plain' })
        )
        const privateFileId = await fylo.files
            .put(new File(['private'], 'private-listing.txt', { type: 'text/plain' }))
            .as({ uid })
        const openDocId = await Fylo.uniqueTTID()
        const privateDocId = await Fylo.uniqueTTID()
        await fylo.documents.put(openDocId, { exportScope: 'open' })
        await fylo.documents.put(privateDocId, { exportScope: 'private' }).as({ uid })

        const anonymousFolder = await fylo.files.folder('/')
        expect(Object.hasOwn(anonymousFolder.files, openFileId)).toBe(true)
        expect(Object.hasOwn(anonymousFolder.files, privateFileId)).toBe(false)
        const ownerFolder = await fylo.files.folder('/').as({ uid })
        expect(Object.hasOwn(ownerFolder.files, privateFileId)).toBe(true)

        const anonymousExport = await Array.fromAsync(fylo.documents.export())
        expect(anonymousExport.some((doc) => doc.exportScope === 'open')).toBe(true)
        expect(anonymousExport.some((doc) => doc.exportScope === 'private')).toBe(false)
        const ownerExport = await Array.fromAsync(fylo.documents.export().as({ uid }))
        expect(ownerExport.some((doc) => doc.exportScope === 'private')).toBe(true)
    })

    test('version restore reapplies the protected UID and mode', async () => {
        const versionRoot = await createTestRoot('fylo-access-version-')
        try {
            const db = new Fylo(versionRoot)
            const repo = new VersionRepository(versionRoot)
            await db.documents.create()
            const id = await Fylo.uniqueTTID()
            await db.documents.put(id, { title: 'versioned private' }).as({ uid, mode: 0o640 })
            const [head] = await repo.log({ limit: 1 })

            await db.documents.delete(id).as({ uid })
            await repo.restoreCommit(head.id)

            const restored = new Fylo(versionRoot, { versioning: { autoCommit: false } })
            const target = path.join(
                versionRoot,
                '.collections',
                'documents',
                'docs',
                shardOf(id),
                `${id}.json`
            )
            const info = await stat(target)
            expect(info.uid).toBe(uid)
            expect(info.mode & 0o777).toBe(0o640)
            expect(await restored.documents.get(id).as({ uid })).toEqual({
                [id]: { title: 'versioned private' }
            })
        } finally {
            await rm(versionRoot, { recursive: true, force: true })
        }
    })
})
