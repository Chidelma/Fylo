import TTID from '../vendor/ttid.mjs'
import { legacyShardOf, shardOf } from '../../core/shard.js'
import { copySafeJson, safeRecord } from '../../query/safe-record.js'
import { CollectionNotFoundError, validateCollectionName } from '../../core/collection.js'
import { FyloQueryPlanner } from '../../query/planner.js'
import { runInLane } from './filesystem.js'
import { BrowserDocuments } from './documents.js'
import { validateMetadataRecord } from './metadata.js'
import { BrowserMetadataStore } from './metadata.js'
import { BrowserEventBus } from './event-bus.js'
import { BrowserPrefixIndex } from './prefix-index.js'
import { BrowserQueryEngine } from './query.js'
import { assertPathInside, join } from './path.js'
import '../../core/extensions.js'

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
 * How each join mode combines a matched pair. `inner` and `outer` merge into a
 * prototype-less record.
 * @type {Record<string, (leftData: Record<string, any>, rightData: Record<string, any>) => Record<string, any>>}
 */
const JOIN_MODES = {
    inner: (leftData, rightData) => Object.assign(safeRecord(), leftData, rightData),
    outer: (leftData, rightData) => Object.assign(safeRecord(), leftData, rightData),
    left: (leftData) => leftData,
    right: (leftData, rightData) => rightData
}

/**
 * Buckets joined rows by `$groupby`, returning ids only when the join asked
 * for them. Every accumulator is prototype-less because group keys come from
 * document data.
 * @param {any} join
 * @param {Record<string, Record<string, any>>} docs
 */
function groupJoinedDocs(join, docs) {
    /** @type {Record<string, Record<string, Record<string, any>>>} */
    const groupedDocs = safeRecord()
    for (const ids of Object.keys(docs)) {
        const data = docs[ids]
        const key = String(data[join.$groupby])
        if (!Object.hasOwn(groupedDocs, key)) groupedDocs[key] = safeRecord()
        groupedDocs[key][ids] = data
    }
    if (!join.$onlyIds) return groupedDocs
    /** @type {Record<string, string[]>} */
    const groupedIds = safeRecord()
    for (const key of Object.keys(groupedDocs)) {
        groupedIds[key] = Object.keys(groupedDocs[key]).flat()
    }
    return groupedIds
}

/**
 * @typedef {import('./types.js').TTID} TTIDValue
 * @typedef {import('./filesystem.js').FyloFilesystem} FyloFilesystem
 * @typedef {import('./types.js').BrowserCoreOptions} BrowserCoreOptions
 * @typedef {import('./types.js').BrowserEvent} BrowserEvent
 * @typedef {import('../../query/types.js').StoreJoin<Record<string, any>, Record<string, any>>} StoreJoin
 * @typedef {import('../../query/types.js').StoreQuery<Record<string, any>>} StoreQuery
 * @typedef {import('../../query/types.js').StoreUpdate<Record<string, any>>} StoreUpdate
 * @typedef {import('../../query/types.js').StoreDelete<Record<string, any>>} StoreDelete
 */

const BROWSER_OPERATION = Object.freeze({
    noop: 0,
    putInsert: 10,
    putUpdate: 11,
    delete: 20,
    restore: 30,
    errWormUpdate: 100,
    errWormDelete: 101,
    errWormRestore: 102,
    errSoftDeleted: 103,
    errRestoreActiveExists: 104,
    errRestoreMissingTombstone: 105
})

/**
 * @template T
 * @param {T} value
 * @returns {T}
 */
function clone(value) {
    return /** @type {T} */ (structuredClone(value))
}

/**
 * @param {string} docId
 */
function validateDocId(docId) {
    if (!TTID.isTTID(docId)) throw new Error(`Invalid document ID: ${docId}`)
}

/**
 * @param {Record<string, any>} value
 * @returns {[TTIDValue, Record<string, any>] | null}
 */
