import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const releasedBinary = resolve(requiredOption('--released-binary'))
const rustBinary = resolve(requiredOption('--rust-binary'))
if (releasedBinary === rustBinary) throw new Error('released and Rust binaries must be distinct')

const registry = JSON.parse(await readFile('api/machine/v1/operations.json', 'utf8'))
const canonicalOperations = registry.operations.map(({ name }) => name).sort()
const candidateOnlyOperations = [
    'getFileData',
    'queueAck',
    'queueClaim',
    'queueDeadLetters',
    'queueExtend',
    'queueNack',
    'queuePublish',
    'queueStats',
    'reshardCollection'
]
const releasedOperations = canonicalOperations.filter(
    (operation) => !candidateOnlyOperations.includes(operation)
)
const workspace = await mkdtemp(join(tmpdir(), 'fylo-release-machine-parity-'))
const schemaRoot = join(workspace, 'schema')
const rawSource = join(workspace, 'source.bin')

try {
    await createSchemaFixture(schemaRoot)
    await writeFile(rawSource, new Uint8Array([0, 1, 2, 3, 254, 255]))

    const released = await runScenario('released', releasedBinary, join(workspace, 'released'))
    const rust = await runScenario('rust', rustBinary, join(workspace, 'rust'))

    assertEqual(released.operations, releasedOperations, 'released operation coverage')
    assertEqual(rust.operations, canonicalOperations, 'Rust operation coverage')
    assert(released.nonEmptyResults > 20, 'released corpus produced too few non-empty results')
    assert(rust.nonEmptyResults > 20, 'Rust corpus produced too few non-empty results')
    assertEqual(released.transcript, rust.transcript, 'released/Rust machine semantics')

    console.log(
        `Verified ${releasedOperations.length} shared machine operations against the immutable release and all ${canonicalOperations.length} against Rust (${rust.transcript.length} semantic checkpoints)`
    )
} finally {
    await rm(workspace, { recursive: true, force: true })
}

