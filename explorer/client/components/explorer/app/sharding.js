export const DEFAULT_SHARD_WIDTH = 2
export const MAX_SHARD_WIDTH = 4

/** Last `width` characters of the TTID creation segment. */
export function shardOf(id, width = DEFAULT_SHARD_WIDTH) {
    const normalized = normalizeWidth(width)
    if (normalized === 0) return ''
    return creationSegment(id).slice(-normalized).padStart(normalized, '0')
}

/** Leading-two layout used by releases before ADR 0006. */
export function legacyShardOf(id) {
    return creationSegment(id).slice(0, 2)
}

/** Validate a collection descriptor without trusting arbitrary root JSON. */
export function normalizeShardLayout(descriptor) {
    const source = descriptor && typeof descriptor === 'object' ? descriptor : {}
    const width = normalizeWidth(source.shardWidth ?? DEFAULT_SHARD_WIDTH)
    const previousWidths = Array.isArray(source.previousShardWidths)
        ? source.previousShardWidths.map(normalizeWidth).filter((value, index, all) => {
              return value !== width && all.indexOf(value) === index
          })
        : []
    return { width, previousWidths }
}

/** Current, interrupted-reshard, then released leading-layout candidates. */
export function shardCandidates(id, layout = normalizeShardLayout()) {
    const candidates = []
    for (const width of [layout.width, ...layout.previousWidths]) {
        const shard = shardOf(id, width)
        if (!candidates.includes(shard)) candidates.push(shard)
    }
    const legacy = legacyShardOf(id)
    if (!candidates.includes(legacy)) candidates.push(legacy)
    return candidates
}

/** Every layout that may appear inside immutable version history. */
export function historicalShardCandidates(id, layout = normalizeShardLayout()) {
    const candidates = shardCandidates(id, layout)
    for (let width = 0; width <= MAX_SHARD_WIDTH; width++) {
        const shard = shardOf(id, width)
        if (!candidates.includes(shard)) candidates.push(shard)
    }
    return candidates
}

function normalizeWidth(value) {
    if (!Number.isInteger(value) || value < 0 || value > MAX_SHARD_WIDTH) {
        throw new Error(`Invalid FYLO shard width: ${String(value)}`)
    }
    return value
}

function creationSegment(id) {
    const created = String(id).split('-')[0]
    if (!created || !/^[0-9A-Za-z]+$/.test(created)) {
        throw new Error(`Cannot shard a non-identifier: ${String(id)}`)
    }
    return created
}
