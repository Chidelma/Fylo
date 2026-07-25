import path from 'node:path'
import { createReadStream } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import TTID from '../vendor/ttid.js'
import { FyloPreparedStatement, FyloQueryPlanner } from '../query/planner.js'
import { normalizeAccessInput } from '../security/access.js'
import { Cipher } from '../security/cipher.js'
import { FilesystemEngine } from '../storage/engine.js'
import { metaMutations } from '../storage/files.js'
import { emitFyloEvent } from '../observability/events.js'
import { LocalQueue } from '../queue/local.js'
import { validateDocId, filterTTIDs } from '../core/doc-id.js'
import { validateAgainstHead } from '../schema/validation.js'
import { materializeDoc, materializeEnvelope } from '../schema/migrate.js'
import { schemaEnv } from '../schema/env.js'
import { loadHeadSchema } from '../schema/versioning.js'
import {
    normalizeImportOptions,
    assertImportUrlAllowed,
    redactImportUrl,
    tlsCheckServerIdentity
} from '../security/import-guard.js'
import { createQueryCache } from '../cache/query.js'
import { VersionRepository } from '../versioning/repository.js'
import '../core/extensions.js'

/**
 * Adapts an independent Node file stream without involving Bun's compiled
 * FileBlob stream implementation. Pulling one chunk at a time preserves
 * backpressure while a raw file is durably copied.
 *
 * @param {string} filename
 * @returns {ReadableStream<Uint8Array>}
 */
function localFileStream(filename) {
    const source = createReadStream(filename)
    const iterator = source[Symbol.asyncIterator]()
    return new ReadableStream({
        async pull(controller) {
            try {
                const next = await iterator.next()
                if (next.done) {
                    controller.close()
                    return
                }
                const value = next.value
                controller.enqueue(
                    value instanceof Uint8Array ? value : new Uint8Array(/** @type {any} */ (value))
                )
            } catch (error) {
                controller.error(error)
            }
        },
        async cancel() {
            source.destroy()
            await iterator.return?.()
        }
    })
}

/**
 * @typedef {import('../replication/sync.js').FyloOptions<Record<string, any>>} FyloOptions
 * @typedef {import('../replication/sync.js').FyloSyncMode} FyloSyncMode
 * @typedef {import('../replication/sync.js').FyloSyncHooks<Record<string, any>>} FyloSyncHooks
 * @typedef {import('../replication/sync.js').FyloWriteSyncEvent<Record<string, any>>} FyloWriteSyncEvent
 * @typedef {import('../replication/sync.js').FyloDeleteSyncEvent} FyloDeleteSyncEvent
 * @typedef {import('../replication/sync.js').FyloAutoCommitEvent} FyloAutoCommitEvent
 * @typedef {import('../replication/sync.js').FyloWormMode} FyloWormMode
 * @typedef {import('../replication/sync.js').FyloWormOptions} FyloWormOptions
 * @typedef {import('../observability/events.js').FyloEvent} FyloEvent
 * @typedef {import('../observability/events.js').FyloEventHandler} FyloEventHandler
 * @typedef {import('../query/types.js').StoreDelete<Record<string, any>>} StoreDelete
 * @typedef {import('../query/types.js').StoreInsert<Record<string, any>>} StoreInsert
 * @typedef {import('../query/types.js').StoreJoin<Record<string, any>, Record<string, any>>} StoreJoin
 * @typedef {import('../query/types.js').StoreQuery<Record<string, any>>} StoreQuery
 * @typedef {import('../query/types.js').StoreUpdate<Record<string, any>>} StoreUpdate
 * @typedef {import('../types/vendor.js').TTID} TTIDValue
 * @typedef {import('../storage/types.js').CollectionInspectResult} CollectionInspectResult
 * @typedef {import('../storage/types.js').CollectionRebuildResult} CollectionRebuildResult
 * @typedef {import('../storage/types.js').CollectionCreateOptions} CollectionCreateOptions
 * @typedef {import('../queue/local.js').LocalQueue} LocalQueueInstance
 * @typedef {import('../cache/query.js').QueryCache} QueryCache
 * @typedef {import('../types/fylo.js').GetDocResult<Record<string, any>>} GetDocResult
 * @typedef {import('../types/fylo.js').FindDocsResult<Record<string, any>>} FindDocsResult
 * @typedef {import('../types/fylo.js').DeletedDocsResult<Record<string, any>>} DeletedDocsResult
 * @typedef {import('../types/fylo.js').JoinDocsResult<Record<string, any>, Record<string, any>>} JoinDocsResult
 */

/**
 * @typedef {import('../security/import-guard.js').ImportBulkDataOptions} ImportBulkDataOptions
 * @typedef {Blob | URL} RawFileInput
 * @typedef {Omit<ImportBulkDataOptions, 'limit'> & { key?: string, meta?: Record<string, any> }} RawFilePutOptions
 */

/**
 * @template T
 * @typedef {Promise<T> & { as(access: { uid: number }): AccessPromise<T> }} AccessPromise
 */

/**
 * @typedef {PromiseLike<TTIDValue> & {
 *   catch(onRejected?: (reason: any) => any): Promise<TTIDValue>,
 *   finally(onFinally?: () => void): Promise<TTIDValue>,
 *   as(access: { uid?: number, gid?: number, mode?: number }): MetadataPutOperation,
 *   metadata(record: Record<string, any>): Promise<TTIDValue>
 * }} MetadataPutOperation
 * @typedef {((data: Record<string, any> | RawFileInput, options?: RawFilePutOptions) => MetadataPutOperation) &
 *   ((id: TTIDValue, data: Record<string, any> | RawFileInput, options?: RawFilePutOptions) => MetadataPutOperation) &
 *   ((id: TTIDValue) => { metadata(record: Record<string, any>): any }) & {
 *   batch(batch: Array<Record<string, any> | RawFileInput>, options?: RawFilePutOptions): Promise<TTIDValue[]>
 * }} CollectionPut
 * @typedef {((id: TTIDValue, patch: Record<string, any>, oldDoc?: Record<TTIDValue, Record<string, any>>) => AccessPromise<TTIDValue>) & {
 *   many(update: StoreUpdate): AccessPromise<number>
 * }} CollectionPatch
 * @typedef {((id: TTIDValue) => AccessPromise<void>) & {
 *   many(query: StoreDelete): AccessPromise<number>
 * }} CollectionDelete
 * @typedef {((query?: StoreQuery) => FindDocsResult) & {
 *   deleted(query?: StoreQuery): DeletedDocsResult
 * }} CollectionFind
 * @typedef {((id: TTIDValue, key: string) => AccessPromise<string>) & {
 *   prefix(oldPrefix: string, newPrefix: string): Promise<number>
 * }} CollectionRekey
 */

/**
 * Starts a put on the next microtask. Synchronous `.as()` and `.metadata()`
 * chaining therefore binds configuration before filesystem work begins while
 * preserving the native Promise returned by the historical API.
 *
 * @param {(metadata: Record<string, any> | undefined, access: { uid?: number, gid?: number, mode?: number } | undefined) => Promise<TTIDValue>} write
 * @param {(id: TTIDValue, metadata: Record<string, any>, uid: number | undefined) => Promise<TTIDValue>} writeMetadata
 * @returns {MetadataPutOperation}
 */
function metadataPutOperation(write, writeMetadata) {
    /** @type {Record<string, any> | undefined} */
    let initialMetadata
    let hasInitialMetadata = false
    /** @type {unknown} */
    let validationError
    /** @type {{ uid?: number, gid?: number, mode?: number } | undefined} */
    let access
    let started = false
    const operation = Promise.resolve().then(async () => {
        started = true
        if (validationError) throw validationError
        return await write(hasInitialMetadata ? initialMetadata : undefined, access)
    })
    const enhanced = Object.assign(operation, {
        as(/** @type {{ uid?: number, gid?: number, mode?: number }} */ input) {
            if (started) throw new Error('as() must be called before the put operation starts')
            try {
                access = normalizeAccessInput(input, { allowMode: true })
            } catch (error) {
                validationError = error
            }
            return enhanced
        },
        metadata(/** @type {Record<string, any>} */ record) {
            try {
                metaMutations(record)
            } catch (error) {
                if (started) return Promise.reject(error)
                validationError = error
                return enhanced
            }
            if (!started) {
                initialMetadata = record
                hasInitialMetadata = true
                return enhanced
            }
            return operation.then((id) => writeMetadata(id, record, access?.uid))
        }
    })
    return /** @type {MetadataPutOperation} */ (enhanced)
}

