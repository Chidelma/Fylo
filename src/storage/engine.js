import path from 'node:path'
import { existsSync } from 'node:fs'
import { CollectionNotFoundError, validateCollectionName } from '../core/collection.js'
import { assertPathInside, legacyShardOf, shardOf, validateDocId } from '../core/doc-id.js'
import { Cipher } from '../security/cipher.js'
import { FyloSyncError, resolveSyncMode } from '../replication/sync.js'
import { FyloS3Backup } from '../replication/s3-backup.js'
import { emitFyloEvent } from '../observability/events.js'
import { FilesystemEventBus, FilesystemLockManager, FilesystemStorage } from './primitives.js'
import { FilesystemDocuments } from './documents.js'
import {
    FilesystemFiles,
    KEY_XATTR,
    META_UPDATED_XATTR,
    META_XATTR_PREFIX,
    metaMutations
} from './files.js'
import { FilesystemQueryEngine } from './query.js'
import { materializeDoc } from '../schema/migrate.js'
import { LocalFsPrefixIndexStore, assertIndexableDocument } from './prefix-index.js'
import { parseStoredValue, stringifyStoredValue } from './value-codec.js'
import { getXattr, listXattr, removeXattr, setXattr } from './xattr.js'
import { rawFileKey } from '../core/raw-file.js'
import { tryReleaseFileLock, waitAcquireFileLock } from './fs-lock.js'
import { CollectionTransactionJournal } from './transactions.js'
import {
    ACCESS_XATTR,
    FyloPermissionError,
    applyAccessDescriptor,
    createPosixGroupResolver,
    descriptorAllows,
    normalizeResolvedGroupIds,
    readAccessDescriptor,
    restoreAccessDescriptor,
    restoreAccessState,
    snapshotAccessState
} from '../security/access.js'

/**
 * @typedef {import('../types/vendor.js').TTID} TTID
 * @typedef {import('../replication/sync.js').FyloSyncHooks<Record<string, any>>} FyloSyncHooks
 * @typedef {import('../replication/sync.js').FyloSyncMode} FyloSyncMode
 * @typedef {import('../replication/sync.js').FyloWriteSyncEvent<Record<string, any>>} FyloWriteSyncEvent
 * @typedef {import('../replication/sync.js').FyloDeleteSyncEvent} FyloDeleteSyncEvent
 * @typedef {import('../replication/sync.js').FyloWormOptions} FyloWormOptions
 * @typedef {import('../replication/sync.js').FyloAccessOptions} FyloAccessOptions
 * @typedef {import('../observability/events.js').FyloEventHandler} FyloEventHandler
 * @typedef {import('./types.js').StorageEngine} StorageEngine
 * @typedef {import('./types.js').LockManager} LockManager
 * @typedef {import('./types.js').EventBus<Record<string, any>>} EventBus
 * @typedef {import('./types.js').CollectionInspectResult} CollectionInspectResult
 * @typedef {import('./types.js').CollectionRebuildResult} CollectionRebuildResult
 * @typedef {import('./types.js').CollectionCreateOptions} CollectionCreateOptions
 * @typedef {import('./types.js').FyloCollectionKind} FyloCollectionKind
 * @typedef {import('./types.js').FilesystemEvent<Record<string, any>>} FilesystemEvent
 * @typedef {import('./types.js').StoredDoc<Record<string, any>>} StoredDoc
 * @typedef {import('./files.js').RawFileSource} RawFileSource
 * @typedef {import('./types.js').PrefixIndexStore} PrefixIndexStore
 * @typedef {import('../queue/local.js').LocalQueue} LocalQueue
 * @typedef {import('../cache/query.js').QueryCache} QueryCache
 * @typedef {import('../query/types.js').StoreJoin<Record<string, any>, Record<string, any>>} StoreJoin
 * @typedef {import('../query/types.js').StoreQuery<Record<string, any>>} StoreQuery
 * @typedef {{ id: TTID, createdAt: number, updatedAt: number, deletedAt?: number, data: Record<string, any>, path?: string }} StoredRecord
 */

/**
 * Comparison operators available to a join's `$on` clause.
 * @type {Record<string, (leftValue: unknown, rightValue: unknown) => boolean>}
 */
const JOIN_COMPARATORS = {
    $eq: (leftValue, rightValue) => leftValue === rightValue,
    $ne: (leftValue, rightValue) => leftValue !== rightValue,
    $gt: (leftValue, rightValue) => Number(leftValue) > Number(rightValue),
    $lt: (leftValue, rightValue) => Number(leftValue) < Number(rightValue),
    $gte: (leftValue, rightValue) => Number(leftValue) >= Number(rightValue),
    $lte: (leftValue, rightValue) => Number(leftValue) <= Number(rightValue)
}

/**
 * How each join mode combines a matched pair.
 * @type {Record<string, (leftData: Record<string, any>, rightData: Record<string, any>) => Record<string, any>>}
 */
const JOIN_MODES = {
    inner: (leftData, rightData) => ({ ...leftData, ...rightData }),
    left: (leftData) => leftData,
    right: (leftData, rightData) => rightData,
    outer: (leftData, rightData) => ({ ...leftData, ...rightData })
}

/**
 * Buckets joined rows by `$groupby`, returning ids only when the join asked
 * for them.
 * @param {any} join
 * @param {Record<string, Record<string, any>>} docs
 */
function groupJoinedDocs(join, docs) {
    /** @type {Record<string, Record<string, Record<string, any>>>} */
    const groupedDocs = {}
    for (const ids in docs) {
        const data = docs[ids]
        const key = String(data[join.$groupby])
        if (!groupedDocs[key]) groupedDocs[key] = {}
        groupedDocs[key][ids] = data
    }
    if (!join.$onlyIds) return groupedDocs
    /** @type {Record<string, string[]>} */
    const groupedIds = {}
    for (const key in groupedDocs) groupedIds[key] = Object.keys(groupedDocs[key]).flat()
    return groupedIds
}

/**
 * @param {string} collection
 * @param {string} field
 * @param {string} reason
 * @returns {Error & { code: string }}
 */
function decryptionFailure(collection, field, reason) {
    const error = /** @type {Error & { code: string }} */ (
        new Error(
            `Cannot decrypt encrypted field "${field}" in collection "${collection}": ${reason}.`
        )
    )
    error.code = 'EDECRYPTFAILED'
    return error
}

/**
 * `writeDurable` replaces the target inode. Preserve developer metadata and
 * the protected-record access descriptor across JSON document rewrites.
 * @param {string} target
 * @returns {Array<[string, Uint8Array]>}
 */
function developerMetadataXattrs(target) {
    /** @type {Array<[string, Uint8Array]>} */
    const attributes = []
    for (const name of listXattr(target)) {
        if (
            !name.startsWith(META_XATTR_PREFIX) &&
            name !== META_UPDATED_XATTR &&
            name !== ACCESS_XATTR
        )
            continue
        const value = getXattr(target, name)
        if (value !== null) attributes.push([name, value])
    }
    return attributes
}

/** @param {string} target @param {Array<[string, Uint8Array]>} attributes */
function restoreDeveloperMetadataXattrs(target, attributes) {
    for (const [name, value] of attributes) setXattr(target, name, value)
}

/** @param {string} target @returns {Array<[string, Uint8Array]>} */
function snapshotMetadataXattrs(target) {
    return developerMetadataXattrs(target)
}

/** @param {string} target @param {Array<[string, Uint8Array]>} snapshot */
function restoreMetadataXattrsExact(target, snapshot) {
    const expected = new Set(snapshot.map(([name]) => name))
    for (const name of listXattr(target)) {
        if (
            (name.startsWith(META_XATTR_PREFIX) ||
                name === META_UPDATED_XATTR ||
                name === ACCESS_XATTR) &&
            !expected.has(name)
        ) {
            removeXattr(target, name)
        }
    }
    restoreDeveloperMetadataXattrs(target, snapshot)
}

/**
 * Low-level filesystem storage engine for collections, documents, indexes,
 * events, locks, and strict read-only WORM documents.
 */
/**
 * Resolve a record's path under its shard.
 *
 * Records live under the last two characters of their creation segment. A root
 * written before that change used the first two, so a path that does not exist
 * canonically falls back to the superseded location: an unmigrated root stays
 * readable, and so does a partly migrated one, which is the state an
 * interrupted migration leaves. A record that exists in neither resolves to the
 * canonical path, so new writes always land there.
 *
 * @param {string} root @param {string} docId @param {string} filename
 * @returns {string}
 */
function shardedPath(root, docId, filename) {
    const target = path.join(root, shardOf(docId), filename)
    assertPathInside(root, target)
    if (existsSync(target)) return target
    const legacy = path.join(root, legacyShardOf(docId), filename)
    assertPathInside(root, legacy)
    return existsSync(legacy) ? legacy : target
}

