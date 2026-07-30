import { afterAll, describe, expect, test } from 'bun:test'
import { shardOf } from '../../src/core/doc-id.js'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import Fylo, { FyloSyncError } from '../../src/index.js'
import { createTestRoot } from '../helpers/root.js'

const roots = []

async function createRoot(prefix) {
    const root = await createTestRoot(prefix)
    roots.push(root)
    return root
}

afterAll(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

describe('sync hooks', () => {
    test('await-sync emits write, patch, and delete events with filesystem paths', async () => {
        const root = await createRoot('fylo-sync-await-')
        const calls = []
        const fylo = new Fylo(root, {
            sync: {
                onWrite: async (event) => {
                    calls.push({ hook: 'write', ...event })
                },
                onDelete: async (event) => {
                    calls.push({ hook: 'delete', ...event })
                }
            }
        })

        const collection = 'sync-posts'
        await fylo[collection].create()

        const id = await fylo[collection].put({ title: 'Hello sync' })
        const nextId = await fylo[collection].patch(id, { title: 'Hello sync 2' })
        await fylo[collection].delete(nextId)
        await fylo[collection].restore(id)
        const deletedPath = path.join(
            root,
            '.collections',
            collection,
            '.deleted',
            shardOf(id),
            `${id}.json`
        )

        expect(calls).toEqual([
            {
                hook: 'write',
                operation: 'put',
                collection,
                docId: id,
                path: path.join(
                    root,
                    '.collections',
                    collection,
                    'docs',
                    shardOf(id),
                    `${id}.json`
                ),
                data: { title: 'Hello sync' }
            },
            {
                hook: 'write',
                operation: 'patch',
                collection,
                docId: id,
                path: path.join(
                    root,
                    '.collections',
                    collection,
                    'docs',
                    shardOf(id),
                    `${id}.json`
                ),
                data: { title: 'Hello sync 2' }
            },
            {
                hook: 'delete',
                operation: 'delete',
                collection,
                docId: id,
                path: deletedPath,
                previousPath: path.join(
                    root,
                    '.collections',
                    collection,
                    'docs',
                    shardOf(id),
                    `${id}.json`
                )
            },
            {
                hook: 'write',
                operation: 'restore',
                collection,
                docId: id,
                path: path.join(
                    root,
                    '.collections',
                    collection,
                    'docs',
                    shardOf(id),
                    `${id}.json`
                ),
                data: { title: 'Hello sync 2' }
            }
        ])
    })

    test('strict WORM sync writes once and rejects mutation callbacks', async () => {
        const root = await createRoot('fylo-sync-worm-')
        const calls = []
        const fylo = new Fylo(root, {
            worm: {
                mode: 'strict'
            },
            sync: {
                onWrite: async (event) => {
                    calls.push({ hook: 'write', ...event })
                },
                onDelete: async (event) => {
                    calls.push({ hook: 'delete', ...event })
                }
            }
        })

        const collection = 'worm-sync-posts'
        await fylo[collection].create()

        const id = await fylo[collection].put({ title: 'Hello worm sync' })
        await expect(fylo[collection].patch(id, { title: 'changed' })).rejects.toThrow(
            'Update is not allowed in WORM mode'
        )
        await expect(fylo[collection].delete(id)).rejects.toThrow(
            'Delete is not allowed in WORM mode'
        )

        expect(calls).toEqual([
            {
                hook: 'write',
                operation: 'put',
                collection,
                docId: id,
                path: path.join(
                    root,
                    '.collections',
                    collection,
                    'docs',
                    shardOf(id),
                    `${id}.json`
                ),
                data: { title: 'Hello worm sync' }
            }
        ])
    })

    test('fire-and-forget does not block the local write', async () => {
        const root = await createRoot('fylo-sync-fire-')
        let releaseHook
        let writeStarted = false
        const started = Promise.withResolvers()
        const hookBlocker = new Promise((resolve) => {
            releaseHook = resolve
        })

        const fylo = new Fylo(root, {
            syncMode: 'fire-and-forget',
            // Isolate the sync behavior: auto-commit (on by default) awaits its
            // own version-control work on every write, which is unrelated to
            // whether the fire-and-forget sync hook blocks the local write.
            versioning: { autoCommit: false },
            sync: {
                onWrite: async () => {
                    writeStarted = true
                    started.resolve()
                    await hookBlocker
                }
            }
        })

        await fylo['fire-posts'].create()

        const putPromise = fylo['fire-posts'].put({ title: 'Fast local write' })
        await started.promise

        // The hook blocks forever (hookBlocker is released after this race), so a
        // blocking sync would never let the put resolve. A generous bound keeps
        // the assertion deterministic across fast and slow CI disks.
        const state = await Promise.race([
            putPromise.then(() => 'resolved'),
            Bun.sleep(500).then(() => 'pending')
        ])

        expect(writeStarted).toBe(true)
        expect(state).toBe('resolved')

        releaseHook()
        await putPromise
    })

    test('await-sync surfaces sync failures as FyloSyncError after the local write', async () => {
        const root = await createRoot('fylo-sync-error-')
        let failedDocId
        const fylo = new Fylo(root, {
            sync: {
                onWrite: async (event) => {
                    failedDocId = event.docId
                    throw new Error('remote unavailable')
                }
            }
        })

        await fylo['error-posts'].create()

        await expect(
            fylo['error-posts'].put({ title: 'Still written locally' })
        ).rejects.toBeInstanceOf(FyloSyncError)

        expect(failedDocId).toBeDefined()
        const stored = await fylo['error-posts'].get(failedDocId).once()
        expect(stored[failedDocId]).toEqual({ title: 'Still written locally' })
    })

    test('atomic SQL rollback never publishes partial sync side effects', async () => {
        const root = await createRoot('fylo-sync-atomic-')
        const calls = []
        const fylo = new Fylo(root, {
            versioning: { autoCommit: false },
            sync: {
                onWrite: async (event) => calls.push(event)
            }
        })
        const collection = 'atomic-sync-posts'
        await fylo[collection].create()
        await fylo[collection].put({ state: 'before', ordinal: 1 })
        await fylo[collection].put({ state: 'before', ordinal: 2 })
        calls.length = 0

        const updateDocument = fylo.engine.updateDocument.bind(fylo.engine)
        let attempts = 0
        fylo.engine.updateDocument = async (...args) => {
            attempts++
            if (attempts === 2) throw new Error('injected update failure')
            return await updateDocument(...args)
        }

        await expect(
            fylo._sql(`UPDATE ${collection} SET state = 'after' WHERE state = 'before'`)
        ).rejects.toThrow('injected update failure')
        expect(calls).toHaveLength(0)
    })
})
