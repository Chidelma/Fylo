import path from 'node:path'
import { utimesSync } from 'node:fs'
import { lstat, realpath } from 'node:fs/promises'
import TTID from '../vendor/ttid.js'
import { assertPathInside, validateDocId } from '../core/doc-id.js'
import { DEFAULT_SHARD_WIDTH, legacyShardOf, shardOf } from '../core/shard.js'
import {
    rawFileContentType,
    rawFileExtension,
    rawFileId,
    rawFileKey,
    rawFileMetadata
} from '../core/raw-file.js'
import { getXattr, listXattr, setXattr } from './xattr.js'

/** Extended attribute holding the raw file's durable object key. */
export const KEY_XATTR = 'user.fylo.key'
/**
 * Extended attribute caching `sha256:size:mtimeMs`. A derived accelerator,
 * never versioned: trusted while its (size, mtimeMs) stamp matches the file,
 * recomputed otherwise.
 */
export const CHECKSUM_XATTR = 'user.fylo.checksum'
/** Extended-attribute namespace for developer-defined document metadata. */
export const META_XATTR_PREFIX = 'user.fylo.meta.'
/** Internal last-write timestamp for metadata sync conflict resolution. */
export const META_UPDATED_XATTR = 'user.fylo.meta-updated-at'
/** Conservative cross-platform ceiling below Linux's per-xattr value limit. */
export const MAX_META_VALUE_BYTES = 60 * 1024

/**
 * @param {string} name
 * @returns {string}
 */
export function metaXattrName(name) {
    if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
        throw new Error(
            'Metadata name must be 1-64 characters: letters, digits, ".", "_" or "-", starting with a letter or digit'
        )
    }
    return `${META_XATTR_PREFIX}${name}`
}

/**
 * Metadata values are stored JSON-encoded so they round-trip typed
 * (strings, numbers, booleans, arrays, objects).
 * @param {unknown} value
 * @returns {string}
 */
export function encodeMetaValue(value) {
    const encoded = JSON.stringify(value)
    if (encoded === undefined) throw new Error('Metadata values must be JSON-serializable')
    if (new TextEncoder().encode(encoded).byteLength > MAX_META_VALUE_BYTES) {
        throw new Error('Metadata values must be at most 60 KiB when JSON-encoded')
    }
    return encoded
}

/**
 * @param {string} text
 * @returns {any} the decoded value; pre-JSON plain strings pass through as-is
 */
export function decodeMetaValue(text) {
    try {
        return JSON.parse(text)
    } catch {
        return text
    }
}

/**
 * Normalizes and validates a metadata record into xattr mutations.
 * `null` values mean "remove this entry".
 * @param {Record<string, any>} record
 * @returns {Array<[attr: string, encoded: string | null]>}
 */
export function metaMutations(record) {
    if (typeof record !== 'object' || record === null || Array.isArray(record)) {
        throw new Error('Metadata must be a plain object of name/value pairs')
    }
    return Object.entries(record).map(([name, value]) => [
        metaXattrName(name),
        value === null ? null : encodeMetaValue(value)
    ])
}

/**
 * @typedef {import('./types.js').StorageEngine} StorageEngine
 * @typedef {import('../core/raw-file.js').RawFileMetadata} RawFileMetadata
 *
 * @typedef {object} RawFileSource
 * @property {ReadableStream<Uint8Array>} stream
 * @property {string=} name
 * @property {string=} contentType
 * @property {number=} maxBytes
 * @property {string=} key
 * @property {Record<string, any>=} meta developer metadata written with the upload
 * @property {{ uid?: number, gid?: number, mode?: number }=} access protected-record owner, group, and mode
 *
 * @typedef {object} StoredRawFile
 * @property {string} id
 * @property {string} path
 * @property {number} createdAt
 * @property {number} updatedAt
 * @property {number=} deletedAt
 * @property {RawFileMetadata & { meta?: Record<string, string> }} data
 */

/**
 * Raw-file persistence for file collections. File bytes are never wrapped,
 * encoded, or rewritten; only the TTID-based filename is assigned by FYLO.
 */