export class FilesystemEngine {
    /** @type {string} */
    root
    /** @type {'filesystem'} */
    kind = 'filesystem'
    /** @type {Map<string, Promise<void>>} */
    writeLanes = new Map()
    /** @type {Map<string, Promise<TTID[]>>} */
    cacheMissLanes = new Map()
    /** @type {StorageEngine} */
    storage
    /** @type {LockManager} */
    locks
    /** @type {EventBus} */
    events
    /** @type {LocalQueue | undefined} */
    queue
    /** @type {QueryCache | undefined} */
    queryCache
    /** @type {FilesystemDocuments} */
    documents
    /** @type {FilesystemFiles} */
    files
    /** @type {FilesystemQueryEngine} */
    queryEngine
    /** @type {PrefixIndexStore} */
    index
    /** @type {CollectionTransactionJournal} */
    transactions
    /** @type {FyloSyncHooks | undefined} */
    sync
    /** @type {FyloSyncMode} */
    syncMode
    /** @type {Required<FyloWormOptions>} */
    worm
    /** @type {FyloEventHandler | undefined} */
    onEvent
    /** @type {string} */
    catalogRoot
    /** @type {boolean} */
    repositoryGate
    /** @type {NonNullable<FyloAccessOptions['groupsForUid']> | undefined} */
    groupsForUid
    /**
     * Creates the filesystem-backed FYLO engine and its persistence collaborators.
     * @param {string} [root]
     * @param {{ sync?: FyloSyncHooks, syncMode?: FyloSyncMode, worm?: FyloWormOptions, access?: FyloAccessOptions, onEvent?: FyloEventHandler, queue?: LocalQueue, queryCache?: QueryCache, catalogRoot?: string, repositoryGate?: boolean, ensureEncryptionLoaded?: (collection: string) => Promise<void> }} [options]
     */
    constructor(
        root = process.env.FYLO_ROOT || path.join(process.cwd(), '.fylo-data'),
        options = {}
    ) {
        this.root = root
        this.catalogRoot = options.catalogRoot ?? root
        this.sync = options.sync
        this.syncMode = resolveSyncMode(options.syncMode)
        /**
         * Built-in whole-root S3 backup, when `sync.s3` is configured. Mirrors
         * touched files on write and reconciles the whole root on an interval /
         * on demand. Undefined leaves S3 out of the picture entirely.
         * @type {FyloS3Backup | undefined}
         */
        this.backup = options.sync?.s3
            ? new FyloS3Backup(options.sync.s3, root, { onEvent: options.onEvent })
            : undefined
        this.backup?.start()
        this.worm = {
            mode: options.worm?.mode ?? 'off'
        }
        this.groupsForUid = options.access?.groupsForUid ?? createPosixGroupResolver()
        this.onEvent = options.onEvent
        this.repositoryGate = options.repositoryGate !== false
        this.storage = new FilesystemStorage()
        /**
         * Sync cache of each collection's kind, so path builders can route
         * document collections to `.collections/` and file collections
         * (buckets) to `.buckets/` without an async descriptor read. Warmed by
         * {@link resolveKind} before any sync path is built.
         * @type {Map<string, FyloCollectionKind>}
         */
        this.kinds = new Map()
        this.locks = new FilesystemLockManager(this.collectionRoot.bind(this), this.storage)
        this.events = new FilesystemEventBus(this.collectionRoot.bind(this), this.storage)
        this.queue = options.queue
        this.queryCache = options.queryCache
        /**
         * Loads a collection's schema-driven `$encrypted` registration. Every
         * decode calls this, so a read-only process decrypts without first
         * having to write. Defaults to a no-op for engines built without the
         * API layer (no schema directory is in play there).
         * @type {(collection: string) => Promise<void>}
         */
        this.ensureEncryptionLoaded = options.ensureEncryptionLoaded ?? (async () => {})
        this.index = new LocalFsPrefixIndexStore(this.collectionRoot.bind(this))
        this.documents = new FilesystemDocuments(
            this.storage,
            this.docsRoot.bind(this),
            this.docPath.bind(this),
            this.deletedRoot.bind(this),
            this.deletedPath.bind(this),
            this.ensureCollection.bind(this),
            this.encodeEncrypted.bind(this),
            this.decodeEncrypted.bind(this),
            this.root
        )
        this.files = new FilesystemFiles(
            this.storage,
            this.docsRoot.bind(this),
            this.deletedRoot.bind(this),
            this.ensureCollection.bind(this)
        )
        this.queryEngine = new FilesystemQueryEngine({
            index: this.index
        })
        this.transactions = new CollectionTransactionJournal({
            collectionRoot: this.collectionRoot.bind(this),
            journalRoot: (collection) =>
                path.join(
                    this.root,
                    '.fylo-transactions',
                    this.namespaceDir(collection),
                    collection
                ),
            eventPath: (collection) =>
                path.join(this.collectionRoot(collection), 'events', `${collection}.ndjson`),
            rebuild: this.rebuildCollectionIndexUnlocked.bind(this),
            invalidate: this.invalidateQueryCache.bind(this),
            onEvent: options.onEvent
        })
    }
    /**
     * @param {string} collection
     * @param {FilesystemEvent} event
     * @returns {Promise<void>}
     */
    async publishDocumentEvent(collection, event) {
        await this.events.publish(collection, event)
        const publishQueue = async () => {
            await this.queue?.publishCollectionEvent(collection, event)
        }
        if (!this.transactions.deferAfterCommit(publishQueue)) await publishQueue()
    }
    /**
     * On-disk namespace for a collection: `.buckets` for byte collections
     * (files), `.collections` for document (Record) collections. Reads the
     * synchronous kind cache; defaults to `.collections` until warmed.
     * @param {string} collection @returns {string}
     */
    namespaceDir(collection) {
        return this.kinds.get(collection) === 'file' ? '.buckets' : '.collections'
    }
    /** @param {string} collection @returns {string} */
    collectionRoot(collection) {
        validateCollectionName(collection)
        return path.join(this.root, this.namespaceDir(collection), collection)
    }
    /** @param {string} collection @returns {string} */
    docsRoot(collection) {
        return path.join(this.collectionRoot(collection), 'docs')
    }
    /** @param {string} collection @returns {string} */
    deletedRoot(collection) {
        return path.join(this.collectionRoot(collection), '.deleted')
    }
    /** @param {string} collection @returns {string} */
    metaRoot(collection) {
        return this.collectionRoot(collection)
    }
    /** @param {string} collection @returns {string} */
    collectionDescriptorPath(collection) {
        validateCollectionName(collection)
        return path.join(this.catalogRoot, '.fylo-catalog', 'collections', `${collection}.json`)
    }
    /**
     * Resolves a collection's kind from its catalog descriptor (the authority,
     * at a location-independent path), warms the sync {@link kinds} cache, and
     * lazily migrates a legacy `.collections/<name>` file collection to
     * `.buckets/<name>`. All sync path building depends on this having run for
     * the collection first — `hasCollection` and `createCollection` ensure it.
     * @param {string} collection @returns {Promise<FyloCollectionKind>}
     */
    async resolveKind(collection) {
        validateCollectionName(collection)
        const cached = this.kinds.get(collection)
        if (cached !== undefined) return cached
        const descriptor = this.collectionDescriptorPath(collection)
        /** @type {FyloCollectionKind} */
        let kind = 'document'
        if (await this.storage.exists(descriptor)) {
            const parsed = /** @type {{ kind?: unknown }} */ (
                JSON.parse(await this.storage.read(descriptor))
            )
            if (parsed.kind !== 'document' && parsed.kind !== 'file') {
                throw new Error(`Collection descriptor is corrupt: ${collection}`)
            }
            kind = parsed.kind
        }
        if (kind === 'file') await this.migrateBucketIfNeeded(collection)
        this.kinds.set(collection, kind)
        return kind
    }
    /** @param {string} collection @returns {Promise<FyloCollectionKind>} */
    async collectionKind(collection) {
        return await this.resolveKind(collection)
    }
    /**
     * Auto-migrate on open: move a byte collection's data from the legacy
     * `.collections/<name>` layout to `.buckets/<name>`. Idempotent and
     * crash-safe (a single rename); the catalog descriptor never moves.
     * @param {string} collection @returns {Promise<void>}
     */
    async migrateBucketIfNeeded(collection) {
        const bucketPath = path.join(this.root, '.buckets', collection)
        if (await this.storage.exists(bucketPath)) return
        const legacyPath = path.join(this.root, '.collections', collection)
        if (await this.storage.exists(legacyPath)) {
            await this.storage.move(legacyPath, bucketPath)
        }
    }
    /**
     * @param {string} collection
     * @param {FyloCollectionKind} expected
     * @returns {Promise<void>}
     */
    async requireCollectionKind(collection, expected) {
        const actual = await this.collectionKind(collection)
        if (actual !== expected) {
            throw new Error(
                `Collection "${collection}" is a ${actual} collection, not a ${expected} collection`
            )
        }
    }
    /** @param {string} collection @param {TTID} docId @returns {string} */
    docPath(collection, docId) {
        // ponytail: docId is validated at the public method / storage-layer entry
        // before it reaches this sync path-builder; re-checking via the async
        // `ttid` binary here would force every path build async.
        return shardedPath(this.docsRoot(collection), docId, `${docId}.json`)
    }
    /** @param {string} collection @param {TTID} docId @returns {string} */
    deletedPath(collection, docId) {
        return shardedPath(this.deletedRoot(collection), docId, `${docId}.json`)
    }
    /**
     * Runs a configured sync hook according to the collection's sync mode.
     * @param {string} collection
     * @param {TTID} docId
     * @param {'insert' | 'delete' | string} operation
     * @param {string} targetPath
     * @param {() => Promise<void>} task
     * @returns {Promise<void>}
     */
    async runSyncTask(collection, docId, operation, targetPath, task) {
        if (!this.sync?.onWrite && !this.sync?.onDelete && !this.backup) return
        const run = async () => {
            if (this.syncMode !== 'fire-and-forget') {
                try {
                    await task()
                } catch (cause) {
                    throw new FyloSyncError({
                        collection,
                        docId,
                        operation,
                        path: targetPath,
                        cause
                    })
                }
                return
            }
            void task().catch((cause) => {
                const error = new FyloSyncError({
                    collection,
                    docId,
                    operation,
                    path: targetPath,
                    cause
                })
                console.error(error)
                emitFyloEvent(this.onEvent, {
                    type: 'sync.failed',
                    collection,
                    docId: String(docId),
                    operation,
                    path: targetPath,
                    detail: cause instanceof Error ? cause.message : String(cause)
                })
            })
        }
        if (!this.transactions.deferAfterCommit(run)) await run()
    }
    /** @param {FyloWriteSyncEvent} event @returns {Promise<void>} */
    async syncWrite(event) {
        if (this.sync?.onWrite) await this.sync.onWrite(event)
        if (this.backup) {
            await this.backup.mirror([event.path, ...this.collectionBackupPaths(event.collection)])
        }
    }
    /** @param {FyloDeleteSyncEvent} event @returns {Promise<void>} */
    async syncDelete(event) {
        if (this.sync?.onDelete) await this.sync.onDelete(event)
        if (this.backup) {
            // The record moved from `docs/` into the `.deleted/` tombstone: drop
            // the old docs object, then mirror the tombstone plus the updated
            // index/catalog.
            if (event.previousPath) await this.backup.remove([event.previousPath])
            await this.backup.mirror([event.path, ...this.collectionBackupPaths(event.collection)])
        }
    }

    /**
     * Files that change alongside any document write and must ride along with a
     * mirror-on-write: the collection's local index and its catalog descriptor.
     * Missing entries are skipped by {@link FyloS3Backup.mirror}.
     * @param {string} collection @returns {string[]}
     */
    collectionBackupPaths(collection) {
        const indexDir = path.join(this.collectionRoot(collection), 'index')
        return [
            path.join(indexDir, 'manifest.json'),
            path.join(indexDir, 'keys.snapshot'),
            path.join(indexDir, 'keys.wal'),
            this.collectionDescriptorPath(collection)
        ]
    }

    /**
     * Mirror a record whose xattrs changed without rewriting its bytes.
     * @param {string} collection @param {string} docId
     * @param {'meta' | 'rekey'} operation @param {string} targetPath
     */
    async mirrorRecordMetadata(collection, docId, operation, targetPath) {
        const backup = this.backup
        if (!backup) return
        await this.runSyncTask(collection, /** @type {TTID} */ (docId), operation, targetPath, () =>
            backup.mirror([targetPath, ...this.collectionBackupPaths(collection)])
        )
    }

    /**
     * Reconcile the whole local root to S3 (upload changed, delete removed).
     * No-op when S3 backup isn't configured.
     * @returns {Promise<void>}
     */
    async reconcile() {
        await this.backup?.reconcile()
    }

    /** @returns {Readonly<import('../replication/s3-backup.js').FyloS3Backup['status']> | undefined} */
    backupStatus() {
        return this.backup ? { ...this.backup.status } : undefined
    }

    /** Drain background backup work and release backup-owned descriptors. */
    async close() {
        await this.backup?.close()
    }
    /** @param {string} collection @returns {Promise<void>} */
    async ensureCollection(collection) {
        // Warm the kind cache so every path below resolves to the right
        // namespace (.collections vs .buckets), even on a cold engine.
        await this.resolveKind(collection)
        await this.storage.mkdir(this.collectionRoot(collection))
        await this.assertNoLegacyWormArtifacts(collection)
        await this.storage.mkdir(this.metaRoot(collection))
        await this.storage.mkdir(this.docsRoot(collection))
        await this.storage.mkdir(this.deletedRoot(collection))
        await this.index.ensureCollection(collection)
    }
    /** @param {string} collection @returns {Promise<void>} */
    async requireCollection(collection) {
        if (!(await this.hasCollection(collection))) throw new CollectionNotFoundError(collection)
        if (!this.transactions.isActive(collection)) await this.recoverCollection(collection)
    }

