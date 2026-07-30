// Pure shard derivation, free of any runtime dependency so the browser core
// can share one definition with the Node engine instead of keeping its own.

/**
 * On-disk shard directory for a record.
 *
 * The shard is the last two characters of the identifier's *creation* segment.
 * TTIDs are base36 100 ns ticks, so their leading characters barely move — the
 * second character rolls over roughly every 117 days, which put every document
 * written in a four-month window into one directory. The trailing characters
 * roll every 100 ns and 3.6 us, giving 1296 uniformly used buckets for free.
 *
 * It must be the creation segment specifically: an identifier may carry
 * `created-updated-deleted` lifecycle segments, and sharding on the raw string
 * would move a record between directories when it is updated or deleted.
 *
 * @param {string} id
 * @returns {string}
 */
export function shardOf(id) {
    return creationSegment(id).slice(-2).padStart(2, '0')
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

/**
 * Shard a record occupied under the superseded layout, which used the first two
 * characters. Readers try this after {@link shardOf} so a root written before
 * the change is still readable during the published compatibility window.
 *
 * @param {string} id
 * @returns {string}
 */
export function legacyShardOf(id) {
    return creationSegment(id).slice(0, 2)
}
