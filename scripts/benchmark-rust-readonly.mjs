import { mkdir, mkdtemp, rm, statfs, writeFile } from 'node:fs/promises'
import { arch, cpus, platform, release, tmpdir, totalmem } from 'node:os'
import { dirname, join } from 'node:path'

import Fylo from '../src/index.js'
import { hashRoot } from './rust-golden-root-lib.mjs'

const parameters = parseArguments(process.argv.slice(2))
const workspace = await mkdtemp(join(tmpdir(), 'fylo-readonly-benchmark-'))
const root = join(workspace, 'root')
const collection = 'documents'
const query = { $ops: [{ group: { $eq: 7 } }] }
const thresholds = {
    maximumRustPeakRssBytes: 512 * 1024 * 1024,
    maximumP95RustToCurrentRatio: 10
}

try {
    await mkdir(root, { recursive: true })
    console.error(`Seeding ${parameters.documents} deterministic documents...`)
    const writer = new Fylo(root, { versioning: { autoCommit: false } })
    await writer[collection].create()
    const targetId = await writer[collection].put(documentAt(0))
    if (parameters.documents > 1) {
        const remaining = Array.from({ length: parameters.documents - 1 }, (_, index) =>
            documentAt(index + 1)
        )
        await writer[collection].put.batch(remaining)
    }
    await writer[collection].rebuild()
    await writer.close()

    const before = await hashRoot(root)
    const filesystem = await statfs(root)
    console.error('Benchmarking the current JavaScript engine...')
    const currentEngine = await benchmarkJavaScript(root, collection, targetId, query, parameters)

    console.error('Building the native read-only benchmark in release mode...')
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
        'fylo-readonly-bench'
    ])
    console.error('Benchmarking the native Rust read-only engine...')
    const executable = join(
        process.cwd(),
        'target',
        'release',
        platform() === 'win32' ? 'fylo-readonly-bench.exe' : 'fylo-readonly-bench'
    )
    const rustResult = await jsonCommand([
        executable,
        '--root',
        root,
        '--collection',
        collection,
        '--id',
        String(targetId),
        '--query',
        JSON.stringify(query),
        '--iterations',
        String(parameters.iterations),
        '--warmup',
        String(parameters.warmup)
    ])
    const rustEngine = rustResult.output
    rustEngine.process.observedPeakRssBytes = rustResult.observedPeakRssBytes
    rustEngine.process.peakRssBytes = Math.max(
        rustEngine.process.peakRssBytes ?? 0,
        rustResult.observedPeakRssBytes
    )
    const after = await hashRoot(root)
    if (after.digest !== before.digest) {
        throw new Error(
            `benchmark mutated the compatibility root: ${before.digest} -> ${after.digest}`
        )
    }
    const matchingDocuments = Math.floor((parameters.documents + 2) / 10)
    validateResults(currentEngine, rustEngine, parameters.documents, matchingDocuments)

    const operationComparison = comparison(currentEngine.operations, rustEngine.operations)
    const gates = evaluateGates(operationComparison, rustEngine.process.peakRssBytes)
    const report = {
        format: 'fylo.read-only-benchmark.v2',
        generatedAt: new Date().toISOString(),
        environment: {
            os: platform(),
            release: release(),
            architecture: arch(),
            cpu: cpus()[0]?.model ?? 'unknown',
            logicalCpus: cpus().length,
            totalMemoryBytes: totalmem(),
            filesystemType: String(filesystem.type),
            bun: Bun.version
        },
        dataset: {
            collection,
            documents: parameters.documents,
            matchingDocuments,
            rootDigestAlgorithm: before.algorithm,
            rootDigest: before.digest,
            rootEntries: before.entries.length,
            rootBytes: before.entries.reduce((total, entry) => total + entry.size, 0)
        },
        parameters: {
            iterations: parameters.iterations,
            warmup: parameters.warmup,
            unit: 'nanoseconds'
        },
        noMutationVerified: true,
        currentEngine,
        rustEngine,
        comparison: operationComparison,
        thresholds,
        gates
    }
    await mkdir(dirname(parameters.output), { recursive: true })
    await writeFile(parameters.output, `${JSON.stringify(report, null, 2)}\n`)
    console.log(
        JSON.stringify({ output: parameters.output, comparison: report.comparison }, null, 2)
    )
    if (!gates.passed) {
        throw new Error(`read-only benchmark gates failed: ${gates.failures.join('; ')}`)
    }
} finally {
    await rm(workspace, { recursive: true, force: true })
}

