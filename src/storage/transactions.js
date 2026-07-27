import { AsyncLocalStorage } from 'node:async_hooks'
import {
    chmod,
    constants,
    copyFile,
    link,
    lstat,
    mkdir,
    open,
    readdir,
    rename,
    rm,
    stat,
    truncate,
    utimes
} from 'node:fs/promises'
import path from 'node:path'
import { writeDurable } from './durable.js'
import { emitFyloEvent } from '../observability/events.js'
import {
    getXattr,
    listXattr,
    listXattrFd,
    removeXattr,
    removeXattrFd,
    setXattr,
    setXattrFd
} from './xattr.js'
import {
    chmodSecureDescriptor,
    closeSecureDescriptor,
    openDirectoryNoFollow,
    openFileAtRoot,
    openFileAtRootWithFlags,
    openRenameableFileAtRootWithFlags,
    readSecureDescriptor,
    renameAtRoots,
    renameOpenFileAtRoot,
    statSecureDescriptor,
    syncSecureDescriptor,
    timesSecureDescriptor,
    truncateSecureDescriptor,
    unlinkAtRoot,
    writeSecureDescriptor
} from './secure-open.js'

const FORMAT = 'fylo.collection-transaction.v1'
const STATE_FORMAT = 'fylo.collection-generation.v1'
const MAX_CAPTURES = 10_000
const MAX_PATH_BYTES = 4096
const MAX_XATTRS = 128
const MAX_XATTR_VALUE_BYTES = 1024 * 1024
const MAX_XATTR_TOTAL_BYTES = 8 * MAX_XATTR_VALUE_BYTES
const MAX_STATE_BYTES = 16 * 1024
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024
const MAX_CAPTURE_SEGMENT_BYTES = MAX_XATTR_TOTAL_BYTES + 64 * 1024
const MAX_CAPTURE_PATH_TOTAL_BYTES = 2 * 1024 * 1024

/** @param {unknown} error @param {string} code */
function hasCode(error, code) {
    return error instanceof Error && 'code' in error && error.code === code
}

/** @param {string} target @returns {Promise<boolean>} */
async function exists(target) {
    try {
        await lstat(target)
        return true
    } catch (error) {
        if (hasCode(error, 'ENOENT')) return false
        throw error
    }
}

/** @param {string} directory */
async function syncDirectory(directory) {
    const handle = await open(directory, 'r')
    try {
        await handle.sync()
    } catch (error) {
        if (process.platform !== 'win32') throw error
    } finally {
        await handle.close()
    }
}

/** @param {string} target */
async function syncFileIfPresent(target) {
    try {
        // Windows requires a write-capable handle for FlushFileBuffers even
        // when the caller only wants to persist bytes written earlier.
        const handle = await open(target, process.platform === 'win32' ? 'r+' : 'r')
        try {
            await handle.sync()
        } finally {
            await handle.close()
        }
    } catch (error) {
        if (process.platform === 'win32' && hasCode(error, 'EPERM')) {
            const metadata = await stat(target)
            // WORM and soft-delete paths flush immediately before applying the
            // read-only attribute. Windows cannot reopen them for a redundant
            // commit-time FlushFileBuffers call.
            if ((metadata.mode & 0o222) === 0) return
        }
        if (!hasCode(error, 'ENOENT')) throw error
    }
}

/** @param {string} target @param {number} maxBytes @returns {Promise<any | null>} */
async function readJsonIfExists(target, maxBytes) {
    let handle
    try {
        handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW)
        const metadata = await handle.stat()
        if (!metadata.isFile() || metadata.isSymbolicLink()) {
            throw new Error(`Transaction metadata must be a regular file: ${target}`)
        }
        if (metadata.size > maxBytes) {
            throw new Error(`Transaction metadata exceeds ${maxBytes} bytes: ${target}`)
        }
        const bytes = Buffer.alloc(Math.min(metadata.size + 1, maxBytes + 1))
        let offset = 0
        while (offset < bytes.length) {
            const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset)
            if (bytesRead === 0) break
            offset += bytesRead
        }
        if (offset > maxBytes) {
            throw new Error(`Transaction metadata exceeds ${maxBytes} bytes: ${target}`)
        }
        return JSON.parse(bytes.subarray(0, offset).toString('utf8'))
    } catch (error) {
        if (hasCode(error, 'ENOENT')) return null
        throw new Error(`Transaction metadata is corrupt: ${target}`, { cause: error })
    } finally {
        await handle?.close()
    }
}

/** @param {object} value @param {string[]} expected @param {string} label */
function assertExactKeys(value, expected, label) {
    const actual = Object.keys(value).sort()
    const wanted = [...expected].sort()
    if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
        throw new Error(`${label} has an invalid schema`)
    }
}

/** @param {string} root @param {string} relative @param {string} label */
function containedPath(root, relative, label) {
    // A manifest is portable data, so a capture path is compared in its
    // separator-independent form. `path.normalize` rewrites '/' to '\\' on
    // Windows, which would reject a forward-slash manifest there and make a
    // root unreadable on the platform that did not write it. Traversal,
    // absolute paths, NUL bytes, and oversize values are still refused.
    const portable = typeof relative === 'string' ? relative.replaceAll('\\', '/') : relative
    if (
        typeof relative !== 'string' ||
        relative.length === 0 ||
        Buffer.byteLength(relative) > MAX_PATH_BYTES ||
        relative.includes('\0') ||
        path.isAbsolute(relative) ||
        path.posix.normalize(portable) !== portable
    ) {
        throw new Error(`${label} is not a safe relative path`)
    }
    const resolvedRoot = path.resolve(root)
    const resolved = path.resolve(resolvedRoot, relative)
    if (resolved === resolvedRoot || !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
        throw new Error(`${label} escapes its permitted root`)
    }
    return resolved
}

