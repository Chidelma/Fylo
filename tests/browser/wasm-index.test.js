import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { BrowserCore } from '../../src/browser/core/engine.js'
import { createMemoryFilesystem } from '../../src/browser/core/memory-filesystem.js'
import { WasmIndexScanner } from '../../src/browser/wasm/index-scanner.js'

const DECODER = new TextDecoder()

class TestIndexScanner {
    constructor() {
        this.loads = 0
        this.snapshot = new Uint8Array(0)
    }

    loadSnapshot(snapshot) {
        this.loads++
        this.snapshot = snapshot.slice()
    }

    scanQueries(queries) {
        let candidates = null
        const keys = DECODER.decode(this.snapshot).split('\n').filter(Boolean)
        for (const query of queries) {
            const next = new Set()
            for (const key of keys) {
                if (!key.startsWith(query.prefix)) continue
                if (!includeRange(key, query.range)) continue
                next.add(key.slice(key.lastIndexOf('/') + 1))
            }
            candidates =
                candidates === null
                    ? next
                    : new Set([...candidates].filter((docId) => next.has(docId)))
        }
        return [...(candidates ?? [])]
    }
}

class TestIndexScannerFactory {
    constructor(error) {
        this.error = error
        this.scanners = []
    }

    async ready() {
        if (this.error) throw this.error
    }

    async create() {
        if (this.error) throw this.error
        const scanner = new TestIndexScanner()
        this.scanners.push(scanner)
        return scanner
    }
}

describe('browser Wasm index integration', () => {
    test('executes the versioned compiled Wasm module against the golden query fixture', async () => {
        const wasmUrl = new URL('../../dist-web/fylo-index.wasm', import.meta.url)
        if (!existsSync(wasmUrl)) {
            if (process.env.FYLO_REQUIRE_WASM === '1') {
                throw new Error('dist-web/fylo-index.wasm is required by this test run')
            }
            return
        }
        const fixture = await Bun.file(
            new URL('../fixtures/rust-query-v1.json', import.meta.url)
        ).json()
        const module = await WebAssembly.compile(readFileSync(wasmUrl))
        const instance = await WebAssembly.instantiate(module, {})
        const scanner = new WasmIndexScanner(instance)
        try {
            scanner.loadSnapshot(new TextEncoder().encode(fixture.snapshot))
            for (const testCase of fixture.cases) {
                expect(scanner.scanQueries(testCase.queries)).toEqual(testCase.expected)
            }
        } finally {
            scanner.close()
        }
    })

    test('rejects an incompatible Wasm ABI before copying memory', () => {
        const memory = new WebAssembly.Memory({ initial: 1 })
        expect(
            () =>
                new WasmIndexScanner(
                    /** @type {WebAssembly.Instance} */ ({
                        exports: {
                            memory,
                            abi_version: () => 2,
                            allocate() {},
                            deallocate() {},
                            load_snapshot() {},
                            scan_queries() {}
                        }
                    })
                )
        ).toThrow('Unsupported FYLO Wasm index ABI 2; expected 1')
    })

    test('rejects an invalid snapshot with a stable fallback reason', async () => {
        const wasmUrl = new URL('../../dist-web/fylo-index.wasm', import.meta.url)
        if (!existsSync(wasmUrl)) return
        const module = await WebAssembly.compile(readFileSync(wasmUrl))
        const scanner = new WasmIndexScanner(await WebAssembly.instantiate(module, {}))
        try {
            expect(() => scanner.loadSnapshot(new TextEncoder().encode('z/doc\na/doc\n'))).toThrow(
                '[EWASM_SNAPSHOT]'
            )
        } finally {
            scanner.close()
        }
    })

    test('propagates the worker build token to the default Wasm URL', async () => {
        const token = 'v=release-test'
        const module = await import(`../../src/browser/wasm/index-scanner.js?${token}`)
        const factory = new module.WasmIndexScannerFactory()

        expect(factory.url.href).toEndWith(`/fylo-index.wasm?${token}`)
    })

    test('reuses a warm snapshot, reconciles WAL changes, and reloads after compaction', async () => {
        const fs = createMemoryFilesystem()
        const factory = new TestIndexScannerFactory()
        const fylo = new BrowserCore({ fs, root: '/', indexScannerFactory: factory })
        await fylo.ready()
        await fylo.users.create()
        const low = await fylo.users.put({ name: 'Low', score: 10 })
        const high = await fylo.users.put({ name: 'High', score: 20 })
        await fylo.index.compact('users')

        expect(Object.keys(await collect(fylo, { $ops: [{ score: { $gte: 15 } }] }))).toEqual([
            high
        ])
        expect(factory.scanners).toHaveLength(1)
        expect(factory.scanners[0].loads).toBe(1)

        await fylo.users.patch(high, { score: 5 })
        await fylo.users.patch(low, { score: 30 })
        expect(Object.keys(await collect(fylo, { $ops: [{ score: { $gte: 15 } }] }))).toEqual([low])
        expect(factory.scanners[0].loads).toBe(1)

        await fylo.index.compact('users')
        expect(Object.keys(await collect(fylo, { $ops: [{ score: { $lt: 15 } }] }))).toEqual([high])
        expect(factory.scanners[0].loads).toBe(2)
        expect(fylo.index.accelerationStatus()).toMatchObject({ mode: 'wasm', state: 'active' })
    })

    test('loads a persisted snapshot again after a core restart', async () => {
        const fs = createMemoryFilesystem()
        const firstFactory = new TestIndexScannerFactory()
        const first = new BrowserCore({ fs, root: '/', indexScannerFactory: firstFactory })
        await first.users.create()
        const id = await first.users.put({ name: 'Restarted', score: 42 })
        await first.index.compact('users')
        await first.close()

        const secondFactory = new TestIndexScannerFactory()
        const second = new BrowserCore({ fs, root: '/', indexScannerFactory: secondFactory })
        await second.ready()
        expect(
            Object.keys(await collect(second, { $ops: [{ name: { $eq: 'Restarted' } }] }))
        ).toEqual([id])
        expect(secondFactory.scanners).toHaveLength(1)
        expect(secondFactory.scanners[0].loads).toBe(1)
    })

    test('falls back to the JavaScript scanner when Wasm initialization fails', async () => {
        const fs = createMemoryFilesystem()
        const factory = new TestIndexScannerFactory(new Error('Wasm unavailable'))
        const fylo = new BrowserCore({ fs, root: '/', indexScannerFactory: factory })
        await fylo.ready()
        await fylo.users.create()
        const id = await fylo.users.put({ name: 'Fallback', score: 7 })
        await fylo.index.compact('users')

        expect(Object.keys(await collect(fylo, { $ops: [{ name: { $eq: 'Fallback' } }] }))).toEqual(
            [id]
        )
        expect(fylo.index.accelerationStatus()).toEqual({
            mode: 'wasm',
            state: 'fallback',
            error: 'Wasm unavailable'
        })
    })
})

function includeRange(key, range) {
    if (!range) return true
    const value = key.split('/').at(-2) ?? ''
    if (range.op === '$gt') return value > range.value
    if (range.op === '$gte') return value >= range.value
    if (range.op === '$lt') return value > range.value
    if (range.op === '$lte') return value >= range.value
    return false
}

async function collect(fylo, query) {
    const docs = {}
    for await (const doc of fylo.users.find(query).collect()) Object.assign(docs, doc)
    return docs
}