    /**
     * Recovers an interrupted logical transaction under the same exclusive
     * collection lock used by writers.
     * @param {string} collection
     * @returns {Promise<void>}
     */
    async recoverCollection(collection) {
        const state = await this.transactions.state(collection)
        if (state.state === 'stable') return
        const owner = Bun.randomUUIDv7()
        await this.storage.mkdir(this.metaRoot(collection))
        await this.locks.acquireCollectionWrite(collection, owner)
        try {
            await this.transactions.recover(collection)
        } finally {
            await this.locks.releaseCollectionWrite(collection, owner)
        }
    }

    /**
     * Materializes one generation-consistent read, retrying if a concurrent
     * transaction commits during the operation.
     * @template T
     * @param {string} collection
     * @param {() => Promise<T>} read
     * @returns {Promise<T>}
     */
    async readStable(collection, read) {
        if (this.transactions.isActive(collection)) return await read()
        return await this.transactions.readStable(collection, read, () =>
            this.recoverCollection(collection)
        )
    }

    /**
     * Groups nested collection mutations into one durable rollback and
     * generation boundary.
     * @template T
     * @param {string} collection
     * @param {string} operation
     * @param {() => Promise<T>} action
     * @returns {Promise<T>}
     */
    async atomic(collection, operation, action) {
        await this.requireCollection(collection)
        return await this.withCollectionWriteLock(collection, action, operation)
    }
    /**
     * Refuses to reinterpret append-only WORM files as independent live docs
     * after the strict WORM storage format change.
     * @param {string} collection
     * @returns {Promise<void>}
     */
    async assertNoLegacyWormArtifacts(collection) {
        const legacyPaths = ['heads', 'versions']
        for (const legacyPath of legacyPaths) {
            const files = await this.storage.list(
                path.join(this.collectionRoot(collection), legacyPath)
            )
            if (files.length > 0) {
                throw new Error(
                    `Collection '${collection}' contains unsupported legacy WORM ${legacyPath} metadata; migrate or remove legacy versions before opening it`
                )
            }
        }
    }
    /** @returns {boolean} */
    wormEnabled() {
        return this.worm.mode === 'strict'
    }
    /** @param {string} collection @returns {Promise<void>} */
    async invalidateQueryCache(collection) {
        if (!this.queryCache) return
        try {
            await this.queryCache.bumpCollection(collection)
        } catch (err) {
            if (this.queryCache.required || this.queryCache.method === 'write-through') throw err
        }
    }
    /** @param {string} collection @returns {Promise<number | null>} */
    async queryCacheVersion(collection) {
        if (!this.queryCache) return null
        try {
            return await this.queryCache.version(collection)
        } catch (err) {
            if (this.queryCache.required) throw err
            return null
        }
    }
    /**
     * @param {'active' | 'deleted'} kind
     * @param {string} collection
     * @param {StoreQuery | undefined} query
     * @param {number | null} version
     * @returns {Promise<TTID[] | null>}
     */
    async cachedQueryIds(kind, collection, query, version) {
        if (!this.queryCache || version === null) return null
        try {
            return await this.queryCache.getIds(kind, collection, version, query)
        } catch (err) {
            if (this.queryCache.required) throw err
            return null
        }
    }
    /**
     * @param {'active' | 'deleted'} kind
     * @param {string} collection
     * @param {StoreQuery | undefined} query
     * @param {number | null} version
     * @param {TTID[]} ids
     * @returns {Promise<void>}
     */
    async cacheQueryIds(kind, collection, query, version, ids) {
        if (!this.queryCache || version === null) return
        try {
            if ((await this.queryCache.version(collection)) !== version) return
            await this.queryCache.setIds(kind, collection, version, query, ids)
        } catch (err) {
            if (this.queryCache.required) throw err
        }
    }
    /**
     * @param {'active' | 'deleted'} kind
     * @param {string} collection
     * @param {StoreQuery | undefined} query
     * @param {number | null} version
     * @param {() => Promise<TTID[]>} loadIds
     * @returns {Promise<TTID[]>}
     */
    async loadCacheMissIds(kind, collection, query, version, loadIds) {
        if (!this.queryCache?.stampedeProtection || version === null) return await loadIds()
        const key = this.queryCache.key(kind, collection, version, query)
        const existing = this.cacheMissLanes.get(key)
        if (existing) return await existing
        const lane = loadIds().finally(() => {
            if (this.cacheMissLanes.get(key) === lane) this.cacheMissLanes.delete(key)
        })
        this.cacheMissLanes.set(key, lane)
        return await lane
    }
    /** @param {string} collection @returns {Promise<void>} */
    async resetIndex(collection) {
        await this.index.resetCollection(collection)
        await this.invalidateQueryCache(collection)
    }
    /** @param {string} collection @returns {Promise<TTID[]>} */
    async listQueryableDocIds(collection) {
        await this.requireCollection(collection)
        await this.assertNoLegacyWormArtifacts(collection)
        return (await this.collectionKind(collection)) === 'file'
            ? await this.files.listFileIds(collection)
            : await this.documents.listDocIds(collection)
    }
    /**
     * Overwrites a mutable document while preserving its identity.
     * @param {string} collection
     * @param {TTID} docId
     * @param {Record<string, any>} nextDoc
     * @param {Record<string, any>} oldDoc
     * @param {Record<string, any>=} meta
     * @param {number=} actorUid
     * @param {{ uid?: number, gid?: number, mode?: number }=} nextAccess
     * @returns {Promise<TTID>}
     */
    async updateDocument(
        collection,
        docId,
        nextDoc,
        oldDoc,
        meta = undefined,
        actorUid = undefined,
        nextAccess = undefined
    ) {
        const metaUpdates = meta === undefined ? undefined : metaMutations(meta)
        assertIndexableDocument(nextDoc)
        await validateDocId(docId)
        if (this.wormEnabled()) throw new Error('Update is not allowed in WORM mode')
        await this.requireCollectionKind(collection, 'document')
        await this.assertNoLegacyWormArtifacts(collection)
        return await this.withCollectionWriteLock(collection, async () => {
            const owner = Bun.randomUUIDv7()
            if (!(await this.locks.acquire(collection, docId, owner)))
                throw new Error(`Unable to acquire filesystem lock for ${docId}`)
            const targetPath = this.docPath(collection, docId)
            try {
                const existing =
                    oldDoc ?? (await this.documents.readStoredDoc(collection, docId))?.data
                if (!existing) return docId
                await this.assertDocumentAccess(collection, docId, actorUid, 'write')
                await this.transactions.capture(targetPath)
                await this.removeIndexes(collection, docId, existing)
                const metadata = developerMetadataXattrs(targetPath)
                const accessState = await snapshotAccessState(targetPath)
                try {
                    await this.documents.writeStoredDoc(collection, docId, nextDoc)
                    restoreDeveloperMetadataXattrs(targetPath, metadata)
                    if (metaUpdates?.length) this.applyDocMetaMutations(targetPath, metaUpdates)
                    if (nextAccess) {
                        await applyAccessDescriptor(targetPath, {
                            ...nextAccess,
                            ...(accessState.descriptor
                                ? {
                                      uid: accessState.descriptor.uid,
                                      gid: accessState.descriptor.gid
                                  }
                                : {})
                        })
                    } else {
                        await restoreAccessState(targetPath, accessState)
                    }
                    await this.rebuildIndexes(collection, docId, nextDoc)
                } catch (error) {
                    try {
                        await this.removeIndexes(collection, docId, nextDoc)
                        await this.documents.writeStoredDoc(collection, docId, existing)
                        restoreDeveloperMetadataXattrs(targetPath, metadata)
                        await restoreAccessState(targetPath, accessState)
                        await this.rebuildIndexes(collection, docId, existing)
                    } catch (rollbackError) {
                        throw new AggregateError(
                            [error, rollbackError],
                            'Document update failed and rollback was incomplete'
                        )
                    }
                    throw error
                }
                await this.publishDocumentEvent(collection, {
                    ts: Date.now(),
                    action: 'insert',
                    id: docId,
                    doc: await this.encodeEncrypted(collection, nextDoc)
                })
                await this.runSyncTask(collection, docId, 'patch', targetPath, async () => {
                    await this.syncWrite({
                        operation: 'patch',
                        collection,
                        docId,
                        path: targetPath,
                        data: nextDoc
                    })
                })
                await this.invalidateQueryCache(collection)
                return docId
            } finally {
                await this.locks.release(collection, docId, owner)
            }
        })
    }
    /**
     * @template T
     * @param {string} collection
     * @param {() => Promise<T>} action
     * @param {string} [operation]
     * @returns {Promise<T>}
     */
    async withCollectionWriteLock(collection, action, operation = 'write') {
        if (this.transactions.isActive(collection)) return await action()
        const previous = this.writeLanes.get(collection) ?? Promise.resolve()
        /** @type {() => void} */
        let release = () => {}
        /** @type {Promise<void>} */
        const current = new Promise((resolve) => {
            release = () => resolve()
        })
        const lane = previous.then(() => current)
        this.writeLanes.set(collection, lane)
        await previous
        const owner = Bun.randomUUIDv7()
        const repositoryGate = path.join(
            this.catalogRoot,
            '.fylo-vcs',
            'locks',
            'worktree',
            `${collection}.lock`
        )
        let repositoryGateHeld = false
        try {
            if (
                this.repositoryGate &&
                (await this.storage.exists(path.join(this.catalogRoot, '.fylo-vcs', 'HEAD')))
            ) {
                await waitAcquireFileLock(repositoryGate, owner, {
                    ttlMs: 300_000,
                    waitTimeoutMs: 60_000,
                    heartbeat: true
                })
                repositoryGateHeld = true
                const pendingTransactions = await this.storage.list(
                    path.join(this.catalogRoot, '.fylo-vcs', 'staging')
                )
                if (
                    pendingTransactions.some(
                        (target) => path.basename(target) === 'transaction.json'
                    )
                ) {
                    throw new Error(
                        'Pending version materialization requires repository startup recovery'
                    )
                }
            }
            await this.storage.mkdir(this.metaRoot(collection))
            await this.locks.acquireCollectionWrite(collection, owner, {
                onTakeover: (info) => {
                    emitFyloEvent(this.onEvent, {
                        type: 'lock.takeover',
                        lockPath: info.lockPath,
                        newOwner: info.newOwner,
                        previousOwner: info.previousOwner
                    })
                }
            })
            await this.transactions.recover(collection)
            return await this.transactions.run(collection, operation, action)
        } finally {
            try {
                await this.locks.releaseCollectionWrite(collection, owner)
            } finally {
                try {
                    if (repositoryGateHeld) await tryReleaseFileLock(repositoryGate, owner)
                } finally {
                    release()
                    if (this.writeLanes.get(collection) === lane) this.writeLanes.delete(collection)
                }
            }
        }
    }
    /** @param {string} collection @param {CollectionCreateOptions} [options] @returns {Promise<void>} */
    async createCollection(collection, options = {}) {
        const kind = options.kind ?? 'document'
        if (kind !== 'document' && kind !== 'file') {
            throw new Error('Collection kind must be "document" or "file"')
        }
        if (await this.hasCollection(collection)) {
            const existingKind = await this.collectionKind(collection)
            if (options.kind !== undefined && existingKind !== kind) {
                throw new Error(
                    `Collection "${collection}" already exists with kind "${existingKind}"`
                )
            }
            await this.ensureCollection(collection)
            return
        }
        if (options.versioned !== undefined && typeof options.versioned !== 'boolean') {
            throw new Error('Collection "versioned" option must be a boolean')
        }
        await this.storage.write(
            this.collectionDescriptorPath(collection),
            `${JSON.stringify({
                version: 1,
                kind,
                ...(options.versioned === false ? { versioned: false } : {})
            })}\n`
        )
        // Route this collection's paths to the right namespace before building them.
        this.kinds.set(collection, kind)
        await this.ensureCollection(collection)
        await this.invalidateQueryCache(collection)
    }
    /** @param {string} collection @returns {Promise<void>} */
    async dropCollection(collection) {
        await this.requireCollection(collection)
        const kind = await this.collectionKind(collection)
        const ids =
            kind === 'file'
                ? await this.files.listFileIds(collection)
                : await this.documents.listDocIds(collection)
        if (this.wormEnabled() && ids.length > 0) {
            throw new Error('Drop is not allowed for a non-empty WORM collection')
        }
        await this.storage.rmdir(this.collectionRoot(collection))
        this.kinds.delete(collection)
        await this.invalidateQueryCache(collection)
    }
    /** @param {string} collection @returns {Promise<boolean>} */
    async hasCollection(collection) {
        // Warm the kind cache (and migrate legacy buckets) so collectionRoot
        // resolves to the right namespace before we probe for existence.
        await this.resolveKind(collection)
        return await this.storage.exists(this.collectionRoot(collection))
    }
    /** @param {string} collection @returns {Promise<CollectionInspectResult>} */
    async inspectCollection(collection) {
        const exists = await this.hasCollection(collection)
        if (!exists) {
            return {
                collection,
                kind: 'document',
                exists: false,
                worm: false,
                docsStored: 0,
                deletedDocs: 0,
                indexedDocs: 0
            }
        }
        await this.requireCollection(collection)
        return await this.readStable(collection, () =>
            this.inspectCollectionAtGeneration(collection)
        )
    }
    /** @param {string} collection @returns {Promise<CollectionInspectResult>} */
    async inspectCollectionAtGeneration(collection) {
        const kind = await this.collectionKind(collection)
        const [docIds, deletedDocIds, indexedDocs] = await Promise.all([
            kind === 'file'
                ? this.files.listFileIds(collection)
                : this.documents.listDocIds(collection),
            kind === 'file'
                ? this.files.listDeletedFileIds(collection)
                : this.documents.listDeletedDocIds(collection),
            this.index.countDocuments(collection)
        ])
        return {
            collection,
            kind,
            exists: true,
            worm: this.wormEnabled(),
            docsStored: docIds.length,
            deletedDocs: deletedDocIds.length,
            indexedDocs
        }
    }
    /** @param {string} collection @param {any} value @param {string} [parentField] @returns {Promise<any>} */
    async encodeEncrypted(collection, value, parentField) {
        if (Array.isArray(value)) {
            const encodedItems = await Promise.all(
                value.map(async (item) => {
                    if (item && typeof item === 'object')
                        return await this.encodeEncrypted(collection, item)
                    if (
                        parentField &&
                        Cipher.isConfigured() &&
                        Cipher.isEncryptedField(collection, parentField)
                    ) {
                        return await Cipher.encrypt(stringifyStoredValue(item))
                    }
                    return item
                })
            )
            return encodedItems
        }
        if (value && typeof value === 'object') {
            /** @type {Record<string, any>} */
            const copy = {}
            for (const field in value) {
                const nextField = parentField ? `${parentField}/${field}` : field
                const fieldValue = value[field]
                if (fieldValue && typeof fieldValue === 'object')
                    copy[field] = await this.encodeEncrypted(collection, fieldValue, nextField)
                else if (Cipher.isConfigured() && Cipher.isEncryptedField(collection, nextField)) {
                    copy[field] = await Cipher.encrypt(stringifyStoredValue(fieldValue))
                } else copy[field] = fieldValue
            }
            return copy
        }
        return value
    }
    /**
     * Decrypts one stored value for a field the schema declares `$encrypted`.
     * Always fails closed: returning an undecryptable value verbatim would hand
     * the caller an opaque blob typed as an ordinary string.
     *
     * @param {string} collection
     * @param {string} field
     * @param {string} stored
     * @returns {Promise<any>}
     */
    async decryptStoredField(collection, field, stored) {
        if (!Cipher.isConfigured()) {
            throw decryptionFailure(
                collection,
                field,
                'no encryption key is configured; set FYLO_ENCRYPTION_KEY'
            )
        }
        try {
            return parseStoredValue((await Cipher.decrypt(stored)).replaceAll('%2F', '/'))
        } catch (error) {
            throw decryptionFailure(
                collection,
                field,
                `the configured key could not decrypt it (${/** @type {Error} */ (error).message})`
            )
        }
    }

