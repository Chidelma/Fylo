import { describe, expect, test } from 'bun:test'
import { shardOf } from '../../src/core/shard.js'
import path from 'node:path'
import TTID from '../../src/browser/vendor/ttid.mjs'
import fylo, {
    CollectionNotFoundError,
    createBrowserClient,
    createBrowserFylo
} from '../../src/browser/index.js'
import { createMemoryFilesystem } from '../../src/browser/core/memory-filesystem.js'
import { runBrowserRequest } from '../../src/browser/core/protocol.js'
import { relativeBridgePath } from '../../src/browser/opfs-bridge.mjs'
import { runBrowserConformance } from './helpers/conformance.js'

describe('browser runtime', () => {
    test('browser engine host paths stay inside the granted root', () => {
        expect(relativeBridgePath('/fylo/root/docs/record.json', '/fylo/root')).toBe(
            'docs/record.json'
        )
        expect(relativeBridgePath('/fylo/root', '/fylo/root')).toBe('')
        expect(relativeBridgePath('/fylo/.root.fylo-root-owner.lock.json', '/fylo/root')).toBe(
            '.root.fylo-root-owner.lock.json'
        )
        expect(() => relativeBridgePath('/fylo/root-other/record.json', '/fylo/root')).toThrow(
            'escapes the granted root'
        )
        expect(() => relativeBridgePath('/fylo/root/../other', '/fylo/root')).toThrow(
            'traversal component'
        )
    })

    test('reference browser runtime satisfies the browser conformance contract', async () => {
        const result = await runBrowserConformance(() => createBrowserFylo({ worker: false }))
        expect(result.userId).toBeString()
        expect(result.orderId).toBeString()
    })

    test('browser export bundles for browser target without Bun or Node builtins', async () => {
        const result = await Bun.build({
            entrypoints: [path.resolve('src/browser/index.js')],
            target: 'browser',
            format: 'esm'
        })
        expect(result.success).toBe(true)
        const combined = (await Promise.all(result.outputs.map((output) => output.text()))).join(
            '\n'
        )
        expect(combined).not.toContain('Bun.')
        expect(combined).not.toContain('node:')
        expect(combined).not.toContain('node:fs')
        expect(combined).not.toContain('node:path')
        expect(combined).not.toContain('process.env')
        expect(combined).not.toContain('Cipher.configure')
    })

    test('strict WORM mode remains write-once in the browser runtime', async () => {
        const fylo = createBrowserFylo({ worker: false, worm: { mode: 'strict' } })
        await fylo['worm-docs'].create()
        const id = await fylo['worm-docs'].put({ title: 'Immutable' })

        await expect(fylo['worm-docs'].patch(id, { title: 'Changed' })).rejects.toThrow(
            'Update is not allowed in WORM mode'
        )
        await expect(fylo['worm-docs'].delete(id)).rejects.toThrow(
            'Delete is not allowed in WORM mode'
        )
        expect((await fylo['worm-docs'].latest(id))[id].title).toBe('Immutable')
    })

    test('browser facade can use an injected per-document filesystem', async () => {
        const fs = createMemoryFilesystem()
        const fylo = createBrowserFylo({ worker: false, fs })
        await fylo.users.create()
        const id = await fylo.users.put({ name: 'Lin' })

        expect(await fs.exists(`/.collections/users/docs/${shardOf(id)}/${id}.json`)).toBe(true)
        expect(await fs.exists('/.collections/users/collection.json')).toBe(false)
    })

    test('File System Access storage requires a directory handle', () => {
        expect(() =>
            createBrowserFylo({
                worker: false,
                storage: /** @type {any} */ ({ type: 'fsa', handle: { kind: 'file' } })
            })
        ).toThrow('requires a directory handle')
    })

    test('browser SQL supports non-executing EXPLAIN plans', async () => {
        const local = createBrowserFylo({ worker: false })
        await local.people.create()
        await local.people.put({ name: 'Ada' })

        const plan = await local._sql("EXPLAIN SELECT * FROM people WHERE name = 'Ada'")
        expect(plan).toMatchObject({
            operation: 'SELECT',
            collection: 'people',
            executed: false
        })
        expect(plan.access.some((step) => step.kind === 'prefix-index')).toBe(true)
    })

    test('browser collection facades fail closed when the collection does not exist', async () => {
        const fylo = createBrowserFylo({ worker: false })
        const missing = `missing${Date.now()}`
        const id = TTID.generate()

        expect((await fylo[missing].inspect()).exists).toBe(false)
        await expect(fylo[missing].put({ name: 'No collection' })).rejects.toBeInstanceOf(
            CollectionNotFoundError
        )
        await expect(fylo[missing].get(id).once()).rejects.toBeInstanceOf(CollectionNotFoundError)
        await expect(Array.fromAsync(fylo[missing].find({}).collect())).rejects.toBeInstanceOf(
            CollectionNotFoundError
        )
        await expect(fylo[missing].delete(id)).rejects.toBeInstanceOf(CollectionNotFoundError)
        await fylo[missing].create()
        expect((await fylo[missing].inspect()).exists).toBe(true)
    })

    test('worker protocol rejects present non-object initial metadata atomically', async () => {
        const local = createBrowserFylo({ worker: false })
        await local.people.create()
        const id = TTID.generate()
        const response = await runBrowserRequest(local.core, {
            op: 'putData',
            collection: 'people',
            data: { [id]: { name: 'Must not persist' } },
            meta: /** @type {any} */ ([])
        })

        expect(response.ok).toBe(false)
        expect(response.error?.message).toContain('field "meta" must be an object')
        expect(await local.people.get(id).once()).toEqual({})

        const undefinedId = TTID.generate()
        const undefinedResponse = await runBrowserRequest(local.core, {
            op: 'putData',
            collection: 'people',
            data: { [undefinedId]: { name: 'Must not persist either' } },
            meta: /** @type {any} */ (undefined)
        })
        expect(undefinedResponse.ok).toBe(false)
        expect(await local.people.get(undefinedId).once()).toEqual({})
    })

    test('direct browser runtime exposes collection subscriptions', async () => {
        const fylo = createBrowserFylo({ worker: false })
        await fylo.users.create()
        const events = []
        const unsubscribe = fylo.users.subscribe((event) => events.push(event))

        const id = await fylo.users.put({ name: 'Sub' })
        unsubscribe()

        expect(events).toHaveLength(1)
        expect(events[0]).toMatchObject({ action: 'insert', id })
    })

    test('top-level browser default exposes direct collection facades', async () => {
        const collection = `users${Date.now()}`
        await fylo.collection(collection).create()
        const id = await fylo[collection].put({ name: 'Default browser import' })

        const found = await fylo[collection].get(id).once()
        expect(found[id].name).toBe('Default browser import')
    })

    test('top-level browser factory defaults to memory when OPFS is unavailable', async () => {
        const local = createBrowserClient({ worker: false })
        await local.users.create()
        const id = await local.users.put({ name: 'Memory fallback' })

        expect(local.options.storage).toBe('memory')
        expect((await local.users.latest(id))[id].name).toBe('Memory fallback')
    })
})
