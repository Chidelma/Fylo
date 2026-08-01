import { dirname, join, normalize } from './path.js'

/**
 * @typedef {import('./filesystem.js').FyloFilesystem} FyloFilesystem
 */

const ENCODER = new TextEncoder()
const DECODER = new TextDecoder()

/**
 * Errors raised by `MemoryFilesystem` carry POSIX-style codes so callers can
 * distinguish missing entries from other failures without string matching.
 */
class MemoryFilesystemError extends Error {
    /**
     * @param {string} code
     * @param {string} message
     */
    constructor(code, message) {
        super(message)
        this.code = code
        this.name = 'MemoryFilesystemError'
    }
}

/**
 * @param {string} path
 * @returns {MemoryFilesystemError}
 */
function notFound(path) {
    return new MemoryFilesystemError('ENOENT', `No such file or directory: ${path}`)
}

/**
 * @param {string} path
 * @returns {MemoryFilesystemError}
 */
function notDirectory(path) {
    return new MemoryFilesystemError('ENOTDIR', `Not a directory: ${path}`)
}

/**
 * In-memory `FyloFilesystem` implementation used by tests, SSR, and the
 * worker-less fallback path. Mirrors the POSIX semantics the browser core relies
 * on without leaking any node:fs or Bun-specific surface.
 *
 * Stores file contents as `Uint8Array` blobs keyed by their normalised
 * absolute-style path. Directories are tracked in a separate Set so empty
 * directories and parent traversal work.
 *
 * @implements {FyloFilesystem}
 */
export class MemoryFilesystem {
    constructor() {
        /** @type {Map<string, Uint8Array>} */
        this.files = new Map()
        /** @type {Map<string, number>} */
        this.mtimes = new Map()
        /** @type {Set<string>} */
        this.dirs = new Set(['/'])
        this.mtimes.set('/', Date.now())
    }

    /**
     * @param {string} path
     * @returns {string}
     */
    key(path) {
        const normalised = normalize(path)
        if (!normalised.startsWith('/')) return `/${normalised === '.' ? '' : normalised}`
        return normalised
    }

    /** @param {string} path @returns {Promise<boolean>} */
    async exists(path) {
        const key = this.key(path)
        return this.files.has(key) || this.dirs.has(key)
    }

    /** @param {string} path @returns {Promise<boolean>} */
    async isDirectory(path) {
        return this.dirs.has(this.key(path))
    }

    /** @param {string} path @returns {Promise<number>} */
    async mtimeMs(path) {
        const key = this.key(path)
        if (!this.files.has(key) && !this.dirs.has(key)) throw notFound(path)
        return this.mtimes.get(key) ?? 0
    }

    /**
     * @param {string} path
     * @param {{ recursive?: boolean }} [options]
     * @returns {Promise<void>}
     */
    async mkdir(path, options = {}) {
        const key = this.key(path)
        if (this.files.has(key)) throw notDirectory(path)
        if (this.dirs.has(key)) return
        if (options.recursive) {
            const segments = key.split('/').filter((segment) => segment.length > 0)
            let cursor = ''
            for (const segment of segments) {
                cursor += `/${segment}`
                if (this.files.has(cursor)) throw notDirectory(cursor)
                this.dirs.add(cursor)
                this.mtimes.set(cursor, Date.now())
            }
            return
        }
        const parent = dirname(key)
        if (!this.dirs.has(parent)) throw notFound(parent)
        this.dirs.add(key)
        this.mtimes.set(key, Date.now())
    }

    /** @param {string} path @returns {Promise<string[]>} */
    async list(path) {
        const key = this.key(path)
        if (!this.dirs.has(key)) throw notFound(path)
        const prefix = key === '/' ? '/' : `${key}/`
        const names = new Set()
        for (const file of this.files.keys()) {
            if (!file.startsWith(prefix)) continue
            const remainder = file.slice(prefix.length)
            const slash = remainder.indexOf('/')
            names.add(slash === -1 ? remainder : remainder.slice(0, slash))
        }
        for (const dir of this.dirs) {
            if (dir === key) continue
            if (!dir.startsWith(prefix)) continue
            const remainder = dir.slice(prefix.length)
            const slash = remainder.indexOf('/')
            names.add(slash === -1 ? remainder : remainder.slice(0, slash))
        }
        return [...names].sort()
    }

    /**
     * Removes a directory and everything beneath it. The root always survives,
     * since the filesystem must keep a mount point.
     * @param {string} key
     */
    removeSubtree(key) {
        const prefix = key === '/' ? '/' : `${key}/`
        const covered = (/** @type {string} */ entry) => entry === key || entry.startsWith(prefix)
        for (const file of [...this.files.keys()]) {
            if (!covered(file)) continue
            this.files.delete(file)
            this.mtimes.delete(file)
        }
        for (const dir of [...this.dirs]) {
            if (!covered(dir)) continue
            this.dirs.delete(dir)
            this.mtimes.delete(dir)
        }
        this.dirs.add('/')
        this.mtimes.set('/', Date.now())
    }

