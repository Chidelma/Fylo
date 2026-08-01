import { lstat, mkdir, mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { arch, cpus, platform, release, tmpdir, totalmem } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { Fylo } from '../clients/node/fylo.mjs'

const options = parseArguments(process.argv.slice(2))
const workspace = await mkdtemp(join(tmpdir(), 'fylo-rust-soak-'))
const root = join(workspace, 'root')
const collection = 'records'
const primaryId = '4VRNF52JPK1'
const secondaryId = '4VRNF52JPK2'
const deletedId = '4VRNF52JPK3'
const binary = resolve(
    process.env.FYLO_RUST_BINARY ??
        join('target', 'release', platform() === 'win32' ? 'fylo-rust.exe' : 'fylo-rust')
)
const startedAt = new Date()
const deadline = options.durationMs === null ? null : Date.now() + options.durationMs
const metrics = {
    iterations: 0,
    machineOperations: 0,
    assertions: 0,
    restarts: 0,
    peakRssBytes: 0,
    latency: createHistogram()
}
let interruptedSignal = null
let client = null
let initialBytes = null
let failure = null
let finalReport = null

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
        interruptedSignal ??= signal
    })
}

try {
    await buildBinary()
    await seedRoot()
    initialBytes = await directoryBytes(root)
    client = await openClient()

    while (shouldContinue()) {
        const sequence = metrics.iterations + 1
        await runIteration(sequence)
        metrics.iterations = sequence

        if (sequence % options.restartEvery === 0) {
            await sampleResources()
            await closeClient()
            client = await openClient()
            metrics.restarts++
        }
        if (sequence % options.checkpointEvery === 0) {
            await sampleResources()
            await writeReport(false)
        }
    }
    if (interruptedSignal) throw new Error(`soak interrupted by ${interruptedSignal}`)
} catch (error) {
    failure = error
} finally {
    await sampleResources()
    await closeClient()
    finalReport = await writeReport(failure === null)
    if (failure === null || !options.keepRootsOnFailure) {
        await rm(workspace, { recursive: true, force: true })
    }
}

if (failure) throw failure
if (finalReport.status !== 'passed') {
    throw new Error(`soak gates failed: ${JSON.stringify(finalReport.gates)}`)
}
console.log(
    `Completed ${metrics.iterations} Rust soak iterations ` +
        `(${metrics.machineOperations} machine operations, ${metrics.assertions} assertions); ` +
        `report: ${options.output}`
)

function shouldContinue() {
    if (interruptedSignal) return false
    if (options.iterations !== null) return metrics.iterations < options.iterations
    return Date.now() < deadline
}

async function runIteration(sequence) {
    await operation({
        op: 'patchDoc',
        collection,
        id: primaryId,
        newDoc: { sequence, parity: sequence % 2 === 0 }
    })
    const metadata = await operation({
        op: 'setMeta',
        collection,
        id: primaryId,
        meta: { checkpoint: String(sequence), worker: 'rust-soak' }
    })
    check(metadata.id === primaryId, 'setMeta dropped canonical id')
    check(metadata.checkpoint === String(sequence), 'setMeta lost the current checkpoint')

    const active = sequence % 2 === 0
    const updated = await operation({
        op: 'executeSQL',
        sql: `UPDATE ${collection} SET active = ${active ? 'true' : 'false'} WHERE name = 'Grace'`
    })
    check(updated === 1, 'SQL update affected an unexpected row count')

    const primary = await operation({ op: 'getDoc', collection, id: primaryId })
    check(primary[primaryId]?.sequence === sequence, 'getDoc returned a stale sequence')
    check(primary[primaryId]?.parity === active, 'getDoc returned stale parity')

    const found = await operation({
        op: 'findDocs',
        collection,
        query: { $ops: [{ sequence: { $eq: sequence } }] }
    })
    check(Object.keys(found).length === 1, 'findDocs returned an unexpected row count')
    check(found[primaryId]?.sequence === sequence, 'findDocs lost the primary row')

    const grace = await operation({ op: 'getDoc', collection, id: secondaryId })
    check(grace[secondaryId]?.active === active, 'SQL mutation was not durable')

    const inspection = await operation({ op: 'inspectCollection', collection })
    check(Number(inspection.docsStored) === 3, 'collection live-document count drifted')

    if (sequence % options.deleteEvery === 0) {
        const deleted = await operation({ op: 'delDoc', collection, id: deletedId })
        check(deleted.deleted === true, 'delete did not report a tombstone')
        const tombstones = await operation({
            op: 'findDeletedDocs',
            collection,
            query: { $ops: [{ name: { $eq: 'Linus' } }] }
        })
        check(tombstones[deletedId]?.name === 'Linus', 'deleted query lost the tombstone')
        const restored = await operation({ op: 'restoreDoc', collection, id: deletedId })
        check(restored.restored === true, 'restore did not report success')
        const live = await operation({ op: 'getDoc', collection, id: deletedId })
        check(live[deletedId]?.name === 'Linus', 'restored document was not readable')
    }
}