function explicitDocumentEntry(value) {
    const entries = Object.entries(value)
    if (entries.length !== 1) return null
    const [candidate, doc] = entries[0]
    if (!TTID.isTTID(candidate)) return null
    if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
        throw new Error('Explicit TTID document payload must be an object')
    }
    return [candidate, doc]
}

/**
 * FYLO's browser-targeted core. It preserves the server storage layout over a
 * host-agnostic filesystem:
 *
 * `.collections/<collection>/docs/<bucket>/<id>.json`
 * `.collections/<collection>/.deleted/<bucket>/<id>.json`
 * `.collections/<collection>/index/{manifest.json,keys.snapshot,keys.wal}`
 * `.collections/<collection>/events/<collection>.ndjson`
 */
export class BrowserCore {
    planner = new FyloQueryPlanner()
    /**
     * @param {BrowserCoreOptions} options
     */
    constructor(options) {
        this.fs = options.fs
        this.root = options.root ?? '/'
        this.wormMode = options.worm?.mode ?? 'off'
        /** @type {Map<string, Promise<unknown>>} */
        this.writeLanes = new Map()
        this.index = new BrowserPrefixIndex(this.fs, this.collectionRoot.bind(this), {
            indexScannerFactory: options.indexScannerFactory
        })
        this.events = new BrowserEventBus(this.fs, this.collectionRoot.bind(this))
        this.documents = new BrowserDocuments(
            this.fs,
            this.docsRoot.bind(this),
            this.docPath.bind(this),
            this.deletedRoot.bind(this),
            this.deletedPath.bind(this),
            this.ensureCollection.bind(this)
        )
        this.metadata = new BrowserMetadataStore(this.fs, this.collectionRoot.bind(this))
        this.queryEngine = new BrowserQueryEngine({ index: this.index })
        return new Proxy(this, {
            get(target, prop, receiver) {
                if (typeof prop === 'symbol') return Reflect.get(target, prop, receiver)
                if (prop in target || typeof (/** @type {any} */ (target)[prop]) === 'function')
                    return Reflect.get(target, prop, receiver)
                return new BrowserCollectionFacade(target, prop)
            }
        })
    }

    /** @returns {Promise<void>} */
    async ready() {
        await this.index.ready()
    }

    /** @returns {Promise<void>} */
    async close() {
        await this.index.close()
    }

    /** @returns {boolean} */
    wormEnabled() {
        return this.wormMode === 'strict'
    }

    /** @param {string} collection */
    assertCollectionName(collection) {
        validateCollectionName(collection)
    }

    /** @param {string} collection @returns {string} */
    collectionRoot(collection) {
        this.assertCollectionName(collection)
        return join(this.root, '.collections', collection)
    }

    /** @param {string} collection @returns {string} */
    docsRoot(collection) {
        return join(this.collectionRoot(collection), 'docs')
    }

    /** @param {string} collection @returns {string} */
    deletedRoot(collection) {
        return join(this.collectionRoot(collection), '.deleted')
    }

    /** @param {string} collection @returns {string} */
    metaRoot(collection) {
        return this.collectionRoot(collection)
    }

    /** @param {string} collection @param {TTIDValue} docId @returns {string} */
    docPath(collection, docId) {
        validateDocId(docId)
        const root = this.docsRoot(collection)
        const target = join(root, shardOf(docId), `${docId}.json`)
        assertPathInside(root, target)
        return target
    }

    /** @param {string} collection @param {TTIDValue} docId @returns {string} */
    deletedPath(collection, docId) {
        validateDocId(docId)
        const root = this.deletedRoot(collection)
        const target = join(root, shardOf(docId), `${docId}.json`)
        assertPathInside(root, target)
        return target
    }

    /**
     * @param {string} collection
     * @template T
     * @param {() => Promise<T>} action
     * @returns {Promise<T>}
     */
    async withCollectionWriteLane(collection, action) {
        return await runInLane(this.writeLanes, collection, action)
    }

