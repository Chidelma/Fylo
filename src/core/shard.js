// Pure shard derivation, free of any runtime dependency so the browser core
// can share one definition with the Node engine instead of keeping its own.

/**
 * Default shard width for a newly created collection.
 *
 * One character gives 36 buckets. Sharding exists to stop a single directory
 * growing unbounded, and enumeration costs one directory read per shard, so a
 * width past what the record count needs is pure overhead. A root records the
 * width it was created with, so changing this never moves an existing record.
 */
export const DEFAULT_SHARD_WIDTH = 1

/**
 * Narrowest shard a collection may use.
 *
 * Zero was once allowed as a flat collection with no shard directory, but
 * nothing could read one back: enumeration walks `docs/` expecting shard
 * directories and refuses a file. It is refused rather than fixed because a
 * single unbounded directory is what sharding exists to prevent.
 */
export const MIN_SHARD_WIDTH = 1

/**
 * Widest shard a collection may use. 36^4 is already 1.7 million directories,
 * past which enumeration costs more than the fan-out saves.
 */
export const MAX_SHARD_WIDTH = 4

/**
 * On-disk shard directory for a record.
 *
 * The shard is the last `width` characters of the identifier's *creation*
 * segment. A TTID is base36 100 ns ticks, so its leading characters barely
 * move — the second rolls over roughly every 117 days, which put every record
 * written in a four-month window into one directory. The trailing characters
 * roll every 100 ns and 3.6 us, so they distribute uniformly.
 *
 * It must be the creation segment: an identifier may carry
 * `created-updated-deleted` lifecycle segments, and sharding the raw string
 * would move a record between directories when it is updated or deleted.
 *
 * @param {string} id
 * @param {number} [width]
 * @returns {string}
 */
export function shardOf(id, width = DEFAULT_SHARD_WIDTH) {
    const shard = assertShardWidth(width)
    return creationSegment(id).slice(-shard).padStart(shard, '0')
}

/**
 * Shard a record occupies under the layout superseded by ADR 0006, which used
 * the first two characters. Readers try this after {@link shardOf} so a root
 * written before that change stays readable.
 *
 * @param {string} id
 * @returns {string}
 */
export function legacyShardOf(id) {
    return creationSegment(id).slice(0, 2)
}

/**
 * Every shard directory a record may legitimately occupy, most likely first.
 *
 * A reshard records the widths it is moving away from until it completes, so a
 * root interrupted midway is still fully readable: a record that has moved is
 * found under the new width, one that has not under an old one. The layout
 * superseded by ADR 0006 is always the last candidate.
 *
 * @param {string} id
 * @param {number} width
 * @param {number[]} [previousWidths]
 * @returns {string[]}
 */
export function shardCandidates(id, width, previousWidths = []) {
    /** @type {string[]} */
    const candidates = []
    for (const candidate of [width, ...previousWidths]) {
        const shard = shardOf(id, candidate)
        if (!candidates.includes(shard)) candidates.push(shard)
    }
    const legacy = legacyShardOf(id)
    if (!candidates.includes(legacy)) candidates.push(legacy)
    return candidates
}

/**
 * Validate a configured shard width.
 *
 * @param {unknown} width
 * @returns {number}
 */
export function assertShardWidth(width) {
    if (
        !Number.isInteger(width) ||
        Number(width) < MIN_SHARD_WIDTH ||
        Number(width) > MAX_SHARD_WIDTH
    ) {
        throw new Error(
            `Shard width must be an integer from ${MIN_SHARD_WIDTH} to ${MAX_SHARD_WIDTH}: ${String(width)}`
        )
    }
    return Number(width)
}

/**
 * The creation segment of an identifier, rejecting anything that is not one.
 *
 * A filename shards to a plausible-looking directory taken from its extension,
 * which is a silent wrong answer rather than an error, so the segment must be
 * alphanumeric.
 *
 * @param {string} id
 * @returns {string}
 */
function creationSegment(id) {
    const created = String(id).split('-')[0]
    if (created.length === 0 || !/^[0-9A-Za-z]+$/.test(created)) {
        throw new Error(`Cannot shard a non-identifier: ${String(id)}`)
    }
    return created
}
