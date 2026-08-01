import { stringifyStoredValue } from '../../storage/value-codec.js'
import TTID from '../vendor/ttid.mjs'
import { join } from './path.js'

/**
 * Browser host for the canonical prefix-index format. Stores the same
 * `manifest.json` + `keys.snapshot` + `keys.wal` shape so a future migration
 * tool can move index files between the server and a browser-OPFS deployment
 * unchanged. The crypto hash uses Web Crypto so it works on Bun, Node 18+ and
 * every modern browser. Browser field encryption is intentionally not wired
 * into this module yet; encrypted-field indexes will need a browser-safe
 * crypto adapter, not the server cipher singleton.
 *
 * @typedef {import('../../types/vendor.js').TTID} TTIDValue
 * @typedef {import('../../query/types.js').Operand} Operand
 * @typedef {import('./filesystem.js').FyloFilesystem} FyloFilesystem
 */

const LOCAL_FS_FORMAT = 'fylo.local-fs.index.v1'
const LOCAL_FS_MANIFEST = 'manifest.json'
const LOCAL_FS_SNAPSHOT = 'keys.snapshot'
const LOCAL_FS_WAL = 'keys.wal'
const LOCAL_FS_WAL_COMPACT_BYTES = 1_048_576

const MAX_STRING_PREFIX_BYTES = 180
const MAX_NGRAM_SOURCE_CHARS = 512
const NGRAM_SIZE = 3
const UINT64_MAX = (1n << 64n) - 1n
const SIGN_MASK = 1n << 63n

const ENCODER = new TextEncoder()
const DECODER = new TextDecoder()

/**
 * @param {string} value
 * @returns {string}
 */
function encodeSegment(value) {
    return encodeURIComponent(value)
}

/**
 * @param {string} value
 * @returns {string}
 */
function decodeSegment(value) {
    return decodeURIComponent(value)
}

/**
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function bytesToHex(bytes) {
    let hex = ''
    for (const byte of bytes) hex += byte.toString(16).padStart(2, '0')
    return hex
}

/**
 * Web Crypto-backed SHA-256. Available on Bun, Node ≥ 18 and every modern
 * browser. Identical bytes-out as `Bun.CryptoHasher('sha256')` so server and
 * browser produce the same index keys for the same input value.
 *
 * @param {string} value
 * @returns {Promise<string>}
 */
export async function sha256Hex(value) {
    const buffer = await crypto.subtle.digest('SHA-256', ENCODER.encode(value))
    return bytesToHex(new Uint8Array(buffer))
}

/**
 * @param {string} value
 * @returns {Promise<string>}
 */
async function lookupToken(value) {
    const encoded = encodeSegment(value)
    if (ENCODER.encode(encoded).byteLength <= MAX_STRING_PREFIX_BYTES) return encoded
    return `h_${await sha256Hex(value)}`
}

/**
 * @param {number} value
 * @returns {string}
 */
function sortableFloat64(value) {
    if (!Number.isFinite(value)) return ''
    const buffer = new ArrayBuffer(8)
    const view = new DataView(buffer)
    view.setFloat64(0, value, false)
    const bits = view.getBigUint64(0, false)
    const sortable = bits & SIGN_MASK ? ~bits & UINT64_MAX : bits ^ SIGN_MASK
    return sortable.toString(16).padStart(16, '0')
}

/**
 * @param {string} sortable
 * @returns {string}
 */
