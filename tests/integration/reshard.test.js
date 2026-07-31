import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import Fylo from '../../src/index.js'
import { shardOf } from '../../src/core/shard.js'

const COLLECTION = 'records'

describe('shard width', () => {
    /** @type {string} */
    let root
    /** @type {string | undefined} */
    let previousWidth

    beforeEach(async () => {
        previousWidth = process.env.FYLO_SHARD_WIDTH
        root = await mkdtemp(path.join(tmpdir(), 'fylo-reshard-'))
    })

    afterEach(async () => {
        if (previousWidth === undefined) delete process.env.FYLO_SHARD_WIDTH
        else process.env.FYLO_SHARD_WIDTH = previousWidth
        await rm(root, { recursive: true, force: true })
    })

    async function seed(width, count) {
        process.env.FYLO_SHARD_WIDTH = String(width)
        const fylo = new Fylo(root, { versioning: { autoCommit: false } })
        await fylo[COLLECTION].create()
        const ids = []
        for (let index = 0; index < count; index++) {
            ids.push(String(await fylo[COLLECTION].put({ index })))
        }
        return { fylo, ids }
    }

    const docsRoot = () => path.join(root, '.collections', COLLECTION, 'docs')

    test('records the configured width and stores records under it', async () => {
        const { fylo, ids } = await seed(1, 20)
        const descriptor = JSON.parse(
            await readFile(path.join(root, '.fylo-catalog/collections/records.json'), 'utf8')
        )
        expect(descriptor.shardWidth).toBe(1)
        for (const shard of await readdir(docsRoot())) expect(shard).toHaveLength(1)
        expect((await fylo[COLLECTION].get(ids[3]).once())[ids[3]]).toEqual({ index: 3 })
        await fylo.close()
    })

    test('refuses a write when the configured width does not match the record', async () => {
        const { fylo } = await seed(2, 3)
        await fylo.close()

        process.env.FYLO_SHARD_WIDTH = '3'
        const reopened = new Fylo(root, { versioning: { autoCommit: false } })
        await expect(reopened[COLLECTION].put({ index: 99 })).rejects.toThrow(/FYLO_SHARD_WIDTH/)
        await reopened.close()
    })

    test('keeps reading a collection whose width the environment disagrees with', async () => {
        const { fylo, ids } = await seed(2, 5)
        await fylo.close()

        process.env.FYLO_SHARD_WIDTH = '4'
        const reopened = new Fylo(root, { versioning: { autoCommit: false } })
        expect((await reopened[COLLECTION].get(ids[1]).once())[ids[1]]).toEqual({ index: 1 })
        await reopened.close()
    })

    test('moves every record and is idempotent', async () => {
        const { fylo, ids } = await seed(2, 25)
        const first = await fylo[COLLECTION].reshard(3)
        expect(first.moved).toBe(25)
        for (const shard of await readdir(docsRoot())) expect(shard).toHaveLength(3)
        expect((await fylo[COLLECTION].get(ids[7]).once())[ids[7]]).toEqual({ index: 7 })

        const again = await fylo[COLLECTION].reshard(3)
        expect(again.moved).toBe(0)
        await fylo.close()
    })

    test('relocates tombstones alongside live records', async () => {
        const { fylo, ids } = await seed(2, 6)
        await fylo[COLLECTION].delete(ids[0])
        await fylo[COLLECTION].reshard(1)
        const deletedRoot = path.join(root, '.collections', COLLECTION, '.deleted')
        expect(await readdir(deletedRoot)).toEqual([shardOf(ids[0], 1)])
        expect(Number((await fylo[COLLECTION].inspect()).deletedDocs)).toBe(1)
        await fylo.close()
    })

    test('stays readable and resumes when a reshard is interrupted', async () => {
        const { fylo, ids } = await seed(2, 8)
        await fylo.close()

        // The descriptor names the destination and the width being left before
        // any record moves, which is exactly the state a crash leaves behind.
        const descriptorPath = path.join(root, '.fylo-catalog/collections/records.json')
        const descriptor = JSON.parse(await readFile(descriptorPath, 'utf8'))
        await writeFile(
            descriptorPath,
            JSON.stringify({ ...descriptor, shardWidth: 3, previousShardWidths: [2] })
        )

        process.env.FYLO_SHARD_WIDTH = '3'
        const reopened = new Fylo(root, { versioning: { autoCommit: false } })
        expect((await reopened[COLLECTION].get(ids[2]).once())[ids[2]]).toEqual({ index: 2 })

        const resumed = await reopened[COLLECTION].reshard(3)
        expect(resumed.moved).toBe(8)
        expect((await reopened[COLLECTION].get(ids[2]).once())[ids[2]]).toEqual({ index: 2 })
        const finished = JSON.parse(await readFile(descriptorPath, 'utf8'))
        expect(finished.previousShardWidths).toBeUndefined()
        await reopened.close()
    })

    test('rejects a width outside the supported range', async () => {
        const { fylo } = await seed(2, 1)
        await expect(fylo[COLLECTION].reshard(9)).rejects.toThrow(/Shard width/)
        await fylo.close()
    })
})
