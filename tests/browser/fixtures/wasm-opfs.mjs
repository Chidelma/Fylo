import {
    BrowserCore,
    createOpfsFilesystem,
    createWasmIndexScannerFactory
} from '../../../dist-web/fylo.mjs'

const output = document.querySelector('output')
const parameters = new URLSearchParams(location.search)
const namespace = parameters.get('namespace') ?? `fylo-wasm-${Date.now()}`
const fallback = parameters.get('fallback') === '1'
let qualificationStep = 'feature-detection'
let storageOperation = null

if (typeof navigator.storage?.getDirectory !== 'function') {
    finish({
        status: 'unsupported',
        supported: false,
        reason: 'Origin-private file system is unavailable in this browser'
    })
} else {
    try {
        qualificationStep = 'create-filesystem'
        const fs = createOpfsFilesystem({ namespace })
        traceStorageOperations(fs)
        qualificationStep = 'open-opfs-root'
        const opfsRoot = await navigator.storage.getDirectory()
        qualificationStep = 'open-opfs-namespace'
        await opfsRoot.getDirectoryHandle(namespace, { create: true })
        const wasmUrl = new URL(
            fallback ? '/dist-web/missing-fylo-index.wasm' : '/dist-web/fylo-index.wasm',
            location.href
        )
        const first = new BrowserCore({
            fs,
            root: '/',
            indexScannerFactory: createWasmIndexScannerFactory({ url: wasmUrl })
        })
        const initializationStartedAt = performance.now()
        qualificationStep = 'initialize-core'
        await first.ready()
        const initializationMs = performance.now() - initializationStartedAt
        qualificationStep = 'create-collection'
        await first.records.create()

        const ids = []
        qualificationStep = 'write-documents'
        for (let index = 0; index < 120; index++) {
            ids.push(
                await first.records.put({
                    name: `record-${String(index).padStart(3, '0')}`,
                    score: index,
                    group: index % 2 === 0 ? 'even' : 'odd',
                    tags: [index % 3 === 0 ? 'tri' : 'other']
                })
            )
        }
        qualificationStep = 'compact-index'
        await first.index.compact('records')

        qualificationStep = 'query-index'
        const exactIds = await candidateIds(first, 'name', { $eq: 'record-042' })
        assertEqual(exactIds, [ids[42]], 'exact query')
        const prefixIds = await candidateIds(first, 'name', { $like: 'record-01%' })
        assertEqual(prefixIds, ids.slice(10, 20), 'prefix query')
        const greaterIds = await candidateIds(first, 'score', { $gte: 115 })
        assertEqual(greaterIds, ids.slice(115), 'numeric range query')
        const lessIds = await candidateIds(first, 'score', { $lt: 5 })
        assertEqual(lessIds, ids.slice(0, 5).reverse(), 'reverse numeric range query')
        const evenIds = await candidateIds(first, 'group', { $eq: 'even' })
        const triIds = await candidateIds(first, 'tags', { $contains: 'tri' })
        const intersection = evenIds.filter((id) => triIds.includes(id))
        assertEqual(
            intersection,
            ids.filter((_, index) => index % 6 === 0),
            'intersection query'
        )

        await first.records.patch(ids[42], { name: 'record-moved' })
        assertEqual(await candidateIds(first, 'name', { $eq: 'record-042' }), [], 'WAL removal')
        assertEqual(
            await candidateIds(first, 'name', { $eq: 'record-moved' }),
            [ids[42]],
            'WAL addition'
        )
        const acceleration = first.index.accelerationStatus()
        qualificationStep = 'close-first-core'
        await first.close()

        qualificationStep = 'restart-core'
        const second = new BrowserCore({
            fs,
            root: '/',
            indexScannerFactory: createWasmIndexScannerFactory({ url: wasmUrl })
        })
        await second.ready()
        const restartIds = await candidateIds(second, 'name', { $eq: 'record-moved' })
        const restartAcceleration = second.index.accelerationStatus()
        qualificationStep = 'benchmark'
        const benchmark = fallback ? null : await benchmarkEndToEnd(second, fs)
        if (benchmark) {
            benchmark.kernel = await benchmarkPortableKernel(second, fs, wasmUrl, ids)
        }
        await second.close()

        finish({
            status: 'passed',
            supported: true,
            acceleration,
            initializationMs,
            restartAcceleration,
            benchmark,
            restartIds,
            expectedRestartIds: [ids[42]]
        })
    } catch (error) {
        const opfsUnavailable =
            qualificationStep === 'open-opfs-root' || qualificationStep === 'open-opfs-namespace'
        finish({
            status: opfsUnavailable ? 'unsupported' : 'failed',
            supported: !opfsUnavailable,
            step: qualificationStep,
            storageOperation,
            reason: opfsUnavailable
                ? 'The browser exposes OPFS but cannot open its origin-private storage root'
                : undefined,
            reasonCode: opfsUnavailable ? 'EOPFS_UNAVAILABLE' : undefined,
            error: {
                name: /** @type {{ name?: unknown }} */ (error)?.name ?? '',
                message: /** @type {{ message?: unknown }} */ (error)?.message ?? '',
                stack: /** @type {{ stack?: unknown }} */ (error)?.stack ?? '',
                value: String(error)
            }
        })
    }
}

