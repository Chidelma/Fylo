import { matchesLike } from '../../query/like.js'
import { copySafeRecord, safeRecord } from '../../query/safe-record.js'

/**
 * Browser-safe query evaluator for the FYLO browser core.
 *
 * This mirrors `FilesystemQueryEngine` without importing the server Cipher
 * module. Browser encryption is intentionally not wired here yet; exact-match
 * blind indexes can be added behind this class with a browser-safe adapter.
 */

/**
 * @typedef {import('../../types/vendor.js').TTID} TTIDValue
 * @typedef {import('../../query/types.js').Operand} Operand
 * @typedef {import('../../query/types.js').QueryOperation<Record<string, any>>} QueryOperation
 * @typedef {import('../../query/types.js').StoreQuery<Record<string, any>>} StoreQuery
 * @typedef {object} BrowserPrefixIndexLike
 * @property {(collection: string, fieldPath: string, operand: Operand) => Promise<Set<TTIDValue> | null>} candidateDocIds
 */

export class BrowserQueryEngine {
    /**
     * @param {{ index: BrowserPrefixIndexLike }} context
     */
    constructor(context) {
        this.context = context
    }

    /**
     * @param {Record<string, any>} target
     * @param {string} fieldPath
     * @returns {unknown}
     */
    getValueByPath(target, fieldPath) {
        return fieldPath
            .replaceAll('/', '.')
            .split('.')
            .reduce((acc, key) => {
                if (acc === undefined || acc === null || typeof acc !== 'object') return undefined
                return Object.hasOwn(acc, key) ? acc[key] : undefined
            }, target)
    }

    /** @param {string} fieldPath @returns {string} */
    normalizeFieldPath(fieldPath) {
        return fieldPath.replaceAll('.', '/')
    }

    /**
     * @param {TTIDValue} _docId
     * @param {StoreQuery | undefined} query
     * @param {{ createdAt: number, updatedAt: number }} timestamps
     * @returns {boolean}
     */
    matchesTimestamp(_docId, query, timestamps) {
        if (!query?.$created && !query?.$updated) return true
        /**
         * @param {number} value
         * @param {import('../../query/types.js').TimestampQuery | undefined} range
         * @returns {boolean}
         */
        const match = (value, range) => {
            if (!range) return true
            if (range.$gt !== undefined && !(value > range.$gt)) return false
            if (range.$gte !== undefined && !(value >= range.$gte)) return false
            if (range.$lt !== undefined && !(value < range.$lt)) return false
            if (range.$lte !== undefined && !(value <= range.$lte)) return false
            return true
        }
        return (
            match(timestamps.createdAt, query.$created) &&
            match(timestamps.updatedAt, query.$updated)
        )
    }

    /**
     * @param {TTIDValue} docId
     * @param {Record<string, any>} doc
     * @param {StoreQuery | undefined} query
     * @param {{ createdAt: number, deletedAt: number }} timestamps
     * @returns {boolean}
     */
    matchesDeletedQuery(docId, doc, query, timestamps) {
        if (query?.$updated)
            throw new Error('Deleted document queries use $deleted instead of $updated')
        if (
            !this.matchesQuery(docId, doc, query, {
                ...timestamps,
                updatedAt: timestamps.deletedAt
            })
        )
            return false
        const range = query?.$deleted
        if (!range) return true
        if (range.$gt !== undefined && !(timestamps.deletedAt > range.$gt)) return false
        if (range.$gte !== undefined && !(timestamps.deletedAt >= range.$gte)) return false
        if (range.$lt !== undefined && !(timestamps.deletedAt < range.$lt)) return false
        if (range.$lte !== undefined && !(timestamps.deletedAt <= range.$lte)) return false
        return true
    }