async function runScenario(label, binary, root) {
    await mkdir(root, { recursive: true })
    let machine = new Machine(binary, root, { FYLO_SCHEMA: schemaRoot })
    const operations = new Set()
    const transcript = []
    const identifiers = new Map()
    const commits = new Map()
    let nonEmptyResults = 0
    const repositoryOperations = new Set([
        'handshake',
        'checkout',
        'branch',
        'commit',
        'log',
        'status',
        'diff',
        'restoreCommit',
        'merge'
    ])

    const request = async (checkpoint, body, options = {}) => {
        if (process.env.FYLO_PARITY_DEBUG === '1') {
            console.error(`[${label}] ${checkpoint}`)
        }
        operations.add(body.op)
        const effectiveBody =
            repositoryOperations.has(body.op) || body.versioning !== undefined
                ? body
                : { ...body, versioning: { autoCommit: false } }
        let result
        try {
            result = await machine.request(effectiveBody)
        } catch (error) {
            throw new Error(`${label} ${checkpoint}: ${error.message}`, { cause: error })
        }
        if (isNonEmpty(result)) nonEmptyResults++
        if (options.identifier) {
            assertTtid(result, `${label} ${checkpoint}`)
            identifiers.set(String(result), options.identifier)
        }
        if (options.identifiers) {
            assert(Array.isArray(result), `${label} ${checkpoint} did not return identifiers`)
            assert(
                result.length === options.identifiers.length,
                `${label} ${checkpoint} identifier count drift`
            )
            result.forEach((id, index) => {
                assertTtid(id, `${label} ${checkpoint}[${index}]`)
                identifiers.set(String(id), options.identifiers[index])
            })
        }
        if (options.commit) {
            const id = result?.id
            assertCommitId(id, `${label} ${checkpoint}: ${JSON.stringify(result)}`)
            commits.set(String(id), options.commit)
        }
        if (options.record !== false) {
            transcript.push({
                checkpoint,
                op: body.op,
                result: canonicalize(
                    body.op === 'handshake'
                        ? normalizeHandshake(result)
                        : normalizeKnownReleaseDeltas(body.op, result),
                    { root, identifiers, commits }
                )
            })
        }
        return result
    }

    try {
        await request('handshake', { op: 'handshake' })

        for (const collection of ['records', 'right', 'disposable']) {
            await request(`create-${collection}`, {
                op: 'createCollection',
                collection,
                kind: 'document',
                versioning: { autoCommit: false }
            })
        }
        await request('create-assets', {
            op: 'createCollection',
            collection: 'assets',
            kind: 'file',
            versioning: { autoCommit: false }
        })

        const ada = await request(
            'put-ada',
            {
                op: 'putData',
                collection: 'records',
                data: { name: 'Ada', team: 'engine', score: 10, active: true },
                meta: { source: 'parity' },
                versioning: { autoCommit: false }
            },
            { identifier: 'ada' }
        )
        const grace = await request(
            'put-grace',
            {
                op: 'putData',
                collection: 'records',
                data: { name: 'Grace', team: 'engine', score: 20, active: true },
                versioning: { autoCommit: false }
            },
            { identifier: 'grace' }
        )
        await request(
            'put-right',
            {
                op: 'putData',
                collection: 'right',
                data: { owner: 'Ada', team: 'engine', tier: 'gold' },
                versioning: { autoCommit: false }
            },
            { identifier: 'right-ada' }
        )
        const [linus, margaret] = await request(
            'batch-put',
            {
                op: 'batchPutData',
                collection: 'records',
                batch: [
                    { name: 'Linus', team: 'kernel', score: 5, active: true },
                    { name: 'Margaret', team: 'compiler', score: 30, active: false }
                ],
                versioning: { autoCommit: false }
            },
            { identifiers: ['linus', 'margaret'] }
        )

        await request('get-ada', { op: 'getDoc', collection: 'records', id: ada })
        await request('get-ada-meta', { op: 'getMeta', collection: 'records', id: ada })
        await request('set-ada-meta', {
            op: 'setMeta',
            collection: 'records',
            id: ada,
            meta: { reviewer: 'database', source: null }
        })
        await request('patch-ada', {
            op: 'patchDoc',
            collection: 'records',
            id: ada,
            newDoc: { score: 11 }
        })
        await request('patch-engine-team', {
            op: 'patchDocs',
            collection: 'records',
            update: {
                $where: { $ops: [{ team: { $eq: 'engine' } }] },
                $set: { reviewed: true }
            }
        })
        await request('sql-update', {
            op: 'executeSQL',
            sql: "UPDATE records SET active = false WHERE name = 'Linus'"
        })
        await request('find-engine', {
            op: 'findDocs',
            collection: 'records',
            query: { $ops: [{ team: { $eq: 'engine' } }] }
        })
        await request('join-team', {
            op: 'joinDocs',
            join: {
                $leftCollection: 'records',
                $rightCollection: 'right',
                $mode: 'inner',
                $on: { team: { $eq: 'team' } },
                $select: ['name', 'owner', 'tier']
            }
        })
        await request('latest-ada', {
            op: 'getLatest',
            collection: 'records',
            id: ada,
            onlyId: false
        })

        await request('delete-margaret', {
            op: 'delDoc',
            collection: 'records',
            id: margaret
        })
        await request('find-deleted-margaret', {
            op: 'findDeletedDocs',
            collection: 'records',
            query: { $ops: [{ name: { $eq: 'Margaret' } }] }
        })
        await request('restore-margaret', {
            op: 'restoreDoc',
            collection: 'records',
            id: margaret
        })
        await request('delete-kernel-team', {
            op: 'delDocs',
            collection: 'records',
            delete: { $ops: [{ team: { $eq: 'kernel' } }] }
        })
        await request('restore-linus', {
            op: 'restoreDoc',
            collection: 'records',
            id: linus
        })

        await request(
            'import-data-url',
            {
                op: 'importBulkData',
                collection: 'records',
                url: `data:application/json,${encodeURIComponent(
                    JSON.stringify([{ name: 'Imported', team: 'batch', score: 40 }])
                )}`
            },
            { record: true }
        )

        const fileId = await request(
            'put-raw-file',
            {
                op: 'putData',
                collection: 'assets',
                file: { path: rawSource, key: '/fixtures/source.bin' },
                meta: { fixture: true }
            },
            { identifier: 'raw-source' }
        )
        await request('get-raw-file', { op: 'getDoc', collection: 'assets', id: fileId })
        if (label === 'rust') {
            await request(
                'get-raw-file-data',
                { op: 'getFileData', collection: 'assets', id: fileId },
                { record: false }
            )
            await request(
                'reshard-assets',
                { op: 'reshardCollection', collection: 'assets', width: 2 },
                { record: false }
            )

            const published = await request(
                'queue-publish',
                {
                    op: 'queuePublish',
                    topic: 'parity.jobs',
                    payload: { job: 'candidate-only' },
                    idempotencyKey: 'parity-job-1'
                },
                { record: false }
            )
            const firstClaim = await request(
                'queue-claim-first',
                {
                    op: 'queueClaim',
                    topic: 'parity.jobs',
                    group: 'parity-workers',
                    maxAttempts: 3
                },
                { record: false }
            )
            assert(
                firstClaim.length === 1 && firstClaim[0].id === published.id,
                'Rust queue claim did not return the candidate publication'
            )
            await request(
                'queue-nack',
                {
                    op: 'queueNack',
                    topic: 'parity.jobs',
                    group: 'parity-workers',
                    id: firstClaim[0].id,
                    receipt: firstClaim[0].receipt,
                    reason: 'candidate retry'
                },
                { record: false }
            )
            const secondClaim = await request(
                'queue-claim-second',
                {
                    op: 'queueClaim',
                    topic: 'parity.jobs',
                    group: 'parity-workers',
                    maxAttempts: 3
                },
                { record: false }
            )
            assert(
                secondClaim.length === 1 && secondClaim[0].attempt === 2,
                'Rust queue retry did not advance the delivery attempt'
            )
            await request(
                'queue-extend',
                {
                    op: 'queueExtend',
                    topic: 'parity.jobs',
                    group: 'parity-workers',
                    id: secondClaim[0].id,
                    receipt: secondClaim[0].receipt,
                    visibilityTimeoutMs: 30_000
                },
                { record: false }
            )
            await request(
                'queue-ack',
                {
                    op: 'queueAck',
                    topic: 'parity.jobs',
                    group: 'parity-workers',
                    id: secondClaim[0].id,
                    receipt: secondClaim[0].receipt
                },
                { record: false }
            )
            const queueStats = await request(
                'queue-stats',
                { op: 'queueStats', topic: 'parity.jobs', group: 'parity-workers' },
                { record: false }
            )
            assert(
                queueStats.retired === 1 && queueStats.available === 0,
                'Rust queue acknowledgement was not durable'
            )
            const deadLetters = await request(
                'queue-dead-letters',
                {
                    op: 'queueDeadLetters',
                    topic: 'parity.jobs',
                    group: 'parity-workers',
                    limit: 10
                },
                { record: false }
            )
            assert(deadLetters.length === 0, 'Rust queue unexpectedly dead-lettered the job')
        }
        await request('verify-assets', { op: 'verifyCollection', collection: 'assets' })

        await request('rebuild-records', { op: 'rebuildCollection', collection: 'records' })
        await request('inspect-records', { op: 'inspectCollection', collection: 'records' })
        await request('drop-disposable', { op: 'dropCollection', collection: 'disposable' })

        const initial = await request(
            'commit-initial',
            { op: 'commit', message: 'parity initial' },
            { commit: 'initial' }
        )
        await request('repository-status-clean', { op: 'status' })
        await request('repository-log-initial', { op: 'log' })
        await request('repository-branches-main', { op: 'branch' })
        await request('checkout-feature', {
            op: 'checkout',
            branch: 'feature/parity',
            create: true
        })
        await machine.close()
        machine = new Machine(binary, root, { FYLO_SCHEMA: schemaRoot })
        if (label === 'rust') {
            const branchAdaMetadata = await request(
                'get-ada-meta-after-checkout-feature',
                { op: 'getMeta', collection: 'records', id: ada },
                { record: false }
            )
            const branchFileMetadata = await request(
                'get-file-meta-after-checkout-feature',
                { op: 'getMeta', collection: 'assets', id: fileId },
                { record: false }
            )
            assert(
                branchAdaMetadata.reviewer === 'database',
                'Rust branch checkout did not preserve document custom metadata'
            )
            assert(
                branchFileMetadata.fixture === true,
                'Rust branch checkout did not preserve raw-file custom metadata'
            )
        }
        await request('patch-feature', {
            op: 'patchDoc',
            collection: 'records',
            id: grace,
            newDoc: { branchValue: 'feature' },
            versioning: { autoCommit: false }
        })
        await request('diff-feature-worktree', { op: 'diff' })
        const feature = await request(
            'commit-feature',
            { op: 'commit', message: 'parity feature' },
            { commit: 'feature' }
        )
        await request('merge-current-feature', { op: 'merge', source: 'feature/parity' })
        await request('checkout-main', { op: 'checkout', branch: 'main' })
        await machine.close()
        machine = new Machine(binary, root, { FYLO_SCHEMA: schemaRoot })
        await request('diff-commits', { op: 'diff', from: initial.id, to: feature.id })
        await request('restore-initial', { op: 'restoreCommit', id: initial.id, force: true })
        await request('get-grace-after-restore', {
            op: 'getDoc',
            collection: 'records',
            id: grace
        })

        await request('schema-inspect', {
            op: 'schemaInspect',
            collection: 'profiles',
            schemaDir: schemaRoot
        })
        await request('schema-current', {
            op: 'schemaCurrent',
            collection: 'profiles',
            schemaDir: schemaRoot
        })
        await request('schema-history', {
            op: 'schemaHistory',
            collection: 'profiles',
            schemaDir: schemaRoot
        })
        await request('schema-doctor', {
            op: 'schemaDoctor',
            collection: 'profiles',
            schemaDir: schemaRoot
        })
        await request('schema-validate', {
            op: 'schemaValidate',
            collection: 'profiles',
            schemaDir: schemaRoot,
            document: { name: 'Ada Lovelace', active: true }
        })
        await request('schema-materialize', {
            op: 'schemaMaterialize',
            collection: 'profiles',
            schemaDir: schemaRoot,
            document: { _v: 'v1', fullName: 'Grace Hopper', active: true }
        })
    } finally {
        await machine.close()
    }

    return {
        operations: [...operations].sort(),
        transcript,
        nonEmptyResults
    }
}