async function operation(request) {
    const started = performance.now()
    const response = await client.request({
        ...request,
        requestId: `soak-${metrics.machineOperations}`
    })
    observeHistogram(metrics.latency, performance.now() - started)
    metrics.machineOperations++
    if (!response.ok) {
        throw new Error(
            `${request.op} failed (${response.error?.code}): ${response.error?.message}`
        )
    }
    return response.result
}

function check(value, message) {
    metrics.assertions++
    if (!value) throw new Error(message)
}

async function buildBinary() {
    if (process.env.FYLO_SKIP_RUST_BUILD === '1') return
    await command([
        process.execPath,
        './scripts/run-rust.mjs',
        'cargo',
        'build',
        '--release',
        '--locked',
        '-p',
        'fylo-cli',
        '--bin',
        'fylo-rust'
    ])
}

async function seedRoot() {
    await mkdir(root, { recursive: true })
    const database = await openClient()
    try {
        await required(database, { op: 'createCollection', collection, kind: 'document' })
        await required(database, {
            op: 'putData',
            collection,
            id: primaryId,
            data: { name: 'Ada', active: true, sequence: 0, parity: true }
        })
        await required(database, {
            op: 'putData',
            collection,
            id: secondaryId,
            data: { name: 'Grace', active: true }
        })
        await required(database, {
            op: 'putData',
            collection,
            id: deletedId,
            data: { name: 'Linus', active: true }
        })
    } finally {
        await database.close()
    }
}

async function required(database, request) {
    const response = await database.request(request)
    if (!response.ok) {
        throw new Error(
            `seed ${request.op} failed (${response.error?.code}): ${response.error?.message}`
        )
    }
    return response.result
}

async function openClient() {
    const opened = new Fylo(root, { binary, exclusiveRoot: true })
    await opened.ready
    return opened
}

async function closeClient() {
    if (!client) return
    const closing = client
    client = null
    await closing.close()
}

async function sampleResources() {
    if (!client) return
    metrics.peakRssBytes = Math.max(metrics.peakRssBytes, await processRssBytes(client._proc.pid))
}