    /** @param {string} collection @param {any} value @param {string} [parentField] @returns {Promise<any>} */
    async decodeEncrypted(collection, value, parentField) {
        // Registration is schema-driven and lazy, so load it before the first
        // decode instead of relying on a write having happened in this process.
        if (parentField === undefined) await this.ensureEncryptionLoaded(collection)
        if (Array.isArray(value)) {
            const decodedItems = await Promise.all(
                value.map(async (item) => {
                    if (item && typeof item === 'object')
                        return await this.decodeEncrypted(collection, item, parentField)
                    if (
                        parentField &&
                        Cipher.isEncryptedField(collection, parentField) &&
                        typeof item === 'string'
                    ) {
                        return await this.decryptStoredField(collection, parentField, item)
                    }
                    return item
                })
            )
            return decodedItems
        }
        if (value && typeof value === 'object') {
            /** @type {Record<string, any>} */
            const copy = {}
            for (const field in value) {
                const nextField = parentField ? `${parentField}/${field}` : field
                const fieldValue = value[field]
                if (fieldValue && typeof fieldValue === 'object')
                    copy[field] = await this.decodeEncrypted(collection, fieldValue, nextField)
                else if (
                    Cipher.isEncryptedField(collection, nextField) &&
                    typeof fieldValue === 'string'
                ) {
                    copy[field] = await this.decryptStoredField(collection, nextField, fieldValue)
                } else copy[field] = fieldValue
            }
            return copy
        }
        return value
    }
    /**
     * @param {string} collection
     * @param {TTID} docId
     * @returns {Promise<StoredRecord | null>}
     */
    async readStoredRecord(collection, docId) {
        return (await this.collectionKind(collection)) === 'file'
            ? await this.files.readStoredFile(collection, docId)
            : await this.documents.readStoredDoc(collection, docId)
    }
    /**
     * @param {string} collection
     * @param {TTID} docId
     * @returns {Promise<StoredRecord | null>}
     */
    async readDeletedRecord(collection, docId) {
        if ((await this.collectionKind(collection)) === 'file') {
            return await this.files.readDeletedFile(collection, docId)
        }
        const deleted = await this.documents.readDeletedDoc(collection, docId)
        return deleted ? { ...deleted, updatedAt: deleted.deletedAt } : null
    }
    /**
     * @param {string} collection
     * @param {Record<string, any>} data
     * @returns {Promise<Record<string, any>>}
     */
    async materializeRecord(collection, data) {
        if ((await this.collectionKind(collection)) === 'file') return data
        return /** @type {Record<string, any>} */ (await materializeDoc(collection, data))
    }
    /** @param {string} collection @param {StoreQuery | undefined} [query] @param {number=} actorUid @returns {Promise<Array<Record<string, Record<string, any>>>>} */
    async docResults(collection, query, actorUid = undefined) {
        await this.requireCollection(collection)
        return await this.readStable(collection, () =>
            this.docResultsAtGeneration(collection, query, actorUid)
        )
    }
    /** @param {string} collection @param {StoreQuery | undefined} [query] @param {number=} actorUid @returns {Promise<Array<Record<string, Record<string, any>>>>} */
    async docResultsAtGeneration(collection, query, actorUid = undefined) {
        const cacheVersion = await this.queryCacheVersion(collection)
        const cachedIds = await this.cachedQueryIds('active', collection, query, cacheVersion)
        const ids =
            cachedIds ??
            (await this.loadCacheMissIds('active', collection, query, cacheVersion, async () => {
                const candidateIds = await this.queryEngine.candidateDocIdsForQuery(
                    collection,
                    query
                )
                return candidateIds
                    ? Array.from(candidateIds)
                    : await this.listQueryableDocIds(collection)
            }))
        const limit = query?.$limit
        /** @type {Array<Record<string, Record<string, any>>>} */
        const results = []
        /** @type {TTID[]} */
        const resultIds = []
        for (const id of ids) {
            const stored = await this.readStoredRecord(collection, id)
            if (!stored) continue
            // Upgrade pre-match so queries against fields added in newer schema
            // versions can still hit older docs in storage. Note: indexes are
            // built from on-disk shape, so index-eligible queries on new-only
            // fields still require a rebuild after a schema bump.
            const data = await this.materializeRecord(collection, stored.data)
            if (!this.queryEngine.matchesQuery(id, data, query, stored)) continue
            resultIds.push(id)
            if (!(await this.canAccessDocument(collection, id, actorUid, 'read'))) continue
            results.push({ [id]: data })
            if (limit && results.length >= limit) break
        }
        if (!cachedIds)
            await this.cacheQueryIds('active', collection, query, cacheVersion, resultIds)
        return results
    }
    /** @param {string} collection @param {StoreQuery | undefined} [query] @param {number=} actorUid @returns {Promise<Array<Record<string, Record<string, any>>>>} */
    async deletedDocResults(collection, query, actorUid = undefined) {
        await this.requireCollection(collection)
        return await this.readStable(collection, () =>
            this.deletedDocResultsAtGeneration(collection, query, actorUid)
        )
    }
    /** @param {string} collection @param {StoreQuery | undefined} [query] @param {number=} actorUid @returns {Promise<Array<Record<string, Record<string, any>>>>} */
    async deletedDocResultsAtGeneration(collection, query, actorUid = undefined) {
        const cacheVersion = await this.queryCacheVersion(collection)
        const cachedIds = await this.cachedQueryIds('deleted', collection, query, cacheVersion)
        const ids =
            cachedIds ??
            (await this.loadCacheMissIds('deleted', collection, query, cacheVersion, async () => {
                return (await this.collectionKind(collection)) === 'file'
                    ? await this.files.listDeletedFileIds(collection)
                    : await this.documents.listDeletedDocIds(collection)
            }))
        const limit = query?.$limit
        /** @type {Array<Record<string, Record<string, any>>>} */
        const results = []
        /** @type {TTID[]} */
        const resultIds = []
        for (const id of ids) {
            const stored = await this.readDeletedRecord(collection, id)
            if (!stored) continue
            const data = await this.materializeRecord(collection, stored.data)
            if (
                !this.queryEngine.matchesDeletedQuery(
                    id,
                    data,
                    query,
                    /** @type {{ createdAt: number, deletedAt: number }} */ (stored)
                )
            )
                continue
            resultIds.push(id)
            if (
                !(await this.canAccessDocument(collection, id, actorUid, 'read', {
                    deleted: true
                }))
            )
                continue
            results.push({ [id]: data })
            if (limit && results.length >= limit) break
        }
        if (!cachedIds)
            await this.cacheQueryIds('deleted', collection, query, cacheVersion, resultIds)
        return results
    }
    /** @param {string} collection @param {TTID} docId @param {Record<string, any>} doc @returns {Promise<void>} */
    async rebuildIndexes(collection, docId, doc) {
        await this.index.putDocument(collection, docId, doc)
    }
    /** @param {string} collection @param {TTID} docId @param {Record<string, any>} doc @returns {Promise<void>} */
    async removeIndexes(collection, docId, doc) {
        await this.index.removeDocument(collection, docId, doc)
    }
    /** @param {string} collection @returns {Promise<CollectionRebuildResult>} */
    async rebuildCollection(collection) {
        await this.requireCollection(collection)
        return await this.withCollectionWriteLock(
            collection,
            () => this.rebuildCollectionIndexUnlocked(collection),
            'rebuild'
        )
    }