class Machine {
    constructor(binary, root, environment) {
        this.sequence = 0
        this.child = Bun.spawn([binary, 'exec', '--loop', '--root', root], {
            // Keep packaged Bun releases away from a repository-local `.env`.
            // The corpus is intentionally self-contained inside its root.
            cwd: root,
            env: { ...process.env, ...environment },
            stdin: 'pipe',
            stdout: 'pipe',
            stderr: 'pipe'
        })
        this.reader = this.child.stdout.getReader()
        this.stderr = new Response(this.child.stderr).text()
        this.decoder = new TextDecoder()
        this.buffered = ''
    }

    async request(body) {
        const requestId = `parity-${++this.sequence}`
        this.child.stdin.write(`${JSON.stringify({ ...body, requestId })}\n`)
        await this.child.stdin.flush()
        while (!this.buffered.includes('\n')) {
            const { value, done } = await this.reader.read()
            if (done) {
                const stderr = await this.stderr
                throw new Error(`machine exited before ${requestId}: ${stderr}`)
            }
            this.buffered += this.decoder.decode(value, { stream: true })
        }
        const newline = this.buffered.indexOf('\n')
        const line = this.buffered.slice(0, newline)
        this.buffered = this.buffered.slice(newline + 1)
        const response = JSON.parse(line)
        assert(
            response.requestId === requestId,
            `machine response correlation drift for ${requestId}`
        )
        if (response.ok !== true) {
            throw new Error(
                `${body.op} failed (${response.error?.code}): ${response.error?.message}`
            )
        }
        return response.result
    }