function traceStorageOperations(fs) {
    for (const method of [
        'mkdir',
        'rmdir',
        'readBytes',
        'readText',
        'writeBytes',
        'writeText',
        'appendText',
        'remove',
        'move'
    ]) {
        const operation = fs[method].bind(fs)
        fs[method] = async (path, ...args) => {
            storageOperation = { method, path }
            return await operation(path, ...args)
        }
    }
}

async function candidateIds(core, field, operand) {
    return [...((await core.index.candidateDocIds('records', field, operand)) ?? [])]
}

async function benchmarkEndToEnd(wasmCore, fs) {
    const javascriptCore = new BrowserCore({ fs, root: '/' })
    await javascriptCore.ready()
    const query = { $ops: [{ score: { $gte: 115 } }], $onlyIds: true }
    const operand = { $gte: 115 }
    for (let index = 0; index < 2; index++) {
        await collectIds(wasmCore, query)
        await collectIds(javascriptCore, query)
        await candidateIds(wasmCore, 'score', operand)
        await candidateIds(javascriptCore, 'score', operand)
    }

    const wasmMs = []
    const javascriptMs = []
    const wasmIndexMs = []
    const javascriptIndexMs = []
    for (let index = 0; index < 6; index++) {
        const first = index % 2 === 0 ? wasmCore : javascriptCore
        const second = index % 2 === 0 ? javascriptCore : wasmCore
        const firstTimings = index % 2 === 0 ? wasmMs : javascriptMs
        const secondTimings = index % 2 === 0 ? javascriptMs : wasmMs
        const firstIndexTimings = index % 2 === 0 ? wasmIndexMs : javascriptIndexMs
        const secondIndexTimings = index % 2 === 0 ? javascriptIndexMs : wasmIndexMs
        firstTimings.push(await timeQuery(first, query))
        secondTimings.push(await timeQuery(second, query))
        firstIndexTimings.push(await timeIndexQuery(first, operand))
        secondIndexTimings.push(await timeIndexQuery(second, operand))
    }
    const wasmMedianMs = median(wasmMs)
    const javascriptMedianMs = median(javascriptMs)
    const wasmIndexMedianMs = median(wasmIndexMs)
    const javascriptIndexMedianMs = median(javascriptIndexMs)
    await javascriptCore.close()
    return {
        workload: {
            documents: 120,
            matchingDocuments: 5,
            warmup: 2,
            iterations: 6,
            query
        },
        wasmMedianMs,
        javascriptMedianMs,
        speedup: javascriptMedianMs / wasmMedianMs,
        index: {
            wasmMedianMs: wasmIndexMedianMs,
            javascriptMedianMs: javascriptIndexMedianMs,
            speedup: javascriptIndexMedianMs / wasmIndexMedianMs
        }
    }
}

