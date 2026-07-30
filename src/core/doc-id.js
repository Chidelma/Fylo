import path from 'node:path'
import TTID from '../vendor/ttid.js'

/**
 * @param {string} docId
 * @returns {Promise<void>}
 */
export async function validateDocId(docId) {
    if (!(await TTID.isTTID(docId))) {
        const error = /** @type {Error & { code: string }} */ (
            new Error(`Invalid document ID: ${docId}`)
        )
        error.code = 'EINVALIDDOCID'
        throw error
    }
}

/**
 * Keep only the strings that are valid TTIDs, driving the async `ttid` binary
 * once per key in parallel.
 * @param {string[]} keys
 * @returns {Promise<string[]>}
 */
export async function filterTTIDs(keys) {
    const flags = await Promise.all(keys.map((key) => TTID.isTTID(key)))
    return keys.filter((_, i) => flags[i] !== null)
}

/**
 * @param {string} parent
 * @param {string} target
 */
export { legacyShardOf, shardOf } from './shard.js'

export function assertPathInside(parent, target) {
    const resolvedParent = path.resolve(parent)
    const resolvedTarget = path.resolve(target)
    const relative = path.relative(resolvedParent, resolvedTarget)
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(`Unsafe document path: ${target}`)
    }
}