    /** @param {string} collection @returns {Promise<void>} */
    async ensureCollection(collection) {
        this.assertCollectionName(collection)
        await this.fs.mkdir(this.collectionRoot(collection), { recursive: true })
        await this.fs.mkdir(this.docsRoot(collection), { recursive: true })
        await this.fs.mkdir(this.deletedRoot(collection), { recursive: true })
        await this.fs.mkdir(this.metadata.root(collection), { recursive: true })
        await this.fs.mkdir(join(this.collectionRoot(collection), 'events'), { recursive: true })
        await this.index.ensureCollection(collection)
    }

    /** @param {string} collection @returns {Promise<void>} */
    async createCollection(collection) {
        await this.ensureCollection(collection)
    }

    /** @param {string} collection @returns {Promise<void>} */
    async requireCollection(collection) {
        if (!(await this.hasCollection(collection))) throw new CollectionNotFoundError(collection)
    }

    /** @param {string} collection @returns {Promise<void>} */
    async dropCollection(collection) {
        this.assertCollectionName(collection)
        await this.requireCollection(collection)
        if (this.wormEnabled() && (await this.documents.listDocIds(collection)).length > 0) {
            throw new Error('Drop is not allowed for a non-empty WORM collection')
        }
        await this.index.forgetCollection(collection)
        await this.fs.rmdir(this.collectionRoot(collection), { recursive: true })
    }

    /** @param {string} collection @returns {Promise<boolean>} */
    async hasCollection(collection) {
        return await this.fs.exists(this.collectionRoot(collection))
    }

    /**
     * @param {string} collection
     * @returns {Promise<{ collection: string, exists: boolean, worm: boolean, docsStored: number, deletedDocs: number, indexedDocs: number, indexAcceleration: ReturnType<BrowserPrefixIndex['accelerationStatus']> }>}
     */
    async inspectCollection(collection) {
        const exists = await this.hasCollection(collection)
        if (!exists) {
            return {
                collection,
                exists: false,
                worm: false,
                docsStored: 0,
                deletedDocs: 0,
                indexedDocs: 0,
                indexAcceleration: this.index.accelerationStatus()
            }
        }
        const [docIds, deletedDocIds, indexedDocs] = await Promise.all([
            this.documents.listDocIds(collection),
            this.documents.listDeletedDocIds(collection),
            this.index.countDocuments(collection)
        ])
        return {
            collection,
            exists: true,
            worm: this.wormEnabled(),
            docsStored: docIds.length,
            deletedDocs: deletedDocIds.length,
            indexedDocs,
            indexAcceleration: this.index.accelerationStatus()
        }
    }

    /** @param {string} collection @returns {Promise<{ collection: string, worm: boolean, docsScanned: number, indexedDocs: number }>} */
    async rebuildCollection(collection) {
        await this.requireCollection(collection)
        return await this.withCollectionWriteLane(collection, async () => {
            await this.ensureCollection(collection)
            const docIds = await this.documents.listDocIds(collection)
            let indexedDocs = 0
            await this.index.resetCollection(collection)
            for (const docId of docIds) {
                const stored = await this.documents.readStoredDoc(collection, docId)
                if (!stored) continue
                await this.index.putDocument(collection, docId, stored.data)
                indexedDocs++
            }
            return {
                collection,
                worm: this.wormEnabled(),
                docsScanned: docIds.length,
                indexedDocs
            }
        })
    }