    /**
     * @param {unknown} value
     * @param {Operand} operand
     * @returns {boolean}
     */
    matchesOperand(value, operand) {
        /**
         * Each operator's predicate, evaluated only when the operand supplies
         * it. Every supplied operator must hold.
         * @type {Record<string, (expected: any) => boolean>}
         */
        const predicates = {
            // eslint-disable-next-line eqeqeq -- loose compare is the documented FYLO semantic
            $eq: (expected) => value == expected,
            // eslint-disable-next-line eqeqeq
            $ne: (expected) => value != expected,
            $gt: (expected) => this.matchesNumber(value, '$gt', expected),
            $gte: (expected) => this.matchesNumber(value, '$gte', expected),
            $lt: (expected) => this.matchesNumber(value, '$lt', expected),
            $lte: (expected) => this.matchesNumber(value, '$lte', expected),
            $like: (expected) => typeof value === 'string' && this.matchesLike(value, expected),
            $contains: (expected) =>
                // eslint-disable-next-line eqeqeq
                Array.isArray(value) && value.some((item) => item == expected)
        }
        const supplied = /** @type {Record<string, any>} */ (operand)
        for (const [operator, predicate] of Object.entries(predicates)) {
            if (supplied[operator] === undefined) continue
            if (!predicate(supplied[operator])) return false
        }
        return true
    }

    /**
     * @param {unknown} value
     * @param {'$gt' | '$gte' | '$lt' | '$lte'} operator
     * @param {number} expected
     * @returns {boolean}
     */
    matchesNumber(value, operator, expected) {
        const numeric = Number(value)
        if (operator === '$gt') return numeric > expected
        if (operator === '$gte') return numeric >= expected
        if (operator === '$lt') return numeric < expected
        return numeric <= expected
    }

    /**
     * @param {string} value
     * @param {string} pattern
     * @returns {boolean}
     */
    matchesLike(value, pattern) {
        return matchesLike(value, pattern)
    }

    /**
     * @param {Set<TTIDValue> | null} current
     * @param {Iterable<TTIDValue>} next
     * @returns {Set<TTIDValue>}
     */
    intersectDocIds(current, next) {
        const nextSet = next instanceof Set ? next : new Set(next)
        if (current === null) return new Set(nextSet)
        const intersection = new Set()
        for (const docId of current) {
            if (nextSet.has(docId)) intersection.add(docId)
        }
        return intersection
    }

    /**
     * @param {string} collection
     * @param {string} fieldPath
     * @param {Operand} operand
     * @returns {Promise<Set<TTIDValue> | null>}
     */
    async candidateDocIdsForOperand(collection, fieldPath, operand) {
        let candidateIds = null
        if (operand.$eq !== undefined) {
            candidateIds = this.intersectDocIds(
                candidateIds,
                (await this.context.index.candidateDocIds(collection, fieldPath, {
                    $eq: operand.$eq
                })) ?? new Set()
            )
        }
        if (
            operand.$gt !== undefined ||
            operand.$gte !== undefined ||
            operand.$lt !== undefined ||
            operand.$lte !== undefined
        ) {
            for (const key of /** @type {const} */ (['$gt', '$gte', '$lt', '$lte'])) {
                if (operand[key] === undefined) continue
                const rangeCandidates = await this.context.index.candidateDocIds(
                    collection,
                    fieldPath,
                    { [key]: operand[key] }
                )
                if (rangeCandidates === null) return null
                candidateIds = this.intersectDocIds(candidateIds, rangeCandidates)
            }
        }
        if (operand.$like !== undefined) {
            const likeCandidates = await this.context.index.candidateDocIds(collection, fieldPath, {
                $like: operand.$like
            })
            if (likeCandidates === null) return null
            candidateIds = this.intersectDocIds(candidateIds, likeCandidates)
        }
        if (operand.$contains !== undefined) {
            const containsCandidates = await this.context.index.candidateDocIds(
                collection,
                fieldPath,
                { $contains: operand.$contains }
            )
            candidateIds = this.intersectDocIds(candidateIds, containsCandidates ?? new Set())
        }
        return candidateIds
    }