function reverseSortable(sortable) {
    const value = BigInt(`0x${sortable}`)
    return (UINT64_MAX - value).toString(16).padStart(16, '0')
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function numericValue(value) {
    const numeric = typeof value === 'number' ? value : Number(value)
    return Number.isFinite(numeric) ? numeric : null
}

/**
 * @param {string} value
 * @returns {string}
 */
function reverseString(value) {
    return Array.from(value).reverse().join('')
}

/**
 * @param {string} value
 * @returns {string[]}
 */
function trigrams(value) {
    const source = value.slice(0, MAX_NGRAM_SOURCE_CHARS)
    const chars = Array.from(source)
    if (chars.length < NGRAM_SIZE) return []
    const grams = new Set()
    for (let i = 0; i <= chars.length - NGRAM_SIZE; i++) {
        grams.add(chars.slice(i, i + NGRAM_SIZE).join(''))
    }
    return [...grams]
}

/**
 * @param {string} fieldPath
 * @returns {string}
 */
function encodeFieldPath(fieldPath) {
    return fieldPath.split('/').map(encodeSegment).join('/')
}

/**
 * @param {string} prefix
 * @param {string} key
 * @returns {TTIDValue}
 */
function docIdFromKey(prefix, key) {
    const suffix = key.slice(prefix.length)
    const segments = suffix.split('/')
    const docId = decodeSegment(segments.at(-1) ?? '')
    if (!TTID.isTTID(docId)) throw new Error(`Invalid document ID: ${docId}`)
    return docId
}

/**
 * @param {string} collection
 * @param {string} fieldPath
 * @param {unknown} value
 * @returns {Promise<string>}
 */
async function queryLookupValue(collection, fieldPath, value) {
    void collection
    void fieldPath
    const stored = stringifyStoredValue(value)
    return lookupToken(stored)
}

/**
 * Plans index prefixes for a SQL LIKE pattern. Returns null when no index can
 * answer the pattern safely, leaving the caller on the in-memory matcher.
 * @param {string} collection
 * @param {string} fieldPath
 * @param {string} pattern
 * @returns {Promise<Array<{ kind: string, valuePrefix: string }> | null>}
 */
async function likeQueryPrefixes(collection, fieldPath, pattern) {
    // `_` is a one-character wildcard. Existing prefix/reverse/ngram indexes
    // cannot encode that positional constraint safely, so use the bounded
    // in-memory matcher rather than risk false negatives.
    if (pattern.includes('_')) return null
    const wildcards = (pattern.match(/%/g) ?? []).length
    if (wildcards === 0) {
        return [
            {
                kind: 'eq',
                valuePrefix: `${await queryLookupValue(collection, fieldPath, pattern)}/`
            }
        ]
    }
    if (wildcards === 1 && pattern.endsWith('%')) {
        return [{ kind: 'f', valuePrefix: encodeSegment(pattern.slice(0, -1)) }]
    }
    if (wildcards === 1 && pattern.startsWith('%')) {
        return [{ kind: 'r', valuePrefix: encodeSegment(reverseString(pattern.slice(1))) }]
    }
    return containsQueryPrefixes(pattern, wildcards)
}

/**
 * `%needle%` can use the trigram index, but only when the needle is long
 * enough to produce one.
 * @param {string} pattern
 * @param {number} wildcards
 * @returns {Array<{ kind: string, valuePrefix: string }> | null}
 */
function containsQueryPrefixes(pattern, wildcards) {
    if (wildcards !== 2 || !pattern.startsWith('%') || !pattern.endsWith('%')) return null
    if (pattern.length <= 2) return null
    const needle = pattern.slice(1, -1)
    if (Array.from(needle).length < NGRAM_SIZE) return null
    const planned = trigrams(needle)[0]
    return [{ kind: 'g3', valuePrefix: `${encodeSegment(planned ?? needle.slice(0, 3))}/` }]
}

/**
 * Plans forward and reverse numeric range scans. A non-numeric bound cannot be
 * served by the index at all.
 * @param {Record<string, any>} operand
 * @returns {Array<{ kind: string, valuePrefix: string, range: { op: '$gt' | '$gte' | '$lt' | '$lte', value: string } }> | null}
 */
function rangeQueryPrefixes(operand) {
    /** @type {Array<{ kind: string, valuePrefix: string, range: { op: '$gt' | '$gte' | '$lt' | '$lte', value: string } }>} */
    const rangeEntries = []
    for (const operator of /** @type {const} */ (['$gt', '$gte', '$lt', '$lte'])) {
        const raw = operand[operator]
        if (raw === undefined) continue
        const numeric = numericValue(raw)
        const sortable = numeric === null ? '' : sortableFloat64(numeric)
        if (!sortable) return null
        const ascending = operator === '$gt' || operator === '$gte'
        rangeEntries.push({
            kind: ascending ? 'n' : 'nr',
            valuePrefix: '',
            range: { op: operator, value: ascending ? sortable : reverseSortable(sortable) }
        })
    }
    return rangeEntries.length ? rangeEntries : null
}

/**
 * Encodes document field values into prefix-searchable index keys and query
 * lookup prefixes. Algorithmically identical to the server `PrefixIndexCodec`,
 * but uses the Web Crypto `sha256Hex` so it runs everywhere.
 */
export class BrowserPrefixIndexCodec {
    /**
     * @param {string} fieldPath
     * @param {string} kind
     * @param {string} value
     * @param {TTIDValue} docId
     * @returns {string}
     */
    static key(fieldPath, kind, value, docId) {
        if (!TTID.isTTID(docId)) throw new Error(`Invalid document ID: ${docId}`)
        return [encodeFieldPath(fieldPath), kind, value, encodeSegment(docId)].join('/')
    }

    /**
     * @param {string} fieldPath
     * @param {string} kind
     * @param {string} [valuePrefix]
     * @returns {string}
     */
    static prefix(fieldPath, kind, valuePrefix = '') {
        return [encodeFieldPath(fieldPath), kind, valuePrefix].join('/')
    }

    /**
     * @param {string} collection
     * @param {TTIDValue} docId
     * @param {Record<string, any>} data
     * @returns {Promise<string[]>}
     */
    static async entriesForDocument(collection, docId, data) {
        /** @type {string[]} */
        const entries = []
        /** @type {string[]} */
        const exactEntries = []
        /**
         * @param {string} fieldPath
         * @param {unknown} raw
         */
        const addValue = async (fieldPath, raw) => {
            const value = stringifyStoredValue(raw)
            /**
             * @param {string} kind
             * @param {string} plannedValue
             * @returns {string}
             */
            const planKey = (kind, plannedValue) => this.key(fieldPath, kind, plannedValue, docId)

            exactEntries.push(this.key(fieldPath, 'eq', await lookupToken(value), docId))

            const numeric = numericValue(raw)
            const sortable = numeric === null ? '' : sortableFloat64(numeric)
            if (sortable) {
                entries.push(planKey('n', sortable))
                entries.push(planKey('nr', reverseSortable(sortable)))
            }

            if (typeof raw !== 'string') return
            const encoded = encodeSegment(value)
            if (ENCODER.encode(encoded).byteLength > MAX_STRING_PREFIX_BYTES) return
            entries.push(planKey('f', encoded))
            entries.push(planKey('r', encodeSegment(reverseString(value))))
            for (const gram of trigrams(value)) {
                entries.push(planKey('g3', encodeSegment(gram)))
            }
        }

        /**
         * @param {Record<string, any>} target
         * @param {string=} parentField
         */
        const walk = async (target, parentField) => {
            for (const field of Object.keys(target)) {
                const fieldPath = parentField ? `${parentField}/${field}` : field
                const value = target[field]
                if (value && typeof value === 'object' && !Array.isArray(value)) {
                    await walk(value, fieldPath)
                    continue
                }
                if (Array.isArray(value)) {
                    for (const item of value) {
                        if (item && typeof item === 'object') {
                            throw new Error('Cannot index an array of objects')
                        }
                        await addValue(fieldPath, item)
                    }
                    continue
                }
                await addValue(fieldPath, value)
            }
        }

        await walk(data)
        entries.push(...exactEntries)
        return [...new Set(entries)]
    }

    /**
     * @param {string} collection
     * @param {string} fieldPath
     * @param {Operand} operand
     * @returns {Promise<Array<{ kind: string, valuePrefix: string, range?: { op: '$gt' | '$gte' | '$lt' | '$lte', value: string } }> | null>}
     */
    static async queryPrefixes(collection, fieldPath, operand) {
        if (operand.$eq !== undefined) {
            return [
                {
                    kind: 'eq',
                    valuePrefix: `${await queryLookupValue(collection, fieldPath, operand.$eq)}/`
                }
            ]
        }
        if (operand.$contains !== undefined) {
            return [
                {
                    kind: 'eq',
                    valuePrefix: `${await queryLookupValue(
                        collection,
                        fieldPath,
                        operand.$contains
                    )}/`
                }
            ]
        }
        if (operand.$like !== undefined) {
            return await likeQueryPrefixes(collection, fieldPath, operand.$like)
        }
        return rangeQueryPrefixes(operand)
    }

    /**
     * @param {string} key
     * @returns {string}
     */
    static rangeValueFromKey(key) {
        const segments = key.split('/')
        return segments.at(-2) ?? ''
    }
}

/**
 * @param {string} text
 * @returns {string[]}
 */
function completeLines(text) {
    if (!text) return []
    const complete = text.endsWith('\n') ? text : text.slice(0, text.lastIndexOf('\n') + 1)
    return complete.split('\n').map(stripTrailingCarriageReturn).filter(Boolean)
}

/**
 * @param {string} line
 * @returns {string}
 */
function stripTrailingCarriageReturn(line) {
    return line.endsWith('\r') ? line.slice(0, -1) : line
}

/**
 * @param {string[]} keys
 * @returns {string}
 */
function serializeSnapshot(keys) {
    return keys.length ? `${keys.join('\n')}\n` : ''
}

/**
 * @param {{ op: '+' | '-', key: string }[]} mutations
 * @returns {string}
 */
function serializeWal(mutations) {
    return mutations.map((mutation) => `${mutation.op}\t${mutation.key}\n`).join('')
}

/**
 * @param {string} line
 * @returns {{ op: '+' | '-', key: string } | null}
 */
function parseWalMutation(line) {
    const operation = line[0]
    if ((operation !== '+' && operation !== '-') || line[1] !== '\t') return null
    const key = line.slice(2)
    return key ? { op: operation, key } : null
}

/**
 * @param {FyloFilesystem} fs
 * @param {string} path
 * @returns {Promise<string>}
 */
async function readTextIfExists(fs, path) {
    if (!(await fs.exists(path))) return ''
    return await fs.readText(path)
}

/**
 * @param {FyloFilesystem} fs
 * @param {string} path
 * @param {string} data
 * @returns {Promise<void>}
 */
async function writeIfMissing(fs, path, data) {
    if (await fs.exists(path)) return
    await fs.writeText(path, data)
}

/**
 * Browser/browser port of FYLO's local-filesystem prefix index. Stores the same
 * compact zero-payload key format on disk so a future migration tool can move
 * collections between server and browser deployments unchanged.
 *
 * Composes over any `FyloFilesystem`. Used by `BrowserCore` to satisfy the
 * prefix-index shape that `BrowserQueryEngine` calls into.
 */
export class BrowserPrefixIndex {
    /**
     * @param {FyloFilesystem} fs
     * @param {(collection: string) => string} rootForCollection
     * @param {{ indexScannerFactory?: { ready(): Promise<void>, create(): Promise<{ loadSnapshot(snapshot: Uint8Array): void | Promise<void>, scanQueries(queries: Array<{ prefix: string, range?: { op: '$gt' | '$gte' | '$lt' | '$lte', value: string } }>): string[] | Promise<string[]>, close?(): void | Promise<void> }> } }} [options]
     */
    constructor(fs, rootForCollection, options = {}) {
        this.fs = fs
        this.rootForCollection = rootForCollection
        /** @type {Map<string, Uint8Array>} */
        this.snapshotCache = new Map()
        this.indexScannerFactory = options.indexScannerFactory
        /** @type {Map<string, Promise<any>>} */
        this.scanners = new Map()
        /** @type {Map<string, Uint8Array>} */
        this.scannerSnapshots = new Map()
        /** @type {Map<string, { added: Set<string>, removed: Set<string> }>} */
        this.walOverlayCache = new Map()
        /** @type {'loading' | 'active' | 'fallback'} */
        this.accelerationState = 'loading'
        /** @type {string | null} */
        this.accelerationError = null
        /** @type {string | null} */
        this.accelerationReasonCode = null
        this.accelerationMetrics = {
            snapshotReads: 0,
            snapshotReadMs: 0,
            snapshotBytes: 0,
            walReads: 0,
            walReadMs: 0,
            walBytes: 0,
            snapshotLoads: 0,
            snapshotLoadMs: 0,
            scans: 0,
            scanMs: 0
        }
    }

    /** @returns {Promise<void>} */
    async ready() {
        if (!this.indexScannerFactory || this.accelerationState === 'fallback') return
        try {
            await this.indexScannerFactory.ready()
            this.accelerationState = 'active'
        } catch (error) {
            await this.disableAcceleration(error, 'EWASM_INSTANTIATE')
        }
    }

    /** @returns {Promise<void>} */
    async close() {
        const scanners = [...this.scanners.values()]
        this.scanners.clear()
        this.scannerSnapshots.clear()
        for (const pending of scanners) {
            try {
                const scanner = await pending
                await scanner.close?.()
            } catch {}
        }
    }

    /**
     * @returns {{ mode: 'javascript', state: 'off' } | { mode: 'wasm', state: 'loading' | 'active' | 'fallback', reasonCode?: string, error?: string, metrics: { snapshotReads: number, snapshotReadMs: number, snapshotBytes: number, walReads: number, walReadMs: number, walBytes: number, snapshotLoads: number, snapshotLoadMs: number, scans: number, scanMs: number } }}
     */
    accelerationStatus() {
        if (!this.indexScannerFactory) return { mode: 'javascript', state: 'off' }
        const status = {
            mode: /** @type {const} */ ('wasm'),
            state: this.accelerationState,
            metrics: { ...this.accelerationMetrics }
        }
        return this.accelerationError
            ? {
                  ...status,
                  reasonCode: this.accelerationReasonCode ?? 'EWASM_INSTANTIATE',
                  error: this.accelerationError
              }
            : status
    }

    /**
     * @param {unknown} error
     * @param {string} defaultCode
     * @returns {Promise<void>}
     */
    async disableAcceleration(error, defaultCode) {
        this.accelerationState = 'fallback'
        this.accelerationError = error instanceof Error ? error.message : String(error)
        const code = /** @type {{ code?: unknown }} */ (error)?.code
        this.accelerationReasonCode =
            typeof code === 'string' && code.startsWith('EWASM_') ? code : defaultCode
        await this.close()
    }

    /** @param {string} collection @returns {Promise<any | null>} */
    async scannerFor(collection) {
        if (!this.indexScannerFactory || this.accelerationState === 'fallback') return null
        if (this.accelerationState !== 'active') await this.ready()
        if (this.accelerationState !== 'active') return null
        let scanner = this.scanners.get(collection)
        if (!scanner) {
            scanner = Promise.resolve(this.indexScannerFactory.create())
            this.scanners.set(collection, scanner)
        }
        try {
            return await scanner
        } catch (error) {
            await this.disableAcceleration(error, 'EWASM_INSTANTIATE')
            return null
        }
    }

    /** @param {string} collection @returns {Promise<void>} */
    async forgetCollection(collection) {
        this.snapshotCache.delete(collection)
        this.scannerSnapshots.delete(collection)
        this.walOverlayCache.delete(collection)
        const scanner = this.scanners.get(collection)
        this.scanners.delete(collection)
        if (!scanner) return
        try {
            const instance = await scanner
            await instance.close?.()
        } catch {}
    }

    /**
     * @param {string} collection
     * @returns {string}
     */
    root(collection) {
        return join(this.rootForCollection(collection), 'index')
    }

    /** @param {string} collection @returns {string} */
    manifestPath(collection) {
        return join(this.root(collection), LOCAL_FS_MANIFEST)
    }

    /** @param {string} collection @returns {string} */
    snapshotPath(collection) {
        return join(this.root(collection), LOCAL_FS_SNAPSHOT)
    }

    /** @param {string} collection @returns {string} */
    walPath(collection) {
        return join(this.root(collection), LOCAL_FS_WAL)
    }

    /** @param {string} collection @returns {Promise<void>} */
    async ensureCollection(collection) {
        await this.fs.mkdir(this.root(collection), { recursive: true })
        await writeIfMissing(
            this.fs,
            this.manifestPath(collection),
            `${JSON.stringify({ format: LOCAL_FS_FORMAT, createdAt: Date.now() })}\n`
        )
        await writeIfMissing(this.fs, this.snapshotPath(collection), '')
        await writeIfMissing(this.fs, this.walPath(collection), '')
    }

    /** @param {string} collection @returns {Promise<void>} */
    async resetCollection(collection) {
        await this.forgetCollection(collection)
        await this.fs.rmdir(this.root(collection), { recursive: true })
        await this.ensureCollection(collection)
    }

    /**
     * Reads (and caches) the snapshot bytes for `collection`.
     *
     * The cache is invalidated when the immutable snapshot is regenerated by
     * compaction. WAL-only mutations do not require a snapshot reload.
     *
     * @param {string} collection
     * @returns {Promise<Uint8Array>}
     */
    async readSnapshotBytes(collection) {
        const cached = this.snapshotCache.get(collection)
        if (cached) return cached
        const path = this.snapshotPath(collection)
        const startedAt = monotonicNow()
        const bytes = (await this.fs.exists(path))
            ? await this.fs.readBytes(path)
            : new Uint8Array(0)
        this.accelerationMetrics.snapshotReads++
        this.accelerationMetrics.snapshotReadMs += monotonicNow() - startedAt
        this.accelerationMetrics.snapshotBytes += bytes.byteLength
        this.snapshotCache.set(collection, bytes)
        return bytes
    }

    /**
     * Binary search returning the byte offset of the first key ≥ `prefix`.
     * Matches the native Rust prefix-index encoding exactly.
     *
     * @param {Uint8Array} bytes
     * @param {string} prefix
     * @returns {number}
     */
    findFirstKeyAtOrAfter(bytes, prefix) {
        if (bytes.length === 0) return 0
        let lo = 0
        let hi = bytes.length
        while (lo < hi) {
            const mid = Math.floor((lo + hi) / 2)
            let start = mid
            while (start > 0 && bytes[start - 1] !== 0x0a) start--
            let end = mid
            while (end < bytes.length && bytes[end] !== 0x0a) end++
            const key = DECODER.decode(bytes.subarray(start, end))
            if (key < prefix) lo = end + 1
            else hi = start
        }
        while (lo > 0 && lo < bytes.length && bytes[lo - 1] !== 0x0a) lo--
        return lo
    }

    /**
     * Loads the full key set (snapshot + WAL) into memory. Used during
     * compaction and for `countDocuments`. Not the hot query path.
     *
     * @param {string} collection
     * @returns {Promise<Set<string>>}
     */
    async loadKeySet(collection) {
        await this.ensureCollection(collection)
        const bytes = await this.readSnapshotBytes(collection)
        const keys = new Set(completeLines(DECODER.decode(bytes)))
        for (const line of completeLines(
            await readTextIfExists(this.fs, this.walPath(collection))
        )) {
            const mutation = parseWalMutation(line)
            if (!mutation) continue
            if (mutation.op === '+') keys.add(mutation.key)
            else keys.delete(mutation.key)
        }
        return keys
    }

    /**
     * @param {string} collection
     * @param {{ op: '+' | '-', key: string }[]} mutations
     * @returns {Promise<void>}
     */
    async appendMutations(collection, mutations) {
        if (mutations.length === 0) return
        await this.ensureCollection(collection)
        await this.fs.appendText(this.walPath(collection), serializeWal(mutations))
        const overlay = this.walOverlayCache.get(collection)
        if (overlay) {
            for (const mutation of mutations) {
                if (mutation.op === '+') {
                    overlay.added.add(mutation.key)
                    overlay.removed.delete(mutation.key)
                } else {
                    overlay.added.delete(mutation.key)
                    overlay.removed.add(mutation.key)
                }
            }
        }
        await this.compactIfNeeded(collection)
    }

    /** @param {string} collection @returns {Promise<void>} */
    async compactIfNeeded(collection) {
        if (!(await this.fs.exists(this.walPath(collection)))) return
        const wal = await this.fs.readText(this.walPath(collection))
        if (ENCODER.encode(wal).byteLength < LOCAL_FS_WAL_COMPACT_BYTES) return
        await this.compact(collection)
    }

    /**
     * Merges the WAL into the sorted snapshot. The in-memory snapshot cache is
     * dropped so the next query re-reads the freshly compacted file.
     *
     * @param {string} collection
     * @returns {Promise<void>}
     */
    async compact(collection) {
        const keys = [...(await this.loadKeySet(collection))].sort()
        await this.fs.writeText(this.snapshotPath(collection), serializeSnapshot(keys))
        await this.fs.writeText(this.walPath(collection), '')
        this.snapshotCache.delete(collection)
        this.scannerSnapshots.delete(collection)
        this.walOverlayCache.set(collection, { added: new Set(), removed: new Set() })
    }

    /**
     * @param {string} collection
     * @param {TTIDValue} docId
     * @param {Record<string, any>} doc
     * @returns {Promise<void>}
     */
    async putDocument(collection, docId, doc) {
        const keys = await BrowserPrefixIndexCodec.entriesForDocument(collection, docId, doc)
        await this.appendMutations(
            collection,
            keys.map((key) => ({ op: '+', key }))
        )
    }

    /**
     * @param {string} collection
     * @param {TTIDValue} docId
     * @param {Record<string, any>} doc
     * @returns {Promise<void>}
     */
    async removeDocument(collection, docId, doc) {
        const keys = await BrowserPrefixIndexCodec.entriesForDocument(collection, docId, doc)
        await this.appendMutations(
            collection,
            keys.map((key) => ({ op: '-', key }))
        )
    }

    /**
     * Counts distinct document IDs visible in the merged snapshot + WAL.
     *
     * @param {string} collection
     * @returns {Promise<number>}
     */
    async countDocuments(collection) {
        const docIds = new Set()
        for (const key of await this.loadKeySet(collection)) {
            const segments = key.split('/')
            if (segments.length < 2) continue
            docIds.add(segments.at(-1))
        }
        return docIds.size
    }

    /**
     * @param {string} collection
     * @param {string} fieldPath
     * @param {Operand} operand
     * @returns {Promise<Set<TTIDValue> | null>}
     */
    async candidateDocIds(collection, fieldPath, operand) {
        const prefixes = await BrowserPrefixIndexCodec.queryPrefixes(collection, fieldPath, operand)
        if (!prefixes) return null
        await this.ensureCollection(collection)
        const overlay = await this.loadWalOverlay(collection)
        const bytes = await this.readSnapshotBytes(collection)
        /** @type {Set<TTIDValue> | null} */
        let candidates = null
        for (const entry of prefixes) {
            const rootPrefix = BrowserPrefixIndexCodec.prefix(fieldPath, entry.kind)
            const fullPrefix = BrowserPrefixIndexCodec.prefix(
                fieldPath,
                entry.kind,
                entry.valuePrefix
            )
            /** @type {Set<TTIDValue>} */
            const next = new Set()
            const scanner = await this.scannerFor(collection)
            if (scanner) {
                try {
                    if (this.scannerSnapshots.get(collection) !== bytes) {
                        const loadStartedAt = monotonicNow()
                        await scanner.loadSnapshot(bytes)
                        this.accelerationMetrics.snapshotLoads++
                        this.accelerationMetrics.snapshotLoadMs += monotonicNow() - loadStartedAt
                        this.scannerSnapshots.set(collection, bytes)
                    }
                    const scanStartedAt = monotonicNow()
                    for (const encodedDocId of await scanner.scanQueries([
                        { prefix: fullPrefix, range: entry.range }
                    ])) {
                        const docId = decodeSegment(encodedDocId)
                        if (!TTID.isTTID(docId)) throw new Error(`Invalid document ID: ${docId}`)
                        next.add(docId)
                    }
                    this.accelerationMetrics.scans++
                    this.accelerationMetrics.scanMs += monotonicNow() - scanStartedAt
                } catch (error) {
                    await this.disableAcceleration(error, 'EWASM_QUERY')
                    next.clear()
                    this.scanSnapshotWithJavaScript(
                        bytes,
                        fullPrefix,
                        rootPrefix,
                        entry.range,
                        next
                    )
                }
            } else {
                this.scanSnapshotWithJavaScript(bytes, fullPrefix, rootPrefix, entry.range, next)
            }
            for (const key of overlay.removed) {
                if (!key.startsWith(fullPrefix)) continue
                if (!includeKeyInRange(key, entry.range)) continue
                next.delete(docIdFromKey(rootPrefix, key))
            }
            for (const key of overlay.added) {
                if (!key.startsWith(fullPrefix)) continue
                if (!includeKeyInRange(key, entry.range)) continue
                next.add(docIdFromKey(rootPrefix, key))
            }
            candidates = intersect(candidates, next)
        }
        return candidates
    }

    /**
     * @param {Uint8Array} bytes
     * @param {string} fullPrefix
     * @param {string} rootPrefix
     * @param {{ op: '$gt' | '$gte' | '$lt' | '$lte', value: string } | undefined} range
     * @param {Set<TTIDValue>} target
     */
    scanSnapshotWithJavaScript(bytes, fullPrefix, rootPrefix, range, target) {
        const offset = this.findFirstKeyAtOrAfter(bytes, fullPrefix)
        for (const key of streamKeysFrom(bytes, offset)) {
            if (!key.startsWith(fullPrefix)) break
            if (!includeKeyInRange(key, range)) continue
            target.add(docIdFromKey(rootPrefix, key))
        }
    }

    /**
     * @param {string} collection
     * @returns {Promise<{ added: Set<string>, removed: Set<string> }>}
     */
    async loadWalOverlay(collection) {
        const cached = this.walOverlayCache.get(collection)
        if (cached) return cached
        const added = new Set()
        const removed = new Set()
        const startedAt = monotonicNow()
        const wal = await readTextIfExists(this.fs, this.walPath(collection))
        this.accelerationMetrics.walReads++
        this.accelerationMetrics.walReadMs += monotonicNow() - startedAt
        this.accelerationMetrics.walBytes += ENCODER.encode(wal).byteLength
        for (const line of completeLines(wal)) {
            const mutation = parseWalMutation(line)
            if (!mutation) continue
            if (mutation.op === '+') {
                added.add(mutation.key)
                removed.delete(mutation.key)
            } else {
                added.delete(mutation.key)
                removed.add(mutation.key)
            }
        }
        const overlay = { added, removed }
        this.walOverlayCache.set(collection, overlay)
        return overlay
    }
}

/** @returns {number} */
function monotonicNow() {
    return globalThis.performance?.now() ?? Date.now()
}

/**
 * Streams sorted keys from `bytes` starting at `offset`. Sync iterator —
 * callers compare each yielded key against the prefix they care about and
 * `break` when the prefix is exceeded.
 *
 * @param {Uint8Array} bytes
 * @param {number} offset
 * @returns {Generator<string, void, unknown>}
 */
function* streamKeysFrom(bytes, offset) {
    let cursor = offset
    while (cursor < bytes.length) {
        let end = cursor
        while (end < bytes.length && bytes[end] !== 0x0a) end++
        const key = DECODER.decode(bytes.subarray(cursor, end))
        if (key.length > 0) yield key
        cursor = end + 1
    }
}

/**
 * Set intersection compatible with the server's pattern: a `null` left side
 * means "no constraint yet", so the first constraint wins. Subsequent
 * constraints intersect against the running set.
 *
 * @template T
 * @param {Set<T> | null} current
 * @param {Set<T>} next
 * @returns {Set<T>}
 */
function intersect(current, next) {
    if (current === null) return next
    const out = new Set()
    for (const value of next) if (current.has(value)) out.add(value)
    return out
}

/**
 * @param {string} key
 * @param {{ op: '$gt' | '$gte' | '$lt' | '$lte', value: string } | undefined} range
 * @returns {boolean}
 */
function includeKeyInRange(key, range) {
    if (!range) return true
    const value = BrowserPrefixIndexCodec.rangeValueFromKey(key)
    if (range.op === '$gt') return value > range.value
    if (range.op === '$gte') return value >= range.value
    if (range.op === '$lt') return value > range.value
    if (range.op === '$lte') return value >= range.value
    return true
}