    /**
     * @param {string} collection
     * @param {Record<string, any>} data
     * @param {Record<string, any>=} meta
     * @returns {Promise<TTIDValue>}
     */
    async putData(collection, data, meta) {
        if (meta !== undefined) validateMetadataRecord(meta)
        await this.requireCollection(collection)
        const explicit = explicitDocumentEntry(data)
        const id = explicit?.[0] ?? /** @type {TTIDValue} */ (TTID.generate())
        const doc = clone(explicit?.[1] ?? data)
        validateDocId(id)
        return await this.withCollectionWriteLane(collection, async () => {
            await this.ensureCollection(collection)
            const [deleted, existing] = await Promise.all([
                this.documents.readDeletedDoc(collection, id),
                this.documents.readStoredDoc(collection, id)
            ])
            const operation = planPutOperation({
                existing: Boolean(existing),
                worm: this.wormEnabled(),
                deleted: Boolean(deleted)
            })
            if (operation === BROWSER_OPERATION.errSoftDeleted) {
                throw new Error(`Document is soft-deleted; restore it before writing: ${id}`)
            }
            if (operation === BROWSER_OPERATION.errWormUpdate) {
                throw new Error('Update is not allowed in WORM mode')
            }
            if (operation === BROWSER_OPERATION.putUpdate && existing) {
                await this.index.removeDocument(collection, id, existing.data)
            }
            await this.documents.writeStoredDoc(collection, id, doc)
            try {
                if (meta !== undefined) await this.metadata.mutate(collection, id, meta)
            } catch (error) {
                if (existing) {
                    await this.documents.writeStoredDoc(collection, id, existing.data)
                    await this.index.putDocument(collection, id, existing.data)
                } else {
                    await this.documents.removeStoredDoc(collection, id)
                }
                throw error
            }
            await this.index.putDocument(collection, id, doc)
            if (this.wormEnabled()) await this.documents.makeStoredDocReadOnly(collection, id)
            const stored = await this.documents.readStoredDoc(collection, id)
            await this.events.publish(collection, {
                ts: stored?.updatedAt ?? Date.now(),
                action: 'insert',
                id,
                doc: clone(doc)
            })
            return id
        })
    }

    /** @param {string} collection @param {Record<string, any>[]} batch @returns {Promise<TTIDValue[]>} */
    async batchPutData(collection, batch) {
        /** @type {TTIDValue[]} */
        const ids = []
        for (const data of batch) ids.push(await this.putData(collection, data))
        return ids
    }

    /** @param {string} collection @param {TTIDValue} id */
    async getDocMeta(collection, id) {
        validateDocId(id)
        await this.requireCollection(collection)
        const stored = await this.documents.readStoredDoc(collection, id)
        if (!stored) {
            throw new Error(`Document not found: ${id}`)
        }
        const metadata = copySafeJson((await this.metadata.read(collection, id)).values)
        metadata.id = stored.id
        metadata.mtime = stored.updatedAt
        metadata.updatedAt = stored.updatedAt
        metadata.createdAt = stored.createdAt
        return metadata
    }

    /** @param {string} collection @param {TTIDValue} id @param {Record<string, any>} record */
    async setDocMetaRecord(collection, id, record) {
        validateDocId(id)
        await this.requireCollection(collection)
        return await this.withCollectionWriteLane(collection, async () => {
            if (!(await this.documents.readStoredDoc(collection, id))) {
                throw new Error(`Document not found: ${id}`)
            }
            const result = await this.metadata.mutate(collection, id, record)
            await this.events.publish(collection, {
                ts: result.updatedAt,
                action: 'meta',
                id,
                meta: copySafeJson(result.values)
            })
            return copySafeJson(result.values)
        })
    }

    /**
     * @param {string} collection
     * @param {Record<TTIDValue, Record<string, any>>} newDoc
     * @param {Record<TTIDValue, Record<string, any>>} [oldDoc]
     * @returns {Promise<TTIDValue>}
     */
    async patchDoc(collection, newDoc, oldDoc = {}) {
        if (this.wormEnabled()) throw new Error('Update is not allowed in WORM mode')
        await this.requireCollection(collection)
        const id = Object.keys(newDoc).shift()
        if (!id) throw new Error('this document does not contain an TTID')
        validateDocId(id)
        const stored = await this.documents.readStoredDoc(collection, id)
        const previous = oldDoc[id] ?? stored?.data
        if (!stored || !previous) return id
        return await this.putData(collection, { [id]: { ...previous, ...newDoc[id] } })
    }