    async close() {
        this.reader.cancel().catch(() => {})
        await this.child.stdin.end()
        const exitCode = await this.child.exited
        if (exitCode !== 0) {
            const stderr = await this.stderr
            throw new Error(`machine exited ${exitCode}: ${stderr}`)
        }
    }
}

async function createSchemaFixture(root) {
    const collection = join(root, 'profiles')
    await mkdir(join(collection, 'history'), { recursive: true })
    await mkdir(join(collection, 'upgraders'), { recursive: true })
    await writeFile(
        join(collection, 'manifest.json'),
        JSON.stringify({ current: 'v2', versions: [{ v: 'v1' }, { v: 'v2' }] })
    )
    await writeFile(
        join(collection, 'history', 'v1.schema.json'),
        JSON.stringify({ fullName: '^.+$', active: '^(true|false)$' })
    )
    await writeFile(
        join(collection, 'history', 'v2.schema.json'),
        JSON.stringify({ name: '^.+$', active: '^(true|false)$' })
    )
    await writeFile(
        join(collection, 'upgraders', 'v1-to-v2.js'),
        'export default async (document) => ({ name: document.fullName, active: document.active })\n'
    )
}

function canonicalize(value, context, key = '') {
    if (typeof value === 'string') {
        let normalized = value
        for (const [identifier, name] of context.identifiers) {
            normalized = normalized.replaceAll(identifier, `<id:${name}>`)
        }
        for (const [commit, name] of context.commits) {
            normalized = normalized.replaceAll(commit, `<commit:${name}>`)
        }
        normalized = normalized.replaceAll(`/private${context.root}`, '<root>')
        normalized = normalized.replaceAll(context.root, '<root>')
        normalized = normalized.replaceAll(schemaRoot, '<schema>')
        if (key === 'path') {
            normalized = normalized.replace(/\/[^/]+\/(?=<id:[^>]+>)/g, '/<shard>/')
        }
        if (isTimestampKey(key) && !Number.isNaN(Date.parse(value))) return '<timestamp>'
        return normalized
    }
    if (typeof value === 'number' && isTimestampKey(key)) return '<timestamp>'
    if (Array.isArray(value)) {
        return value.map((item) => canonicalize(item, context, key))
    }
    if (!value || typeof value !== 'object') return value

    const entries = Object.entries(value)
    if (entries.length > 0 && entries.every(([entryKey]) => looksLikeTtid(entryKey))) {
        return entries
            .map(([, item]) => canonicalize(item, context))
            .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
    }
    return Object.fromEntries(
        entries
            .filter(([entryKey]) => entryKey !== 'durationMs')
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([entryKey, item]) => [
                canonicalize(entryKey, context),
                canonicalize(item, context, entryKey)
            ])
    )
}

