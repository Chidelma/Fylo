/**
 * POSIX path utilities for the browser-targeted FYLO runtime.
 *
 * The browser core must not import `node:path`. Everything that operates on FYLO's
 * on-disk layout (collection roots, bucket directories, document file paths)
 * goes through this module so the same code can run on top of OPFS,
 * in-memory, or any other host filesystem.
 *
 * Slashes are normalised, '.' segments are dropped, and '..' segments resolve
 * relative to the prefix path. Absolute paths begin with '/' and stay rooted;
 * relative paths stay relative. Trailing slashes are stripped.
 */

const SEPARATOR = '/'

/**
 * @param {string} segment
 * @returns {boolean}
 */
function isMeaningful(segment) {
    return segment.length > 0 && segment !== '.'
}

/**
 * Normalises a path string. Collapses repeated separators, resolves '.' and
 * '..' segments. Preserves the leading slash if the input had one.
 *
 * @param {string} value
 * @returns {string}
 */
export function normalize(value) {
    if (typeof value !== 'string') return ''
    const isAbsolute = value.startsWith(SEPARATOR)
    /** @type {string[]} */
    const out = []
    for (const segment of value.split(SEPARATOR)) {
        if (!isMeaningful(segment)) continue
        if (segment === '..') {
            if (out.length > 0 && out[out.length - 1] !== '..') {
                out.pop()
            } else if (!isAbsolute) {
                out.push('..')
            }
            continue
        }
        out.push(segment)
    }
    const joined = out.join(SEPARATOR)
    if (isAbsolute) return SEPARATOR + joined
    return joined || '.'
}

/**
 * Joins path segments using '/' and normalises the result. Falsy and empty
 * segments are ignored.
 *
 * @param {...(string | undefined | null)} segments
 * @returns {string}
 */
export function join(...segments) {
    /** @type {string[]} */
    const parts = []
    for (const segment of segments) {
        if (typeof segment !== 'string') continue
        if (segment.length === 0) continue
        parts.push(segment)
    }
    if (parts.length === 0) return '.'
    return normalize(parts.join(SEPARATOR))
}

/**
 * Returns the parent directory of `value`. Mirrors `path.posix.dirname`.
 *
 * @param {string} value
 * @returns {string}
 */
export function dirname(value) {
    const normalised = normalize(value)
    if (normalised === SEPARATOR) return SEPARATOR
    const index = normalised.lastIndexOf(SEPARATOR)
    if (index < 0) return '.'
    if (index === 0) return SEPARATOR
    return normalised.slice(0, index)
}

/**
 * Returns the final segment of `value`. Mirrors `path.posix.basename`.
 *
 * @param {string} value
 * @returns {string}
 */
export function basename(value) {
    const normalised = normalize(value)
    if (normalised === SEPARATOR) return ''
    const index = normalised.lastIndexOf(SEPARATOR)
    if (index < 0) return normalised
    return normalised.slice(index + 1)
}

/**
 * Resolves `value` against `from`. Absolute paths are returned as-is.
 * Relative paths are appended to `from`. The result is always normalised.
 *
 * @param {string} from
 * @param {string} value
 * @returns {string}
 */
export function resolve(from, value) {
    if (typeof value !== 'string') return normalize(from)
    if (value.startsWith(SEPARATOR)) return normalize(value)
    return normalize(`${from}${SEPARATOR}${value}`)
}

/**
 * Returns the relative path from `from` to `to`. Both must be absolute or both
 * must be relative. Mirrors `path.posix.relative` for the common cases used by
 * `assertPathInside`.
 *
 * @param {string} from
 * @param {string} to
 * @returns {string}
 */
export function relative(from, to) {
    const fromSegments = normalize(from)
        .split(SEPARATOR)
        .filter((segment) => segment.length > 0)
    const toSegments = normalize(to)
        .split(SEPARATOR)
        .filter((segment) => segment.length > 0)
    let common = 0
    while (
        common < fromSegments.length &&
        common < toSegments.length &&
        fromSegments[common] === toSegments[common]
    ) {
        common++
    }
    /** @type {string[]} */
    const out = []
    for (let index = common; index < fromSegments.length; index++) out.push('..')
    for (let index = common; index < toSegments.length; index++) out.push(toSegments[index])
    return out.join(SEPARATOR)
}

/**
 * Throws if `target` is not inside `parent`. Mirrors the native engine check
 * that protects against path traversal in document paths.
 *
 * @param {string} parent
 * @param {string} target
 */
export function assertPathInside(parent, target) {
    const resolvedParent = normalize(parent)
    const resolvedTarget = normalize(target)
    if (resolvedTarget === resolvedParent) return
    const offset = relative(resolvedParent, resolvedTarget)
    if (offset.startsWith('..') || offset.startsWith(SEPARATOR)) {
        throw new Error(`Unsafe document path: ${target}`)
    }
}