    /** @param {string} collection @param {StoreUpdate} update @returns {Promise<number>} */
    async patchDocs(collection, update) {
        let count = 0
        for await (const value of this.findDocs(collection, update.$where ?? {}).collect()) {
            if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
            const [id, current] = Object.entries(value)[0] ?? []
            if (!id || !current) continue
            await this.patchDoc(collection, { [id]: update.$set }, { [id]: current })
            count++
        }
        return count
    }

    /** @param {string} collection @param {TTIDValue} id @returns {Promise<void>} */
    async delDoc(collection, id) {
        validateDocId(id)
        await this.requireCollection(collection)
        await this.withCollectionWriteLane(collection, async () => {
            const stored = await this.documents.readStoredDoc(collection, id)
            const operation = planDeleteOperation({
                existing: Boolean(stored),
                worm: this.wormEnabled()
            })
            if (operation === BROWSER_OPERATION.errWormDelete) {
                throw new Error('Delete is not allowed in WORM mode')
            }
            if (operation === BROWSER_OPERATION.noop || !stored) return
            await this.index.removeDocument(collection, id, stored.data)
            const deletedAt = Date.now()
            await this.documents.softDeleteStoredDoc(collection, id, deletedAt)
            await this.events.publish(collection, {
                ts: deletedAt,
                action: 'delete',
                id,
                doc: clone(stored.data),
                createdAt: stored.createdAt,
                updatedAt: stored.updatedAt
            })
        })
    }

    /** @param {string} collection @param {TTIDValue} id @returns {Promise<TTIDValue>} */
    async restoreDoc(collection, id) {
        validateDocId(id)
        await this.requireCollection(collection)
        return await this.withCollectionWriteLane(collection, async () => {
            const [active, deleted] = await Promise.all([
                this.documents.readStoredDoc(collection, id),
                this.documents.readDeletedDoc(collection, id)
            ])
            const operation = planRestoreOperation({
                activeExists: Boolean(active),
                deletedExists: Boolean(deleted),
                worm: this.wormEnabled()
            })
            if (operation === BROWSER_OPERATION.errWormRestore) {
                throw new Error('Restore is not allowed in WORM mode')
            }
            if (operation === BROWSER_OPERATION.errRestoreActiveExists) {
                throw new Error(`Cannot restore document because it already exists: ${id}`)
            }
            if (operation === BROWSER_OPERATION.errRestoreMissingTombstone || !deleted) {
                throw new Error(`Deleted document not found: ${id}`)
            }
            await this.documents.restoreStoredDoc(collection, id, Date.now())
            await this.index.putDocument(collection, id, deleted.data)
            const stored = await this.documents.readStoredDoc(collection, id)
            await this.events.publish(collection, {
                ts: stored?.updatedAt ?? Date.now(),
                action: 'insert',
                id,
                doc: clone(deleted.data)
            })
            return id
        })
    }

    /** @param {string} collection @param {StoreDelete} deleteSchema @returns {Promise<number>} */
    async delDocs(collection, deleteSchema) {
        let count = 0
        for await (const value of this.findDocs(collection, deleteSchema).collect()) {
            if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
            const id = Object.keys(value).find((docId) => TTID.isTTID(docId))
            if (!id) continue
            await this.delDoc(collection, id)
            count++
        }
        return count
    }

    /** @param {string} collection @returns {Promise<TTIDValue[]>} */
    async listQueryableDocIds(collection) {
        await this.requireCollection(collection)
        return await this.documents.listDocIds(collection)
    }