/**
 * Builds a native Promise whose filesystem work starts on the next microtask,
 * leaving the same expression's `.as()` call time to bind the supplied UID.
 * @template T
 * @param {(access: { uid: number } | undefined) => Promise<T>} run
 * @returns {any}
 */
function deferredAccessOperation(run) {
    /** @type {{ uid: number } | undefined} */
    let access
    /** @type {unknown} */
    let validationError
    let started = false
    const operation = Promise.resolve().then(async () => {
        started = true
        if (validationError) throw validationError
        return await run(access)
    })
    return Object.assign(operation, {
        as(/** @type {{ uid: number }} */ input) {
            if (started) throw new Error('as() must be called before the operation starts')
            try {
                access = normalizeAccessInput(input, { allowMode: false })
            } catch (error) {
                validationError = error
            }
            return operation
        }
    })
}

/**
 * Native Promise used by the SQL tag. Access is bound synchronously through
 * `.as()` before planning/execution begins on the next microtask.
 * @template T
 * @param {(access: { uid?: number, gid?: number, mode?: number } | undefined) => Promise<T>} run
 * @returns {Promise<T> & { as(input: { uid?: number, gid?: number, mode?: number }): any }}
 */
function sqlAccessOperation(run) {
    /** @type {{ uid?: number, gid?: number, mode?: number } | undefined} */
    let access
    /** @type {unknown} */
    let validationError
    let started = false
    const operation = Promise.resolve().then(async () => {
        started = true
        if (validationError) throw validationError
        return await run(access)
    })
    return Object.assign(operation, {
        as(/** @type {{ uid?: number, gid?: number, mode?: number }} */ input) {
            if (started) throw new Error('as() must be called before SQL execution starts')
            try {
                access = normalizeAccessInput(input, { allowMode: true })
            } catch (error) {
                validationError = error
            }
            return operation
        }
    })
}

/**
 * Metadata-only puts historically return a native Promise. Keep that contract
 * while giving a same-expression `.as({ uid })` call one microtask to bind the
 * actor before the write starts.
 * @template T
 * @param {(access: { uid: number } | undefined) => Promise<T>} run
 * @returns {Promise<T> & { as(input: { uid: number }): any }}
 */
function accessPromiseOperation(run) {
    /** @type {{ uid: number } | undefined} */
    let access
    /** @type {unknown} */
    let validationError
    let started = false
    const operation = Promise.resolve().then(async () => {
        started = true
        if (validationError) throw validationError
        return await run(access)
    })
    return Object.assign(operation, {
        as(/** @type {{ uid: number }} */ input) {
            if (started) throw new Error('as() must be called before the metadata write starts')
            try {
                access = normalizeAccessInput(input, { allowMode: false })
            } catch (error) {
                validationError = error
            }
            return operation
        }
    })
}

/**
 * Thrown by `collection.put.batch` when one or more documents fail to write.
 * Every item in the batch is still attempted; the error then carries the ids
 * that were written and the per-item failures so callers can recover or retry
 * the failed records instead of silently losing them.
 */
export class FyloBatchWriteError extends Error {
    /** @type {'FYLO_BATCH_WRITE_FAILED'} */
    code = 'FYLO_BATCH_WRITE_FAILED'
    /** @type {string} */
    collection
    /** @type {TTIDValue[]} */
    writtenIds
    /** @type {Array<{ index: number, error: Error }>} */
    failures
    /**
     * @param {string} collection
     * @param {TTIDValue[]} writtenIds
     * @param {Array<{ index: number, error: Error }>} failures
     */
    constructor(collection, writtenIds, failures) {
        const total = writtenIds.length + failures.length
        super(
            `${failures.length} of ${total} documents failed to write to collection "${collection}"`
        )
        this.name = 'FyloBatchWriteError'
        this.collection = collection
        this.writtenIds = writtenIds
        this.failures = failures
    }
}

export default class Fylo {
    /** @type {string | undefined} */
    static LOGGING = process.env.FYLO_LOGGING
    /** @type {number} */
    static MAX_CPUS = navigator.hardwareConcurrency
    /** @type {string | undefined} */
    static STRICT = process.env.FYLO_STRICT
    /** @type {Promise<void>} */
    static ttidLock = Promise.resolve()
    /** Last id issued by {@link Fylo.uniqueTTID}; guards against same-tick collisions. */
    static lastTTID = ''
    /** Collections whose schema `$encrypted` config has already been loaded. */
    /** @type {Set<string>} */
    static loadedEncryption = new Set()
    /** @type {FilesystemEngine} */
    engine
    /** @type {string} */
    root
    /** @type {string} */
    repositoryRoot
    /** @type {FyloEventHandler | undefined} */
    onEvent
    /** @type {LocalQueueInstance | undefined} */
    queue
    /** @type {QueryCache | undefined} */
    cache
    /** @type {Promise<void>} */
    startup
    /** @type {FyloQueryPlanner} */
    planner = new FyloQueryPlanner()
    /** @type {(strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>} */
    sql
    /** @type {NonNullable<FyloOptions['versioning']>} */
    versioning
    /** @type {Promise<void>} */
    autoCommitLane = Promise.resolve()
    /** @type {number} */
    coalesceDepth = 0
    /** @type {Array<Omit<FyloAutoCommitEvent, 'repositoryRoot'>> | null} */
    coalesceChanges = null
    /**
     * @param {string} root
     * @param {FyloOptions} [options]
     */
    constructor(root, options = {}) {
        const requestedRoot = Fylo.rootFromPath(root)
        const repositoryRoot = VersionRepository.resolveRepositoryRoot(
            options.versioning?.repositoryRoot ?? requestedRoot
        )
        root = requestedRoot
        if (options.versioning?.resolve !== false) {
            root = VersionRepository.resolveActiveRoot(root)
        }
        if (Object.hasOwn(options, 'root')) {
            throw new Error(
                'Fylo constructor config must not include root; pass the database path as the first argument'
            )
        }
        this.root = root
        this.repositoryRoot = repositoryRoot
        this.versioning = options.versioning ?? {}
        this.onEvent = options.onEvent
        this.queue = options.queue ? new LocalQueue({ root }) : undefined
        this.cache = createQueryCache(root, options.cache)
        this.engine = new FilesystemEngine(root, {
            sync: options.sync,
            syncMode: options.syncMode,
            worm: options.worm,
            access: options.access,
            onEvent: options.onEvent,
            queue: this.queue,
            queryCache: this.cache,
            catalogRoot: this.repositoryRoot,
            ensureEncryptionLoaded: (collection) => this.loadEncryptionWithEvent(collection)
        })
        this.sql = this.createSqlTag()
        this.startup = (async () => {
            if (await Bun.file(path.join(repositoryRoot, '.fylo-vcs', 'HEAD')).exists()) {
                await new VersionRepository(repositoryRoot).init()
            }
            await this.bootstrapCollectionsFromSchemas()
        })()
        return this.createFyloProxy()
    }

    /** @returns {Promise<void>} */
    async ready() {
        await this.startup
    }

    async close() {
        await this.engine.close()
        await this.cache?.close?.()
    }

    /**
     * Force a full whole-root reconcile to S3 (upload changed, delete removed).
     * No-op unless `sync.s3` was configured. `backup()` is an alias.
     * @returns {Promise<void>}
     */
    async reconcile() {
        await this.engine.reconcile()
    }

    /** @returns {Promise<void>} */
    async backup() {
        await this.engine.reconcile()
    }

    /** Inspect the current and most recent S3 backup pass. */
    backupStatus() {
        return this.engine.backupStatus()
    }

    /** Inspect durable transaction generation and the latest recovery activity. @param {string} collection */
    async recoveryStatus(collection) {
        await this.ready()
        return await this.engine.transactions.inspect(collection)
    }