async function benchmarkPortableKernel(core, fs, wasmUrl, documentIds) {
    const keys = []
    for (let index = 0; index < 500; index++) {
        const token = String(index).padStart(3, '0')
        keys.push(`bench/eq/value-${token}/${documentIds[index % documentIds.length]}`)
    }
    const encoded = new TextEncoder().encode(`${keys.join('\n')}\n`)
    const path = '/portable-benchmark.snapshot'
    await fs.writeBytes(path, encoded)
    const readStartedAt = performance.now()
    const snapshot = await fs.readBytes(path)
    const readMs = performance.now() - readStartedAt
    const factory = createWasmIndexScannerFactory({ url: wasmUrl })
    await factory.ready()
    const scanner = await factory.create()
    const loadStartedAt = performance.now()
    scanner.loadSnapshot(snapshot)
    const loadMs = performance.now() - loadStartedAt
    const query = { prefix: 'bench/eq/value-0' }

    for (let index = 0; index < 1; index++) {
        scanner.scanQueries([query])
        scanWithJavascript(core.index, snapshot, query)
    }
    const wasmMs = []
    const javascriptMs = []
    for (let index = 0; index < 3; index++) {
        if (index % 2 === 0) {
            wasmMs.push(time(() => scanner.scanQueries([query])))
            javascriptMs.push(time(() => scanWithJavascript(core.index, snapshot, query)))
        } else {
            javascriptMs.push(time(() => scanWithJavascript(core.index, snapshot, query)))
            wasmMs.push(time(() => scanner.scanQueries([query])))
        }
    }
    scanner.close()
    const wasmMedianMs = median(wasmMs)
    const javascriptMedianMs = median(javascriptMs)
    return {
        workload: {
            keys: 500,
            matchingKeys: 100,
            warmup: 1,
            iterations: 3,
            repetitionsPerSample: 100
        },
        snapshotBytes: snapshot.byteLength,
        readMs,
        loadMs,
        wasmMedianMs,
        javascriptMedianMs,
        speedup: javascriptMedianMs / wasmMedianMs
    }
}

function scanWithJavascript(index, snapshot, query) {
    const target = new Set()
    index.scanSnapshotWithJavaScript(snapshot, query.prefix, 'bench/eq/', undefined, target)
    if (target.size !== 100) {
        throw new Error(`JavaScript benchmark scan returned ${target.size} rows`)
    }
    return target
}

function time(operation) {
    const startedAt = performance.now()
    let result
    for (let index = 0; index < 100; index++) result = operation()
    if (result.length !== undefined && result.length !== 100) {
        throw new Error(`Wasm benchmark scan returned ${result.length} rows`)
    }
    return (performance.now() - startedAt) / 100
}

async function timeQuery(core, query) {
    const startedAt = performance.now()
    const ids = await collectIds(core, query)
    if (ids.length !== 5) throw new Error(`benchmark query returned ${ids.length} rows`)
    return performance.now() - startedAt
}

async function timeIndexQuery(core, operand) {
    const startedAt = performance.now()
    const ids = await candidateIds(core, 'score', operand)
    if (ids.length !== 5) throw new Error(`benchmark index query returned ${ids.length} rows`)
    return performance.now() - startedAt
}

async function collectIds(core, query) {
    const ids = []
    for await (const row of core.records.find(query).collect()) {
        ids.push(typeof row === 'string' ? row : Object.keys(row)[0])
    }
    return ids
}

function median(values) {
    const sorted = [...values].sort((left, right) => left - right)
    const middle = Math.floor(sorted.length / 2)
    return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

function assertEqual(actual, expected, name) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(
            `${name} mismatch: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
        )
    }
}

function finish(evidence) {
    globalThis.__FYLO_WASM_EVIDENCE__ = evidence
    output.dataset.status = evidence.status
    output.textContent = JSON.stringify(evidence)
}