/**
 * Rejects symlinks in every existing component below a trusted root.
 * @param {string} root
 * @param {string} target
 * @param {string} label
 */
async function assertNoSymlinkComponents(root, target, label) {
    const relative = path.relative(path.resolve(root), path.resolve(target))
    let current = path.resolve(root)
    for (const component of relative.split(path.sep)) {
        current = path.join(current, component)
        try {
            const metadata = await lstat(current)
            if (metadata.isSymbolicLink()) throw new Error(`${label} contains a symbolic link`)
        } catch (error) {
            if (hasCode(error, 'ENOENT')) return
            throw error
        }
    }
}

/** @param {unknown} value */
function isCanonicalBase64(value) {
    if (typeof value !== 'string') return false
    try {
        const decoded = Buffer.from(value, 'base64')
        return decoded.length <= MAX_XATTR_VALUE_BYTES && decoded.toString('base64') === value
    } catch {
        return false
    }
}

/**
 * @param {any} transaction
 * @param {string} collection
 * @param {string} id
 * @param {string} collectionRoot
 * @param {string} journalRoot
 */
async function validateRecoveryManifest(transaction, collection, id, collectionRoot, journalRoot) {
    if (!transaction || typeof transaction !== 'object' || Array.isArray(transaction)) {
        throw new Error('Transaction manifest must be an object')
    }
    assertExactKeys(
        transaction,
        [
            'format',
            'id',
            'collection',
            'operation',
            'phase',
            'generationBefore',
            'eventOffset',
            'captures'
        ],
        'Transaction manifest'
    )
    assertManifestScalars(transaction, collection, id)

    const transactionRoot = containedPath(journalRoot, id, 'Transaction id')
    await assertNoSymlinkComponents(journalRoot, transactionRoot, 'Transaction journal path')
    const seen = new Set()
    let capturePathBytes = 0
    let manifestXattrBytes = 0
    for (const capture of transaction.captures) {
        capturePathBytes = await validateCaptureTarget(capture, {
            collectionRoot,
            seen,
            capturePathBytes
        })
        if (!capture.present) continue
        await assertCaptureBackupFile(capture, transactionRoot)
        assertCaptureMetadataBounds(capture)
        manifestXattrBytes = validateCaptureXattrs(capture, manifestXattrBytes)
    }
    return transaction
}

/**
 * Validates a capture's shape and its target path, enforcing containment,
 * uniqueness, and the aggregate path-length bound.
 * @param {any} capture
 * @param {{ collectionRoot: string, seen: Set<string>, capturePathBytes: number }} context
 * @returns {Promise<number>} the running capture-path byte total
 */
async function validateCaptureTarget(capture, context) {
    if (!capture || typeof capture !== 'object' || Array.isArray(capture)) {
        throw new Error('Transaction capture must be an object')
    }
    if (typeof capture.present !== 'boolean') {
        throw new Error('Transaction capture has an invalid present flag')
    }
    assertExactKeys(
        capture,
        capture.present
            ? ['path', 'present', 'backup', 'mode', 'mtimeMs', 'xattrs']
            : ['path', 'present'],
        'Transaction capture'
    )
    const target = containedPath(context.collectionRoot, capture.path, 'Transaction capture path')
    const capturePathBytes = context.capturePathBytes + Buffer.byteLength(capture.path)
    if (capturePathBytes > MAX_CAPTURE_PATH_TOTAL_BYTES) {
        throw new Error('Transaction capture paths exceed the safe aggregate bound')
    }
    if (context.seen.has(target)) {
        throw new Error('Transaction manifest contains duplicate captures')
    }
    context.seen.add(target)
    await assertNoSymlinkComponents(context.collectionRoot, target, 'Transaction capture path')
    return capturePathBytes
}

/**
 * The backup for a present capture must exist inside the journal as a regular
 * file, never a symlink that could redirect a restore outside the root.
 * @param {Record<string, any>} capture
 * @param {string} transactionRoot
 */
async function assertCaptureBackupFile(capture, transactionRoot) {
    const backup = containedPath(transactionRoot, capture.backup, 'Transaction backup path')
    await assertNoSymlinkComponents(transactionRoot, backup, 'Transaction backup path')
    let backupMetadata
    try {
        backupMetadata = await lstat(backup)
    } catch (error) {
        if (hasCode(error, 'ENOENT')) throw new Error('Transaction backup is missing')
        throw error
    }
    if (!backupMetadata.isFile() || backupMetadata.isSymbolicLink()) {
        throw new Error('Transaction backup must be a regular file')
    }
}

/**
 * The recorded transaction id names a directory inside the journal, so it must
 * be a single safe path segment before it is ever opened.
 * @param {unknown} id
 * @param {string} collection
 * @returns {string}
 */
function assertRecoverableTransactionId(id, collection) {
    if (
        typeof id !== 'string' ||
        id.length === 0 ||
        id.length > 128 ||
        id.includes('\0') ||
        path.basename(id) !== id
    ) {
        throw new Error(`Collection transaction state has no active transaction: ${collection}`)
    }
    return id
}

/**
 * A recovering transaction may only truncate events it actually appended, so
 * the recorded offset must fall inside the journal that exists now.
 * @param {Record<string, any>} transaction
 * @param {number} collectionFd
 * @param {string} eventRelative
 */
function assertEventJournalBounds(transaction, collectionFd, eventRelative) {
    const eventFd = openFileAtRoot(collectionFd, eventRelative)
    if (eventFd === null) {
        if (transaction.eventOffset !== 0) {
            throw new Error('Transaction event journal is missing')
        }
        return
    }
    try {
        const eventMetadata = statSecureDescriptor(eventFd)
        if (!eventMetadata.isFile() || transaction.eventOffset > eventMetadata.size) {
            throw new Error('Transaction event offset is outside safe bounds')
        }
    } finally {
        closeSecureDescriptor(eventFd)
    }
}