export class FilesystemFiles {
    /**
     * @param {StorageEngine} storage
     * @param {(collection: string) => string} docsRoot
     * @param {(collection: string) => string} deletedRoot
     * @param {(collection: string) => Promise<void>} ensureCollection
     */
    constructor(storage, docsRoot, deletedRoot, ensureCollection, shardWidth) {
        this.storage = storage
        this.docsRoot = docsRoot
        this.deletedRoot = deletedRoot
        this.ensureCollection = ensureCollection
        // Raw files shard exactly as documents do, so the width has to come
        // from the same recorded descriptor rather than a second default.
        this.shardWidth = shardWidth ?? (() => DEFAULT_SHARD_WIDTH)
    }

    /**
     * @param {string} docId
     * @param {RawFileSource} source
     * @returns {{ extension: string, contentType: string, key: string }}
     */
    resolveMetadata(docId, source) {
        const extension = rawFileExtension(source.name, source.contentType)
        return {
            extension,
            contentType: rawFileContentType(extension, source.contentType),
            key: rawFileKey(source.key, docId, extension)
        }
    }

    /**
     * The durable object key lives in an extended attribute on the raw file
     * itself, so it travels with the bytes across moves (soft delete, restore).
     * @param {string} target
     * @param {string} docId
     * @returns {string}
     */
    readKey(target, docId) {
        const value = getXattr(target, KEY_XATTR)
        if (value === null) {
            throw new Error(`Raw file system metadata is missing: ${docId}`)
        }
        return new TextDecoder().decode(value)
    }

    /**
     * Re-stamps the default key (`/<filename>`) on a raw file whose xattr
     * metadata was stripped (copied without xattrs). Custom keys are not
     * recoverable from the bytes; the file becomes readable again at its
     * degraded default key.
     * @param {string} collection
     * @param {string} docId
     * @returns {Promise<string>}
     */
    async repairKey(collection, docId) {
        const target = await this.findPath(
            this.docsRoot(collection),
            docId,
            this.shardWidth(collection)
        )
        if (!target) throw new Error(`Raw file not found: ${docId}`)
        const key = `/${path.basename(target)}`
        setXattr(target, KEY_XATTR, key)
        return key
    }

    /**
     * Developer metadata xattrs as a plain record, or null when there are none.
     * @param {string} target
     * @returns {Record<string, string> | null}
     */
    readMeta(target) {
        /** @type {Record<string, any> | null} */
        let meta = null
        for (const name of listXattr(target)) {
            if (!name.startsWith(META_XATTR_PREFIX)) continue
            const value = getXattr(target, name)
            if (value === null) continue
            ;(meta ??= {})[name.slice(META_XATTR_PREFIX.length)] = decodeMetaValue(
                new TextDecoder().decode(value)
            )
        }
        return meta
    }

    /**
     * @param {string} root
     * @param {string} docId
     * @returns {Promise<string | null>}
     */
    async findPath(root, docId, width = DEFAULT_SHARD_WIDTH) {
        await validateDocId(docId)
        // A root written before ADR 0006 keeps its records under the leading
        // characters, so both candidates are searched.
        for (const shard of [shardOf(docId, width), legacyShardOf(docId)]) {
            const found = await this.findInShard(root, shard, docId)
            if (found) return found
        }
        return null
    }

    /**
     * @param {string} root
     * @param {string} shard
     * @param {string} docId
     * @returns {Promise<string | null>}
     */
    async findInShard(root, shard, docId) {
        const bucket = path.join(root, shard)
        let entries
        try {
            entries = await this.storage.list(bucket)
        } catch (err) {
            // Bucket directory doesn't exist yet (empty collection / unknown id).
            if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return null
            throw err
        }
        const matches = entries.filter((file) => {
            const filename = path.basename(file)
            return rawFileId(filename) === docId
        })
        if (matches.length > 1) {
            throw new Error(`Multiple raw files found for document ID: ${docId}`)
        }
        const target = matches[0]
        if (!target) return null
        assertPathInside(root, target)
        const metadata = await lstat(target)
        if (metadata.isSymbolicLink() || !metadata.isFile()) {
            throw new Error(`Raw file must be a regular, non-link file: ${docId}`)
        }
        const storageRoot = path.dirname(path.dirname(path.dirname(root)))
        const [canonicalStorageRoot, canonicalRoot, canonicalTarget] = await Promise.all([
            realpath(storageRoot),
            realpath(root),
            realpath(target)
        ])
        assertPathInside(canonicalStorageRoot, canonicalRoot)
        assertPathInside(canonicalRoot, canonicalTarget)
        return target
    }