    /**
     * Rebuilds only derived index state. The caller must hold the collection
     * write lock; transaction recovery uses this path before readers resume.
     * @param {string} collection
     * @returns {Promise<CollectionRebuildResult>}
     */
    async rebuildCollectionIndexUnlocked(collection) {
        await this.ensureCollection(collection)
        const kind = await this.collectionKind(collection)
        const docIds =
            kind === 'file'
                ? await this.files.listFileIds(collection)
                : await this.documents.listDocIds(collection)
        let indexedDocs = 0
        const objectKeys = new Map()
        await this.resetIndex(collection)
        for (const docId of docIds) {
            let stored
            try {
                stored =
                    kind === 'file'
                        ? await this.files.readStoredFile(collection, docId)
                        : await this.documents.readStoredDoc(collection, docId)
            } catch (err) {
                if (
                    kind !== 'file' ||
                    !/metadata is missing/.test(/** @type {Error} */ (err).message)
                ) {
                    throw err
                }
                const key = await this.files.repairKey(collection, docId)
                emitFyloEvent(this.onEvent, {
                    type: 'file.key-repaired',
                    collection,
                    docId,
                    key
                })
                stored = await this.files.readStoredFile(collection, docId)
            }
            if (!stored) continue
            if (kind === 'file') {
                const key = String(stored.data.key)
                const existingId = objectKeys.get(key)
                if (existingId && existingId !== docId) {
                    throw new Error(
                        `Duplicate object key "${key}" belongs to ${existingId} and ${docId}`
                    )
                }
                objectKeys.set(key, docId)
            }
            await this.index.putDocument(collection, docId, stored.data)
            indexedDocs++
        }
        emitFyloEvent(this.onEvent, {
            type: 'index.rebuilt',
            collection,
            docsScanned: docIds.length,
            indexedDocs,
            worm: this.wormEnabled()
        })
        return {
            collection,
            kind,
            worm: this.wormEnabled(),
            docsScanned: docIds.length,
            indexedDocs
        }
    }
    /**
     * A soft-deleted document must be restored before it can be written again,
     * WORM forbids updating an existing record, and an existing record's own
     * access descriptor governs who may replace it.
     * @param {string} collection
     * @param {TTID} docId
     * @param {any} existing
     * @param {any} deleted
     * @param {{ uid?: number }=} access
     */
    async assertDocumentWritable(collection, docId, existing, deleted, access) {
        if (deleted) {
            throw new Error(`Document is soft-deleted; restore it before writing: ${docId}`)
        }
        if (!existing) return
        if (this.wormEnabled()) throw new Error('Update is not allowed in WORM mode')
        await this.assertDocumentAccess(collection, docId, access?.uid, 'write')
    }

    /**
     * Writes the document, its developer metadata, and its access descriptor,
     * then rebuilds indexes. Any failure restores the previous record (or
     * removes a newly created one) before rethrowing, so a failed put leaves
     * no partial state behind.
     * @param {{ collection: string, docId: TTID, doc: Record<string, any>, targetPath: string, existing: any, metadata: Array<[string, Uint8Array]>, previousAccess: any, metaUpdates: any, access: any }} input
     */
    async writeDocumentOrRollback(input) {
        const { collection, docId, doc, targetPath, existing, metadata, previousAccess } = input
        try {
            await this.documents.writeStoredDoc(collection, docId, doc)
            restoreDeveloperMetadataXattrs(targetPath, metadata)
            if (input.metaUpdates?.length) {
                this.applyDocMetaMutations(targetPath, input.metaUpdates)
            }
            if (input.access) await applyAccessDescriptor(targetPath, input.access)
            else await restoreAccessState(targetPath, previousAccess)
            await this.rebuildIndexes(collection, docId, doc)
        } catch (error) {
            try {
                await this.removeIndexes(collection, docId, doc)
                if (existing) {
                    await this.documents.writeStoredDoc(collection, docId, existing.data)
                    restoreDeveloperMetadataXattrs(targetPath, metadata)
                    await restoreAccessState(targetPath, previousAccess)
                    await this.rebuildIndexes(collection, docId, existing.data)
                } else {
                    await this.documents.removeStoredDoc(collection, docId)
                }
            } catch (rollbackError) {
                throw new AggregateError(
                    [error, rollbackError],
                    'Document put failed and rollback was incomplete'
                )
            }
            throw error
        }
    }