/**
 * Scalar identity and bounds of a recovery manifest. Kept separate from the
 * capture walk so each half stays legible; every check is load-bearing for
 * crash recovery, so none may be relaxed.
 * @param {Record<string, any>} transaction
 * @param {string} collection
 * @param {string} id
 */
function assertManifestScalars(transaction, collection, id) {
    if (
        transaction.format !== FORMAT ||
        transaction.id !== id ||
        transaction.collection !== collection ||
        typeof transaction.operation !== 'string' ||
        transaction.operation.length === 0 ||
        transaction.operation.length > 256 ||
        !['active', 'committed'].includes(transaction.phase) ||
        !Number.isSafeInteger(transaction.generationBefore) ||
        transaction.generationBefore < 0 ||
        !Number.isSafeInteger(transaction.eventOffset) ||
        transaction.eventOffset < 0 ||
        !Array.isArray(transaction.captures) ||
        transaction.captures.length > MAX_CAPTURES
    ) {
        throw new Error('Transaction manifest has invalid values')
    }
}

/** @param {Record<string, any>} capture */
function assertCaptureMetadataBounds(capture) {
    if (
        !Number.isSafeInteger(capture.mode) ||
        capture.mode < 0 ||
        capture.mode > 0o777 ||
        typeof capture.mtimeMs !== 'number' ||
        !Number.isFinite(capture.mtimeMs) ||
        capture.mtimeMs < 0 ||
        capture.mtimeMs > 8.64e15 ||
        !Array.isArray(capture.xattrs) ||
        capture.xattrs.length > MAX_XATTRS
    ) {
        throw new Error('Transaction capture metadata is outside safe bounds')
    }
}

/**
 * Validates one capture's xattrs, enforcing both the per-capture and the
 * whole-manifest aggregate byte bounds.
 * @param {Record<string, any>} capture
 * @param {number} manifestXattrBytes bytes already counted across earlier captures
 * @returns {number} the running manifest total after this capture
 */
function validateCaptureXattrs(capture, manifestXattrBytes) {
    const names = new Set()
    let xattrBytes = 0
    let manifestTotal = manifestXattrBytes
    for (const attribute of capture.xattrs) {
        if (!attribute || typeof attribute !== 'object' || Array.isArray(attribute)) {
            throw new Error('Transaction xattr must be an object')
        }
        assertExactKeys(attribute, ['name', 'value'], 'Transaction xattr')
        assertXattrEntryBounds(attribute, names)
        const valueBytes = Buffer.from(attribute.value, 'base64').length
        xattrBytes += valueBytes
        manifestTotal += valueBytes
        if (xattrBytes > MAX_XATTR_TOTAL_BYTES) {
            throw new Error('Transaction xattrs exceed the safe aggregate bound')
        }
        if (manifestTotal > MAX_XATTR_TOTAL_BYTES) {
            throw new Error('Transaction manifest xattrs exceed the safe aggregate bound')
        }
        names.add(attribute.name)
    }
    return manifestTotal
}

/** @param {Record<string, any>} attribute @param {Set<string>} names */
function assertXattrEntryBounds(attribute, names) {
    if (
        typeof attribute.name !== 'string' ||
        attribute.name.length === 0 ||
        Buffer.byteLength(attribute.name) > 255 ||
        attribute.name.includes('\0') ||
        names.has(attribute.name) ||
        !isCanonicalBase64(attribute.value)
    ) {
        throw new Error('Transaction xattr is outside safe bounds')
    }
}

/** Durably creates a backup directory entry without copying large file bytes. */
/** @param {string} source @param {string} target */
async function linkOrCopyDurable(source, target) {
    await mkdir(path.dirname(target), { recursive: true })
    try {
        await link(source, target)
    } catch (error) {
        if (!['EXDEV', 'EPERM', 'EACCES', 'ENOTSUP'].some((code) => hasCode(error, code))) {
            throw error
        }
        await copyFile(source, target)
        const handle = await open(target, process.platform === 'win32' ? 'r+' : 'r')
        try {
            await handle.sync()
        } finally {
            await handle.close()
        }
    }
    await syncDirectory(path.dirname(target))
}

/**
 * Creates a durable, independent inode for rollback installation. A hard link
 * is unsafe here: for xattr-only mutations the current target and before-image
 * are the same inode, and POSIX rename is then allowed to leave both names.
 * @param {string} source
 * @param {string} target
 */
async function copyDurable(source, target) {
    await mkdir(path.dirname(target), { recursive: true })
    await copyFile(source, target)
    const handle = await open(target, process.platform === 'win32' ? 'r+' : 'r')
    try {
        await handle.sync()
    } finally {
        await handle.close()
    }
    await syncDirectory(path.dirname(target))
}

/** @param {string} target */
/** @param {string} target */
function snapshotXattrsBounded(target) {
    const names = listXattr(target)
    if (names.length > MAX_XATTRS) throw new Error('Transaction target has too many xattrs')
    let total = 0
    return names.map((name) => {
        if (!name || Buffer.byteLength(name) > 255 || name.includes('\0')) {
            throw new Error('Transaction target has an invalid xattr name')
        }
        const bytes = Buffer.from(getXattr(target, name) ?? new Uint8Array())
        total += bytes.length
        if (bytes.length > MAX_XATTR_VALUE_BYTES || total > MAX_XATTR_TOTAL_BYTES) {
            throw new Error('Transaction target xattrs exceed journal bounds')
        }
        return { name, value: bytes.toString('base64') }
    })
}