    /** @returns {Promise<void>} */
    async bootstrapCollectionsFromSchemas() {
        const schemaDir = schemaEnv()
        if (!schemaDir) return
        /** @type {import('node:fs').Dirent[]} */
        let entries = []
        try {
            entries = await readdir(schemaDir, { withFileTypes: true })
        } catch (err) {
            if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'ENOENT') throw err
            return
        }
        for (const entry of entries) {
            if (!entry.isDirectory()) continue
            const collection = entry.name
            if (!(await Bun.file(path.join(schemaDir, collection, 'manifest.json')).exists()))
                continue
            await this.engine.createCollection(collection)
        }
    }

    /** @returns {string} */
    static defaultRoot() {
        return process.env.FYLO_ROOT || path.join(process.cwd(), '.fylo-data')
    }
    /**
     * @param {string} root
     * @returns {string}
     */
    static rootFromPath(root) {
        if (typeof root !== 'string' || root.length === 0) {
            throw new Error('Fylo constructor requires a database path string')
        }
        if (root.startsWith('fylo://')) {
            throw new Error('Fylo constructor accepts a filesystem path directly; remove fylo://')
        }
        return root
    }
    /** @returns {FilesystemEngine} */
    static get defaultEngine() {
        return new FilesystemEngine(Fylo.defaultRoot())
    }
    /**
     * @param {unknown} value
     * @returns {string}
     */
    static sqlValue(value) {
        if (value === null || value === undefined) return 'NULL'
        if (typeof value === 'number') {
            if (!Number.isFinite(value)) throw new Error('SQL parameter must be a finite number')
            return String(value)
        }
        if (typeof value === 'boolean') return value ? 'true' : 'false'
        if (typeof value === 'bigint') return value.toString()
        if (value instanceof Date) return `'${value.toISOString().replaceAll("'", "''")}'`
        if (typeof value === 'object') {
            throw new Error('SQL parameters must be scalar values')
        }
        return `'${String(value).replaceAll("'", "''")}'`
    }
    /**
     * Internal: execute a raw SQL string. Prefer the `fylo.sql`...`` template tag for application code.
     * @param {string} SQL
     * @param {{ uid?: number, gid?: number, mode?: number }=} access
     * @returns {Promise<unknown>}
     */
    async _sql(SQL, access = undefined) {
        await this.ready()
        const plan = this.planner.prepare(SQL)
        const normalizedAccess = access
            ? normalizeAccessInput(access, { allowMode: true })
            : undefined
        if (
            plan.operation !== 'INSERT' &&
            (normalizedAccess?.gid !== undefined || normalizedAccess?.mode !== undefined)
        ) {
            throw new TypeError('SQL gid and mode are only supported for INSERT statements')
        }
        if (
            normalizedAccess &&
            (plan.operation === 'SELECT' ||
                plan.operation === 'UPDATE' ||
                plan.operation === 'DELETE') &&
            normalizedAccess.uid === undefined
        ) {
            throw new TypeError(`SQL ${plan.operation} as() requires a numeric uid`)
        }
        if (normalizedAccess && (plan.operation === 'CREATE' || plan.operation === 'DROP')) {
            throw new TypeError(`SQL ${plan.operation} does not support as({ uid })`)
        }
        if (plan.explain && !plan.analyze) return this.planner.describe(plan)
        const startedAt = performance.now()
        const result = await this.executeSqlPlan(plan, normalizedAccess)
        if (!plan.explain) return result
        return {
            ...this.planner.describe(plan),
            executed: true,
            elapsedMs: performance.now() - startedAt,
            result
        }
    }
    /**
     * @param {ReturnType<FyloQueryPlanner['prepare']>} plan
     * @param {{ uid?: number, gid?: number, mode?: number }=} access
     * @returns {Promise<unknown>}
     */
    async executeSqlPlan(plan, access = undefined) {
        const operation = plan.operation
        const parsed = /** @type {any} */ (structuredClone(plan.ast))
        const col = String(parsed.$collection ?? '')
        switch (operation) {
            case 'CREATE':
                return await new CollectionFacade(this, col).create()
            case 'DROP':
                return await new CollectionFacade(this, col).drop()
            case 'SELECT': {
                const query = /** @type {StoreQuery} */ (parsed)
                if (plan.sql.includes('JOIN'))
                    return await this.join(/** @type {StoreJoin} */ (query), access?.uid)
                const selectedCollection = query.$collection
                delete query.$collection
                const cursor = new CollectionFacade(this, String(selectedCollection)).find(query)
                if (access) cursor.as({ uid: /** @type {number} */ (access.uid) })
                /** @type {TTIDValue[] | Record<string, any>} */
                let docs = query.$onlyIds ? [] : {}
                for await (const data of cursor.collect()) {
                    if (typeof data === 'object')
                        docs = /** @type {{ appendGroup(target: any, value: any): any }} */ (
                            /** @type {unknown} */ (Object)
                        ).appendGroup(docs, data)
                    else docs.push(data)
                }
                return docs
            }
            case 'INSERT': {
                const insert = /** @type {StoreInsert} */ (parsed)
                const insertCollection = insert.$collection
                delete insert.$collection
                const operation = new CollectionFacade(this, String(insertCollection)).put(
                    insert.$values
                )
                return await (access ? operation.as(access) : operation)
            }
            case 'UPDATE': {
                const update = /** @type {StoreUpdate} */ (parsed)
                const updateCol = update.$collection
                delete update.$collection
                const operation = new CollectionFacade(this, String(updateCol)).patch.many(update)
                return await (access
                    ? operation.as({ uid: /** @type {number} */ (access.uid) })
                    : operation)
            }
            case 'DELETE': {
                const del = /** @type {StoreDelete} */ (parsed)
                const deleteCollection = del.$collection
                delete del.$collection
                const operation = new CollectionFacade(this, String(deleteCollection)).delete.many(
                    del
                )
                return await (access
                    ? operation.as({ uid: /** @type {number} */ (access.uid) })
                    : operation)
            }
            default:
                throw new Error('Invalid Operation')
        }
    }
    /**
     * Parses and retains a reusable SQL plan.
     * @param {string} SQL
     * @returns {FyloPreparedStatement}
     */
    prepare(SQL) {
        const plan = this.planner.prepare(SQL)
        return new FyloPreparedStatement(this.planner, plan, async (prepared) => {
            await this.ready()
            return await this.executeSqlPlan(prepared)
        })
    }
    createSqlTag() {
        const fylo = this
        return /** @type {(strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown> & { as(input: { uid?: number, gid?: number, mode?: number }): any }} */ (
            (strings, ...values) =>
                sqlAccessOperation((access) => {
                    let statement = strings[0] ?? ''
                    for (let index = 0; index < values.length; index++) {
                        statement += Fylo.sqlValue(values[index]) + (strings[index + 1] ?? '')
                    }
                    return fylo._sql(statement, access)
                })
        )
    }
    /** @returns {Fylo} */
    createFyloProxy() {
        const fylo = this
        const reserved = new Set([
            'then',
            'constructor',
            'prototype',
            '_sql',
            ...Object.getOwnPropertyNames(Object.prototype),
            ...Object.getOwnPropertyNames(Fylo.prototype),
            ...Object.getOwnPropertyNames(fylo)
        ])
        return new Proxy(this, {
            get(target, prop, receiver) {
                if (typeof prop === 'symbol') return Reflect.get(target, prop, receiver)
                if (reserved.has(prop)) return Reflect.get(target, prop, receiver)
                return new CollectionFacade(fylo, prop)
            }
        })
    }
    /**
     * Loads encrypted field config from a collection's JSON schema if not already loaded.
     * Reads the `$encrypted` array from the schema and registers fields with Cipher.
     * Auto-configures the Cipher key from `FYLO_ENCRYPTION_KEY` env var on first use.
     */
    /** @param {string} collection @returns {Promise<void>} */
    static async loadEncryption(collection) {
        if (Fylo.loadedEncryption.has(collection)) return
        const schemaDir = schemaEnv()
        if (!schemaDir) {
            Fylo.loadedEncryption.add(collection)
            return
        }
        const schema = await loadHeadSchema(collection, schemaDir)
        if (!schema) {
            Fylo.loadedEncryption.add(collection)
            return
        }
        const encrypted = schema.$encrypted
        if (encrypted !== undefined && !Array.isArray(encrypted))
            throw new Error(`Schema $encrypted for ${collection} must be an array of field names`)
        if (Array.isArray(encrypted) && encrypted.length > 0) {
            if (!encrypted.every((field) => typeof field === 'string' && field.length > 0))
                throw new Error(`Schema $encrypted for ${collection} must only contain strings`)
            if (!Cipher.isConfigured()) {
                const secret = process.env.FYLO_ENCRYPTION_KEY
                if (!secret) {
                    // Fail closed: reads of this collection must not fall back
                    // to handing the caller stored ciphertext.
                    const error = /** @type {Error & { code: string }} */ (
                        new Error(
                            `Collection "${collection}" declares $encrypted fields but FYLO_ENCRYPTION_KEY env var is not set`
                        )
                    )
                    error.code = 'EDECRYPTFAILED'
                    throw error
                }
                if (secret.length < 32)
                    throw new Error('FYLO_ENCRYPTION_KEY must be at least 32 characters long')
                await Cipher.configure(secret)
            }
            Cipher.registerFields(collection, encrypted)
        }
        Fylo.loadedEncryption.add(collection)
    }
    /** @param {StoreJoin} join @param {number=} actorUid @returns {Promise<JoinDocsResult>} */
    async join(join, actorUid = undefined) {
        await this.ready()
        return await this.engine.joinDocs(join, actorUid)
    }
    /** @param {string} collection @param {URL} url @param {number | ImportBulkDataOptions} [limitOrOptions] @returns {Promise<number>} */
    async importBulkData(collection, url, limitOrOptions) {
        await this.ready()
        await this.engine.requireCollection(collection)
        const importOptions = normalizeImportOptions(limitOrOptions)
        const limit = importOptions.limit
        if (limit !== undefined && limit <= 0) return 0
        /** @type {{ pinnedUrls: URL[], serverName: string } | null} */
        let pin = null
        try {
            pin = await assertImportUrlAllowed(url, importOptions)
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            /** @type {'protocol' | 'host' | 'private-network'} */
            let reason = 'host'
            if (message.includes('protocol is not allowed')) reason = 'protocol'
            else if (message.includes('host is not allowed')) reason = 'host'
            else if (message.includes('private address')) reason = 'private-network'
            emitFyloEvent(this.onEvent, {
                type: 'import.blocked',
                reason,
                url: redactImportUrl(url),
                detail: message
            })
            throw err
        }
        /** @type {RequestInit & { tls?: { serverName?: string, checkServerIdentity?: Function } }} */
        const fetchInit = { redirect: 'manual' }
        if (pin) {
            const { serverName } = pin
            fetchInit.headers = { Host: url.host }
            if (url.protocol === 'https:') {
                fetchInit.tls = {
                    serverName,
                    /** @param {string} _hostname @param {import('node:tls').PeerCertificate} cert */
                    checkServerIdentity: (_hostname, cert) =>
                        tlsCheckServerIdentity(serverName, cert)
                }
            }
        }
        /** @type {URL[]} */
        const fetchTargets = pin ? pin.pinnedUrls : [url]
        /** @type {Response | undefined} */
        let response
        /** @type {unknown} */
        let lastFetchError
        for (let i = 0; i < fetchTargets.length; i++) {
            try {
                response = await fetch(fetchTargets[i], fetchInit)
                break
            } catch (err) {
                lastFetchError = err
                if (i === fetchTargets.length - 1) throw err
            }
        }
        if (!response)
            throw lastFetchError instanceof Error
                ? lastFetchError
                : new Error('Import request failed')
        if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get('location')
            const redactedLocation = location ? redactImportUrl(location) : 'unknown'
            emitFyloEvent(this.onEvent, {
                type: 'import.blocked',
                reason: 'redirect',
                url: redactImportUrl(url),
                detail: `redirect to ${redactedLocation}`
            })
            throw new Error(`Import request redirected to ${redactedLocation}`)
        }
        if (!response.ok) throw new Error(`Import request failed with status ${response.status}`)
        if (!response.headers.get('content-type')?.includes('application/json'))
            throw new Error('Response is not JSON')
        if (!response.body) throw new Error('Response body is empty')
        const responseBody = response.body
        let count = 0
        let batchNum = 0
        /** @param {Record<string, any>[]} batch @returns {Promise<void>} */
        const flush = async (batch) => {
            if (!batch.length) return
            const items =
                limit !== undefined && count + batch.length > limit
                    ? batch.slice(0, limit - count)
                    : batch
            if (!items.length) return
            batchNum++
            const start = Date.now()
            await new CollectionFacade(this, collection).put.batch(items)
            count += items.length
            if (count % 10000 === 0) console.log('Count:', count)
            if (Fylo.LOGGING) {
                const bytes = JSON.stringify(items).length
                const elapsed = Date.now() - start
                const bytesPerSec = (bytes / (elapsed / 1000)).toFixed(2)
                console.log(
                    `Batch ${batchNum} of ${bytes} bytes took ${elapsed === Infinity ? 'Infinity' : elapsed}ms (${bytesPerSec} bytes/sec)`
                )
            }
        }
        // Coalesce the entire stream into one commit: each `flush` opens a
        // nested coalesced scope that joins this outer one, so a multi-batch
        // import records a single version-control entry instead of one per batch.
        return await this.runCoalesced(async () => {
            let isJsonArray = null
            const jsonArrayChunks = []
            let jsonArrayLength = 0
            let pending = new Uint8Array(0)
            /** @type {Record<string, any>[]} */
            let batch = []
            let totalBytes = 0
            for await (const chunk of /** @type {AsyncIterable<Uint8Array>} */ (
                /** @type {unknown} */ (responseBody)
            )) {
                totalBytes += chunk.length
                if (totalBytes > importOptions.maxBytes)
                    throw new Error(`Import response exceeded ${importOptions.maxBytes} bytes`)
                if (isJsonArray === null) isJsonArray = chunk[0] === 0x5b
                if (isJsonArray) {
                    jsonArrayChunks.push(chunk)
                    jsonArrayLength += chunk.length
                    continue
                }
                const merged = new Uint8Array(pending.length + chunk.length)
                merged.set(pending)
                merged.set(chunk, pending.length)
                const { values, read } = Bun.JSONL.parseChunk(merged)
                pending = merged.subarray(read)
                for (const item of values) {
                    batch.push(/** @type {Record<string, any>} */ (item))
                    if (batch.length === Fylo.MAX_CPUS) {
                        await flush(batch)
                        batch = []
                        if (limit !== undefined && count >= limit) return count
                    }
                }
            }
            if (isJsonArray) {
                const body = new Uint8Array(jsonArrayLength)
                let offset = 0
                for (const c of jsonArrayChunks) {
                    body.set(c, offset)
                    offset += c.length
                }
                let data
                try {
                    data = JSON.parse(new TextDecoder().decode(body))
                } catch {
                    throw new Error('Invalid JSON in import response')
                }
                const items = /** @type {Record<string, any>[]} */ (
                    Array.isArray(data) ? data : [data]
                )
                for (let i = 0; i < items.length; i += Fylo.MAX_CPUS) {
                    if (limit !== undefined && count >= limit) break
                    await flush(items.slice(i, i + Fylo.MAX_CPUS))
                }
            } else {
                if (pending.length > 0) {
                    const { values } = Bun.JSONL.parseChunk(pending)
                    for (const item of values) batch.push(/** @type {Record<string, any>} */ (item))
                }
                if (batch.length > 0) await flush(batch)
            }
            return count
        })
    }
    /**
     * Puts a document into a collection.
     * @param collection The name of the collection.
     * @param data The document to put.
     * @returns The ID of the document.
     */
    /** @param {TTIDValue | undefined} existingId @returns {Promise<TTIDValue>} */
    static async uniqueTTID(existingId) {
        let _id
        const prev = Fylo.ttidLock
        Fylo.ttidLock = prev.then(async () => {
            if (existingId) {
                _id = await TTID.generate(existingId)
                return
            }
            // Fresh ids are serialized here, but TTID.generate() is clock-based:
            // rapid concurrent inserts can land in the same tick and produce the
            // same id (→ two docs collide on one file). Regenerate until strictly
            // greater than the last issued id. TTIDs are equal-length time-ordered
            // strings, so string comparison matches chronological order; the clock
            // advances within a couple of iterations.
            do {
                _id = await TTID.generate()
            } while (_id <= Fylo.lastTTID)
            Fylo.lastTTID = /** @type {string} */ (_id)
        })
        await Fylo.ttidLock
        return /** @type {TTIDValue} */ (/** @type {unknown} */ (_id))
    }
    /**
     * Loads schema-driven encryption config for a collection and emits
     * `cipher.configured` if this call was the one that flipped the global
     * Cipher from unconfigured to configured.
     * @param {string} collection
     * @returns {Promise<void>}
     */
    async loadEncryptionWithEvent(collection) {
        const before = Cipher.isConfigured()
        await Fylo.loadEncryption(collection)
        if (!before && Cipher.isConfigured()) {
            emitFyloEvent(this.onEvent, { type: 'cipher.configured', collection })
        }
    }
    /** @returns {boolean} */
    autoCommitEnabled() {
        if (this.engine.wormEnabled()) return false
        return this.versioning.autoCommit !== false
    }
    /**
     * @param {FyloAutoCommitEvent} event
     * @returns {string}
     */
    autoCommitMessage(event) {
        return (
            this.versioning.autoCommitMessage?.(event) ??
            `${event.operation} ${event.collection}/${event.docId}`
        )
    }
    /**
     * Promotes a successful document mutation into version-control history.
     * Inside a {@link runCoalesced} block the change is recorded but its commit
     * is deferred so the whole bulk operation yields one commit; otherwise the
     * dirty check runs immediately under a repository-level lock so parallel
     * writes commit in deterministic order.
     *
     * @param {Omit<FyloAutoCommitEvent, 'repositoryRoot'>} event
     * @returns {Promise<void>}
     */
    async autoCommit(event) {
        if (!this.autoCommitEnabled()) return
        if (this.coalesceDepth > 0) {
            this.coalesceChanges?.push(event)
            return
        }
        const message = this.autoCommitMessage({ ...event, repositoryRoot: this.repositoryRoot })
        const hints = [{ collection: event.collection, id: String(event.docId) }]
        await this.runAutoCommit((repository) => repository.commitIfDirty(message, hints))
    }
    /**
     * Groups every document mutation performed inside `fn` into a single
     * version-control commit instead of one commit per write. Nested calls join
     * the outermost group, so a streaming import that issues many internal
     * batches still produces exactly one commit. With auto-commit disabled (or
     * in WORM mode) this is a transparent pass-through.
     *
     * @template T
     * @param {() => Promise<T>} fn
     * @returns {Promise<T>}
     */
    async runCoalesced(fn) {
        if (!this.autoCommitEnabled()) return await fn()
        const outermost = this.coalesceDepth === 0
        if (outermost) this.coalesceChanges = []
        this.coalesceDepth++
        try {
            return await fn()
        } finally {
            this.coalesceDepth--
            if (outermost) {
                const changes = this.coalesceChanges ?? []
                this.coalesceChanges = null
                if (changes.length > 0) await this.commitCoalesced(changes)
            }
        }
    }
    /**
     * @param {Array<Omit<FyloAutoCommitEvent, 'repositoryRoot'>>} changes
     * @returns {Promise<void>}
     */
    async commitCoalesced(changes) {
        const { operation, collection } = changes[0]
        const count = changes.length
        const message = `${operation} ${collection} (${count} document${count === 1 ? '' : 's'})`
        const hints = changes.map((change) => ({
            collection: change.collection,
            id: String(change.docId)
        }))
        await this.runAutoCommit((repository) => repository.commitIfDirty(message, hints))
    }
    /**
     * Serializes a repository write behind {@link autoCommitLane} so concurrent
     * mutations on this instance commit in order, and absorbs failures into the
     * lane without breaking the chain for the next writer.
     *
     * @param {(repository: VersionRepository) => Promise<unknown>} commit
     * @returns {Promise<void>}
     */
    async runAutoCommit(commit) {
        const run = this.autoCommitLane
            .catch(() => {})
            .then(async () => {
                await commit(new VersionRepository(this.repositoryRoot))
            })
        this.autoCommitLane = run.catch(() => {})
        await run
    }
    /**
     * Converts a public raw-file input into a one-shot byte stream. File URLs
     * are read locally; network URLs pass through the same SSRF and redirect
     * controls as bulk imports.
     *
     * @param {RawFileInput} input
     * @param {RawFilePutOptions} [options]
     * @returns {Promise<import('../storage/files.js').RawFileSource>}
     */
    async prepareFileSource(input, options = {}) {
        const normalized = normalizeImportOptions(options)
        if (input instanceof Blob) {
            if (input.size > normalized.maxBytes) {
                throw new Error(`Raw file exceeded ${normalized.maxBytes} bytes`)
            }
            return {
                stream: /** @type {ReadableStream<Uint8Array>} */ (input.stream()),
                name:
                    typeof (/** @type {{ name?: unknown }} */ (input).name) === 'string'
                        ? /** @type {{ name: string }} */ (/** @type {unknown} */ (input)).name
                        : undefined,
                contentType: input.type || undefined,
                key: options.key,
                maxBytes: normalized.maxBytes
            }
        }
        if (!(input instanceof URL)) {
            throw new Error('File collection put() requires a Blob, File, or URL')
        }
        if (input.protocol === 'file:') {
            const file = Bun.file(fileURLToPath(input))
            if (!(await file.exists())) throw new Error(`Raw file source was not found: ${input}`)
            if (file.size > normalized.maxBytes) {
                throw new Error(`Raw file exceeded ${normalized.maxBytes} bytes`)
            }
            return {
                // Bun's compiled runtime can stop servicing a long-lived stdin
                // iterator after Bun.file().stream() reaches EOF. Adapt the
                // independent Node file stream instead so `fylo exec --loop`
                // retains ownership of stdin for the next machine request.
                stream: localFileStream(fileURLToPath(input)),
                name: decodeURIComponent(input.pathname.split('/').pop() ?? ''),
                contentType: file.type || undefined,
                key: options.key,
                maxBytes: normalized.maxBytes
            }
        }
        const response = await this.fetchRawFile(input, normalized)
        if (!response.body) throw new Error('Raw file response body is empty')
        const declaredLength = Number(response.headers.get('content-length'))
        if (Number.isFinite(declaredLength) && declaredLength > normalized.maxBytes) {
            throw new Error(`Raw file exceeded ${normalized.maxBytes} bytes`)
        }
        const disposition = response.headers.get('content-disposition') ?? ''
        const filename = disposition.match(/filename\*?=(?:UTF-8''|")?([^";]+)/i)?.[1]
        return {
            stream: /** @type {ReadableStream<Uint8Array>} */ (response.body),
            name:
                filename !== undefined
                    ? decodeURIComponent(filename.trim())
                    : decodeURIComponent(input.pathname.split('/').pop() || 'file.bin'),
            contentType: response.headers.get('content-type') ?? undefined,
            key: options.key,
            maxBytes: normalized.maxBytes
        }
    }
    /**
     * @param {URL} url
     * @param {ReturnType<typeof normalizeImportOptions>} options
     * @returns {Promise<Response>}
     */
    async fetchRawFile(url, options) {
        const pin = await assertImportUrlAllowed(url, options)
        /** @type {RequestInit & { tls?: { serverName?: string, checkServerIdentity?: Function } }} */
        const fetchInit = { redirect: 'manual' }
        if (pin) {
            fetchInit.headers = { Host: url.host }
            if (url.protocol === 'https:') {
                fetchInit.tls = {
                    serverName: pin.serverName,
                    /** @param {string} _hostname @param {import('node:tls').PeerCertificate} cert */
                    checkServerIdentity: (_hostname, cert) =>
                        tlsCheckServerIdentity(pin.serverName, cert)
                }
            }
        }
        const targets = pin ? pin.pinnedUrls : [url]
        /** @type {Response | undefined} */
        let response
        /** @type {unknown} */
        let lastError
        for (const target of targets) {
            try {
                response = await fetch(target, fetchInit)
                break
            } catch (error) {
                lastError = error
            }
        }
        if (!response) {
            throw lastError instanceof Error ? lastError : new Error('Raw file request failed')
        }
        if (response.status >= 300 && response.status < 400) {
            throw new Error(
                `Raw file request redirected to ${redactImportUrl(response.headers.get('location') ?? 'unknown')}`
            )
        }
        if (!response.ok) {
            throw new Error(`Raw file request failed with status ${response.status}`)
        }
        return response
    }
    /** @param {string} collection @param {Record<string, any>} data @returns {Promise<{ _id: TTIDValue, doc: Record<string, any>, previousId?: TTIDValue }>} */
    async prepareInsert(collection, data) {
        await this.ready()
        await this.loadEncryptionWithEvent(collection)
        const currId = Object.keys(data).shift()
        const hasExistingId = typeof currId === 'string' && (await TTID.isTTID(currId)) !== null
        const _id = hasExistingId ? currId : await Fylo.uniqueTTID(undefined)
        let doc = hasExistingId ? Object.values(data).shift() : data
        if (Fylo.STRICT) doc = await validateAgainstHead(collection, doc)
        return { _id, doc, previousId: hasExistingId ? currId : undefined }
    }
    /**
     * @param {string} collection
     * @param {RawFileInput} input
     * @param {RawFilePutOptions} [options]
     * @param {{ uid?: number, gid?: number, mode?: number }} [access]
     * @returns {Promise<TTIDValue>}
     */
    async executePutFileDirect(collection, input, options, access) {
        await this.ready()
        const source = await this.prepareFileSource(input, options)
        if (options?.meta !== undefined) source.meta = options.meta
        if (access) source.access = access
        return await this.executePutFileSourceDirect(collection, source)
    }
    /**
     * @param {string} collection
     * @param {TTIDValue} id
     * @param {RawFileInput} input
     * @param {RawFilePutOptions} [options]
     * @param {{ uid?: number, gid?: number, mode?: number }} [access]
     * @returns {Promise<TTIDValue>}
     */
    async executePutFileAtIdDirect(collection, id, input, options, access) {
        await this.ready()
        await validateDocId(id)
        const source = await this.prepareFileSource(input, options)
        if (options?.meta !== undefined) source.meta = options.meta
        if (access) source.access = access
        await this.engine.putFile(collection, id, source)
        await this.autoCommit({ operation: 'put', collection, docId: id })
        return id
    }
    /**
     * @param {string} collection
     * @param {import('../storage/files.js').RawFileSource} source
     * @returns {Promise<TTIDValue>}
     */
    async executePutFileSourceDirect(collection, source) {
        let id = await Fylo.uniqueTTID(undefined)
        while (!(await this.engine.putFile(collection, id, source, true))) {
            id = await Fylo.uniqueTTID(undefined)
        }
        await this.autoCommit({ operation: 'put', collection, docId: id })
        return id
    }
    /** @param {string} collection @param {TTIDValue} _id @param {Record<string, any>} doc @param {TTIDValue | undefined} previousId @param {Record<string, any>=} meta @param {{ uid?: number, gid?: number, mode?: number }=} access @param {boolean=} generated @returns {Promise<TTIDValue>} */
    async executePutDataDirect(collection, _id, doc, previousId, meta, access, generated = false) {
        await this.ready()
        if (previousId)
            await this.engine.replaceDocumentVersion(
                collection,
                previousId,
                _id,
                doc,
                undefined,
                meta,
                access
            )
        else if (generated) {
            while (!(await this.engine.putDocument(collection, _id, doc, meta, access, true))) {
                _id = await Fylo.uniqueTTID(undefined)
            }
        } else await this.engine.putDocument(collection, _id, doc, meta, access)
        await this.autoCommit({
            operation: previousId ? 'patch' : 'put',
            collection,
            docId: _id
        })
        if (Fylo.LOGGING) console.log(`Finished Writing ${_id}`)
        return _id
    }
    /**
     * @param {string} collection
     * @param {TTIDValue} id
     * @param {Record<string, any>} record
     * @param {number=} actorUid
     * @returns {Promise<TTIDValue>}
     */
    async writeDocMetadata(collection, id, record, actorUid = undefined) {
        await this.ready()
        await this.engine.atomic(collection, 'meta', async () => {
            await this.engine.setDocMetaRecord(collection, String(id), record, actorUid)
            await this.engine.publishDocumentEvent(collection, {
                ts: await this.engine.docMetaUpdatedAt(collection, String(id)),
                action: 'meta',
                id,
                meta: await this.engine.listDocMeta(collection, String(id))
            })
        })
        await this.autoCommit({ operation: 'meta', collection, docId: id })
        return id
    }
    /**
     * @param {string} collection
     * @param {TTIDValue} id
     * @param {Record<string, any>} record authoritative complete metadata record
     * @param {number=} actorUid
     * @returns {Promise<TTIDValue>}
     */
    async replaceDocMetadata(collection, id, record, actorUid = undefined) {
        await this.ready()
        await this.engine.atomic(collection, 'meta', async () => {
            await this.engine.replaceDocMetaRecord(collection, String(id), record, actorUid)
            await this.engine.publishDocumentEvent(collection, {
                ts: await this.engine.docMetaUpdatedAt(collection, String(id)),
                action: 'meta',
                id,
                meta: await this.engine.listDocMeta(collection, String(id))
            })
        })
        await this.autoCommit({ operation: 'meta', collection, docId: id })
        return id
    }
    /** @param {string} collection @param {Record<TTIDValue, Record<string, any>>} newDoc @param {Record<TTIDValue, Record<string, any>>} [oldDoc] @param {number=} actorUid @returns {Promise<TTIDValue>} */
    async executePatchDocDirect(collection, newDoc, oldDoc = {}, actorUid = undefined) {
        await this.ready()
        await this.loadEncryptionWithEvent(collection)
        const _id = Object.keys(newDoc).shift()
        if (!_id) throw new Error('this document does not contain an TTID')
        await validateDocId(_id)
        let existingDoc = oldDoc[_id]
        if (!existingDoc) {
            const existing = await this.engine.getDoc(collection, _id, false, actorUid).once()
            existingDoc = existing[_id]
        }
        if (!existingDoc) return _id
        const currData = { ...existingDoc, ...newDoc[_id] }
        let docToWrite = currData
        if (Fylo.STRICT) docToWrite = await validateAgainstHead(collection, currData)
        const nextId = await this.engine.patchDocument(
            collection,
            _id,
            _id,
            docToWrite,
            existingDoc,
            actorUid
        )
        if (Fylo.LOGGING) console.log(`Finished Updating ${_id} to ${nextId}`)
        await this.autoCommit({ operation: 'patch', collection, docId: nextId })
        return nextId
    }
    /** @param {string} collection @param {TTIDValue} _id @param {number=} actorUid @returns {Promise<void>} */
    async executeDelDocDirect(collection, _id, actorUid = undefined) {
        await this.ready()
        await validateDocId(_id)
        await this.engine.deleteDocument(collection, _id, actorUid)
        await this.autoCommit({ operation: 'delete', collection, docId: _id })
        if (Fylo.LOGGING) console.log(`Finished Deleting ${_id}`)
    }
    /** @param {string} collection @param {TTIDValue} _id @param {number=} actorUid @returns {Promise<TTIDValue>} */
    async executeRestoreDocDirect(collection, _id, actorUid = undefined) {
        await this.ready()
        const restoredId = await this.engine.restoreDocument(collection, _id, actorUid)
        await this.autoCommit({ operation: 'restore', collection, docId: restoredId })
        return restoredId
    }
}

