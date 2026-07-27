import { dirname, join, normalize } from './core/path.js'

/**
 * @typedef {import('./core/filesystem.js').FyloFilesystem} FyloFilesystem
 */

const ENCODER = new TextEncoder()
const DECODER = new TextDecoder()

/**
 * @param {unknown} navigatorLike
 * @returns {navigatorLike is Navigator & { storage: StorageManager & { getDirectory: () => Promise<FileSystemDirectoryHandle> } }}
 */
export function hasOpfs(navigatorLike) {
    return (
        typeof navigatorLike === 'object' &&
        navigatorLike !== null &&
        'storage' in navigatorLike &&
        typeof (
            /** @type {{ storage?: { getDirectory?: unknown } }} */ (navigatorLike).storage
                ?.getDirectory
        ) === 'function'
    )
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isNotFound(error) {
    return /** @type {{ name?: string }} */ (error)?.name === 'NotFoundError'
}

/**
 * OPFS-backed implementation of `FyloFilesystem`.
 *
 * The layout is one OPFS file per FYLO document/index/journal file. It does not
 * serialize a whole collection into one blob.
 */
export class OpfsFilesystem {
    /**
     * @param {{ namespace?: string }=} options
     */
    constructor(options = {}) {
        this.namespace = options.namespace ?? 'fylo'
        /** @type {Promise<FileSystemDirectoryHandle> | null} */
        this.rootPromise = null
        /** @type {Map<string, FileSystemDirectoryHandle>} */
        this.dirCache = new Map()
    }

    /**
     * @param {string} path
     * @returns {string}
     */
    key(path) {
        const normalised = normalize(path)
        return normalised.startsWith('/') ? normalised.slice(1) : normalised
    }

    /** @returns {Promise<FileSystemDirectoryHandle>} */
    async root() {
        if (this.rootPromise) return await this.rootPromise
        if (!hasOpfs(globalThis.navigator)) {
            throw new Error('OPFS is not available in this browser context')
        }
        this.rootPromise = globalThis.navigator.storage
            .getDirectory()
            .then((root) => root.getDirectoryHandle(this.namespace, { create: true }))
        return await this.rootPromise
    }

    /**
     * @param {string} path
     * @param {boolean} [create]
     * @returns {Promise<FileSystemDirectoryHandle>}
     */
    async directoryHandle(path, create = false) {
        const key = this.key(path)
        const cacheKey = key || '/'
        const cached = this.dirCache.get(cacheKey)
        if (cached) return cached
        let handle = await this.root()
        if (!key || key === '.') return handle
        for (const segment of key.split('/').filter(Boolean)) {
            handle = await handle.getDirectoryHandle(segment, { create })
        }
        this.dirCache.set(cacheKey, handle)
        return handle
    }

    /**
     * @param {string} path
     * @param {boolean} [create]
     * @returns {Promise<FileSystemFileHandle>}
     */
    async fileHandle(path, create = false) {
        const dir = await this.directoryHandle(dirname(path), create)
        return await dir.getFileHandle(this.basename(path), { create })
    }

    /** @param {string} path @returns {string} */
    basename(path) {
        const key = this.key(path)
        const index = key.lastIndexOf('/')
        return index === -1 ? key : key.slice(index + 1)
    }

    /** @param {string} path @returns {Promise<boolean>} */
    async exists(path) {
        try {
            await this.fileHandle(path, false)
            return true
        } catch (err) {
            if (!isNotFound(err)) {
                try {
                    await this.directoryHandle(path, false)
                    return true
                } catch (directoryErr) {
                    if (!isNotFound(directoryErr)) throw directoryErr
                }
            }
            return false
        }
    }

    /** @param {string} path @returns {Promise<boolean>} */
    async isDirectory(path) {
        try {
            await this.directoryHandle(path, false)
            return true
        } catch (err) {
            if (isNotFound(err)) return false
            throw err
        }
    }

    /** @param {string} path @returns {Promise<number>} */
    async mtimeMs(path) {
        const file = await (await this.fileHandle(path, false)).getFile()
        return file.lastModified
    }

    /** @param {string} path @returns {Promise<number>} */
    async size(path) {
        const file = await (await this.fileHandle(path, false)).getFile()
        return file.size
    }

    /** @param {string} path @param {{ recursive?: boolean }} [options] @returns {Promise<void>} */
    async mkdir(path, options = {}) {
        await this.directoryHandle(path, options.recursive === true)
    }

    /** @param {string} path @returns {Promise<string[]>} */
    async list(path) {
        const dir = await this.directoryHandle(path, false)
        /** @type {string[]} */
        const names = []
        // FileSystemDirectoryHandle is async-iterable in browsers that support OPFS.
        const keys = /** @type {{ keys: () => AsyncIterable<string> }} */ (
            /** @type {unknown} */ (dir)
        ).keys()
        for await (const name of keys) {
            names.push(name)
        }
        return names.sort()
    }

    /** @param {string} path @param {{ recursive?: boolean }} [options] @returns {Promise<void>} */
    async rmdir(path, options = {}) {
        const parent = await this.directoryHandle(dirname(path), false)
        try {
            await parent.removeEntry(this.basename(path), { recursive: options.recursive === true })
        } catch (err) {
            if (!isNotFound(err)) throw err
        }
    }

    /** @param {string} path @returns {Promise<string>} */
    async readText(path) {
        return DECODER.decode(await this.readBytes(path))
    }

    /** @param {string} path @returns {Promise<Uint8Array>} */
    async readBytes(path) {
        const file = await (await this.fileHandle(path, false)).getFile()
        const buffer = await file.arrayBuffer()
        return new Uint8Array(buffer)
    }

    /** @param {string} path @param {string} data @returns {Promise<void>} */
    async writeText(path, data) {
        await this.writeBytes(path, ENCODER.encode(data))
    }

    /** @param {string} path @param {Uint8Array} data @returns {Promise<void>} */
    async writeBytes(path, data) {
        const handle = await this.fileHandle(path, true)
        const writable = await handle.createWritable()
        try {
            await writable.write(/** @type {FileSystemWriteChunkType} */ (data.slice()))
        } finally {
            await writable.close()
        }
    }

    /** @param {string} path @param {string} data @returns {Promise<void>} */
    async appendText(path, data) {
        const handle = await this.fileHandle(path, true)
        if (typeof globalThis.document === 'undefined' && 'createSyncAccessHandle' in handle) {
            const access =
                await /** @type {FileSystemFileHandle & { createSyncAccessHandle: () => Promise<{ getSize: () => number, write: (bytes: Uint8Array, options?: { at?: number }) => number, flush: () => void, close: () => void }> }} */ (
                    handle
                ).createSyncAccessHandle()
            try {
                access.write(ENCODER.encode(data), { at: access.getSize() })
                access.flush()
            } finally {
                access.close()
            }
            return
        }
        const existing = (await this.exists(path)) ? await this.readBytes(path) : new Uint8Array(0)
        const addition = ENCODER.encode(data)
        const merged = new Uint8Array(existing.byteLength + addition.byteLength)
        merged.set(existing, 0)
        merged.set(addition, existing.byteLength)
        await this.writeBytes(path, merged)
    }

    /** @param {string} path @returns {Promise<void>} */
    async remove(path) {
        const parent = await this.directoryHandle(dirname(path), false)
        try {
            await parent.removeEntry(this.basename(path))
        } catch (err) {
            if (!isNotFound(err)) throw err
        }
    }

    /** @param {string} source @param {string} target @returns {Promise<void>} */
    async move(source, target) {
        const bytes = await this.readBytes(source)
        await this.writeBytes(target, bytes)
        await this.remove(source)
    }

    /**
     * @template T
     * @param {string} _path
     * @param {() => Promise<T>} body
     * @returns {Promise<T>}
     */
    async withSession(_path, body) {
        return await body()
    }
}

/** @param {{ namespace?: string }=} options @returns {OpfsFilesystem} */
export function createOpfsFilesystem(options = {}) {
    return new OpfsFilesystem(options)
}