function documentAt(index) {
    return {
        title: `document-${String(index).padStart(6, '0')}`,
        group: index % 10,
        tags: [`tag-${index % 5}`, `batch-${Math.floor(index / 100)}`],
        nested: { score: index, active: index % 2 === 0 }
    }
}

async function benchmarkJavaScript(root, collection, targetId, query, parameters) {
    const startedRssBytes = process.memoryUsage().rss
    const database = new Fylo(root, { versioning: { autoCommit: false } })
    try {
        const get = await measure(parameters, async () => {
            const result = await database[collection].get(targetId).once()
            return Object.keys(result).length
        })
        const find = await measure(parameters, async () => {
            let count = 0
            for await (const result of database[collection].find(query).collect()) {
                count += Object.keys(result).length
            }
            return count
        })
        const inspect = await measure(parameters, async () => {
            const report = await database[collection].inspect()
            return Number(report.docsStored)
        })
        return {
            format: 'fylo.read-only-benchmark.engine.v1',
            engine: 'javascript-current',
            unit: 'nanoseconds',
            operations: { get, find, inspect },
            process: {
                startedRssBytes,
                currentRssBytes: process.memoryUsage().rss
            }
        }
    } finally {
        await database.close()
    }
}

async function measure(parameters, operation) {
    for (let index = 0; index < parameters.warmup; index++) await operation()
    const samples = []
    let lastResult = 0
    for (let index = 0; index < parameters.iterations; index++) {
        const started = performance.now()
        lastResult = await operation()
        samples.push(Math.max(0, Math.round((performance.now() - started) * 1_000_000)))
    }
    samples.sort((left, right) => left - right)
    const total = samples.reduce((sum, sample) => sum + sample, 0)
    return {
        iterations: parameters.iterations,
        min: samples[0],
        mean: Math.round(total / samples.length),
        p50: percentile(samples, 50),
        p95: percentile(samples, 95),
        p99: percentile(samples, 99),
        max: samples.at(-1),
        lastResult
    }
}

function percentile(samples, value) {
    const rank = Math.max(0, Math.ceil((samples.length * value) / 100) - 1)
    return samples[Math.min(samples.length - 1, rank)]
}

function comparison(current, rust) {
    const output = {}
    for (const operation of ['get', 'find', 'inspect']) {
        output[operation] = {
            p50RustToCurrentRatio: ratio(rust[operation].p50, current[operation].p50),
            p95RustToCurrentRatio: ratio(rust[operation].p95, current[operation].p95)
        }
    }
    return output
}

function evaluateGates(operationComparison, peakRssBytes) {
    const failures = []
    if (!Number.isSafeInteger(peakRssBytes) || peakRssBytes <= 0) {
        failures.push('cross-platform Rust peak RSS was not observed')
    } else if (peakRssBytes > thresholds.maximumRustPeakRssBytes) {
        failures.push(`Rust peak RSS ${peakRssBytes} exceeds ${thresholds.maximumRustPeakRssBytes}`)
    }
    for (const [operation, result] of Object.entries(operationComparison)) {
        if (
            result.p95RustToCurrentRatio === null ||
            result.p95RustToCurrentRatio > thresholds.maximumP95RustToCurrentRatio
        ) {
            failures.push(
                `${operation} p95 Rust/current ratio ${result.p95RustToCurrentRatio} exceeds ${thresholds.maximumP95RustToCurrentRatio}`
            )
        }
    }
    return { passed: failures.length === 0, failures }
}