/**
 * Collection-scoped facade returned by `fylo.<collection>`.
 * Each access creates a new facade that binds the collection name
 * so callers write `fylo.users.get(id)` instead of `fylo.getDoc('users', id)`.
 */
export class CollectionFacade {
    /** @type {Fylo} */
    fylo
    /** @type {string} */
    collection
    /** @type {CollectionPut} */
    put
    /** @type {CollectionPatch} */
    patch
    /** @type {CollectionDelete} */
    delete
    /** @type {CollectionFind} */
    find
    /** @type {CollectionRekey} */
    rekey
    /**
     * @param {Fylo} fylo
     * @param {string} collection
     */
    constructor(fylo, collection) {
        this.fylo = fylo
        this.collection = collection

        const self = this
        // rekey / rekey.prefix — reassign object keys in place (no byte rewrite).
        const rekey = /** @type {CollectionRekey} */ (
            /** @type {unknown} */ (
                (/** @type {TTIDValue} */ id, /** @type {string} */ key) =>
                    deferredAccessOperation(async (access) => {
                        await self.fylo.ready()
                        const next = await self.fylo.engine.rekeyFile(
                            self.collection,
                            String(id),
                            key,
                            access?.uid
                        )
                        await self.fylo.autoCommit({
                            operation: 'rekey',
                            collection: self.collection,
                            docId: id
                        })
                        return next
                    })
            )
        )
        rekey.prefix = async (oldPrefix, newPrefix) => {
            for (const prefix of [oldPrefix, newPrefix]) {
                if (
                    typeof prefix !== 'string' ||
                    !prefix.startsWith('/') ||
                    !prefix.endsWith('/')
                ) {
                    throw new Error("Rekey prefixes must start and end with '/'")
                }
            }
            await self.fylo.ready()
            // One coalesced commit for the whole folder move.
            return await self.fylo.runCoalesced(async () => {
                let moved = 0
                for await (const entry of self
                    .find({ $ops: [{ key: { $like: `${oldPrefix}%` } }] })
                    .collect()) {
                    if (typeof entry !== 'object' || entry === null) continue
                    for (const [docId, data] of Object.entries(entry)) {
                        const key = String(data?.key ?? '')
                        if (!key.startsWith(oldPrefix)) continue
                        await self.fylo.engine.rekeyFile(
                            self.collection,
                            docId,
                            `${newPrefix}${key.slice(oldPrefix.length)}`
                        )
                        await self.fylo.autoCommit({
                            operation: 'rekey',
                            collection: self.collection,
                            docId
                        })
                        moved++
                    }
                }
                return moved
            })
        }
        this.rekey = rekey

        // put / put.batch
        const put = /** @type {CollectionPut} */ (
            /** @type {unknown} */ (
                function (
                    /** @type {TTIDValue | Record<string, any> | RawFileInput} */ idOrData,
                    /** @type {Record<string, any> | RawFileInput | RawFilePutOptions | undefined} */ dataOrOptions,
                    /** @type {RawFilePutOptions | undefined} */ explicitOptions
                ) {
                    if (typeof idOrData === 'string') {
                        const id = /** @type {TTIDValue} */ (idOrData)
                        if (arguments.length === 1) {
                            return {
                                metadata: (/** @type {Record<string, any>} */ record) => {
                                    return accessPromiseOperation(async (access) => {
                                        metaMutations(record)
                                        return await self.fylo.writeDocMetadata(
                                            self.collection,
                                            id,
                                            record,
                                            access?.uid
                                        )
                                    })
                                }
                            }
                        }
                        const data = /** @type {Record<string, any> | RawFileInput} */ (
                            dataOrOptions
                        )
                        return metadataPutOperation(
                            async (metadata, access) => {
                                await self.fylo.ready()
                                await self.fylo.engine.requireCollection(self.collection)
                                const kind = await self.fylo.engine.collectionKind(self.collection)
                                const rawInput = data instanceof Blob || data instanceof URL
                                const options = {
                                    ...(explicitOptions ?? {}),
                                    ...(metadata ? { meta: metadata } : {})
                                }
                                if (kind === 'file') {
                                    if (!rawInput) {
                                        throw new Error(
                                            `Collection "${self.collection}" is a file collection; put(id, file) requires a Blob, File, or URL`
                                        )
                                    }
                                    return await self.fylo.executePutFileAtIdDirect(
                                        self.collection,
                                        id,
                                        /** @type {RawFileInput} */ (data),
                                        options,
                                        access
                                    )
                                }
                                if (
                                    rawInput ||
                                    typeof data !== 'object' ||
                                    data === null ||
                                    Array.isArray(data)
                                ) {
                                    throw new Error(
                                        `Collection "${self.collection}" is a document collection; put(id, document) requires a record`
                                    )
                                }
                                await self.fylo.loadEncryptionWithEvent(self.collection)
                                let doc = /** @type {Record<string, any>} */ (data)
                                if (Fylo.STRICT)
                                    doc = await validateAgainstHead(self.collection, doc)
                                return await self.fylo.executePutDataDirect(
                                    self.collection,
                                    id,
                                    doc,
                                    undefined,
                                    metadata,
                                    access
                                )
                            },
                            async (writtenId, metadata, actorUid) =>
                                await self.fylo.writeDocMetadata(
                                    self.collection,
                                    writtenId,
                                    metadata,
                                    actorUid
                                )
                        )
                    }
                    const data = /** @type {Record<string, any> | RawFileInput} */ (idOrData)
                    const options = /** @type {RawFilePutOptions | undefined} */ (dataOrOptions)
                    return metadataPutOperation(
                        async (metadata, access) => {
                            await self.fylo.ready()
                            await self.fylo.engine.requireCollection(self.collection)
                            const kind = await self.fylo.engine.collectionKind(self.collection)
                            const rawInput = data instanceof Blob || data instanceof URL
                            const putOptions = {
                                ...(options ?? {}),
                                ...(metadata ? { meta: metadata } : {})
                            }
                            if (kind === 'file') {
                                if (!rawInput) {
                                    throw new Error(
                                        `Collection "${self.collection}" is a file collection; put() requires a Blob, File, or URL`
                                    )
                                }
                                return await self.fylo.executePutFileDirect(
                                    self.collection,
                                    /** @type {RawFileInput} */ (data),
                                    putOptions,
                                    access
                                )
                            }
                            if (rawInput) {
                                throw new Error(
                                    `Collection "${self.collection}" is a document collection; put() requires a record`
                                )
                            }
                            const { _id, doc, previousId } = await self.fylo.prepareInsert(
                                self.collection,
                                /** @type {Record<string, any>} */ (data)
                            )
                            return await self.fylo.executePutDataDirect(
                                self.collection,
                                _id,
                                doc,
                                previousId,
                                putOptions.meta,
                                access,
                                previousId === undefined
                            )
                        },
                        async (writtenId, metadata, actorUid) =>
                            await self.fylo.writeDocMetadata(
                                self.collection,
                                writtenId,
                                metadata,
                                actorUid
                            )
                    )
                }
            )
        )
        put.batch = async (batch, options) => {
            await self.fylo.ready()
            return await self.fylo.runCoalesced(async () => {
                /** @type {TTIDValue[]} */
                const ids = []
                /** @type {Array<{ index: number, error: Error }>} */
                const failures = []
                const chunkSize = navigator.hardwareConcurrency
                for (let i = 0; i < batch.length; i += chunkSize) {
                    const chunk = batch.slice(i, i + chunkSize)
                    const results = await Promise.allSettled(
                        chunk.map((data) => self.put(data, options))
                    )
                    results.forEach((result, offset) => {
                        if (result.status === 'fulfilled') {
                            ids.push(result.value)
                            return
                        }
                        failures.push({
                            index: i + offset,
                            error:
                                result.reason instanceof Error
                                    ? result.reason
                                    : new Error(String(result.reason))
                        })
                    })
                }
                if (failures.length > 0) {
                    throw new FyloBatchWriteError(self.collection, ids, failures)
                }
                return ids
            })
        }
        this.put = put
        // patch / patch.many
        const patch = /** @type {CollectionPatch} */ (
            /** @type {unknown} */ (
                function (
                    /** @type {TTIDValue} */ id,
                    /** @type {Record<string, any>} */ patchData,
                    /** @type {Record<TTIDValue, Record<string, any>>} */ oldDoc = {}
                ) {
                    return deferredAccessOperation((access) =>
                        self.fylo.executePatchDocDirect(
                            self.collection,
                            { [id]: patchData },
                            oldDoc,
                            access?.uid
                        )
                    )
                }
            )
        )
        patch.many = (update) =>
            deferredAccessOperation(async (access) => {
                await self.fylo.loadEncryptionWithEvent(self.collection)
                return await self.fylo.runCoalesced(async () => {
                    return await self.fylo.engine.atomic(
                        self.collection,
                        'update-many',
                        async () => {
                            let count = 0
                            const cursor = self.find(update.$where ?? {})
                            if (access) cursor.as(access)
                            for await (const value of cursor.collect()) {
                                if (
                                    typeof value !== 'object' ||
                                    value === null ||
                                    Array.isArray(value)
                                )
                                    continue
                                const entries = Object.entries(value)
                                if (entries.length === 0) continue
                                const [docId, existing] = entries[0]
                                await self.fylo.executePatchDocDirect(
                                    self.collection,
                                    { [docId]: update.$set },
                                    {
                                        [docId]: /** @type {Record<string, any>} */ (existing)
                                    },
                                    access?.uid
                                )
                                count++
                            }
                            return count
                        }
                    )
                })
            })
        this.patch = patch
        // delete / delete.many
        const del = /** @type {CollectionDelete} */ (
            (id) =>
                deferredAccessOperation((access) =>
                    self.fylo.executeDelDocDirect(self.collection, id, access?.uid)
                )
        )
        del.many = (query) =>
            deferredAccessOperation(async (access) => {
                await self.fylo.loadEncryptionWithEvent(self.collection)
                return await self.fylo.runCoalesced(async () => {
                    return await self.fylo.engine.atomic(
                        self.collection,
                        'delete-many',
                        async () => {
                            let count = 0
                            const cursor = self.find(query)
                            if (access) cursor.as(access)
                            for await (const value of cursor.collect()) {
                                if (
                                    typeof value !== 'object' ||
                                    value === null ||
                                    Array.isArray(value)
                                )
                                    continue
                                const entries = Object.entries(value)
                                if (entries.length === 0) continue
                                const [docId] = entries[0]
                                await self.fylo.executeDelDocDirect(
                                    self.collection,
                                    docId,
                                    access?.uid
                                )
                                count++
                            }
                            return count
                        }
                    )
                })
            })
        this.delete = del
        // find / find.deleted
        const find = /** @type {CollectionFind} */ (
            /** @type {unknown} */ (
                (query = {}) => {
                    /** @type {{ uid: number } | undefined} */
                    let access
                    /** @type {unknown} */
                    let validationError
                    /** @type {Promise<any> | undefined} */
                    let source
                    const getSource = () =>
                        (source ??= self.fylo
                            .ready()
                            .then(() =>
                                self.fylo.engine.findDocs(self.collection, query, access?.uid)
                            ))
                    const result = {
                        as(/** @type {{ uid: number }} */ input) {
                            if (source)
                                throw new Error(
                                    'as() must be called before the find operation starts'
                                )
                            try {
                                access = normalizeAccessInput(input, { allowMode: false })
                            } catch (error) {
                                validationError = error
                            }
                            return result
                        },
                        async *[Symbol.asyncIterator]() {
                            if (validationError) throw validationError
                            yield* await getSource()
                        },
                        async *collect() {
                            if (validationError) throw validationError
                            yield* (await getSource()).collect()
                        },
                        async *onDelete() {
                            if (validationError) throw validationError
                            yield* (await getSource()).onDelete()
                        }
                    }
                    return result
                }
            )
        )
        find.deleted = (query = {}) => {
            /** @type {{ uid: number } | undefined} */
            let access
            /** @type {unknown} */
            let validationError
            /** @type {Promise<any> | undefined} */
            let source
            const getSource = () =>
                (source ??= self.fylo
                    .ready()
                    .then(() =>
                        self.fylo.engine.findDeletedDocs(self.collection, query, access?.uid)
                    ))
            const result = {
                as(/** @type {{ uid: number }} */ input) {
                    if (source)
                        throw new Error('as() must be called before the find operation starts')
                    try {
                        access = normalizeAccessInput(input, { allowMode: false })
                    } catch (error) {
                        validationError = error
                    }
                    return result
                },
                async *[Symbol.asyncIterator]() {
                    if (validationError) throw validationError
                    yield* await getSource()
                },
                async *collect() {
                    if (validationError) throw validationError
                    yield* (await getSource()).collect()
                }
            }
            return result
        }
        this.find = find
    }
    /** @param {TTIDValue} id @param {boolean} [onlyId] */
    get(id, onlyId = false) {
        const fylo = this.fylo
        const collection = this.collection
        /** @type {{ uid: number } | undefined} */
        let access
        /** @type {Promise<any> | undefined} */
        let source
        /** @type {unknown} */
        let validationError
        const failValidation = () => Promise.reject(validationError)
        // Validation is async now (ttid binary). engine.getDoc validates lazily in
        // its own async entries (iterator/once/onDelete), so we don't validate in
        // this eager source promise — doing so would surface an unhandled
        // rejection when a caller builds get(badId) without consuming it. The
        // direct file readers below (bytes/stream) validate explicitly.
        const getSource = () =>
            (source ??= fylo
                .ready()
                .then(() => fylo.engine.getDoc(collection, id, onlyId, access?.uid)))
        const result = {
            then(/** @type {any} */ onFulfilled, /** @type {any} */ onRejected) {
                return (validationError ? failValidation() : result.once()).then(
                    onFulfilled,
                    onRejected
                )
            },
            catch(/** @type {any} */ onRejected) {
                return (validationError ? failValidation() : result.once()).catch(onRejected)
            },
            finally(/** @type {any} */ onFinally) {
                return (validationError ? failValidation() : result.once()).finally(onFinally)
            },
            as(/** @type {{ uid: number }} */ input) {
                if (source) throw new Error('as() must be called before the get operation starts')
                try {
                    access = normalizeAccessInput(input, { allowMode: false })
                } catch (error) {
                    validationError = error
                }
                return result
            },
            async *[Symbol.asyncIterator]() {
                if (validationError) await failValidation()
                yield* await getSource()
            },
            async once() {
                if (validationError) return await failValidation()
                return await (await getSource()).once()
            },
            async bytes() {
                if (validationError) return await failValidation()
                await fylo.ready()
                await validateDocId(id)
                return await fylo.engine.getFileBytes(collection, id, access?.uid)
            },
            /** @param {{ start?: number, end?: number }} [range] half-open byte range [start, end) */
            async stream(range) {
                if (validationError) return await failValidation()
                await fylo.ready()
                await validateDocId(id)
                return await fylo.engine.getFileStream(collection, id, range, access?.uid)
            },
            /**
             * The document's complete canonical metadata plus developer
             * metadata (`user.fylo.meta.*` xattrs), decoded to typed values.
             * `mtime` and `updatedAt` are the file modification time;
             * `createdAt` is derived from the TTID. Raw-file records also
             * include their stored descriptor (name, key, type, size, and
             * checksum). Write developer metadata with
             * `put(id, data).metadata(record)` or `put(id).metadata(record)`.
             * @returns {Promise<Record<string, any>>}
             */
            async metadata() {
                if (validationError) return await failValidation()
                await fylo.ready()
                return await fylo.engine.getDocMetadata(collection, String(id), access?.uid)
            },
            async blob() {
                if (validationError) return await failValidation()
                await fylo.ready()
                const manifest = await (await getSource()).once()
                const contentType = manifest[id]?.contentType
                const bytes = await fylo.engine.getFileBytes(collection, id, access?.uid)
                return new Blob([/** @type {BlobPart} */ (/** @type {unknown} */ (bytes))], {
                    type: typeof contentType === 'string' ? contentType : ''
                })
            },
            async *onDelete() {
                if (validationError) await failValidation()
                yield* (await getSource()).onDelete()
            }
        }
        return result
    }
    /** @param {TTIDValue} id @param {boolean} [onlyId] */
    latest(id, onlyId = false) {
        return deferredAccessOperation(async (access) => {
            await this.fylo.ready()
            await validateDocId(id)
            return await this.fylo.engine.getLatest(this.collection, id, onlyId, access?.uid)
        })
    }
    /** @param {TTIDValue} id */
    restore(id) {
        return deferredAccessOperation(async (access) => {
            await this.fylo.ready()
            return await this.fylo.executeRestoreDocDirect(this.collection, id, access?.uid)
        })
    }
    /**
     * One folder level of a file collection: direct-child file manifests plus
     * immediate subfolder names, derived from object keys.
     * @param {string} [prefix]
     * @returns {any}
     */
    folder(prefix = '/') {
        return deferredAccessOperation(async (access) => {
            await this.fylo.ready()
            return await this.fylo.engine.listFolder(this.collection, prefix, access?.uid)
        })
    }
    /**
     * Stamp-ignoring integrity audit: re-hashes every file's full contents
     * (active and soft-deleted) and reports any whose bytes no longer match
     * their recorded checksum. Slow by design — run it as a background job.
     * @returns {Promise<{
     *   collection: string,
     *   filesScanned: number,
     *   verified: number,
     *   stamped: number,
     *   corrupt: Array<{ id: string, namespace: 'active' | 'deleted', expected: string, actual: string }>
     * }>}
     */
    async verify() {
        await this.fylo.ready()
        return await this.fylo.engine.verifyCollection(this.collection)
    }
    /** @returns {{ as(input: { uid: number }): any, [Symbol.asyncIterator](): AsyncGenerator<Record<string, any>, void, unknown> }} */
    export() {
        const fylo = this.fylo
        const collection = this.collection
        /** @type {{ uid: number } | undefined} */
        let access
        /** @type {unknown} */
        let validationError
        let started = false
        const result = {
            as(/** @type {{ uid: number }} */ input) {
                if (started) throw new Error('as() must be called before export starts')
                try {
                    access = normalizeAccessInput(input, { allowMode: false })
                } catch (error) {
                    validationError = error
                }
                return result
            },
            async *[Symbol.asyncIterator]() {
                started = true
                if (validationError) throw validationError
                await fylo.ready()
                yield* fylo.engine.exportBulkData(collection, access?.uid)
            }
        }
        return result
    }
    /** @param {URL} url @param {number | ImportBulkDataOptions} [limitOrOptions] */
    async import(url, limitOrOptions) {
        return await this.fylo.importBulkData(this.collection, url, limitOrOptions)
    }
    async inspect() {
        await this.fylo.ready()
        return await this.fylo.engine.inspectCollection(this.collection)
    }
    async rebuild() {
        await this.fylo.ready()
        return await this.fylo.engine.rebuildCollection(this.collection)
    }
    /** @param {CollectionCreateOptions} [options] */
    async create(options) {
        await this.fylo.ready()
        return await this.fylo.engine.createCollection(this.collection, options)
    }
    async drop() {
        await this.fylo.ready()
        return await this.fylo.engine.dropCollection(this.collection)
    }
}

/**
 * A `Fylo` instance accessed through its collection-facade Proxy: real methods
 * plus dynamic `fylo[collection]` access returning a `CollectionFacade`.
 * @typedef {Fylo & { [collection: string]: CollectionFacade }} FyloCollections
 */