    /**
     * @param {string} collection
     * @param {string} docId
     * @param {RawFileSource} source
     * @returns {Promise<StoredRawFile>}
     */
    async writeStoredFile(collection, docId, source) {
        await validateDocId(docId)
        await this.ensureCollection(collection)
        const { extension, contentType, key } = this.resolveMetadata(docId, source)
        const target = path.join(
            this.docsRoot(collection),
            shardOf(docId, this.shardWidth(collection)),
            `${docId}${extension}`
        )
        assertPathInside(this.docsRoot(collection), target)
        await this.storage.mkdir(path.dirname(target))
        const docsRoot = this.docsRoot(collection)
        const storageRoot = path.dirname(path.dirname(path.dirname(docsRoot)))
        const [canonicalStorageRoot, canonicalRoot, canonicalParent] = await Promise.all([
            realpath(storageRoot),
            realpath(docsRoot),
            realpath(path.dirname(target))
        ])
        assertPathInside(canonicalStorageRoot, canonicalRoot)
        assertPathInside(canonicalRoot, canonicalParent)
        try {
            const existing = await lstat(target)
            if (existing.isSymbolicLink() || !existing.isFile()) {
                throw new Error(`Raw file target must be a regular, non-link file: ${docId}`)
            }
        } catch (error) {
            if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error
        }
        // Validate metadata before any bytes hit disk.
        const mutations = source.meta ? metaMutations(source.meta) : []
        let written
        try {
            written = await this.storage.writeStream(target, source.stream, {
                maxBytes: source.maxBytes
            })
            setXattr(target, KEY_XATTR, key)
            for (const [attr, encoded] of mutations) {
                if (encoded !== null) setXattr(target, attr, encoded)
            }
            if (mutations.length > 0) setXattr(target, META_UPDATED_XATTR, String(Date.now()))
        } catch (error) {
            await this.storage.delete(target)
            throw error
        }
        const metadata = await this.storage.metadata(target)
        this.stampChecksum(target, written.checksumSHA256, metadata)
        const meta = this.readMeta(target)
        const { createdAt } = await TTID.decodeTime(docId)
        return {
            id: docId,
            path: target,
            createdAt,
            updatedAt: metadata.mtimeMs,
            data: {
                ...rawFileMetadata(
                    docId,
                    key,
                    extension,
                    contentType,
                    written.contentLength,
                    written.checksumSHA256,
                    createdAt,
                    metadata.mtimeMs
                ),
                ...(meta ? { meta } : {})
            }
        }
    }

    /**
     * @param {string} collection
     * @param {string} docId
     * @returns {Promise<StoredRawFile | null>}
     */
    async readStoredFile(collection, docId) {
        return await this.readFileAtRoot(collection, this.docsRoot(collection), docId)
    }

    /**
     * @param {string} collection
     * @param {string} docId
     * @returns {Promise<StoredRawFile | null>}
     */
    async readDeletedFile(collection, docId) {
        const stored = await this.readFileAtRoot(collection, this.deletedRoot(collection), docId)
        return stored ? { ...stored, deletedAt: stored.updatedAt } : null
    }

    /**
     * @param {string} collection
     * @param {string} root
     * @param {string} docId
     * @returns {Promise<StoredRawFile | null>}
     */
    async readFileAtRoot(collection, root, docId) {
        const target = await this.findPath(root, docId, this.shardWidth(collection))
        if (!target) return null
        try {
            const filename = path.basename(target)
            const extension = filename.slice(docId.length).toLowerCase()
            const metadata = await this.storage.metadata(target)
            const checksumSHA256 = await this.checksum(target, metadata)
            const key = this.readKey(target, docId)
            const meta = this.readMeta(target)
            const { createdAt } = await TTID.decodeTime(docId)
            return {
                id: docId,
                path: target,
                createdAt,
                updatedAt: metadata.mtimeMs,
                data: {
                    ...rawFileMetadata(
                        docId,
                        key,
                        extension,
                        rawFileContentType(extension, undefined),
                        metadata.size,
                        checksumSHA256,
                        createdAt,
                        metadata.mtimeMs
                    ),
                    ...(meta ? { meta } : {})
                }
            }
        } catch (err) {
            // File (or its metadata) vanished between listing and reading.
            if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return null
            throw err
        }
    }