function validateResults(current, rust, documents, matchingDocuments) {
    const checks = [
        ['current get', current.operations.get.lastResult, 1],
        ['current find', current.operations.find.lastResult, matchingDocuments],
        ['current inspect', current.operations.inspect.lastResult, documents],
        ['Rust find', rust.operations.find.lastResult, matchingDocuments],
        ['Rust inspect', rust.operations.inspect.lastResult, documents],
        ['Rust index verification', rust.operations.verifyIndex.lastResult, 1]
    ]
    for (const [label, actual, expected] of checks) {
        if (actual !== expected) {
            throw new Error(`${label} result drift: expected ${expected}, received ${actual}`)
        }
    }
}

function ratio(numerator, denominator) {
    if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) {
        return null
    }
    return Math.round((numerator / denominator) * 1000) / 1000
}

async function command(commandArguments) {
    const subprocess = Bun.spawn(commandArguments, {
        cwd: process.cwd(),
        env: process.env,
        stdout: 'inherit',
        stderr: 'inherit'
    })
    const exitCode = await subprocess.exited
    if (exitCode !== 0)
        throw new Error(`command failed (${exitCode}): ${commandArguments.join(' ')}`)
}

async function jsonCommand(commandArguments) {
    const subprocess = Bun.spawn(commandArguments, {
        cwd: process.cwd(),
        env: process.env,
        stdout: 'pipe',
        stderr: 'pipe'
    })
    let sampling = true
    const samples = sampleProcessRss(subprocess.pid, () => sampling)
    const [stdout, stderr, exitCode, observedPeakRssBytes] = await Promise.all([
        new Response(subprocess.stdout).text(),
        new Response(subprocess.stderr).text(),
        subprocess.exited.then((code) => {
            sampling = false
            return code
        }),
        samples
    ])
    if (exitCode !== 0) {
        throw new Error(
            `command failed (${exitCode}): ${stderr.trim() || commandArguments.join(' ')}`
        )
    }
    return { output: JSON.parse(stdout), observedPeakRssBytes }
}

async function sampleProcessRss(pid, shouldContinue) {
    let peak = 0
    do {
        peak = Math.max(peak, await processRssBytes(pid))
        if (shouldContinue()) await Bun.sleep(5)
    } while (shouldContinue())
    return peak
}

async function processRssBytes(pid) {
    const commandArguments =
        platform() === 'win32'
            ? [
                  'powershell.exe',
                  '-NoProfile',
                  '-NonInteractive',
                  '-Command',
                  `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).WorkingSet64`
              ]
            : ['ps', '-o', 'rss=', '-p', String(pid)]
    const subprocess = Bun.spawn(commandArguments, {
        stdout: 'pipe',
        stderr: 'ignore'
    })
    const [stdout, exitCode] = await Promise.all([
        new Response(subprocess.stdout).text(),
        subprocess.exited
    ])
    if (exitCode !== 0) return 0
    const value = Number(stdout.trim())
    if (!Number.isFinite(value) || value <= 0) return 0
    return platform() === 'win32' ? Math.round(value) : Math.round(value * 1024)
}

function parseArguments(commandArguments) {
    const output = option(commandArguments, '--output') ?? 'target/benchmarks/read-only.json'
    return {
        documents: boundedInteger(commandArguments, '--documents', 500, 10, 100_000),
        iterations: boundedInteger(commandArguments, '--iterations', 100, 1, 100_000),
        warmup: boundedInteger(commandArguments, '--warmup', 20, 0, 10_000),
        output
    }
}

function boundedInteger(commandArguments, name, fallback, minimum, maximum) {
    const encoded = option(commandArguments, name)
    if (encoded === undefined) return fallback
    const value = Number(encoded)
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
        throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`)
    }
    return value
}

function option(commandArguments, name) {
    const index = commandArguments.indexOf(name)
    if (index === -1) return undefined
    const value = commandArguments[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${name}`)
    return value
}