/** @param {number} transactionFd @param {string} transactionRoot */
async function readCaptureSegments(transactionFd, transactionRoot) {
    const directory = path.join(transactionRoot, 'captures')
    let entries
    try {
        entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
        if (hasCode(error, 'ENOENT')) return []
        throw error
    }
    if (entries.length > MAX_CAPTURES) throw new Error('Transaction capture limit exceeded')
    const names = entries.map((entry) => entry.name).sort()
    const captures = []
    let bytes = 0
    for (let index = 0; index < names.length; index += 1) {
        const expected = `${String(index).padStart(6, '0')}.json`
        if (
            names[index] !== expected ||
            !entries.find((entry) => entry.name === expected)?.isFile()
        ) {
            throw new Error('Transaction capture segments are corrupt')
        }
        const relative = path.join('captures', expected)
        const descriptor = openFileAtRoot(transactionFd, relative)
        if (descriptor === null) throw new Error('Transaction capture segment is missing')
        try {
            const size = statSecureDescriptor(descriptor).size
            bytes += size
            if (bytes > MAX_MANIFEST_BYTES) {
                throw new Error('Transaction capture segments exceed the manifest budget')
            }
            captures.push(readJsonDescriptor(descriptor, MAX_CAPTURE_SEGMENT_BYTES, relative))
        } finally {
            closeSecureDescriptor(descriptor)
        }
    }
    return captures
}

/** @param {string} target @param {Array<{ name: string, value: string }>} attributes */
function restoreXattrs(target, attributes) {
    const expected = new Set(attributes.map(({ name }) => name))
    for (const name of listXattr(target)) {
        if (!expected.has(name)) removeXattr(target, name)
    }
    for (const { name, value } of attributes) {
        setXattr(target, name, Buffer.from(value, 'base64'))
    }
}

/** @param {number} descriptor @param {Array<{ name: string, value: string }>} attributes */
function restoreXattrsFd(descriptor, attributes) {
    const expected = new Set(attributes.map(({ name }) => name))
    for (const name of listXattrFd(descriptor)) {
        if (!expected.has(name)) removeXattrFd(descriptor, name)
    }
    for (const { name, value } of attributes) {
        setXattrFd(descriptor, name, Buffer.from(value, 'base64'))
    }
}