    /**
     * @param {string} path
     * @param {{ recursive?: boolean }} [options]
     * @returns {Promise<void>}
     */
    async rmdir(path, options = {}) {
        const key = this.key(path)
        if (!this.dirs.has(key)) {
            if (this.files.has(key)) throw notDirectory(path)
            return
        }
        if (options.recursive) return this.removeSubtree(key)
        const children = await this.list(path)
        if (children.length > 0) {
            throw new MemoryFilesystemError('ENOTEMPTY', `Directory not empty: ${path}`)
        }
        if (key !== '/') {
            this.dirs.delete(key)
            this.mtimes.delete(key)
        }
    }

    /** @param {string} path @returns {Promise<string>} */
    async readText(path) {
        return DECODER.decode(await this.readBytes(path))
    }

    /** @param {string} path @returns {Promise<Uint8Array>} */
    async readBytes(path) {
        const key = this.key(path)
        const bytes = this.files.get(key)
        if (!bytes) throw notFound(path)
        return new Uint8Array(bytes)
    }

    /** @param {string} path @returns {Promise<number>} */
    async size(path) {
        const key = this.key(path)
        const bytes = this.files.get(key)
        if (!bytes) throw notFound(path)
        return bytes.byteLength
    }

    /**
     * @param {string} key
     * @returns {void}
     */
    ensureParents(key) {
        const parent = dirname(key)
        if (this.files.has(parent)) throw notDirectory(parent)
        if (this.dirs.has(parent)) return
        const segments = parent.split('/').filter((segment) => segment.length > 0)
        let cursor = ''
        for (const segment of segments) {
            cursor += `/${segment}`
            if (this.files.has(cursor)) throw notDirectory(cursor)
            this.dirs.add(cursor)
            this.mtimes.set(cursor, Date.now())
        }
    }

    /**
     * @param {string} path
     * @param {string} data
     * @returns {Promise<void>}
     */
    async writeText(path, data) {
        await this.writeBytes(path, ENCODER.encode(data))
    }

    /**
     * @param {string} path
     * @param {Uint8Array} data
     * @returns {Promise<void>}
     */
    async writeBytes(path, data) {
        const key = this.key(path)
        if (this.dirs.has(key)) throw notDirectory(path)
        this.ensureParents(key)
        this.files.set(key, new Uint8Array(data))
        this.mtimes.set(key, Date.now())
    }

    /**
     * @param {string} path
     * @param {string} data
     * @returns {Promise<void>}
     */
    async appendText(path, data) {
        const key = this.key(path)
        if (this.dirs.has(key)) throw notDirectory(path)
        this.ensureParents(key)
        const existing = this.files.get(key) ?? new Uint8Array(0)
        const addition = ENCODER.encode(data)
        const merged = new Uint8Array(existing.byteLength + addition.byteLength)
        merged.set(existing, 0)
        merged.set(addition, existing.byteLength)
        this.files.set(key, merged)
        this.mtimes.set(key, Date.now())
    }

    /** @param {string} path @returns {Promise<void>} */
    async remove(path) {
        const key = this.key(path)
        if (this.files.has(key)) {
            this.files.delete(key)
            this.mtimes.delete(key)
            return
        }
        if (this.dirs.has(key)) throw new MemoryFilesystemError('EISDIR', `Is a directory: ${path}`)
    }

    /**
     * @param {string} source
     * @param {string} target
     * @returns {Promise<void>}
     */
    async move(source, target) {
        const sourceKey = this.key(source)
        const data = this.files.get(sourceKey)
        if (!data) throw notFound(source)
        const targetKey = this.key(target)
        if (this.dirs.has(targetKey)) throw notDirectory(target)
        this.ensureParents(targetKey)
        this.files.set(targetKey, data)
        this.mtimes.set(targetKey, Date.now())
        this.files.delete(sourceKey)
        this.mtimes.delete(sourceKey)
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

/**
 * Convenience helper used by tests that want a quick path-to-bytes peek
 * without going through the async filesystem methods.
 *
 * @param {MemoryFilesystem} fs
 * @param {string} path
 * @returns {Uint8Array | null}
 */
export function peekBytes(fs, path) {
    const key = fs.key(path)
    const bytes = fs.files.get(key)
    return bytes ? new Uint8Array(bytes) : null
}

/**
 * Convenience helper that creates a fresh `MemoryFilesystem` with the given
 * collection of seed files, used to set up complex test scenarios in one
 * declaration.
 *
 * @param {Record<string, string>} [seed]
 * @returns {MemoryFilesystem}
 */
export function createMemoryFilesystem(seed = {}) {
    const fs = new MemoryFilesystem()
    for (const [path, data] of Object.entries(seed)) {
        const key = fs.key(path)
        fs.ensureParents(key)
        fs.files.set(key, ENCODER.encode(data))
        fs.mtimes.set(key, Date.now())
    }
    return fs
}

export { join }
