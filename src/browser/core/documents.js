import TTID from '../vendor/ttid.mjs'
import { legacyShardOf } from '../../core/shard.js'
import { assertPathInside, basename, join } from './path.js'

/**
 * @typedef {string} TTIDValue
 * @typedef {import('./filesystem.js').FyloFilesystem} FyloFilesystem
 * @typedef {object} StoredDocRecord
 * @property {TTIDValue} id
 * @property {number} createdAt
 * @property {number} updatedAt
 * @property {Record<string, any>} data
 * @typedef {object} DeletedDocRecord
 * @property {TTIDValue} id
 * @property {number} createdAt
 * @property {number} deletedAt
 * @property {Record<string, any>} data
 */

/**
 * Browser implementation of the canonical per-document
 * disk layout (`docs/<bucket>/<id>.json`, `.deleted/<bucket>/<id>.json`) but
 * stores `deletedAt` inside the tombstone JSON body rather than setting file
 * `mtime` — OPFS exposes `lastModified` but cannot set it explicitly.
 * Active document bodies stay pure user JSON to preserve FYLO's normal
 * per-document storage format.
 *
 * `move()` is best-effort. If a host (e.g. Firefox OPFS without
 * `FileSystemFileHandle.move()`) implements move as copy-then-delete, a
 * delete-side failure leaves a duplicate. `readStoredDoc` and `readDeletedDoc`
 * tolerate that case: if both copies exist, the live copy is the source of
 * truth and the orphan tombstone is reconciled on the next write.
 */
export class BrowserDocuments {
    /**
     * @param {FyloFilesystem} fs
     * @param {(collection: string) => string} docsRoot
     * @param {(collection: string, docId: TTIDValue) => string} docPath
     * @param {(collection: string) => string} deletedRoot
     * @param {(collection: string, docId: TTIDValue) => string} deletedPath
     * @param {(collection: string) => Promise<void>} ensureCollection
     */
    constructor(fs, docsRoot, docPath, deletedRoot, deletedPath, ensureCollection) {
        this.fs = fs
        this.docsRoot = docsRoot
        this.docPath = docPath
        this.deletedRoot = deletedRoot
        this.deletedPath = deletedPath
        this.ensureCollection = ensureCollection
    }

    /**
     * @param {TTIDValue} docId
     */
    validateDocId(docId) {
        if (!TTID.isTTID(docId)) throw new Error(`Invalid document ID: ${docId}`)
    }

    /**
     * @param {string} collection
     * @param {TTIDValue} docId
     * @returns {Promise<StoredDocRecord | null>}
     */
    async readStoredDoc(collection, docId) {
        this.validateDocId(docId)
        const root = this.docsRoot(collection)
        const target = await this.existingPath(root, this.docPath(collection, docId), docId)
        assertPathInside(root, target)
        if (!(await this.fs.exists(target))) return null
        const text = await this.fs.readText(target)
        const raw = this.parseJsonDocumentText(text)
        const { createdAt } = TTID.decodeTime(docId)
        return {
            id: docId,
            createdAt,
            updatedAt: await this.fs.mtimeMs(target),
            data: stripInternalFields(raw)
        }
    }

    /**
     * @param {string} collection
     * @param {TTIDValue} docId
     * @returns {Promise<DeletedDocRecord | null>}
     */
    async readDeletedDoc(collection, docId) {
        this.validateDocId(docId)
        const root = this.deletedRoot(collection)
        const target = await this.existingPath(root, this.deletedPath(collection, docId), docId)
        assertPathInside(root, target)
        if (!(await this.fs.exists(target))) return null
        const text = await this.fs.readText(target)
        const raw = this.parseJsonDocumentText(text)
        const { createdAt } = TTID.decodeTime(docId)
        return {
            id: docId,
            createdAt,
            deletedAt: typeof raw._deletedAt === 'number' ? raw._deletedAt : createdAt,
            data: stripInternalFields(raw)
        }
    }

    /**
     * @template {Record<string, any>} T
     * @param {string} collection
     * @param {TTIDValue} docId
     * @param {T} data
     * @returns {Promise<void>}
     */
    async writeStoredDoc(collection, docId, data) {
        this.validateDocId(docId)
        await this.ensureCollection(collection)
        const target = this.docPath(collection, docId)
        assertPathInside(this.docsRoot(collection), target)
        const text = JSON.stringify(data)
        this.assertJsonDocumentText(text)
        await this.fs.writeText(target, text)
        await this.removeLegacyCopy(this.docsRoot(collection), target, docId)
        // Reconcile any orphan tombstone so the live copy wins.
        const tombstone = this.deletedPath(collection, docId)
        if (await this.fs.exists(tombstone)) await this.fs.remove(tombstone)
        await this.removeLegacyCopy(this.deletedRoot(collection), tombstone, docId)
    }

    /**
     * @param {string} collection
     * @param {TTIDValue} docId
     * @returns {Promise<void>}
     */
    async removeStoredDoc(collection, docId) {
        this.validateDocId(docId)
        const root = this.docsRoot(collection)
        const target = await this.existingPath(root, this.docPath(collection, docId), docId)
        assertPathInside(root, target)
        if (await this.fs.exists(target)) await this.fs.remove(target)
    }

