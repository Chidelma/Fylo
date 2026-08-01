// Reads FYLO's git-like `.fylo-vcs` store straight from the filesystem — the
// browser engine doesn't expose version control, so the Explorer walks it.

import { historicalShardCandidates, normalizeShardLayout } from './sharding.js'

const VCS = '/.fylo-vcs'

const safeRecord = () => Object.create(null)

/** Filesystem path of a content-addressed object blob. */
export function vcsObjectPath(hash) {
    return `${VCS}/objects/${hash.slice(0, 2)}/${hash.slice(2)}`
}

/** Entries of a content-addressed tree object. */
async function vcsNode(fs, hash) {
    const bytes = await fs.readBytes(vcsObjectPath(hash))
    return JSON.parse(new TextDecoder().decode(bytes)).entries
}

/** Walk root → collection → active → bucket → file to the blob's content hash. */
async function vcsBlobHash(fs, rootHash, collection, bucket, filename) {
    const step = async (hash, name) => {
        const entries = await vcsNode(fs, hash).catch(() => [])
        return entries.find((e) => e.name === name)?.hash ?? null
    }
    let hash = await step(rootHash, collection)
    if (hash) hash = await step(hash, 'active') // live documents/files
    if (hash) hash = await step(hash, bucket)
    return hash ? await step(hash, filename) : null
}

/**
 * Per top-level entry (collection/bucket) write history, derived from the commit
 * chain. An entry "changed" in a commit when its subtree hash differs from the
 * parent commit's — content-addressing means a differing hash is a write
 * somewhere beneath it, so a top-level compare needs no recursion. Returns a
 * write count and an evenly time-bucketed series (for sparklines) per name.
 * Missing/uncommitted stores yield empty — the browser never writes commits.
 *
 * @param {*} fs
 * @param {number} [buckets] number of time buckets in each series
 * @returns {Promise<{ names: Record<string, { count: number, series: number[] }>, buckets: number, from: number, to: number }>}
 */
export async function readWriteActivity(fs, buckets = 24) {
    const empty = { names: safeRecord(), buckets, from: 0, to: 0 }
    if (!fs) return empty
    try {
        const head = await fs.readText(`${VCS}/HEAD`)
        const branch = head.match(/refs\/heads\/(.+)/)?.[1]?.trim()
        if (!branch) return empty
        const ref = JSON.parse(await fs.readText(`${VCS}/refs/heads/${branch}.json`))
        let commitId = ref?.head
        // Walk the first-parent chain newest → oldest, recording each commit's
        // time and its top-level name → subtree-hash map.
        const chain = []
        let guard = 0
        while (commitId && guard++ < 2000) {
            let manifest
            try {
                manifest = JSON.parse(await fs.readText(`${VCS}/commits/${commitId}/manifest.json`))
            } catch {
                break
            }
            const tree = JSON.parse(
                await fs.readText(`${VCS}/commits/${commitId}/tree.json`).catch(() => '{}')
            )
            const entries = tree.root ? await vcsNode(fs, tree.root).catch(() => []) : []
            const map = safeRecord()
            for (const entry of entries) map[entry.name] = entry.hash
            chain.push({ at: Date.parse(manifest.createdAt) || 0, map })
            commitId = manifest.parents?.[0] ?? null
        }
        if (chain.length === 0) return empty
        // A write event = an entry whose hash differs from the same entry in its
        // parent commit (or is newly present in the oldest commit).
        /** @type {Record<string, number[]>} name → event timestamps */
        const events = safeRecord()
        for (let i = 0; i < chain.length; i++) {
            const parent = chain[i + 1]?.map ?? {}
            for (const [name, hash] of Object.entries(chain[i].map)) {
                if (parent[name] !== hash) (events[name] ??= []).push(chain[i].at)
            }
        }
        const times = chain.map((c) => c.at)
        const from = Math.min(...times)
        const to = Math.max(...times)
        const span = to - from
        /** @type {Record<string, { count: number, series: number[] }>} */
        const names = safeRecord()
        for (const [name, timestamps] of Object.entries(events)) {
            const series = new Array(buckets).fill(0)
            for (const t of timestamps) {
                const idx =
                    span > 0
                        ? Math.min(buckets - 1, Math.floor(((t - from) / span) * buckets))
                        : buckets - 1
                series[idx] += 1
            }
            names[name] = { count: timestamps.length, series }
        }
        return { names, buckets, from, to }
    } catch {
        return empty
    }
}

/**
 * Build the version list for a document/file: walk the current branch's commit
 * chain (first parent), resolving the file's blob hash in each commit; a new
 * entry is recorded each time the content hash changes (newest first). Missing
 * or uncommitted stores yield [] — the browser never writes commits.
 */
export async function readVersions(fs, { collection, id, filename, shardLayout }) {
    if (!fs || !filename) return []
    try {
        const head = await fs.readText(`${VCS}/HEAD`)
        const branch = head.match(/refs\/heads\/(.+)/)?.[1]?.trim()
        if (!branch) return []
        const ref = JSON.parse(await fs.readText(`${VCS}/refs/heads/${branch}.json`))
        let commitId = ref?.head
        const buckets = historicalShardCandidates(id, normalizeShardLayout(shardLayout))
        const out = []
        let last = null
        let guard = 0
        while (commitId && guard++ < 2000) {
            let manifest
            try {
                manifest = JSON.parse(await fs.readText(`${VCS}/commits/${commitId}/manifest.json`))
            } catch {
                break
            }
            const tree = JSON.parse(
                await fs.readText(`${VCS}/commits/${commitId}/tree.json`).catch(() => '{}')
            )
            let hash = null
            if (tree.root) {
                for (const bucket of buckets) {
                    hash = await vcsBlobHash(fs, tree.root, collection, bucket, filename)
                    if (hash) break
                }
            }
            if (hash && hash !== last) {
                out.push({
                    commit: commitId,
                    hash,
                    message: manifest.message || '',
                    at: manifest.createdAt
                })
                last = hash
            }
            commitId = manifest.parents?.[0] ?? null
        }
        return out
    } catch {
        return []
    }
}