    /** @param {string} collection @param {StoreQuery | undefined} [query] @returns {Promise<Array<Record<string, Record<string, any>>>>} */
    async docResults(collection, query = {}) {
        await this.requireCollection(collection)
        const candidateIds = await this.queryEngine.candidateDocIdsForQuery(collection, query)
        const ids = candidateIds
            ? Array.from(candidateIds)
            : await this.listQueryableDocIds(collection)
        const limit = query.$limit
        /** @type {Array<Record<string, Record<string, any>>>} */
        const results = []
        for (const id of ids) {
            const stored = await this.documents.readStoredDoc(collection, id)
            if (!stored) continue
            if (!this.queryEngine.matchesQuery(id, stored.data, query, stored)) continue
            results.push({ [id]: clone(stored.data) })
            if (limit && results.length >= limit) break
        }
        return results
    }

    /** @param {string} collection @param {StoreQuery | undefined} [query] @returns {Promise<Array<Record<string, Record<string, any>>>>} */
    async deletedDocResults(collection, query = {}) {
        await this.requireCollection(collection)
        const ids = await this.documents.listDeletedDocIds(collection)
        const limit = query.$limit
        /** @type {Array<Record<string, Record<string, any>>>} */
        const results = []
        for (const id of ids) {
            const deleted = await this.documents.readDeletedDoc(collection, id)
            if (!deleted) continue
            if (!this.queryEngine.matchesDeletedQuery(id, deleted.data, query, deleted)) continue
            results.push({ [id]: clone(deleted.data) })
            if (limit && results.length >= limit) break
        }
        return results
    }

    /** @param {string} collection @param {TTIDValue} id @param {boolean} [onlyId] */
    getDoc(collection, id, onlyId = false) {
        validateDocId(id)
        const core = this
        return {
            async *[Symbol.asyncIterator]() {
                const doc = await this.once()
                if (doc && (typeof doc === 'string' || Object.keys(doc).length > 0)) yield doc
                for await (const event of core.events.listen(collection)) {
                    if (event.action !== 'insert' || event.id !== id || !event.doc) continue
                    yield onlyId ? event.id : { [event.id]: clone(event.doc) }
                }
            },
            async once() {
                await core.requireCollection(collection)
                const stored = await core.documents.readStoredDoc(collection, id)
                if (!stored) return onlyId ? null : {}
                return onlyId ? stored.id : { [stored.id]: clone(stored.data) }
            },
            async *onDelete() {
                await core.requireCollection(collection)
                for await (const event of core.events.listen(collection)) {
                    if (event.action === 'delete' && event.id === id) yield event.id
                }
            }
        }
    }

    /** @param {string} collection @param {TTIDValue} id @param {boolean} [onlyId] @returns {Promise<Record<TTIDValue, Record<string, any>> | TTIDValue | null>} */
    async getLatest(collection, id, onlyId = false) {
        validateDocId(id)
        await this.requireCollection(collection)
        const stored = await this.documents.readStoredDoc(collection, id)
        if (!stored) return onlyId ? null : {}
        return onlyId ? stored.id : { [stored.id]: clone(stored.data) }
    }