    /**
     * @param {string} collection
     * @param {TTIDValue} docId
     * @param {number} deletedAt
     * @returns {Promise<string>}
     */
    async softDeleteStoredDoc(collection, docId, deletedAt) {
        this.validateDocId(docId)
        const source = await this.existingPath(
            this.docsRoot(collection),
            this.docPath(collection, docId),
            docId
        )
        const target = this.deletedPath(collection, docId)
        assertPathInside(this.docsRoot(collection), source)
        assertPathInside(this.deletedRoot(collection), target)
        if (!(await this.fs.exists(source))) {
            throw new Error(`Document not found: ${docId}`)
        }
        const sourceText = await this.fs.readText(source)
        const raw = this.parseJsonDocumentText(sourceText)
        const stamped = { ...raw, _deletedAt: deletedAt }
        const tombstoneText = JSON.stringify(stamped)
        this.assertJsonDocumentText(tombstoneText)
        // Write tombstone first; a failure here leaves the live copy intact.
        await this.fs.writeText(target, tombstoneText)
        await this.fs.remove(source)
        return target
    }

    /**
     * @param {string} collection
     * @param {TTIDValue} docId
     * @param {number} _restoredAt
     * @returns {Promise<string>}
     */
    async restoreStoredDoc(collection, docId, _restoredAt) {
        this.validateDocId(docId)
        const source = await this.existingPath(
            this.deletedRoot(collection),
            this.deletedPath(collection, docId),
            docId
        )
        const target = this.docPath(collection, docId)
        assertPathInside(this.deletedRoot(collection), source)
        assertPathInside(this.docsRoot(collection), target)
        if (!(await this.fs.exists(source))) {
            throw new Error(`No tombstone to restore: ${docId}`)
        }
        const sourceText = await this.fs.readText(source)
        const raw = this.parseJsonDocumentText(sourceText)
        const restoredText = JSON.stringify(stripInternalFields(raw))
        this.assertJsonDocumentText(restoredText)
        await this.fs.writeText(target, restoredText)
        await this.fs.remove(source)
        return target
    }

    /**
     * No-op in the browser runtime — OPFS has no concept of file permissions.
     * Strict WORM still rejects every write/delete at the engine layer.
     *
     * @param {string} _collection
     * @param {TTIDValue} _docId
     * @returns {Promise<void>}
     */
    async makeStoredDocReadOnly(_collection, _docId) {
        // intentionally empty
    }

    /**
     * Resolve a record written before ADR 0006 without changing the root.
     * New writes always use `canonical`; a later mutation removes the old copy.
     *
     * @param {string} root
     * @param {string} canonical
     * @param {TTIDValue} docId
     * @returns {Promise<string>}
     */
    async existingPath(root, canonical, docId) {
        if (await this.fs.exists(canonical)) return canonical
        const legacy = join(root, legacyShardOf(docId), `${docId}.json`)
        assertPathInside(root, legacy)
        return legacy !== canonical && (await this.fs.exists(legacy)) ? legacy : canonical
    }

    /** @param {string} root @param {string} canonical @param {TTIDValue} docId */
    async removeLegacyCopy(root, canonical, docId) {
        const legacy = join(root, legacyShardOf(docId), `${docId}.json`)
        assertPathInside(root, legacy)
        if (legacy !== canonical && (await this.fs.exists(legacy))) await this.fs.remove(legacy)
    }

    /**
     * @param {string} text
     */
    assertJsonDocumentText(text) {
        const raw = JSON.parse(text)
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            throw new Error('FYLO document body must be a JSON object')
        }
    }

    /**
     * @param {string} text
     * @returns {Record<string, any>}
     */
    parseJsonDocumentText(text) {
        const raw = JSON.parse(text)
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            throw new Error('FYLO document body must be a JSON object')
        }
        return /** @type {Record<string, any>} */ (raw)
    }

    /**
     * Lists every document id under the docs tree. Walks `<docsRoot>/<bucket>/`
     * because the on-disk layout shards by TTID-prefix bucket.
     *
     * @param {string} collection
     * @returns {Promise<TTIDValue[]>}
     */
    async listDocIds(collection) {
        return await listBucketedDocIds(this.fs, this.docsRoot(collection))
    }

    /**
     * @param {string} collection
     * @returns {Promise<TTIDValue[]>}
     */
    async listDeletedDocIds(collection) {
        return await listBucketedDocIds(this.fs, this.deletedRoot(collection))
    }
}

/**
 * @param {Record<string, any>} raw
 * @returns {Record<string, any>}
 */
function stripInternalFields(raw) {
    const out = { ...raw }
    delete out._updatedAt
    delete out._deletedAt
    return out
}

/**
 * Walks `<root>/<bucket>/<id>.json` and returns the TTIDs. Missing roots
 * yield an empty array (matches the server behaviour where `listDocIds` of an
 * unknown collection returns `[]`).
 *
 * @param {FyloFilesystem} fs
 * @param {string} root
 * @returns {Promise<string[]>}
 */
async function listBucketedDocIds(fs, root) {
    if (!(await fs.exists(root))) return []
    const ids = []
    const buckets = await fs.list(root)
    for (const bucket of buckets) {
        const bucketPath = join(root, bucket)
        if (!(await fs.isDirectory(bucketPath))) continue
        const files = await fs.list(bucketPath)
        for (const file of files) {
            if (!file.endsWith('.json')) continue
            const id = basename(file).slice(0, -'.json'.length)
            if (TTID.isTTID(id)) ids.push(id)
        }
    }
    return ids
}