    /**
     * Cached sha256 for reads and listings: trusts the checksum xattr while
     * its (size, mtimeMs) stamp matches the file, so materializing a manifest
     * doesn't re-read the full contents. Recomputes and best-effort re-stamps
     * on any mismatch (read-only WORM/soft-deleted files stay cold).
     *
     * A byte-tamper that preserves both size and mtime returns a stale hash
     * here; `verifyTarget` / `collection.verify()` is the stamp-ignoring
     * audit that catches it.
     *
     * @param {string} target
     * @param {{ size: number, mtimeMs: number }} metadata
     * @returns {Promise<string>}
     */
    async checksum(target, metadata) {
        const cached = getXattr(target, CHECKSUM_XATTR)
        if (cached !== null) {
            const [sha256, size, mtimeMs] = new TextDecoder().decode(cached).split(':')
            if (
                Number(size) === metadata.size &&
                Number(mtimeMs) === metadata.mtimeMs &&
                /^[0-9a-f]{64}$/.test(sha256)
            ) {
                return sha256
            }
        }
        const sha256 = await this.hash(target)
        try {
            this.stampChecksum(target, sha256, metadata)
        } catch {
            // Read-only target; recompute again next time.
        }
        return sha256
    }

    /**
     * @param {string} target
     * @param {string} sha256
     * @param {{ size: number, mtimeMs: number }} metadata
     * @returns {void}
     */
    stampChecksum(target, sha256, metadata) {
        setXattr(target, CHECKSUM_XATTR, `${sha256}:${metadata.size}:${metadata.mtimeMs}`)
        // On Windows an alternate-data-stream write updates the file's
        // last-write time, so writing this stamp invalidates the very mtime it
        // just recorded: the cache would never hit, every read would rehash the
        // whole file, and an index rebuild would derive a different
        // `lastModified` than the one indexed. Restoring the recorded time
        // makes the stamp self-consistent. A POSIX xattr write leaves mtime
        // alone, so this is a no-op there.
        const seconds = metadata.mtimeMs / 1000
        try {
            utimesSync(target, seconds, seconds)
        } catch {
            // Read-only target; the stamp is simply not cached.
        }
    }

    /**
     * Refreshes the checksum stamp after a metadata-only mtime change (soft
     * delete / restore moves); the bytes are unchanged so the hash is kept.
     * @param {string} target
     * @returns {Promise<void>}
     */
    async restampChecksum(target) {
        const cached = getXattr(target, CHECKSUM_XATTR)
        if (cached === null) return
        const [sha256] = new TextDecoder().decode(cached).split(':')
        if (!/^[0-9a-f]{64}$/.test(sha256)) return
        this.stampChecksum(target, sha256, await this.storage.metadata(target))
    }

    /**
     * Stamp-ignoring integrity check: re-hashes the full contents regardless
     * of the cached stamp and compares against the recorded claim. Matches
     * (and files with no usable claim) are freshly re-stamped best-effort;
     * a corrupt file's stamp is left untouched as the record of what the
     * contents should be.
     *
     * @param {string} target
     * @returns {Promise<{ status: 'verified' | 'stamped' | 'corrupt', expected: string | null, actual: string }>}
     */
    async verifyTarget(target) {
        const cached = getXattr(target, CHECKSUM_XATTR)
        const claimed = cached === null ? null : new TextDecoder().decode(cached).split(':')[0]
        const usableClaim = claimed !== null && /^[0-9a-f]{64}$/.test(claimed) ? claimed : null
        const actual = await this.hash(target)
        if (usableClaim !== null && usableClaim !== actual) {
            return { status: 'corrupt', expected: usableClaim, actual }
        }
        try {
            this.stampChecksum(target, actual, await this.storage.metadata(target))
        } catch {
            // Read-only target (WORM / soft-deleted); the verdict still stands.
        }
        return {
            status: usableClaim === null ? 'stamped' : 'verified',
            expected: usableClaim,
            actual
        }
    }