    /** @param {string} collection @param {StoreQuery | undefined} [query] */
    findDocs(collection, query = {}) {
        const core = this
        const collectDocs = async function* () {
            const docs = await core.docResults(collection, query)
            for (const doc of docs) {
                const result = core.queryEngine.processDoc(doc, query)
                if (result !== undefined) yield result
            }
        }
        return {
            async *[Symbol.asyncIterator]() {
                yield* collectDocs()
                for await (const event of core.events.listen(collection)) {
                    if (event.action !== 'insert' || !event.doc) continue
                    const stored = await core.documents.readStoredDoc(collection, event.id)
                    if (
                        !stored ||
                        !core.queryEngine.matchesQuery(event.id, event.doc, query, stored)
                    )
                        continue
                    const processed = core.queryEngine.processDoc({ [event.id]: event.doc }, query)
                    if (processed !== undefined) yield processed
                }
            },
            async *collect() {
                yield* collectDocs()
            },
            async *onDelete() {
                await core.requireCollection(collection)
                for await (const event of core.events.listen(collection)) {
                    if (event.action !== 'delete' || !event.doc) continue
                    if (
                        !core.queryEngine.matchesQuery(event.id, event.doc, query, {
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

    /** @param {string} collection @param {StoreQuery | undefined} [query] */
    findDeletedDocs(collection, query = {}) {
        const core = this
        const collectDocs = async function* () {
            const docs = await core.deletedDocResults(collection, query)
            for (const doc of docs) {
                const result = core.queryEngine.processDoc(doc, query)
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

    /**
     * @param {string} collection
     * @param {(event: BrowserEvent) => void} listener
     * @returns {() => void}
     */
    subscribe(collection, listener) {
        this.assertCollectionName(collection)
        return this.events.subscribe(collection, listener)
    }

    /** @param {StoreJoin} join @returns {Promise<any>} */
    async join(join) {
        const leftDocs = await this.docResults(join.$leftCollection)
        const rightDocs = await this.docResults(join.$rightCollection)
        /** @type {Record<string, Record<string, any>>} */
        const docs = safeRecord()
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
     * Whether one left/right pair satisfies any comparison in `$on`.
     * @param {any} join
     * @param {Record<string, any>} leftData
     * @param {Record<string, any>} rightData
     * @returns {boolean}
     */
    joinRowMatches(join, leftData, rightData) {
        for (const [field, operand] of Object.entries(join.$on)) {
            if (!operand) continue
            for (const opKey of Object.keys(JOIN_COMPARATORS)) {
                const rightField = /** @type {Record<string, any>} */ (operand)[opKey]
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
     * `$rename`. Merged rows use a prototype-less record so joined field names
     * can never reach Object.prototype.
     * @param {any} join
     * @param {Record<string, any>} leftData
     * @param {Record<string, any>} rightData
     * @returns {Record<string, any>}
     */
    projectJoinRow(join, leftData, rightData) {
        const combine = JOIN_MODES[join.$mode]
        let projected = /** @type {Record<string, any>} */ (
            combine ? combine(leftData, rightData) : undefined
        )
        if (join.$select?.length) projected = this.queryEngine.selectValues(join.$select, projected)
        if (join.$rename) projected = this.queryEngine.renameFields(join.$rename, projected)
        return projected
    }

    /** @param {string} SQL @returns {Promise<unknown>} */
    async executeSQL(SQL) {
        const plan = this.planner.prepare(SQL)
        if (plan.explain && !plan.analyze) return this.planner.describe(plan)
        const startedAt = performance.now()
        const result = await this.executeSqlPlan(plan)
        if (!plan.explain) return result
        return {
            ...this.planner.describe(plan),
            executed: true,
            elapsedMs: performance.now() - startedAt,
            result
        }
    }

    /** @param {ReturnType<FyloQueryPlanner['prepare']>} plan */
    async executeSqlPlan(plan) {
        const operation = plan.operation
        const parsed = /** @type {any} */ (structuredClone(plan.ast))
        switch (operation) {
            case 'CREATE':
                return await this.createCollection(String(parsed.$collection))
            case 'DROP':
                return await this.dropCollection(String(parsed.$collection))
            case 'SELECT': {
                const query = /** @type {StoreQuery} */ (parsed)
                if (plan.sql.includes('JOIN'))
                    return await this.join(/** @type {StoreJoin} */ (query))
                const selectedCollection = query.$collection
                delete query.$collection
                /** @type {TTIDValue[] | Record<string, any>} */
                let docs = query.$onlyIds ? [] : {}
                for await (const data of this.findDocs(
                    String(selectedCollection),
                    query
                ).collect()) {
                    if (typeof data === 'object' && data !== null) {
                        docs = /** @type {{ appendGroup(target: any, value: any): any }} */ (
                            /** @type {unknown} */ (Object)
                        ).appendGroup(docs, data)
                    } else if (Array.isArray(docs)) docs.push(String(data))
                }
                return docs
            }
            case 'INSERT': {
                const insert =
                    /** @type {import('../../query/types.js').StoreInsert<Record<string, any>>} */ (
                        parsed
                    )
                const insertCollection = insert.$collection
                delete insert.$collection
                return await this.putData(String(insertCollection), insert.$values)
            }
            case 'UPDATE': {
                const update = /** @type {StoreUpdate} */ (parsed)
                const updateCol = update.$collection
                delete update.$collection
                return await this.patchDocs(String(updateCol), update)
            }
            case 'DELETE': {
                const del = /** @type {StoreDelete} */ (parsed)
                const deleteCollection = del.$collection
                delete del.$collection
                return await this.delDocs(String(deleteCollection), del)
            }
            default:
                throw new Error('Invalid Operation')
        }
    }
}

/**
 * @param {{ existing: boolean, worm: boolean, deleted: boolean }} options
 * @returns {number}
 */
function planPutOperation(options) {
    if (options.deleted) return BROWSER_OPERATION.errSoftDeleted
    if (options.worm && options.existing) return BROWSER_OPERATION.errWormUpdate
    return options.existing ? BROWSER_OPERATION.putUpdate : BROWSER_OPERATION.putInsert
}

/**
 * @param {{ existing: boolean, worm: boolean }} options
 * @returns {number}
 */
function planDeleteOperation(options) {
    if (options.worm) return BROWSER_OPERATION.errWormDelete
    return options.existing ? BROWSER_OPERATION.delete : BROWSER_OPERATION.noop
}

/**
 * @param {{ activeExists: boolean, deletedExists: boolean, worm: boolean }} options
 * @returns {number}
 */
function planRestoreOperation(options) {
    if (options.worm) return BROWSER_OPERATION.errWormRestore
    if (options.activeExists) return BROWSER_OPERATION.errRestoreActiveExists
    if (!options.deletedExists) return BROWSER_OPERATION.errRestoreMissingTombstone
    return BROWSER_OPERATION.restore
}

/** Lightweight collection facade for BrowserCore's Proxy. */
class BrowserCollectionFacade {
    /** @param {BrowserCore} core @param {string} collection */
    constructor(core, collection) {
        this.core = core
        this.collection = collection
    }
    async create() {
        await this.core.createCollection(this.collection)
    }
    async drop() {
        await this.core.dropCollection(this.collection)
    }
    async inspect() {
        return await this.core.inspectCollection(this.collection)
    }
    async rebuild() {
        return await this.core.rebuildCollection(this.collection)
    }
    /** @param {Record<string, any>} data */
    async put(data) {
        return await this.core.putData(this.collection, data)
    }
    /** @param {Record<string, any>[]} batch */
    async batchPut(batch) {
        return await this.core.batchPutData(this.collection, batch)
    }
    /** @param {string} id @param {Record<string, any>} patch @param {Record<string, any>} [oldDoc] */
    async patch(id, patch, oldDoc) {
        return await this.core.patchDoc(this.collection, { [id]: patch }, oldDoc ?? {})
    }
    /** @param {StoreUpdate} update */
    async patchMany(update) {
        return await this.core.patchDocs(this.collection, update)
    }
    /** @param {string} id */
    async delete(id) {
        await this.core.delDoc(this.collection, id)
    }
    /** @param {Record<string, any>} query */
    async deleteMany(query) {
        return await this.core.delDocs(this.collection, query)
    }
    /** @param {string} id */
    async restore(id) {
        return await this.core.restoreDoc(this.collection, id)
    }
    /** @param {string} id @param {boolean} [onlyId] */
    get(id, onlyId) {
        return this.core.getDoc(this.collection, id, onlyId)
    }
    /** @param {string} id @param {boolean} [onlyId] */
    async latest(id, onlyId) {
        return await this.core.getLatest(this.collection, id, onlyId)
    }
    /** @param {Record<string, any>} [query] */
    find(query) {
        return this.core.findDocs(this.collection, query ?? {})
    }
    /** @param {Record<string, any>} [query] */
    findDeleted(query) {
        return this.core.deletedDocResults(this.collection, query ?? {})
    }
}