    /** @param {string} collection @param {TTID} docId @param {Record<string, any>} doc @param {Record<string, any>=} meta @param {{ uid?: number, gid?: number, mode?: number }=} access @param {boolean=} createOnly @returns {Promise<boolean>} */
    async putDocument(collection, docId, doc, meta, access, createOnly = false) {
        const metaUpdates = meta === undefined ? undefined : metaMutations(meta)
        assertIndexableDocument(doc)
        await validateDocId(docId)
        await this.requireCollection(collection)
        await this.requireCollectionKind(collection, 'document')
        await this.assertNoLegacyWormArtifacts(collection)
        return await this.withCollectionWriteLock(collection, async () => {
            const owner = Bun.randomUUIDv7()
            if (!(await this.locks.acquire(collection, docId, owner)))
                throw new Error(`Unable to acquire filesystem lock for ${docId}`)
            const targetPath = this.docPath(collection, docId)
            try {
                const existing = await this.documents.readStoredDoc(collection, docId)
                const deleted = await this.documents.readDeletedDoc(collection, docId)
                if (createOnly && (existing || deleted)) return false
                await this.assertDocumentWritable(collection, docId, existing, deleted, access)
                await this.transactions.capture(targetPath)
                if (existing) await this.removeIndexes(collection, docId, existing.data)
                const metadata = existing ? developerMetadataXattrs(targetPath) : []
                const previousAccess = existing ? await snapshotAccessState(targetPath) : null
                await this.writeDocumentOrRollback({
                    collection,
                    docId,
                    doc,
                    targetPath,
                    existing,
                    metadata,
                    previousAccess,
                    metaUpdates,
                    access
                })
                if (this.wormEnabled())
                    await this.documents.makeStoredDocReadOnly(collection, docId)
                await this.publishDocumentEvent(collection, {
                    ts: Date.now(),
                    action: 'insert',
                    id: docId,
                    doc: await this.encodeEncrypted(collection, doc)
                })
                await this.runSyncTask(collection, docId, 'put', targetPath, async () => {
                    await this.syncWrite({
                        operation: 'put',
                        collection,
                        docId,
                        path: targetPath,
                        data: doc
                    })
                })
                await this.invalidateQueryCache(collection)
                return true
            } finally {
                await this.locks.release(collection, docId, owner)
            }
        })
    }
    /**
     * @param {string} collection
     * @param {TTID} docId
     * @param {RawFileSource} source
     * @param {boolean=} createOnly
     * @returns {Promise<boolean>}
     */
    async putFile(collection, docId, source, createOnly = false) {
        await validateDocId(docId)
        await this.requireCollection(collection)
        await this.requireCollectionKind(collection, 'file')
        await this.assertNoLegacyWormArtifacts(collection)
        return await this.withCollectionWriteLock(collection, async () => {
            const owner = Bun.randomUUIDv7()
            if (!(await this.locks.acquire(collection, docId, owner))) {
                throw new Error(`Unable to acquire filesystem lock for ${docId}`)
            }
            try {
                const [existing, deleted] = await Promise.all([
                    this.files.readStoredFile(collection, docId),
                    this.files.readDeletedFile(collection, docId)
                ])
                if (createOnly && (existing || deleted)) return false
                if (deleted) {
                    throw new Error(`Document is soft-deleted; restore it before writing: ${docId}`)
                }
                if (existing) {
                    throw new Error(`Raw file already exists: ${docId}`)
                }
                const { key, extension } = this.files.resolveMetadata(docId, source)
                await this.assertObjectKeyAvailable(collection, key)
                await this.transactions.capture(
                    shardedPath(this.docsRoot(collection), docId, `${docId}${extension}`)
                )
                const stored = await this.files.writeStoredFile(collection, docId, source)
                try {
                    if (source.access) await applyAccessDescriptor(stored.path, source.access)
                    await this.rebuildIndexes(collection, docId, stored.data)
                } catch (error) {
                    /** @type {unknown[]} */
                    const rollbackErrors = []
                    try {
                        // putDocument may have appended some prefix entries
                        // before surfacing a later index failure.
                        await this.removeIndexes(collection, docId, stored.data)
                    } catch (rollbackError) {
                        rollbackErrors.push(rollbackError)
                    }
                    try {
                        // Removing the raw file removes its bytes and every
                        // xattr (key, checksum, and initial developer metadata)
                        // as one inode-scoped rollback.
                        await this.storage.delete(stored.path)
                    } catch (rollbackError) {
                        rollbackErrors.push(rollbackError)
                    }
                    if (rollbackErrors.length > 0) {
                        throw new AggregateError(
                            [error, ...rollbackErrors],
                            'Raw file put failed and rollback was incomplete'
                        )
                    }
                    throw error
                }
                if (this.wormEnabled()) {
                    // chmod 0444 also freezes the file's xattr metadata (the
                    // kernel requires write permission to set user xattrs).
                    await this.files.makeStoredFileReadOnly(collection, docId)
                }
                await this.publishDocumentEvent(collection, {
                    ts: stored.data.lastModified,
                    action: 'insert',
                    id: docId,
                    doc: stored.data
                })
                await this.runSyncTask(collection, docId, 'put', stored.path, async () => {
                    await this.syncWrite({
                        operation: 'put',
                        collection,
                        docId,
                        path: stored.path,
                        data: stored.data
                    })
                })
                await this.invalidateQueryCache(collection)
                return true
            } finally {
                await this.locks.release(collection, docId, owner)
            }
        })
    }
    /**
     * @param {string} collection
     * @param {string} key
     * @param {string} [allowedId]
     * @returns {Promise<void>}
     */
    async assertObjectKeyAvailable(collection, key, allowedId) {
        const ids = await this.index.candidateDocIds(collection, 'key', { $eq: key })
        for (const id of ids ?? []) {
            if (id !== allowedId) {
                throw new Error(`Object key already exists in collection "${collection}": ${key}`)
            }
        }
    }
    /** @param {string} collection @param {TTID} oldId @param {TTID} newId @param {Record<string, any>} patch @param {Record<string, any>} oldDoc @param {number=} actorUid @returns {Promise<TTID>} */
    async patchDocument(collection, oldId, newId, patch, oldDoc, actorUid) {
        if (this.wormEnabled()) throw new Error('Update is not allowed in WORM mode')
        await this.requireCollection(collection)
        await this.requireCollectionKind(collection, 'document')
        const existing = oldDoc ?? (await this.documents.readStoredDoc(collection, oldId))?.data
        if (!existing) return oldId
        const nextDoc = { ...existing, ...patch }
        return await this.updateDocument(collection, oldId, nextDoc, existing, undefined, actorUid)
    }
    /** @param {string} collection @param {TTID} oldId @param {TTID} newId @param {Record<string, any>} doc @param {Record<string, any>} [oldDoc] @param {Record<string, any>} [meta] @param {{ uid?: number, gid?: number, mode?: number }=} access @returns {Promise<TTID>} */
    async replaceDocumentVersion(collection, oldId, newId, doc, oldDoc, meta, access) {
        if (this.wormEnabled()) throw new Error('Update is not allowed in WORM mode')
        await this.requireCollection(collection)
        await this.requireCollectionKind(collection, 'document')
        if (oldDoc)
            return await this.updateDocument(
                collection,
                oldId,
                doc,
                oldDoc,
                meta,
                access?.uid,
                access
            )
        const stored = await this.documents.readStoredDoc(collection, oldId)
        if (!stored && (await this.documents.readDeletedDoc(collection, oldId))) {
            throw new Error(`Document is soft-deleted; restore it before writing: ${oldId}`)
        }
        if (!stored) return oldId
        return await this.updateDocument(
            collection,
            oldId,
            doc,
            stored.data,
            meta,
            access?.uid,
            access
        )
    }
    /** @param {string} collection @param {TTID} docId @param {number=} actorUid @returns {Promise<void>} */
    async deleteDocument(collection, docId, actorUid) {
        await validateDocId(docId)
        if (this.wormEnabled()) throw new Error('Delete is not allowed in WORM mode')
        await this.requireCollection(collection)
        await this.assertNoLegacyWormArtifacts(collection)
        await this.withCollectionWriteLock(collection, async () => {
            const owner = Bun.randomUUIDv7()
            if (!(await this.locks.acquire(collection, docId, owner)))
                throw new Error(`Unable to acquire filesystem lock for ${docId}`)
            try {
                const kind = await this.collectionKind(collection)
                const existing =
                    kind === 'file'
                        ? await this.files.readStoredFile(collection, docId)
                        : await this.documents.readStoredDoc(collection, docId)
                if (!existing) return
                const deletedAt = Date.now()
                // Capture the live docs/ path before the move so the S3 backup can
                // drop the old object (files carry an arbitrary extension, so this
                // must be resolved, not rebuilt from the id).
                const previousPath =
                    (kind === 'file'
                        ? await this.files.findPath(this.docsRoot(collection), docId)
                        : this.docPath(collection, docId)) ?? undefined
                if (!previousPath) throw new Error(`Document path not found: ${docId}`)
                await this.assertDocumentAccess(collection, docId, actorUid, 'write')
                const pendingDeletedPath = shardedPath(
                    this.deletedRoot(collection),
                    docId,
                    path.basename(previousPath)
                )
                await this.transactions.capture(previousPath)
                await this.transactions.capture(pendingDeletedPath)
                await this.removeIndexes(collection, docId, existing.data)
                const deletedPath =
                    kind === 'file'
                        ? await this.files.softDeleteStoredFile(collection, docId, deletedAt)
                        : await this.documents.softDeleteStoredDoc(collection, docId, deletedAt)
                await this.publishDocumentEvent(collection, {
                    ts: deletedAt,
                    action: 'delete',
                    id: docId,
                    doc: await this.encodeEncrypted(collection, existing.data),
                    createdAt: existing.createdAt,
                    updatedAt: existing.updatedAt
                })
                await this.runSyncTask(collection, docId, 'delete', deletedPath, async () => {
                    await this.syncDelete({
                        operation: 'delete',
                        collection,
                        docId,
                        path: deletedPath,
                        previousPath
                    })
                })
                await this.invalidateQueryCache(collection)
            } finally {
                await this.locks.release(collection, docId, owner)
            }
        })
    }
    /** @param {string} collection @param {TTID} docId @param {number=} actorUid @returns {Promise<TTID>} */
    async restoreDocument(collection, docId, actorUid) {
        await validateDocId(docId)
        if (this.wormEnabled()) throw new Error('Restore is not allowed in WORM mode')
        await this.requireCollection(collection)
        await this.assertNoLegacyWormArtifacts(collection)
        return await this.withCollectionWriteLock(collection, async () => {
            const owner = Bun.randomUUIDv7()
            if (!(await this.locks.acquire(collection, docId, owner)))
                throw new Error(`Unable to acquire filesystem lock for ${docId}`)
            try {
                const kind = await this.collectionKind(collection)
                const active =
                    kind === 'file'
                        ? await this.files.readStoredFile(collection, docId)
                        : await this.documents.readStoredDoc(collection, docId)
                if (active) {
                    throw new Error(`Cannot restore document because it already exists: ${docId}`)
                }
                const deleted =
                    kind === 'file'
                        ? await this.files.readDeletedFile(collection, docId)
                        : await this.documents.readDeletedDoc(collection, docId)
                if (!deleted) throw new Error(`Deleted document not found: ${docId}`)
                if (kind === 'file') {
                    await this.assertObjectKeyAvailable(collection, String(deleted.data.key), docId)
                }
                const deletedPath =
                    kind === 'file'
                        ? /** @type {import('./files.js').StoredRawFile} */ (deleted).path
                        : this.deletedPath(collection, docId)
                await this.assertDocumentAccess(collection, docId, actorUid, 'write', {
                    deleted: true
                })
                const access = await readAccessDescriptor(deletedPath)
                const activePath = shardedPath(
                    this.docsRoot(collection),
                    docId,
                    path.basename(deletedPath)
                )
                await this.transactions.capture(deletedPath)
                await this.transactions.capture(activePath)
                const restoredPath =
                    kind === 'file'
                        ? await this.files.restoreStoredFile(collection, docId, Date.now())
                        : await this.documents.restoreStoredDoc(collection, docId, Date.now())
                await restoreAccessDescriptor(restoredPath, access)
                await this.rebuildIndexes(collection, docId, deleted.data)
                await this.publishDocumentEvent(collection, {
                    ts: Date.now(),
                    action: 'insert',
                    id: docId,
                    doc: await this.encodeEncrypted(collection, deleted.data)
                })
                await this.runSyncTask(collection, docId, 'restore', restoredPath, async () => {
                    await this.syncWrite({
                        operation: 'restore',
                        collection,
                        docId,
                        path: restoredPath,
                        data: deleted.data
                    })
                })
                await this.invalidateQueryCache(collection)
                return docId
            } finally {
                await this.locks.release(collection, docId, owner)
            }
        })
    }
    /** @param {string} collection @param {TTID} docId @param {boolean} [onlyId] @param {number=} actorUid @returns {any} */
    getDoc(collection, docId, onlyId = false, actorUid = undefined) {
        // Validation is async now (ttid binary), so it runs inside each async
        // entry below rather than in this sync builder.
        const engine = this
        return {
            async *[Symbol.asyncIterator]() {
                const doc = await this.once()
                if (Object.keys(doc).length > 0) yield onlyId ? Object.keys(doc).shift() : doc
                for await (const event of engine.events.listen(collection)) {
                    if (event.action !== 'insert' || event.id !== docId || !event.doc) continue
                    await engine.assertDocumentAccess(collection, docId, actorUid, 'read')
                    const doc = await engine.decodeEncrypted(collection, event.doc)
                    yield onlyId ? event.id : { [event.id]: doc }
                }
            },
            /** @returns {Promise<Record<TTID, Record<string, any>>>} */
            async once() {
                await validateDocId(docId)
                await engine.requireCollection(collection)
                await engine.assertNoLegacyWormArtifacts(collection)
                return await engine.readStable(collection, async () => {
                    const stored = await engine.readStoredRecord(collection, docId)
                    if (!stored) return {}
                    await engine.assertDocumentAccess(collection, docId, actorUid, 'read')
                    const data = await engine.materializeRecord(collection, stored.data)
                    return { [docId]: data }
                })
            },
            async *onDelete() {
                await validateDocId(docId)
                await engine.requireCollection(collection)
                for await (const event of engine.events.listen(collection)) {
                    if (event.action !== 'delete' || event.id !== docId) continue
                    if (
                        await engine.canAccessDocument(collection, docId, actorUid, 'read', {
                            deleted: true
                        })
                    ) {
                        yield event.id
                    }
                }
            }
        }
    }
    /** @param {string} collection @param {TTID} docId @param {boolean} [onlyId] @param {number=} actorUid @returns {Promise<Record<TTID, Record<string, any>> | TTID | null>} */
    async getLatest(collection, docId, onlyId = false, actorUid = undefined) {
        await validateDocId(docId)
        await this.requireCollection(collection)
        await this.assertNoLegacyWormArtifacts(collection)
        return await this.readStable(collection, async () => {
            const stored = await this.readStoredRecord(collection, docId)
            if (!stored) return onlyId ? null : {}
            await this.assertDocumentAccess(collection, docId, actorUid, 'read')
            if (onlyId) return stored.id
            const data = await this.materializeRecord(collection, stored.data)
            return { [stored.id]: data }
        })
    }
    /** @param {string} collection @param {TTID} docId @param {number=} actorUid @returns {Promise<Uint8Array>} */
    async getFileBytes(collection, docId, actorUid = undefined) {
        await this.requireCollection(collection)
        await this.requireCollectionKind(collection, 'file')
        await this.assertDocumentAccess(collection, docId, actorUid, 'read')
        return await this.readStable(collection, () => this.files.readBytes(collection, docId))
    }
    /**
     * @param {string} collection
     * @param {TTID} docId
     * @param {{ start?: number, end?: number }} [range] half-open byte range [start, end)
     * @param {number=} actorUid
     * @returns {Promise<ReadableStream<Uint8Array>>}
     */
    async getFileStream(collection, docId, range, actorUid = undefined) {
        await this.requireCollection(collection)
        await this.requireCollectionKind(collection, 'file')
        await this.assertDocumentAccess(collection, docId, actorUid, 'read')
        return await this.files.readStream(collection, docId, range)
    }
    /**
     * Reassigns a raw file's durable object key in place — no byte rewrite,
     * new key indexed immediately. Prefix and root keys expand like `put()`.
     * @param {string} collection @param {string} docId @param {string} key
     * @param {number=} actorUid
     * @returns {Promise<string>} the expanded key now assigned
     */
    async rekeyFile(collection, docId, key, actorUid = undefined) {
        await validateDocId(docId)
        if (this.wormEnabled()) throw new Error('Rekey is not allowed in WORM mode')
        await this.requireCollection(collection)
        await this.requireCollectionKind(collection, 'file')
        let targetPath = ''
        const nextKey = await this.withCollectionWriteLock(collection, async () => {
            const stored = await this.files.readStoredFile(collection, docId)
            if (!stored) throw new Error(`Raw file not found: ${docId}`)
            await this.assertDocumentAccess(collection, docId, actorUid, 'write')
            targetPath = stored.path
            const next = rawFileKey(key, docId, stored.data.extension)
            if (next === stored.data.key) return next
            await this.assertObjectKeyAvailable(collection, next, docId)
            const data = { ...stored.data, key: next }
            await this.transactions.capture(stored.path)
            setXattr(stored.path, KEY_XATTR, next)
            try {
                await this.removeIndexes(collection, docId, stored.data)
                await this.rebuildIndexes(collection, docId, data)
                await this.invalidateQueryCache(collection)
            } catch (error) {
                try {
                    setXattr(stored.path, KEY_XATTR, String(stored.data.key))
                    await this.removeIndexes(collection, docId, data)
                    await this.rebuildIndexes(collection, docId, stored.data)
                } catch (rollbackError) {
                    throw new AggregateError(
                        [error, rollbackError],
                        'File rekey failed and rollback was incomplete'
                    )
                }
                throw error
            }
            await this.publishDocumentEvent(collection, {
                ts: Date.now(),
                action: 'insert',
                id: docId,
                doc: data
            })
            return next
        })
        await this.mirrorRecordMetadata(collection, docId, 'rekey', targetPath)
        return nextKey
    }
    /**
     * Stamp-ignoring integrity audit of a file collection: re-hashes the full
     * contents of every active and soft-deleted file, reports files whose
     * bytes no longer match their recorded checksum, and freshens the stamps
     * of the ones that do. Raw files are immutable, so no write lock is held;
     * a file moved or deleted mid-scan is simply skipped.
     *
     * @param {string} collection
     * @returns {Promise<{
     *   collection: string,
     *   filesScanned: number,
     *   verified: number,
     *   stamped: number,
     *   corrupt: Array<{ id: string, namespace: 'active' | 'deleted', expected: string, actual: string }>
     * }>}
     */
    async verifyCollection(collection) {
        await this.requireCollection(collection)
        await this.requireCollectionKind(collection, 'file')
        const result = {
            collection,
            filesScanned: 0,
            verified: 0,
            stamped: 0,
            /** @type {Array<{ id: string, namespace: 'active' | 'deleted', expected: string, actual: string }>} */
            corrupt: []
        }
        /** @type {Array<['active' | 'deleted', string, string[]]>} */
        const namespaces = [
            ['active', this.docsRoot(collection), await this.files.listFileIds(collection)],
            [
                'deleted',
                this.deletedRoot(collection),
                await this.files.listDeletedFileIds(collection)
            ]
        ]
        for (const [namespace, root, ids] of namespaces) {
            for (const docId of ids) {
                const target = await this.files.findPath(root, docId)
                if (!target) continue
                let check
                try {
                    check = await this.files.verifyTarget(target)
                } catch (err) {
                    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') continue
                    throw err
                }
                result.filesScanned++
                if (check.status === 'corrupt') {
                    const expected = /** @type {string} */ (check.expected)
                    result.corrupt.push({ id: docId, namespace, expected, actual: check.actual })
                    emitFyloEvent(this.onEvent, {
                        type: 'file.checksum-mismatch',
                        collection,
                        docId,
                        expected,
                        actual: check.actual
                    })
                } else if (check.status === 'stamped') result.stamped++
                else result.verified++
            }
        }
        return result
    }
    /**
     * One folder level of a file collection: direct-child files as full
     * manifests plus immediate subfolder names. Deeper descendants cost one
     * key-xattr read each — no content is hashed for them.
     * @param {string} collection
     * @param {string} prefix folder path starting and ending with '/'
     * @param {number=} actorUid
     * @returns {Promise<{ prefix: string, files: Record<string, Record<string, any>>, folders: string[] }>}
     */
    async listFolder(collection, prefix, actorUid = undefined) {
        if (typeof prefix !== 'string' || !prefix.startsWith('/') || !prefix.endsWith('/')) {
            throw new Error("Folder prefix must start and end with '/'")
        }
        await this.requireCollection(collection)
        await this.requireCollectionKind(collection, 'file')
        return await this.readStable(collection, () =>
            this.listFolderAtGeneration(collection, prefix, actorUid)
        )
    }
    /** @param {string} collection @param {string} prefix @param {number=} actorUid */
    async listFolderAtGeneration(collection, prefix, actorUid = undefined) {
        const candidates =
            (await this.index.candidateDocIds(collection, 'key', { $like: `${prefix}%` })) ??
            new Set(await this.files.listFileIds(collection))
        /** @type {Record<string, Record<string, any>>} */
        const files = {}
        /** @type {Set<string>} */
        const folders = new Set()
        for (const docId of candidates) {
            if (!(await this.canAccessDocument(collection, String(docId), actorUid, 'read'))) {
                continue
            }
            const target = await this.files.findPath(this.docsRoot(collection), String(docId))
            if (!target) continue
            let key
            try {
                key = this.files.readKey(target, String(docId))
            } catch {
                continue // stripped key xattr; `rebuild()` repairs it
            }
            if (!key.startsWith(prefix)) continue
            const rest = key.slice(prefix.length)
            const slash = rest.indexOf('/')
            if (slash !== -1) {
                folders.add(rest.slice(0, slash))
                continue
            }
            const stored = await this.files.readStoredFile(collection, String(docId))
            if (stored) files[String(docId)] = stored.data
        }
        return { prefix, files, folders: [...folders].sort() }
    }
    /**
     * Resolves the on-disk file (JSON document or raw file) that carries a
     * document's developer metadata xattrs.
     * @param {string} collection @param {string} docId @returns {Promise<string>}
     */
    async metaTarget(collection, docId) {
        await validateDocId(docId)
        await this.requireCollection(collection)
        if ((await this.collectionKind(collection)) === 'file') {
            const target = await this.files.findPath(this.docsRoot(collection), docId)
            if (!target) throw new Error(`Raw file not found: ${docId}`)
            return target
        }
        try {
            return await this.documents.metadataTarget(collection, docId)
        } catch (error) {
            if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') {
                throw new Error(`Document not found: ${docId}`)
            }
            throw error
        }
    }
    /**
     * Resolves the inode that carries a record's native owner, mode, and
     * protected-record marker.
     * @param {string} collection
     * @param {string} docId
     * @param {boolean} [deleted]
     * @returns {Promise<string | null>}
     */
    async accessTarget(collection, docId, deleted = false) {
        await validateDocId(docId)
        await this.requireCollection(collection)
        const kind = await this.collectionKind(collection)
        if (kind === 'file') {
            return await this.files.findPath(
                deleted ? this.deletedRoot(collection) : this.docsRoot(collection),
                docId
            )
        }
        const target = deleted
            ? this.deletedPath(collection, docId)
            : this.docPath(collection, docId)
        return (await this.storage.exists(target)) ? target : null
    }
    /**
     * Open records have no descriptor and retain Fylo's existing unrestricted
     * behavior. Protected records use POSIX owner, group, then other
     * precedence. Group membership comes only from the trusted engine resolver.
     * @param {string} collection
     * @param {string} docId
     * @param {number | undefined} actorUid
     * @param {'read' | 'write'} operation
     * @param {{ deleted?: boolean }} [options]
     * @returns {Promise<import('../security/access.js').FyloAccessDescriptor | null>}
     */
    async assertDocumentAccess(collection, docId, actorUid, operation, options = {}) {
        const target = await this.accessTarget(collection, docId, options.deleted === true)
        if (!target) return null
        const descriptor = await readAccessDescriptor(target)
        if (!descriptor) return null
        const actorGids =
            actorUid === undefined || actorUid === descriptor.uid || !this.groupsForUid
                ? new Set()
                : normalizeResolvedGroupIds(await this.groupsForUid(actorUid))
        if (!descriptorAllows(descriptor, actorUid, actorGids, operation)) {
            throw new FyloPermissionError({ collection, docId, operation })
        }
        return descriptor
    }
    /**
     * @param {string} collection
     * @param {string} docId
     * @param {number | undefined} actorUid
     * @param {'read' | 'write'} operation
     * @param {{ deleted?: boolean }} [options]
     */
    async canAccessDocument(collection, docId, actorUid, operation, options = {}) {
        try {
            await this.assertDocumentAccess(collection, docId, actorUid, operation, options)
            return true
        } catch (error) {
            if (error instanceof FyloPermissionError) return false
            throw error
        }
    }
    /**
     * @param {string} collection
     * @param {string} docId
     * @returns {Promise<import('../security/access.js').FyloAccessDescriptor | null>}
     */
    async documentAccessDescriptor(collection, docId) {
        const target = await this.accessTarget(collection, docId)
        return target ? await readAccessDescriptor(target) : null
    }
    /**
     * Bulk metadata write: sets every pair in `record` (values are stored
     * JSON-encoded, so they round-trip typed); a `null` value removes the
     * entry. One index refresh covers the whole batch.
     * @param {string} collection @param {string} docId @param {Record<string, any>} record @param {number=} actorUid
     * @returns {Promise<void>}
     */
    async setDocMetaRecord(collection, docId, record, actorUid = undefined) {
        const mutations = metaMutations(record)
        if (mutations.length === 0) return
        await this.updateDocMeta(
            collection,
            docId,
            (target) => this.applyDocMetaMutations(target, mutations),
            actorUid
        )
    }
    /** @param {string} target @param {Array<[string, string | null]>} mutations */
    applyDocMetaMutations(target, mutations) {
        const attributes = [...new Set([...mutations.map(([attr]) => attr), META_UPDATED_XATTR])]
        const previous = new Map(attributes.map((attr) => [attr, getXattr(target, attr)]))
        try {
            for (const [attr, encoded] of mutations) {
                if (encoded === null) removeXattr(target, attr)
                else setXattr(target, attr, encoded)
            }
            const previousUpdatedAt = Number(
                new TextDecoder().decode(previous.get(META_UPDATED_XATTR) ?? new Uint8Array())
            )
            const updatedAt = Math.max(
                Date.now(),
                Number.isFinite(previousUpdatedAt) ? previousUpdatedAt + 1 : 0
            )
            setXattr(target, META_UPDATED_XATTR, String(updatedAt))
        } catch (error) {
            /** @type {unknown[]} */
            const rollbackErrors = []
            for (const attr of attributes.reverse()) {
                try {
                    const value = previous.get(attr)
                    if (value === null) removeXattr(target, attr)
                    else if (value !== undefined) setXattr(target, attr, value)
                } catch (rollbackError) {
                    rollbackErrors.push(rollbackError)
                }
            }
            if (rollbackErrors.length > 0) {
                throw new AggregateError(
                    [error, ...rollbackErrors],
                    'Metadata update failed and rollback was incomplete'
                )
            }
            throw error
        }
    }
    /**
     * Replaces the complete developer metadata record. Keys missing from the
     * authoritative record are removed through the same failure-atomic batch.
     * @param {string} collection @param {string} docId @param {Record<string, any>} record @param {number=} actorUid
     * @returns {Promise<void>}
     */
    async replaceDocMetaRecord(collection, docId, record, actorUid = undefined) {
        metaMutations(record)
        await this.updateDocMeta(
            collection,
            docId,
            (target) => {
                const current = this.files.readMeta(target) ?? {}
                /** @type {Record<string, any>} */
                const replacement = { ...record }
                for (const name of Object.keys(current)) {
                    if (!Object.hasOwn(record, name)) replacement[name] = null
                }
                const mutations = metaMutations(replacement)
                if (mutations.length > 0) this.applyDocMetaMutations(target, mutations)
            },
            actorUid
        )
    }
    /** @param {string} collection @param {string} docId @returns {Promise<number>} */
    async docMetaUpdatedAt(collection, docId) {
        const value = getXattr(await this.metaTarget(collection, docId), META_UPDATED_XATTR)
        const updatedAt = value === null ? 0 : Number(new TextDecoder().decode(value))
        return Number.isFinite(updatedAt) ? updatedAt : 0
    }
    /**
     * Applies a metadata mutation; file collections carry meta in their
     * indexed manifests, so the doc's index entries are refreshed under the
     * collection write lock.
     * @param {string} collection @param {string} docId @param {(target: string) => void} mutate @param {number=} actorUid
     * @returns {Promise<void>}
     */
    async updateDocMeta(collection, docId, mutate, actorUid = undefined) {
        if (this.wormEnabled()) throw new Error('Metadata update is not allowed in WORM mode')
        await this.requireCollection(collection)
        let targetPath = ''
        await this.withCollectionWriteLock(collection, async () => {
            const owner = Bun.randomUUIDv7()
            if (!(await this.locks.acquire(collection, docId, owner))) {
                throw new Error(`Unable to acquire filesystem lock for ${docId}`)
            }
            try {
                await this.assertDocumentAccess(collection, docId, actorUid, 'write')
                if ((await this.collectionKind(collection)) !== 'file') {
                    targetPath = await this.metaTarget(collection, docId)
                    await this.transactions.capture(targetPath)
                    mutate(targetPath)
                    return
                }
                const before = await this.files.readStoredFile(collection, docId)
                if (!before) throw new Error(`Raw file not found: ${docId}`)
                targetPath = before.path
                await this.transactions.capture(targetPath)
                const metadata = snapshotMetadataXattrs(before.path)
                /** @type {StoredRecord | null} */
                let after = null
                try {
                    mutate(before.path)
                    after = await this.files.readStoredFile(collection, docId)
                    if (!after)
                        throw new Error(`Raw file not found after metadata update: ${docId}`)
                    await this.removeIndexes(collection, docId, before.data)
                    await this.rebuildIndexes(collection, docId, after.data)
                    await this.invalidateQueryCache(collection)
                } catch (error) {
                    try {
                        restoreMetadataXattrsExact(before.path, metadata)
                        if (after) await this.removeIndexes(collection, docId, after.data)
                        await this.rebuildIndexes(collection, docId, before.data)
                    } catch (rollbackError) {
                        throw new AggregateError(
                            [error, rollbackError],
                            'File metadata update failed and rollback was incomplete'
                        )
                    }
                    throw error
                }
            } finally {
                await this.locks.release(collection, docId, owner)
            }
        })
        await this.mirrorRecordMetadata(collection, docId, 'meta', targetPath)
    }
    /** @param {string} collection @param {string} docId @returns {Promise<Record<string, any>>} */
    async listDocMeta(collection, docId) {
        return this.files.readMeta(await this.metaTarget(collection, docId)) ?? {}
    }
    /**
     * Returns the complete canonical metadata record plus developer metadata.
     * System fields win over colliding developer keys so callers always
     * receive canonical identifiers, timestamps, and raw-file descriptors.
     * @param {string} collection @param {string} docId @param {number=} actorUid
     * @returns {Promise<Record<string, any>>}
     */
    async getDocMetadata(collection, docId, actorUid = undefined) {
        await this.requireCollection(collection)
        return await this.readStable(collection, async () => {
            await this.assertDocumentAccess(collection, docId, actorUid, 'read')
            const metadata = await this.listDocMeta(collection, docId)
            const stored = await this.readStoredRecord(collection, /** @type {TTID} */ (docId))
            if (!stored) return metadata
            const canonical = Object.assign(Object.create(null), {
                id: stored.id,
                mtime: stored.updatedAt,
                updatedAt: stored.updatedAt,
                createdAt: stored.createdAt
            })
            if ((await this.collectionKind(collection)) === 'file') {
                const { meta: _custom, ...fileMetadata } = stored.data
                Object.assign(canonical, fileMetadata)
            }
            const access = await this.documentAccessDescriptor(collection, docId)
            if (access)
                Object.assign(canonical, {
                    uid: access.uid,
                    gid: access.gid,
                    mode: access.mode
                })
            return Object.assign(Object.create(null), metadata, canonical)
        })
    }
    /** @param {string} collection @param {StoreQuery | undefined} query @param {number=} actorUid @returns {any} */
    findDocs(collection, query, actorUid = undefined) {
        const engine = this
        const collectDocs = async function* () {
            const docs = await engine.docResults(collection, query, actorUid)
            for (const doc of docs) {
                const result = engine.queryEngine.processDoc(doc, query)
                if (result !== undefined) yield result
            }
        }
        return {
            async *[Symbol.asyncIterator]() {
                for await (const result of collectDocs()) yield result
                for await (const event of engine.events.listen(collection)) {
                    if (event.action !== 'insert' || !event.doc) continue
                    if (!(await engine.canAccessDocument(collection, event.id, actorUid, 'read')))
                        continue
                    const doc = await engine.decodeEncrypted(collection, event.doc)
                    const stored = await engine.readStoredRecord(collection, event.id)
                    if (!stored || !engine.queryEngine.matchesQuery(event.id, doc, query, stored))
                        continue
                    const processed = engine.queryEngine.processDoc({ [event.id]: doc }, query)
                    if (processed !== undefined) yield processed
                }
            },
            async *collect() {
                for await (const result of collectDocs()) yield result
            },
            async *onDelete() {
                await engine.requireCollection(collection)
                for await (const event of engine.events.listen(collection)) {
                    if (event.action !== 'delete' || !event.doc) continue
                    if (
                        !(await engine.canAccessDocument(collection, event.id, actorUid, 'read', {
                            deleted: true
                        }))
                    ) {
                        continue
                    }
                    const doc = await engine.decodeEncrypted(collection, event.doc)
                    if (
                        !engine.queryEngine.matchesQuery(event.id, doc, query, {
                            createdAt: event.createdAt ?? event.ts,
                            updatedAt: event.updatedAt ?? event.ts
                        })
                    )
                        continue
                    yield event.id
                }
            }
        }
    }
    /** @param {string} collection @param {StoreQuery | undefined} query @param {number=} actorUid @returns {any} */
    findDeletedDocs(collection, query, actorUid = undefined) {
        const engine = this
        const collectDocs = async function* () {
            const docs = await engine.deletedDocResults(collection, query, actorUid)
            for (const doc of docs) {
                const result = engine.queryEngine.processDoc(doc, query)
                if (result !== undefined) yield result
            }
        }
        return {
            async *[Symbol.asyncIterator]() {
                yield* collectDocs()
            },
            async *collect() {
                yield* collectDocs()
            }
        }
    }
    /** @param {string} collection @param {number=} actorUid @returns {AsyncGenerator<Record<string, any>, void, unknown>} */
    async *exportBulkData(collection, actorUid = undefined) {
        const ids = await this.listQueryableDocIds(collection)
        for (const id of ids) {
            if (!(await this.canAccessDocument(collection, id, actorUid, 'read'))) continue
            const stored = await this.readStoredRecord(collection, id)
            if (!stored) continue
            yield await this.materializeRecord(collection, stored.data)
        }
    }
    /** @param {StoreJoin} join @param {number=} actorUid @returns {Promise<any>} */
    async joinDocs(join, actorUid = undefined) {
        const leftDocs = await this.docResults(join.$leftCollection, undefined, actorUid)
        const rightDocs = await this.docResults(join.$rightCollection, undefined, actorUid)
        /** @type {Record<string, Record<string, any>>} */
        const docs = {}
        for (const leftEntry of leftDocs) {
            const [leftId, leftData] = Object.entries(leftEntry)[0]
            for (const rightEntry of rightDocs) {
                const [rightId, rightData] = Object.entries(rightEntry)[0]
                if (!this.joinRowMatches(join, leftData, rightData)) continue
                docs[`${leftId}, ${rightId}`] = this.projectJoinRow(join, leftData, rightData)
                if (join.$limit && Object.keys(docs).length >= join.$limit) break
            }
            if (join.$limit && Object.keys(docs).length >= join.$limit) break
        }
        if (join.$groupby) return groupJoinedDocs(join, docs)
        if (join.$onlyIds) return Array.from(new Set(Object.keys(docs).flat()))
        return docs
    }

    /**
     * Whether one left/right pair satisfies any comparison in `$on`. A join
     * matches when at least one field comparison holds.
     * @param {any} join
     * @param {Record<string, any>} leftData
     * @param {Record<string, any>} rightData
     * @returns {boolean}
     */
    joinRowMatches(join, leftData, rightData) {
        for (const field in join.$on) {
            const operand = join.$on[field]
            if (!operand) continue
            for (const opKey of Object.keys(JOIN_COMPARATORS)) {
                const rightField = operand[opKey]
                if (!rightField) continue
                const leftValue = this.queryEngine.getValueByPath(leftData, String(field))
                const rightValue = this.queryEngine.getValueByPath(rightData, String(rightField))
                if (JOIN_COMPARATORS[opKey](leftValue, rightValue)) return true
            }
        }
        return false
    }

    /**
     * Shapes one matched pair per the join mode, then applies `$select` and
     * `$rename` projections.
     * @param {any} join
     * @param {Record<string, any>} leftData
     * @param {Record<string, any>} rightData
     * @returns {Record<string, any>}
     */
    projectJoinRow(join, leftData, rightData) {
        const combine = JOIN_MODES[join.$mode]
        // An unrecognized mode yields undefined, matching the previous switch
        // that simply left the row unset before projection.
        let projected = /** @type {Record<string, any>} */ (
            combine ? combine(leftData, rightData) : undefined
        )
        if (join.$select?.length) projected = this.queryEngine.selectValues(join.$select, projected)
        if (join.$rename) projected = this.queryEngine.renameFields(join.$rename, projected)
        return projected
    }
}