/** @param {number} descriptor @param {number} maxBytes @param {string} label */
function readJsonDescriptor(descriptor, maxBytes, label) {
    const metadata = statSecureDescriptor(descriptor)
    if (!metadata.isFile() || metadata.size > maxBytes) {
        throw new Error(`${label} is not a bounded regular file`)
    }
    const bytes = Buffer.alloc(Math.min(metadata.size + 1, maxBytes + 1))
    let offset = 0
    while (offset < bytes.length) {
        const count = readSecureDescriptor(descriptor, bytes, offset, bytes.length - offset, offset)
        if (count === 0) break
        offset += count
    }
    if (offset > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes`)
    return JSON.parse(bytes.subarray(0, offset).toString('utf8'))
}

/** @param {number} source @param {number} target */
function copyDescriptor(source, target) {
    const buffer = Buffer.allocUnsafe(64 * 1024)
    let offset = 0
    while (true) {
        const count = readSecureDescriptor(source, buffer, 0, buffer.length, offset)
        if (count === 0) return
        let written = 0
        while (written < count) {
            written += writeSecureDescriptor(
                target,
                buffer,
                written,
                count - written,
                offset + written
            )
        }
        offset += count
    }
}

/** @param {number} rootFd @param {string} relative @param {string | Buffer} content */
function writeDurableAtRoot(rootFd, relative, content) {
    const scratch = `${relative}.${Bun.randomUUIDv7()}.tmp`
    const descriptor = openRenameableFileAtRootWithFlags(
        rootFd,
        scratch,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o600
    )
    try {
        const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content)
        let offset = 0
        while (offset < bytes.length) {
            offset += writeSecureDescriptor(
                descriptor,
                bytes,
                offset,
                bytes.length - offset,
                offset
            )
        }
        syncSecureDescriptor(descriptor)
        renameOpenFileAtRoot(rootFd, scratch, descriptor, rootFd, relative)
    } finally {
        closeSecureDescriptor(descriptor)
    }
}

/**
 * Collection-scoped logical transaction journal. Document files remain the
 * source of truth; the journal preserves before-images while a mutation is in
 * flight and the index is rebuilt after rollback or crash recovery.
 */
export class CollectionTransactionJournal {
    /**
     * @param {{
     *   collectionRoot: (collection: string) => string,
     *   journalRoot: (collection: string) => string,
     *   eventPath: (collection: string) => string,
     *   rebuild: (collection: string) => Promise<unknown>,
     *   invalidate: (collection: string) => Promise<void>,
     *   onEvent?: import('../observability/events.js').FyloEventHandler
     * }} options
     */
    constructor(options) {
        this.collectionRoot = options.collectionRoot
        this.journalRoot = options.journalRoot
        this.eventPath = options.eventPath
        this.rebuild = options.rebuild
        this.invalidate = options.invalidate
        this.onEvent = options.onEvent
        this.activity = new Map()
        this.context = new AsyncLocalStorage()
    }

    /** @param {string} collection */
    root(collection) {
        return this.journalRoot(collection)
    }

    /** @param {string} collection */
    statePath(collection) {
        return path.join(this.root(collection), 'state.json')
    }

    /** @param {string} collection @param {string} id */
    transactionRoot(collection, id) {
        return path.join(this.root(collection), id)
    }

    /** @param {string} collection @param {string} id */
    manifestPath(collection, id) {
        return path.join(this.transactionRoot(collection, id), 'transaction.json')
    }

    /** @param {string} collection @param {string} id */
    capturesRoot(collection, id) {
        return path.join(this.transactionRoot(collection, id), 'captures')
    }

    /** @param {string} collection @param {string} id @param {number} index */
    capturePath(collection, id, index) {
        return path.join(
            this.capturesRoot(collection, id),
            `${String(index).padStart(6, '0')}.json`
        )
    }

    /** @param {string} collection */
    isActive(collection) {
        return this.context.getStore()?.collection === collection
    }

    /** @param {string} collection */
    async state(collection) {
        const state = await readJsonIfExists(this.statePath(collection), MAX_STATE_BYTES)
        if (state === null) {
            return { format: STATE_FORMAT, generation: 0, state: 'stable' }
        }
        if (!state || typeof state !== 'object' || Array.isArray(state)) {
            throw new Error(`Collection transaction state is corrupt: ${collection}`)
        }
        const expectedKeys =
            state.state === 'writing'
                ? ['format', 'generation', 'state', 'transactionId']
                : ['format', 'generation', 'state']
        if (
            state.format !== STATE_FORMAT ||
            !Number.isSafeInteger(state.generation) ||
            state.generation < 0 ||
            !['stable', 'writing'].includes(state.state)
        ) {
            throw new Error(`Collection transaction state is corrupt: ${collection}`)
        }
        try {
            assertExactKeys(state, expectedKeys, 'Collection transaction state')
        } catch {
            throw new Error(`Collection transaction state is corrupt: ${collection}`)
        }
        return state
    }

    /** Operator-facing transaction/recovery inspection hook. @param {string} collection */
    async inspect(collection) {
        try {
            const state = await this.state(collection)
            return {
                collection,
                generation: state.generation,
                state: state.state,
                ...(state.transactionId ? { transactionId: state.transactionId } : {}),
                activity: this.activity.get(collection) ?? { status: 'idle' }
            }
        } catch (error) {
            return {
                collection,
                state: 'corrupt',
                detail: error instanceof Error ? error.message : String(error),
                activity: this.activity.get(collection) ?? { status: 'failed' }
            }
        }
    }

    /** @param {string} collection @param {any} state */
    async writeState(collection, state) {
        const root = this.root(collection)
        await mkdir(root, { recursive: true })
        const rootFd = openDirectoryNoFollow(root)
        try {
            // This record is replaced for every transaction phase. Use the
            // rooted native rename path so Windows can replace it atomically
            // even when another process has just finished reading it.
            writeDurableAtRoot(rootFd, 'state.json', `${JSON.stringify(state)}\n`)
        } finally {
            closeSecureDescriptor(rootFd)
        }
    }

    /** @param {any} transaction */
    async writeManifest(transaction) {
        const record = { ...transaction, captures: [] }
        await writeDurable(
            this.manifestPath(transaction.collection, transaction.id),
            `${JSON.stringify(record)}\n`
        )
    }

    /** @param {any} transaction @param {any} capture */
    async appendCapture(transaction, capture) {
        await writeDurable(
            this.capturePath(transaction.collection, transaction.id, transaction.captures.length),
            `${JSON.stringify(capture)}\n`
        )
    }

    /**
     * Runs one outermost logical transaction. Nested calls for the same
     * collection join it and therefore share one rollback boundary.
     * @template T
     * @param {string} collection
     * @param {string} operation
     * @param {() => Promise<T>} action
     * @returns {Promise<T>}
     */
    async run(collection, operation, action) {
        if (this.isActive(collection)) return await action()
        const prior = await this.state(collection)
        if (prior.state !== 'stable') {
            throw new Error(
                `Collection requires transaction recovery before writing: ${collection}`
            )
        }
        const id = Bun.randomUUIDv7()
        const event = this.eventPath(collection)
        let eventOffset = 0
        try {
            eventOffset = (await stat(event)).size
        } catch (error) {
            if (!hasCode(error, 'ENOENT')) throw error
        }
        const transaction = {
            format: FORMAT,
            id,
            collection,
            operation,
            phase: 'active',
            generationBefore: prior.generation,
            eventOffset,
            captures: []
        }
        Object.defineProperty(transaction, 'afterCommit', { value: [], enumerable: false })
        Object.defineProperty(transaction, 'capturePathBytes', { value: 0, writable: true })
        Object.defineProperty(transaction, 'captureXattrBytes', { value: 0, writable: true })
        Object.defineProperty(transaction, 'capturedPaths', { value: new Set() })
        await mkdir(this.transactionRoot(collection, id), { recursive: true })
        await this.writeManifest(transaction)
        await this.writeState(collection, {
            format: STATE_FORMAT,
            generation: prior.generation + 1,
            state: 'writing',
            transactionId: id
        })
        let result
        try {
            result = await this.context.run({ collection, transaction }, action)
        } catch (error) {
            try {
                await this.rollback(transaction)
            } catch (rollbackError) {
                // Rebuild/invalidation are derived-state maintenance. If the
                // durable generation was restored successfully, preserve the
                // operation's actionable error instead of replacing it with a
                // secondary maintenance failure.
                let stable = false
                try {
                    stable = (await this.state(collection)).state === 'stable'
                } catch {
                    // The rollback failure below carries the uncertain state.
                }
                if (!stable) {
                    throw new Error(`Transaction rollback failed after: ${String(error)}`, {
                        cause: rollbackError
                    })
                }
            }
            throw error
        }
        // Once the committed manifest is durable, recovery must roll forward.
        // A failure while publishing the stable generation is therefore not a
        // reason to restore before-images: the caller may retry a read, which
        // deterministically completes recovery from the committed marker.
        await this.commit(transaction)
        await this.runAfterCommit(transaction)
        return result
    }

    /**
     * Defers an external side effect until the local transaction is durable.
     * @param {() => Promise<void>} action
     * @returns {boolean} whether the action was deferred
     */
    deferAfterCommit(action) {
        const active = this.context.getStore()
        if (!active) return false
        active.transaction.afterCommit.push(action)
        return true
    }

    /** @param {any} transaction */
    async runAfterCommit(transaction) {
        for (const action of transaction.afterCommit ?? []) await action()
    }

    /**
     * Captures one file before its first mutation in the active transaction.
     * @param {string} target
     */
    async capture(target) {
        const active = this.context.getStore()
        if (!active) throw new Error('File capture requires an active collection transaction')
        const { transaction, collection } = active
        const collectionRoot = this.collectionRoot(collection)
        const relative = path.relative(collectionRoot, target)
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
            throw new Error(`Transaction target escapes its collection: ${target}`)
        }
        if (transaction.capturedPaths.has(relative)) return
        if (transaction.captures.length >= MAX_CAPTURES) {
            throw new Error(`Transaction capture limit exceeded (${MAX_CAPTURES})`)
        }
        const pathBytes = Buffer.byteLength(relative)
        if (transaction.capturePathBytes + pathBytes > MAX_CAPTURE_PATH_TOTAL_BYTES) {
            throw new Error('Transaction capture paths exceed journal bounds')
        }

        const present = await exists(target)
        /** @type {any} */
        const capture = { path: relative, present }
        if (present) {
            const metadata = await lstat(target)
            if (!metadata.isFile() || metadata.isSymbolicLink()) {
                throw new Error(`Transaction target must be a regular file: ${target}`)
            }
            const backup = path.join(
                this.transactionRoot(collection, transaction.id),
                'before',
                `${String(transaction.captures.length).padStart(6, '0')}.bin`
            )
            await linkOrCopyDurable(target, backup)
            Object.assign(capture, {
                backup: path.relative(this.transactionRoot(collection, transaction.id), backup),
                mode: metadata.mode & 0o777,
                mtimeMs: metadata.mtimeMs,
                xattrs: snapshotXattrsBounded(target)
            })
            const xattrBytes = capture.xattrs.reduce(
                (/** @type {number} */ total, /** @type {{ value: string }} */ attribute) =>
                    total + Buffer.from(attribute.value, 'base64').length,
                0
            )
            if (transaction.captureXattrBytes + xattrBytes > MAX_XATTR_TOTAL_BYTES) {
                throw new Error('Transaction xattrs exceed journal bounds')
            }
            transaction.captureXattrBytes += xattrBytes
        }
        await this.appendCapture(transaction, capture)
        transaction.captures.push(capture)
        transaction.capturedPaths.add(relative)
        transaction.capturePathBytes += pathBytes
    }

    /** @param {any} transaction */
    async commit(transaction) {
        await this.syncMutations(transaction)
        transaction.phase = 'committed'
        await this.writeManifest(transaction)
        await this.finish(transaction)
    }

    /** @param {any} transaction */
    async rollback(transaction) {
        const startedAt = new Date().toISOString()
        this.activity.set(transaction.collection, {
            status: 'rolling-back',
            transactionId: transaction.id,
            operation: transaction.operation,
            startedAt
        })
        emitFyloEvent(this.onEvent, {
            type: 'transaction.rollback.started',
            collection: transaction.collection,
            transactionId: transaction.id,
            operation: transaction.operation,
            startedAt
        })
        try {
            await this.restoreBeforeImages(transaction)
            await this.truncateEvents(transaction)
            let maintenanceError
            try {
                await this.rebuild(transaction.collection)
            } catch (error) {
                maintenanceError = error
            }
            try {
                await this.invalidate(transaction.collection)
            } catch (error) {
                maintenanceError ??= error
            }
            await this.finish(transaction)
            if (maintenanceError) throw maintenanceError
            const completedAt = new Date().toISOString()
            this.activity.set(transaction.collection, {
                status: 'idle',
                lastAction: 'rollback',
                transactionId: transaction.id,
                operation: transaction.operation,
                startedAt,
                completedAt
            })
            emitFyloEvent(this.onEvent, {
                type: 'transaction.rollback.succeeded',
                collection: transaction.collection,
                transactionId: transaction.id,
                operation: transaction.operation,
                startedAt,
                completedAt
            })
        } catch (error) {
            const failedAt = new Date().toISOString()
            const detail = error instanceof Error ? error.message : String(error)
            this.activity.set(transaction.collection, {
                status: 'failed',
                lastAction: 'rollback',
                transactionId: transaction.id,
                operation: transaction.operation,
                startedAt,
                failedAt,
                detail
            })
            emitFyloEvent(this.onEvent, {
                type: 'transaction.rollback.failed',
                collection: transaction.collection,
                transactionId: transaction.id,
                operation: transaction.operation,
                startedAt,
                failedAt,
                detail
            })
            throw error
        }
    }

    /** @param {any} transaction */
    async syncMutations(transaction) {
        const root = this.collectionRoot(transaction.collection)
        const directories = new Set()
        for (const capture of transaction.captures) {
            const target = path.join(root, capture.path)
            await syncFileIfPresent(target)
            directories.add(path.dirname(target))
        }
        for (const directory of directories) {
            if (await exists(directory)) await syncDirectory(directory)
        }
    }

    /** @param {any} transaction */
    async finish(transaction) {
        await this.writeState(transaction.collection, {
            format: STATE_FORMAT,
            generation: transaction.generationBefore + 2,
            state: 'stable'
        })
        await rm(this.transactionRoot(transaction.collection, transaction.id), {
            recursive: true,
            force: true
        })
    }

    /** @param {any} transaction */
    async restoreBeforeImages(transaction) {
        const transactionRoot = this.transactionRoot(transaction.collection, transaction.id)
        const collectionRoot = this.collectionRoot(transaction.collection)
        for (const capture of [...transaction.captures].reverse()) {
            const target = path.join(collectionRoot, capture.path)
            if (!capture.present) {
                await rm(target, { force: true })
                if (await exists(path.dirname(target))) await syncDirectory(path.dirname(target))
                continue
            }
            const backup = path.join(transactionRoot, capture.backup)
            await mkdir(path.dirname(target), { recursive: true })
            // Use the same durable-writer scratch convention that document
            // scanners explicitly ignore. Raw files may have arbitrary
            // extensions, so a target-prefixed rollback sibling must never be
            // interpreted as a second file with the same TTID.
            const scratch = `${target}.${Bun.randomUUIDv7()}.tmp`
            await copyDurable(backup, scratch)
            await rename(scratch, target)
            await utimes(target, new Date(capture.mtimeMs), new Date(capture.mtimeMs))
            restoreXattrs(target, capture.xattrs ?? [])
            await syncFileIfPresent(target)
            // Apply readonly/mode only after metadata and file flushing; a
            // readonly Windows file cannot be reopened for either operation.
            await chmod(target, capture.mode & 0o777)
            await syncDirectory(path.dirname(target))
        }
    }

    /**
     * Restores untrusted recovery entries exclusively through pinned directory
     * descriptors. No pathname mutation can follow a swapped symlink.
     * @param {any} transaction
     * @param {number} collectionFd
     * @param {number} transactionFd
     */
    async restoreBeforeImagesSecure(transaction, collectionFd, transactionFd) {
        for (const capture of [...transaction.captures].reverse()) {
            if (!capture.present) {
                unlinkAtRoot(collectionFd, capture.path)
                continue
            }
            const backupFd = openFileAtRoot(transactionFd, capture.backup)
            if (backupFd === null) throw new Error('Transaction backup is missing')
            const scratch = `${capture.path}.${Bun.randomUUIDv7()}.tmp`
            let scratchFd
            try {
                scratchFd = openFileAtRootWithFlags(
                    collectionFd,
                    scratch,
                    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
                    0o600
                )
                copyDescriptor(backupFd, scratchFd)
                syncSecureDescriptor(scratchFd)
            } finally {
                closeSecureDescriptor(backupFd)
                if (scratchFd !== undefined) closeSecureDescriptor(scratchFd)
            }
            renameAtRoots(collectionFd, scratch, collectionFd, capture.path)
            const targetFd = openFileAtRootWithFlags(collectionFd, capture.path, constants.O_RDWR)
            if (targetFd === null) throw new Error('Restored transaction target is missing')
            try {
                timesSecureDescriptor(
                    targetFd,
                    new Date(capture.mtimeMs),
                    new Date(capture.mtimeMs)
                )
                restoreXattrsFd(targetFd, capture.xattrs ?? [])
                // Apply readonly/mode last: Windows must be able to write the
                // ADS metadata streams before FILE_ATTRIBUTE_READONLY is set.
                chmodSecureDescriptor(targetFd, capture.mode)
                syncSecureDescriptor(targetFd)
            } finally {
                closeSecureDescriptor(targetFd)
            }
        }
    }

    /** @param {any} transaction @param {number} collectionFd */
    truncateEventsSecure(transaction, collectionFd) {
        const relative = path.relative(
            this.collectionRoot(transaction.collection),
            this.eventPath(transaction.collection)
        )
        const readable = openFileAtRoot(collectionFd, relative)
        if (readable === null) {
            if (transaction.eventOffset === 0) return
            throw new Error('Transaction event journal is missing')
        }
        closeSecureDescriptor(readable)
        const descriptor = openFileAtRootWithFlags(collectionFd, relative, constants.O_RDWR)
        try {
            truncateSecureDescriptor(descriptor, transaction.eventOffset)
            syncSecureDescriptor(descriptor)
        } finally {
            closeSecureDescriptor(descriptor)
        }
    }

    /** @param {any} transaction @param {number} journalFd */
    finishRecoverySecure(transaction, journalFd) {
        writeDurableAtRoot(
            journalFd,
            'state.json',
            `${JSON.stringify({
                format: STATE_FORMAT,
                generation: transaction.generationBefore + 2,
                state: 'stable'
            })}\n`
        )
        unlinkAtRoot(journalFd, path.join(transaction.id, 'transaction.json'))
        for (const capture of transaction.captures) {
            if (capture.present) unlinkAtRoot(journalFd, path.join(transaction.id, capture.backup))
        }
        for (let index = 0; index < transaction.captures.length; index += 1) {
            unlinkAtRoot(
                journalFd,
                path.join(transaction.id, 'captures', `${String(index).padStart(6, '0')}.json`)
            )
        }
        try {
            unlinkAtRoot(journalFd, path.join(transaction.id, 'before'), true)
        } catch (error) {
            if (!hasCode(error, 'ENOENT')) throw error
        }
        try {
            unlinkAtRoot(journalFd, path.join(transaction.id, 'captures'), true)
        } catch (error) {
            if (!hasCode(error, 'ENOENT')) throw error
        }
        unlinkAtRoot(journalFd, transaction.id, true)
    }

    /** @param {any} transaction */
    async truncateEvents(transaction) {
        const target = this.eventPath(transaction.collection)
        if (!(await exists(target))) return
        await truncate(target, transaction.eventOffset)
        const handle = await open(target, process.platform === 'win32' ? 'r+' : 'r')
        try {
            await handle.sync()
        } finally {
            await handle.close()
        }
    }

    /**
     * Reads a transaction manifest through pinned descriptors. Captures live
     * either inline in the manifest or in segment files, never both.
     * @param {number} transactionFd
     * @param {string} collection
     * @param {string} id
     * @returns {Promise<Record<string, any>>}
     */
    async loadTransactionManifest(transactionFd, collection, id) {
        const manifestFd = openFileAtRoot(transactionFd, 'transaction.json')
        if (manifestFd === null) throw new Error('Transaction manifest is missing')
        let transaction
        try {
            transaction = readJsonDescriptor(manifestFd, MAX_MANIFEST_BYTES, 'Transaction manifest')
        } finally {
            closeSecureDescriptor(manifestFd)
        }
        const segmentedCaptures = await readCaptureSegments(
            transactionFd,
            this.transactionRoot(collection, id)
        )
        if (segmentedCaptures.length > 0) {
            if (!Array.isArray(transaction.captures) || transaction.captures.length !== 0) {
                throw new Error('Transaction mixes inline and segmented captures')
            }
            transaction.captures = segmentedCaptures
        }
        return transaction
    }

    /**
     * Recovers an interrupted transaction while the caller holds the
     * collection write lock.
     * @param {string} collection
     * @returns {Promise<boolean>} whether recovery work was performed
     */
    async recover(collection) {
        const state = await this.state(collection)
        if (state.state === 'stable') {
            // A crash after publishing the stable generation but before
            // removing its transaction directory leaves only harmless debris.
            // Clean it here so journals stay bounded without affecting data.
            await this.cleanupOrphans(collection)
            return false
        }
        const id = assertRecoverableTransactionId(state.transactionId, collection)
        let journalFd
        let transactionFd
        let collectionFd
        let transaction
        const startedAt = new Date().toISOString()
        try {
            journalFd = openDirectoryNoFollow(this.root(collection))
            transactionFd = openFileAtRoot(journalFd, id)
            if (transactionFd === null || !statSecureDescriptor(transactionFd).isDirectory()) {
                throw new Error('Transaction journal directory is missing')
            }
            transaction = await this.loadTransactionManifest(transactionFd, collection, id)
            await validateRecoveryManifest(
                transaction,
                collection,
                id,
                this.collectionRoot(collection),
                this.root(collection)
            )
            this.activity.set(collection, {
                status: 'recovering',
                transactionId: transaction.id,
                operation: transaction.operation,
                phase: transaction.phase,
                startedAt
            })
            emitFyloEvent(this.onEvent, {
                type: 'transaction.recovery.started',
                collection,
                transactionId: transaction.id,
                operation: transaction.operation,
                phase: transaction.phase,
                startedAt
            })
            collectionFd = openDirectoryNoFollow(this.collectionRoot(collection))
            const eventRelative = path.relative(
                this.collectionRoot(collection),
                this.eventPath(collection)
            )
            containedPath(this.collectionRoot(collection), eventRelative, 'Transaction event path')
            assertEventJournalBounds(transaction, collectionFd, eventRelative)
            if (transaction.phase !== 'committed') {
                await this.restoreBeforeImagesSecure(transaction, collectionFd, transactionFd)
                this.truncateEventsSecure(transaction, collectionFd)
            }
            await this.rebuild(collection)
            await this.invalidate(collection)
            this.finishRecoverySecure(transaction, journalFd)
            const completedAt = new Date().toISOString()
            this.activity.set(collection, {
                status: 'idle',
                lastAction: 'recovery',
                transactionId: transaction.id,
                operation: transaction.operation,
                phase: transaction.phase,
                startedAt,
                completedAt
            })
            emitFyloEvent(this.onEvent, {
                type: 'transaction.recovery.succeeded',
                collection,
                transactionId: transaction.id,
                operation: transaction.operation,
                phase: transaction.phase,
                startedAt,
                completedAt
            })
            return true
        } catch (error) {
            const failedAt = new Date().toISOString()
            const detail = error instanceof Error ? error.message : String(error)
            this.activity.set(collection, {
                status: 'failed',
                lastAction: 'recovery',
                ...(transaction?.id ? { transactionId: transaction.id } : {}),
                ...(transaction?.operation ? { operation: transaction.operation } : {}),
                ...(transaction?.phase ? { phase: transaction.phase } : {}),
                startedAt,
                failedAt,
                detail
            })
            emitFyloEvent(this.onEvent, {
                type: 'transaction.recovery.failed',
                collection,
                transactionId: transaction?.id ?? id,
                operation: transaction?.operation,
                phase: transaction?.phase,
                startedAt,
                failedAt,
                detail
            })
            throw new Error(
                `Active collection transaction manifest is missing or corrupt: ${collection}`,
                { cause: error }
            )
        } finally {
            if (collectionFd !== undefined) closeSecureDescriptor(collectionFd)
            if (transactionFd !== undefined) closeSecureDescriptor(transactionFd)
            if (journalFd !== undefined) closeSecureDescriptor(journalFd)
        }
    }

    /** @param {string} collection */
    async cleanupOrphans(collection) {
        let entries
        try {
            entries = await readdir(this.root(collection), { withFileTypes: true })
        } catch (error) {
            if (hasCode(error, 'ENOENT')) return
            throw error
        }
        await Promise.all(
            entries
                .filter((entry) => entry.isDirectory())
                .map((entry) =>
                    rm(path.join(this.root(collection), entry.name), {
                        recursive: true,
                        force: true
                    })
                )
        )
    }

    /**
     * Retries a materialized read when a concurrent writer changes the
     * collection generation during the scan.
     * @template T
     * @param {string} collection
     * @param {() => Promise<T>} read
     * @param {() => Promise<void>} recover
     * @returns {Promise<T>}
     */
    async readStable(collection, read, recover) {
        for (let attempt = 0; attempt < 8; attempt++) {
            const before = await this.state(collection)
            if (before.state === 'writing') {
                await recover()
                continue
            }
            const result = await read()
            const after = await this.state(collection)
            if (after.state === 'stable' && after.generation === before.generation) {
                return result
            }
        }
        throw new Error(`Unable to obtain a stable collection snapshot: ${collection}`)
    }
}