async function writeReport(completed) {
    const endedAt = new Date()
    const finalBytes = await directoryBytesIfExists(root)
    const baseline = initialBytes ?? 0
    const durationMs = endedAt.getTime() - startedAt.getTime()
    const gates = {
        durationSatisfied: options.profile !== 'release' || durationMs >= 72 * 60 * 60 * 1000,
        operationMinimumSatisfied:
            options.profile !== 'release' || metrics.machineOperations >= 100_000,
        modelAssertionsExecuted: metrics.assertions > 0,
        rustPeakRssWithinLimit:
            metrics.peakRssBytes > 0 && metrics.peakRssBytes <= 512 * 1024 * 1024,
        diskGrowthWithinLimit: finalBytes - baseline <= 1024 * 1024 * 1024
    }
    const report = {
        format: 'fylo.rust-soak.v1',
        profile: options.profile,
        status: completed && Object.values(gates).every(Boolean) ? 'passed' : 'incomplete',
        startedAt: startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
        durationMs,
        binary,
        environment: {
            os: platform(),
            release: release(),
            architecture: arch(),
            cpu: cpus()[0]?.model ?? 'unknown',
            logicalCpus: cpus().length,
            totalMemoryBytes: totalmem(),
            bun: Bun.version
        },
        workload: {
            iterations: metrics.iterations,
            machineOperations: metrics.machineOperations,
            modelAssertions: metrics.assertions,
            deleteEvery: options.deleteEvery,
            restartEvery: options.restartEvery
        },
        metrics: {
            processRestarts: metrics.restarts,
            peakRssBytes: metrics.peakRssBytes,
            operationLatencyMs: summarizeHistogram(metrics.latency),
            rootBytes: { initial: baseline, final: finalBytes, growth: finalBytes - baseline }
        },
        thresholds: {
            minimumReleaseDurationMs: 72 * 60 * 60 * 1000,
            minimumReleaseOperations: 100_000,
            maximumRustPeakRssBytes: 512 * 1024 * 1024,
            maximumRootGrowthBytes: 1024 * 1024 * 1024
        },
        gates,
        interruption: interruptedSignal,
        error: failure instanceof Error ? failure.message : failure ? String(failure) : null,
        rootsRetainedOnFailure: Boolean(failure && options.keepRootsOnFailure),
        retainedWorkspace: failure && options.keepRootsOnFailure ? workspace : null
    }
    await mkdir(dirname(options.output), { recursive: true })
    const temporary = `${options.output}.tmp`
    await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`)
    await rename(temporary, options.output)
    return report
}

function createHistogram() {
    return {
        boundaries: [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 5000],
        buckets: Array(12).fill(0),
        count: 0,
        total: 0,
        max: 0
    }
}

function observeHistogram(histogram, value) {
    const index = histogram.boundaries.findIndex((boundary) => value <= boundary)
    histogram.buckets[index === -1 ? histogram.buckets.length - 1 : index]++
    histogram.count++
    histogram.total += value
    histogram.max = Math.max(histogram.max, value)
}

function summarizeHistogram(histogram) {
    return {
        count: histogram.count,
        mean: histogram.count === 0 ? null : histogram.total / histogram.count,
        max: histogram.max,
        boundaries: histogram.boundaries,
        buckets: histogram.buckets
    }
}

async function directoryBytes(directory) {
    let total = 0
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name)
        const metadata = await lstat(path)
        if (entry.isDirectory()) total += await directoryBytes(path)
        else if (entry.isFile()) total += metadata.size
    }
    return total
}

async function directoryBytesIfExists(directory) {
    try {
        return await directoryBytes(directory)
    } catch (error) {
        if (error?.code === 'ENOENT') return 0
        throw error
    }
}

async function processRssBytes(pid) {
    const arguments_ =
        platform() === 'win32'
            ? [
                  'powershell.exe',
                  '-NoProfile',
                  '-NonInteractive',
                  '-Command',
                  `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).WorkingSet64`
              ]
            : ['ps', '-o', 'rss=', '-p', String(pid)]
    const child = Bun.spawn(arguments_, { stdout: 'pipe', stderr: 'ignore' })
    const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited])
    if (exitCode !== 0) return 0
    const value = Number(stdout.trim())
    if (!Number.isFinite(value) || value <= 0) return 0
    return platform() === 'win32' ? Math.round(value) : Math.round(value * 1024)
}

async function command(arguments_) {
    const child = Bun.spawn(arguments_, {
        cwd: process.cwd(),
        env: process.env,
        stdout: 'inherit',
        stderr: 'inherit'
    })
    const exitCode = await child.exited
    if (exitCode !== 0) throw new Error(`command failed (${exitCode}): ${arguments_.join(' ')}`)
}

function parseArguments(arguments_) {
    const profile = option(arguments_, '--profile') ?? 'smoke'
    if (!['smoke', 'release'].includes(profile))
        throw new Error('--profile must be smoke or release')
    const iterationsValue = option(arguments_, '--iterations')
    const durationValue = option(arguments_, '--duration-hours')
    if ((iterationsValue === undefined) === (durationValue === undefined)) {
        throw new Error('provide exactly one of --iterations or --duration-hours')
    }
    const iterations =
        iterationsValue === undefined
            ? null
            : boundedNumber(iterationsValue, '--iterations', 1, 1_000_000_000, true)
    const durationHours =
        durationValue === undefined
            ? null
            : boundedNumber(durationValue, '--duration-hours', 0.001, 168, false)
    if (profile === 'release' && (durationHours === null || durationHours < 72)) {
        throw new Error('the release soak profile requires --duration-hours of at least 72')
    }
    return {
        profile,
        iterations,
        durationMs: durationHours === null ? null : durationHours * 60 * 60 * 1000,
        output: option(arguments_, '--output') ?? 'target/soak/rust-soak.json',
        checkpointEvery: boundedOption(arguments_, '--checkpoint-every', 100, 1, 1_000_000),
        restartEvery: boundedOption(arguments_, '--restart-every', 1000, 1, 1_000_000),
        deleteEvery: boundedOption(arguments_, '--delete-every', 10, 1, 1_000_000),
        keepRootsOnFailure: !arguments_.includes('--discard-roots-on-failure')
    }
}

function boundedOption(arguments_, name, fallback, minimum, maximum) {
    const value = option(arguments_, name)
    return value === undefined ? fallback : boundedNumber(value, name, minimum, maximum, true)
}

function boundedNumber(encoded, name, minimum, maximum, integer) {
    const value = Number(encoded)
    if (!Number.isFinite(value) || (integer && !Number.isSafeInteger(value))) {
        throw new Error(`${name} must be ${integer ? 'an integer' : 'a number'}`)
    }
    if (value < minimum || value > maximum) {
        throw new Error(`${name} must be between ${minimum} and ${maximum}`)
    }
    return value
}

function option(arguments_, name) {
    const index = arguments_.indexOf(name)
    if (index === -1) return undefined
    const value = arguments_[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${name}`)
    return value
}
