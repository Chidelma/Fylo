import TTID from '../vendor/ttid.mjs'
import { legacyShardOf, shardOf } from '../../core/shard.js'
import { copySafeJson, safeRecord } from '../../query/safe-record.js'
import { assertPathInside, join } from './path.js'

/** @typedef {import('./filesystem.js').FyloFilesystem} FyloFilesystem */

const META_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const MAX_META_VALUE_BYTES = 60 * 1024

/** @param {Record<string, any>} record */
export function validateMetadataRecord(record) {
    if (typeof record !== 'object' || record === null || Array.isArray(record)) {
        throw new Error('Metadata must be a plain object of name/value pairs')
    }
    for (const [name, value] of Object.entries(record)) {
        if (!META_NAME.test(name)) {
            throw new Error(
                'Metadata name must be 1-64 characters: letters, digits, ".", "_" or "-", starting with a letter or digit'
            )
        }
        if (value !== null) {
            const encoded = JSON.stringify(value)
            if (encoded === undefined) throw new Error('Metadata values must be JSON-serializable')
            if (new TextEncoder().encode(encoded).byteLength > MAX_META_VALUE_BYTES) {
                throw new Error('Metadata values must be at most 60 KiB when JSON-encoded')
            }
        }
    }
}

/**
 * Browser metadata is deliberately an internal sidecar, not user document data
 * or index payload. It is the OPFS equivalent of the filesystem xattr adapter.
 */
export class BrowserMetadataStore {
    /**
     * @param {FyloFilesystem} fs
     * @param {(collection: string) => string} collectionRoot
     */
    constructor(fs, collectionRoot) {
        this.fs = fs
        this.collectionRoot = collectionRoot
    }

    /** @param {string} collection */
    root(collection) {
        return join(this.collectionRoot(collection), '.metadata')
    }

    /** @param {string} collection @param {string} id */
    path(collection, id) {
        if (!TTID.isTTID(id)) throw new Error(`Invalid document ID: ${id}`)
        const root = this.root(collection)
        const target = join(root, shardOf(id), `${id}.json`)
        assertPathInside(root, target)
        return target
    }

    /** @param {string} collection @param {string} id */
    async read(collection, id) {
        const target = this.path(collection, id)
        if (!(await this.fs.exists(target))) return { values: safeRecord(), updatedAt: 0 }
        const parsed = JSON.parse(await this.fs.readText(target))
        return {
            values:
                parsed && typeof parsed.values === 'object' && !Array.isArray(parsed.values)
                    ? copySafeJson(parsed.values)
                    : safeRecord(),
            updatedAt: typeof parsed?.updatedAt === 'number' ? parsed.updatedAt : 0
        }
    }

    /** @param {string} collection @param {string} id @param {Record<string, any>} mutations */
    async mutate(collection, id, mutations) {
        validateMetadataRecord(mutations)
        const current = await this.read(collection, id)
        const values = copySafeJson(current.values)
        for (const [name, value] of Object.entries(mutations)) {
            if (value === null) delete values[name]
            else values[name] = copySafeJson(value)
        }
        return await this.write(collection, id, values, Math.max(Date.now(), current.updatedAt + 1))
    }

    /** @param {string} collection @param {string} id @param {Record<string, any>} values @param {number} updatedAt */
    async write(collection, id, values, updatedAt) {
        const target = this.path(collection, id)
        await this.fs.mkdir(join(this.root(collection), shardOf(id)), { recursive: true })
        await this.fs.writeText(target, JSON.stringify({ values, updatedAt }))
        return { values, updatedAt }
    }
}
