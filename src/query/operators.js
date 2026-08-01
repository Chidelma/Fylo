import { Cipher } from '../security/cipher.js'

/**
 * @typedef {import('./types.js').StoreQuery<Record<string, any>>} StoreQuery
 */

/** @type {(keyof import('./types.js').Operand)[]} */
const ENCRYPTED_FIELD_OPS = ['$ne', '$gt', '$gte', '$lt', '$lte', '$like', '$contains']

/**
 * Utility helpers for explaining which prefix-index expressions a FYLO query
 * can use. This is primarily diagnostic/admin-facing; execution happens in
 * the storage query engine.
 */
export class Query {
    /**
     * Builds diagnostic prefix-index expressions that can satisfy a structured FYLO query.
     * @param {string} collection
     * @param {StoreQuery} query
     * @returns {Promise<string[]>}
     */
    static async getExprs(collection, query) {
        if (!query.$ops) return ['**/*']
        /** @type {Set<string>} */
        const expressions = new Set()
        for (const operation of query.$ops) {
            for (const column of Object.keys(operation)) {
                const operand = operation[column]
                if (!operand) continue
                await Query.addOperandExpressions(collection, expressions, String(column), operand)
            }
        }
        return Array.from(expressions)
    }

    /**
     * Adds every index expression one field operand implies.
     * @param {string} collection
     * @param {Set<string>} expressions
     * @param {string} column
     * @param {import('./types.js').Operand} operand
     */
    static async addOperandExpressions(collection, expressions, column, operand) {
        const fieldPath = column.replaceAll('.', '/')
        const encrypted = Cipher.isConfigured() && Cipher.isEncryptedField(collection, fieldPath)
        if (encrypted) assertNoEncryptedOnlyOperators(column, operand)
        if (operand.$eq) {
            const lookupValue = encrypted
                ? await Cipher.blindIndex(String(operand.$eq).replaceAll('/', '%2F'))
                : operand.$eq
            expressions.add(`${fieldPath}/eq/${lookupValue}/**/*`)
        }
        if (operand.$ne) expressions.add(`${fieldPath}/**/*`)
        for (const operator of /** @type {const} */ (['$gt', '$gte'])) {
            if (operand[operator]) expressions.add(`${fieldPath}/n/**/*`)
        }
        for (const operator of /** @type {const} */ (['$lt', '$lte'])) {
            if (operand[operator]) expressions.add(`${fieldPath}/nr/**/*`)
        }
        if (operand.$like) {
            expressions.add(`${fieldPath}/f/${operand.$like.replaceAll('%', '*')}/**/*`)
        }
        if (operand.$contains !== undefined) {
            expressions.add(`${fieldPath}/eq/${String(operand.$contains)}/**/*`)
        }
    }
}

/**
 * An encrypted field is indexed by an equality-only blind index, so ordering
 * and substring operators cannot be planned against it.
 * @param {string} column
 * @param {import('./types.js').Operand} operand
 */
function assertNoEncryptedOnlyOperators(column, operand) {
    for (const operator of ENCRYPTED_FIELD_OPS) {
        if (operand[operator] !== undefined) {
            throw new Error(`Operator ${operator} is not supported on encrypted field "${column}"`)
        }
    }
}