    /**
     * @param {string} target
     * @returns {Promise<string>}
     */
    async hash(target) {
        const hasher = new Bun.CryptoHasher('sha256')
        for await (const chunk of /** @type {AsyncIterable<Uint8Array>} */ (
            /** @type {unknown} */ (this.storage.readStream(target))
        )) {
            hasher.update(chunk)
        }
        return hasher.digest('hex')
    }

    /** @param {string} collection @returns {Promise<string[]>} */
    async listFileIds(collection) {
        const files = await this.storage.list(this.docsRoot(collection))
        return this.idsFromFiles(files)
    }

    /** @param {string} collection @returns {Promise<string[]>} */
    async listDeletedFileIds(collection) {
        const files = await this.storage.list(this.deletedRoot(collection))
        return this.idsFromFiles(files)
    }

    /**
     * @param {string[]} files
     * @returns {Promise<string[]>}
     */
    async idsFromFiles(files) {
        /** @type {string[]} */
        const ids = []
        for (const file of files) {
            const id = rawFileId(path.basename(file))
            if (id !== null && (await TTID.isTTID(id))) ids.push(id)
        }
        return ids
    }

    /**
     * @param {string} collection
     * @param {string} docId
     * @param {number} deletedAt
     * @returns {Promise<string>}
     */
    async softDeleteStoredFile(collection, docId, deletedAt) {
        const source = await this.findPath(
            this.docsRoot(collection),
            docId,
            this.shardWidth(collection)
        )
        if (!source) throw new Error(`Raw file not found: ${docId}`)
        const target = path.join(
            this.deletedRoot(collection),
            shardOf(docId, this.shardWidth(collection)),
            path.basename(source)
        )
        assertPathInside(this.deletedRoot(collection), target)
        await this.storage.move(source, target)
        await this.storage.setModifiedTime(target, deletedAt)
        await this.restampChecksum(target)
        await this.storage.syncFile(target)
        await this.storage.chmod(target, 0o444)
        return target
    }

    /**
     * @param {string} collection
     * @param {string} docId
     * @param {number} restoredAt
     * @returns {Promise<string>}
     */
    async restoreStoredFile(collection, docId, restoredAt) {
        const source = await this.findPath(
            this.deletedRoot(collection),
            docId,
            this.shardWidth(collection)
        )
        if (!source) throw new Error(`Deleted raw file not found: ${docId}`)
        const target = path.join(
            this.docsRoot(collection),
            shardOf(docId, this.shardWidth(collection)),
            path.basename(source)
        )
        assertPathInside(this.docsRoot(collection), target)
        await this.storage.move(source, target)
        await this.storage.chmod(target, 0o644)
        await this.storage.setModifiedTime(target, restoredAt)
        await this.restampChecksum(target)
        return target
    }

    /** @param {string} collection @param {string} docId @returns {Promise<void>} */
    async makeStoredFileReadOnly(collection, docId) {
        const target = await this.findPath(
            this.docsRoot(collection),
            docId,
            this.shardWidth(collection)
        )
        if (!target) throw new Error(`Raw file not found: ${docId}`)
        await this.storage.syncFile(target)
        await this.storage.chmod(target, 0o444)
    }

    /** @param {string} collection @param {string} docId @returns {Promise<Uint8Array>} */
    async readBytes(collection, docId) {
        const target = await this.findPath(
            this.docsRoot(collection),
            docId,
            this.shardWidth(collection)
        )
        if (!target) throw new Error(`Raw file not found: ${docId}`)
        return await this.storage.readBytes(target)
    }

    /**
     * @param {string} collection
     * @param {string} docId
     * @param {{ start?: number, end?: number }} [range]
     * @returns {Promise<ReadableStream<Uint8Array>>}
     */
    async readStream(collection, docId, range) {
        const target = await this.findPath(
            this.docsRoot(collection),
            docId,
            this.shardWidth(collection)
        )
        if (!target) throw new Error(`Raw file not found: ${docId}`)
        return this.storage.readStream(target, range)
    }
}