function normalizeHandshake(value) {
    const normalized = structuredClone(value)
    delete normalized.buildKind
    delete normalized.buildTarget
    delete normalized.commit
    delete normalized.runtimeVersion
    delete normalized.capabilities?.documentBuckets
    delete normalized.capabilities?.machineAccess
    delete normalized.capabilities?.serverlessQueue
    delete normalized.capabilities?.wholeRootBackup
    delete normalized.dependencies?.chex?.requiredVersion
    delete normalized.dependencies?.ttid?.requiredVersion
    return normalized
}

function normalizeKnownReleaseDeltas(operation, value) {
    if (operation !== 'diff' || !Array.isArray(value?.changes)) return value
    const normalized = structuredClone(value)
    // v26.30.06 loses custom xattrs while copying a branch and consequently
    // exposes their VCS sidecars as deletions. Rust deliberately preserves
    // those xattrs; the direct assertions above make that fix non-negotiable.
    normalized.changes = normalized.changes.filter(
        (change) => !(change.kind === 'metadata' && change.status === 'deleted')
    )
    normalized.counts = {
        added: normalized.changes.filter((change) => change.status === 'added').length,
        modified: normalized.changes.filter((change) => change.status === 'modified').length,
        deleted: normalized.changes.filter((change) => change.status === 'deleted').length,
        total: normalized.changes.length
    }
    return normalized
}

function isTimestampKey(key) {
    return /(?:^|_)(?:time|timestamp)$|(?:At|Mtime|mtime|lastModified)$/i.test(key)
}

function looksLikeTtid(value) {
    return /^[0-9][0-9A-Z]{7,}(?:-[0-9A-Z]+)*$/i.test(value)
}

function assertTtid(value, label) {
    assert(typeof value === 'string' && looksLikeTtid(value), `${label} returned no valid TTID`)
}

function assertCommitId(value, label) {
    assert(typeof value === 'string' && looksLikeTtid(value), `${label} returned no commit`)
}

function isNonEmpty(value) {
    if (value === null || value === undefined || value === false || value === '') return false
    if (Array.isArray(value)) return value.length > 0
    if (typeof value === 'object') return Object.keys(value).length > 0
    return true
}

function requiredOption(name) {
    const index = process.argv.indexOf(name)
    const value = index === -1 ? undefined : process.argv[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`missing ${name}`)
    return value
}

function assert(condition, message) {
    if (!condition) throw new Error(message)
}

function assertEqual(actual, expected, label) {
    const actualJson = JSON.stringify(actual)
    const expectedJson = JSON.stringify(expected)
    if (actualJson !== expectedJson) {
        throw new Error(
            `${label} drift\n--- expected\n${JSON.stringify(expected, null, 2)}\n--- actual\n${JSON.stringify(actual, null, 2)}`
        )
    }
}