    /**
     * @param {string} collection
     * @param {QueryOperation} operation
     * @returns {Promise<Set<TTIDValue> | null>}
     */
    async candidateDocIdsForOperation(collection, operation) {
        let candidateIds = null
        for (const [field, operand] of Object.entries(operation)) {
            if (!operand) continue
            const fieldPath = this.normalizeFieldPath(String(field))
            const fieldCandidates = await this.candidateDocIdsForOperand(
                collection,
                fieldPath,
                operand
            )
            if (fieldCandidates === null) continue
            candidateIds = this.intersectDocIds(candidateIds, fieldCandidates)
        }
        return candidateIds
    }

    /**
     * @param {string} collection
     * @param {StoreQuery | undefined} query
     * @returns {Promise<Set<TTIDValue> | null>}
     */
    async candidateDocIdsForQuery(collection, query) {
        if (!query?.$ops || query.$ops.length === 0) return null
        const union = new Set()
        let usedIndex = false
        for (const operation of query.$ops) {
            const candidateIds = await this.candidateDocIdsForOperation(collection, operation)
            if (candidateIds === null) return null
            usedIndex = true
            for (const docId of candidateIds) union.add(docId)
        }
        return usedIndex ? union : null
    }

    /**
     * @param {TTIDValue} docId
     * @param {Record<string, any>} doc
     * @param {StoreQuery | undefined} query
     * @param {{ createdAt: number, updatedAt: number }} timestamps
     * @returns {boolean}
     */
    matchesQuery(docId, doc, query, timestamps) {
        if (!this.matchesTimestamp(docId, query, timestamps)) return false
        if (!query?.$ops || query.$ops.length === 0) return true
        return query.$ops.some((operation) => {
            for (const field of Object.keys(operation)) {
                const value = this.getValueByPath(doc, field)
                const operand = operation[field]
                if (!operand || !this.matchesOperand(value, operand)) return false
            }
            return true
        })
    }

    /** @param {string[]} selection @param {Record<string, any>} data @returns {Record<string, any>} */
    selectValues(selection, data) {
        const copy = copySafeRecord(data)
        for (const field of Object.keys(copy)) {
            if (!selection.includes(field)) delete copy[field]
        }
        return copy
    }

    /** @param {Record<string, string>} rename @param {Record<string, any>} data @returns {Record<string, any>} */
    renameFields(rename, data) {
        const copy = copySafeRecord(data)
        for (const field of Object.keys(copy)) {
            if (Object.hasOwn(rename, field) && typeof rename[field] === 'string') {
                copy[rename[field]] = copy[field]
                delete copy[field]
            }
        }
        return copy
    }

    /**
     * @param {Record<TTIDValue, Record<string, any>>} doc
     * @param {StoreQuery | undefined} query
     * @returns {TTIDValue | Record<string, any> | undefined}
     */
    processDoc(doc, query) {
        if (Object.keys(doc).length === 0) return
        const next = copySafeRecord(doc)
        for (let [_id, data] of Object.entries(next)) {
            if (query?.$select?.length) data = this.selectValues(query.$select, data)
            if (query?.$rename) data = this.renameFields(query.$rename, data)
            next[_id] = data
        }
        if (query?.$groupby) {
            /** @type {Record<string, Record<TTIDValue, Record<string, any>>>} */
            const docGroup = safeRecord()
            for (const [id, data] of Object.entries(next)) {
                const groupValue = data[query.$groupby]
                if (groupValue !== undefined && groupValue !== null) {
                    const groupData = copySafeRecord(data)
                    delete groupData[query.$groupby]
                    const group = safeRecord()
                    group[id] = groupData
                    docGroup[String(groupValue)] = group
                }
            }
            if (query.$onlyIds) {
                /** @type {Record<string, TTIDValue[]>} */
                const groupedIds = safeRecord()
                for (const group of Object.keys(docGroup)) {
                    groupedIds[group] = Object.keys(docGroup[group])
                }
                return groupedIds
            }
            return docGroup
        }
        if (query?.$onlyIds) return Object.keys(next).shift()
        return next
    }
}
