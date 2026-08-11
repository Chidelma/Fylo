#!/usr/bin/env bun

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createWebArtifact } from './web-artifact.mjs'
import { smokeSite } from './web-smoke.mjs'

const SHA256 = /^[a-f0-9]{64}$/
const TERMINAL = new Set(['SUCCEED', 'FAILED', 'CANCELLED'])
const LEASE_DURATION_MS = 75 * 60_000
const CONDITIONAL_CONFLICTS = new Set(['PreconditionFailed', 'ConditionalRequestConflict'])
const COMMAND_TIMEOUT_MS = 60_000
const UPLOAD_TIMEOUT_MS = 120_000

async function command(
    program,
    args,
    { allowFailure = false, timeoutMs = COMMAND_TIMEOUT_MS, spawn = Bun.spawn } = {}
) {
    const child = spawn([program, ...args], { stdout: 'pipe', stderr: 'pipe' })
    let timedOut = false
    const timeout = setTimeout(() => {
        timedOut = true
        child.kill(9)
    }, timeoutMs)
    let status
    let stdout
    let stderr
    try {
        const results = await Promise.all([
            child.exited,
            new Response(child.stdout).text(),
            new Response(child.stderr).text()
        ])
        status = results[0]
        stdout = results[1]
        stderr = results[2]
    } finally {
        clearTimeout(timeout)
    }
    if (timedOut) {
        throw new Error(`${program} ${args[0] ?? ''} timed out after ${timeoutMs}ms`)
    }
    if (status !== 0 && !allowFailure) {
        throw new Error(
            `${program} ${args[0] ?? ''} failed: ${stderr.trim() || `status ${status}`}`
        )
    }
    return { status, stdout, stderr }
}

async function awsJson(args) {
    const result = await command('aws', [...args, '--output', 'json'])
    return JSON.parse(result.stdout)
}

function objectKey(config, siteName, suffix) {
    return `${config.artifactPrefix.replace(/^\/+|\/+$/g, '')}/${siteName}/${suffix}`
}

function awsErrorCode(stderr) {
    return /An error occurred \(([^)]+)\) when calling the [A-Za-z0-9]+ operation/.exec(stderr)?.[1]
}

function awsFailure(action, bucket, key, result) {
    const code = awsErrorCode(result.stderr)
    const detail = (code ?? result.stderr.trim()) || `status ${result.status}`
    return new Error(`${action} s3://${bucket}/${key} failed: ${detail}`)
}

async function readJsonObject(bucket, key, description, run = command) {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'fylo-s3-json-'))
    try {
        const file = path.join(temporary, 'object.json')
        const result = await run(
            'aws',
            ['s3api', 'get-object', '--bucket', bucket, '--key', key, file, '--output', 'json'],
            { allowFailure: true }
        )
        if (result.status !== 0) {
            const code = awsErrorCode(result.stderr)
            if (code === 'NoSuchKey' || code === 'NotFound') return null
            throw awsFailure(`Reading ${description}`, bucket, key, result)
        }
        let response
        let value
        try {
            response = JSON.parse(result.stdout)
            value = JSON.parse(await readFile(file, 'utf8'))
        } catch (error) {
            throw new Error(`Invalid ${description} at s3://${bucket}/${key}: ${error.message}`)
        }
        if (typeof response.ETag !== 'string' || response.ETag.length === 0) {
            throw new Error(`Missing ETag for ${description} at s3://${bucket}/${key}`)
        }
        return { value, eTag: response.ETag }
    } finally {
        await rm(temporary, { recursive: true, force: true })
    }
}

async function putJsonObject(bucket, key, value, condition, run = command) {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'fylo-s3-json-'))
    try {
        const file = path.join(temporary, 'object.json')
        await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
        const conditionArgs =
            condition.type === 'absent' ? ['--if-none-match', '*'] : ['--if-match', condition.eTag]
        const result = await run(
            'aws',
            [
                's3api',
                'put-object',
                '--bucket',
                bucket,
                '--key',
                key,
                '--body',
                file,
                '--content-type',
                'application/json',
                ...conditionArgs,
                '--output',
                'json'
            ],
            { allowFailure: true }
        )
        if (result.status !== 0) {
            return { conflict: CONDITIONAL_CONFLICTS.has(awsErrorCode(result.stderr)), result }
        }
        let response
        try {
            response = JSON.parse(result.stdout)
        } catch (error) {
            throw new Error(`Invalid S3 write response for s3://${bucket}/${key}: ${error.message}`)
        }
        if (typeof response.ETag !== 'string' || response.ETag.length === 0) {
            throw new Error(`Missing ETag after writing s3://${bucket}/${key}`)
        }
        return { conflict: false, eTag: response.ETag }
    } finally {
        await rm(temporary, { recursive: true, force: true })
    }
}

async function assertConditionalS3Support(run = command) {
    const [put, remove] = await Promise.all([
        run('aws', ['s3api', 'put-object', '--generate-cli-skeleton', 'input'], {
            allowFailure: true
        }),
        run('aws', ['s3api', 'delete-object', '--generate-cli-skeleton', 'input'], {
            allowFailure: true
        })
    ])
    try {
        const putShape = JSON.parse(put.stdout)
        const deleteShape = JSON.parse(remove.stdout)
        if (
            put.status !== 0 ||
            remove.status !== 0 ||
            !Object.hasOwn(putShape, 'IfMatch') ||
            !Object.hasOwn(putShape, 'IfNoneMatch') ||
            !Object.hasOwn(deleteShape, 'IfMatch')
        ) {
            throw new Error('unsupported')
        }
    } catch {
        throw new Error(
            'AWS CLI with S3 PutObject IfMatch/IfNoneMatch and DeleteObject IfMatch support is required; upgrade AWS CLI before deploying'
        )
    }
}

async function readState(bucket, key, { run = command } = {}) {
    const object = await readJsonObject(bucket, key, 'release state', run)
    if (object === null) return null
    const value = object.value
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`Invalid release state at s3://${bucket}/${key}`)
    }
    const { lease: leaseValue, ...stateValue } = value
    const state = Object.keys(stateValue).length === 0 ? null : stateValue
    if (state && !SHA256.test(state.checksum)) {
        throw new Error(`Invalid release state at s3://${bucket}/${key}`)
    }
    if (state?.previousChecksum !== undefined && !SHA256.test(state.previousChecksum)) {
        throw new Error(`Invalid previous checksum at s3://${bucket}/${key}`)
    }
    if (state?.artifactContracts !== undefined) {
        if (
            !state.artifactContracts ||
            typeof state.artifactContracts !== 'object' ||
            Array.isArray(state.artifactContracts)
        ) {
            throw new Error(`Invalid artifact contracts at s3://${bucket}/${key}`)
        }
        for (const [checksum, contract] of Object.entries(state.artifactContracts)) {
            if (!SHA256.test(checksum)) {
                throw new Error(`Invalid artifact contract checksum at s3://${bucket}/${key}`)
            }
            validateArtifactContract(contract, `artifact ${checksum}`)
        }
    }
    let lease = null
    if (leaseValue !== undefined) {
        const expiresAtMs = Date.parse(leaseValue?.expiresAt)
        if (
            !leaseValue ||
            typeof leaseValue !== 'object' ||
            Array.isArray(leaseValue) ||
            typeof leaseValue.owner !== 'string' ||
            leaseValue.owner.length === 0 ||
            !['preparing', 'mutating'].includes(leaseValue.phase) ||
            !Number.isFinite(expiresAtMs)
        ) {
            throw new Error(`Invalid release lease at s3://${bucket}/${key}`)
        }
        lease = { ...leaseValue, expiresAtMs }
    }
    if (!state && !lease) throw new Error(`Invalid release state at s3://${bucket}/${key}`)
    return { state, lease, eTag: object.eTag }
}

function validateArtifactContract(contract, description = 'artifact') {
    if (!contract || typeof contract !== 'object' || Array.isArray(contract)) {
        throw new Error(`Invalid ${description} release contract`)
    }
    if (
        !contract.requiredHeaders ||
        typeof contract.requiredHeaders !== 'object' ||
        Array.isArray(contract.requiredHeaders) ||
        Object.entries(contract.requiredHeaders).some(
            ([name, value]) => !name || typeof value !== 'string'
        )
    ) {
        throw new Error(`Invalid ${description} release headers`)
    }
    if (
        contract.requiredScriptSrcTokens !== undefined &&
        (!Array.isArray(contract.requiredScriptSrcTokens) ||
            contract.requiredScriptSrcTokens.length === 0 ||
            contract.requiredScriptSrcTokens.some(
                (token) => typeof token !== 'string' || !/^'[a-z0-9-]+'$/.test(token)
            ))
    ) {
        throw new Error(`Invalid ${description} release script-src requirements`)
    }
    if (
        !Array.isArray(contract.probes) ||
        contract.probes.length === 0 ||
        contract.probes.some((probe) => {
            const invalidHeaders =
                probe?.requiredHeaders !== undefined &&
                (!probe.requiredHeaders ||
                    typeof probe.requiredHeaders !== 'object' ||
                    Array.isArray(probe.requiredHeaders) ||
                    Object.entries(probe.requiredHeaders).some(
                        ([name, value]) => !name || typeof value !== 'string'
                    ))
            const invalidContentTypes =
                probe?.contentTypes !== undefined &&
                (!Array.isArray(probe.contentTypes) ||
                    probe.contentTypes.length === 0 ||
                    probe.contentTypes.some(
                        (contentType) => typeof contentType !== 'string' || contentType.length === 0
                    ))
            return (
                !probe ||
                typeof probe !== 'object' ||
                Array.isArray(probe) ||
                typeof probe.path !== 'string' ||
                !probe.path.startsWith('/') ||
                probe.path.startsWith('//') ||
                probe.path.includes('\\') ||
                (typeof probe.contains !== 'string' && typeof probe.startsWithHex !== 'string') ||
                invalidHeaders ||
                invalidContentTypes
            )
        })
    ) {
        throw new Error(`Invalid ${description} release probes`)
    }
    return contract
}

function activeArtifactContract(site) {
    return validateArtifactContract(
        { requiredHeaders: site.requiredHeaders, probes: site.probes },
        'active site'
    )
}

function artifactContractFor(site, state, checksum) {
    if (!SHA256.test(checksum)) throw new Error(`Invalid archived artifact checksum ${checksum}`)
    const contract =
        state?.artifactContracts?.[checksum] ?? site.artifactContracts?.[checksum] ?? null
    if (!contract) {
        throw new Error(
            `No checksum-bound release contract is available for archived artifact ${checksum}`
        )
    }
    return validateArtifactContract(contract, `artifact ${checksum}`)
}

function artifactSmokeSite(site, contract) {
    validateArtifactContract(contract)
    const requiredHeaders = {
        ...contract.requiredHeaders,
        ...site.requiredHeaders
    }
    if (contract.requiredScriptSrcTokens) {
        const directives = (site.requiredHeaders?.['content-security-policy'] ?? '')
            .split(';')
            .map((directive) => directive.trim())
            .filter(Boolean)
            .map((directive) => directive.split(/\s+/))
        const scriptSrc = directives.filter(([name]) => name.toLowerCase() === 'script-src')
        if (scriptSrc.length !== 1 || scriptSrc[0].length < 2) {
            throw new Error('Active CSP must contain exactly one non-empty script-src directive')
        }
        const activeScriptSrcTokens = new Set(scriptSrc[0].slice(1))
        for (const token of contract.requiredScriptSrcTokens) {
            if (!activeScriptSrcTokens.has(token)) {
                throw new Error(
                    `Active script-src does not satisfy artifact required token ${token}`
                )
            }
        }
    }
    return {
        ...site,
        probes: contract.probes.map((probe) => ({
            ...probe,
            requiredHeaders: {
                ...probe.requiredHeaders,
                ...requiredHeaders
            }
        })),
        requiredHeaders
    }
}

function artifactContractMap(entries) {
    const contracts = {}
    for (const [checksum, contract] of entries) {
        if (!checksum) continue
        if (!SHA256.test(checksum))
            throw new Error(`Invalid archived artifact checksum ${checksum}`)
        contracts[checksum] = validateArtifactContract(contract, `artifact ${checksum}`)
    }
    return contracts
}

function rollbackReleaseState(current, target, verification, contracts, now = () => new Date()) {
    return {
        ...current,
        checksum: target,
        previousChecksum: current.checksum,
        artifactContracts: contracts,
        deployedAt: now().toISOString(),
        jobId: verification.jobId,
        verifiedProbeCount: verification.probes.length
    }
}

async function writeState(bucket, key, state, lease, { run = command } = {}) {
    const written = await putJsonObject(
        bucket,
        key,
        state,
        { type: 'match', eTag: lease.eTag },
        run
    )
    if (written.conflict) {
        throw new Error(`Release lease ownership was lost at s3://${bucket}/${key}`)
    }
    if (written.result) throw awsFailure('Writing release state', bucket, key, written.result)
    return written.eTag
}

function leasedState(previousState, lease) {
    return previousState ? { ...previousState, lease } : { lease }
}

async function acquireLease(
    bucket,
    key,
    {
        run = command,
        owner = randomUUID(),
        now = () => Date.now(),
        durationMs = LEASE_DURATION_MS,
        attempts = 3
    } = {}
) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        const acquiredAt = now()
        const value = {
            owner,
            phase: 'preparing',
            acquiredAt: new Date(acquiredAt).toISOString(),
            expiresAt: new Date(acquiredAt + durationMs).toISOString()
        }
        const current = await readState(bucket, key, { run })
        if (current?.lease) {
            if (current.lease.phase === 'mutating') {
                throw reconciliationIncident(
                    `Release state s3://${bucket}/${key} is fenced by a mutating lease from ${current.lease.owner}; it must be reconciled manually even though its recorded expiry is ${current.lease.expiresAt}`
                )
            }
            if (current.lease.expiresAtMs > now()) {
                throw new Error(
                    `Another release owns s3://${bucket}/${key} until ${current.lease.expiresAt}`
                )
            }
        }
        const acquired = await putJsonObject(
            bucket,
            key,
            leasedState(current?.state, value),
            current ? { type: 'match', eTag: current.eTag } : { type: 'absent' },
            run
        )
        if (acquired.conflict) continue
        if (acquired.result)
            throw awsFailure('Acquiring release lease', bucket, key, acquired.result)
        return {
            ...value,
            expiresAtMs: acquiredAt + durationMs,
            eTag: acquired.eTag,
            previousState: current?.state ?? null
        }
    }
    throw new Error(`Release lease at s3://${bucket}/${key} changed too often; retry later`)
}

async function refreshLease(
    bucket,
    key,
    lease,
    { run = command, now = () => Date.now(), phase = lease.phase } = {}
) {
    const refreshedAt = now()
    if (lease.expiresAtMs <= refreshedAt) {
        throw new Error(`Release lease expired at s3://${bucket}/${key}`)
    }
    if (
        !['preparing', 'mutating'].includes(phase) ||
        (lease.phase === 'mutating' && phase !== 'mutating')
    ) {
        throw new Error(`Invalid release lease phase transition ${lease.phase} -> ${phase}`)
    }
    const value = {
        owner: lease.owner,
        phase,
        acquiredAt: lease.acquiredAt,
        expiresAt: new Date(refreshedAt + LEASE_DURATION_MS).toISOString()
    }
    const refreshed = await putJsonObject(
        bucket,
        key,
        leasedState(lease.previousState, value),
        { type: 'match', eTag: lease.eTag },
        run
    )
    if (refreshed.conflict) {
        throw new Error(`Release lease ownership was lost at s3://${bucket}/${key}`)
    }
    if (refreshed.result)
        throw awsFailure('Refreshing release lease', bucket, key, refreshed.result)
    return {
        ...value,
        expiresAtMs: refreshedAt + LEASE_DURATION_MS,
        eTag: refreshed.eTag,
        previousState: lease.previousState
    }
}

async function releaseLease(bucket, key, lease, { run = command } = {}) {
    if (lease.previousState) {
        const restored = await putJsonObject(
            bucket,
            key,
            lease.previousState,
            { type: 'match', eTag: lease.eTag },
            run
        )
        if (restored.conflict) {
            throw new Error(`Refusing to release a lease no longer owned at s3://${bucket}/${key}`)
        }
        if (restored.result)
            throw awsFailure('Restoring release state after lease', bucket, key, restored.result)
        return
    }
    const result = await run(
        'aws',
        [
            's3api',
            'delete-object',
            '--bucket',
            bucket,
            '--key',
            key,
            '--if-match',
            lease.eTag,
            '--output',
            'json'
        ],
        { allowFailure: true }
    )
    if (result.status !== 0) {
        if (CONDITIONAL_CONFLICTS.has(awsErrorCode(result.stderr))) {
            throw new Error(`Refusing to release a lease no longer owned at s3://${bucket}/${key}`)
        }
        throw awsFailure('Releasing release lease', bucket, key, result)
    }
}

function withoutTrailingNewline(value) {
    return value.endsWith('\n') ? value.slice(0, -1) : value
}

async function verifyAmplifyHeaderPolicy(site, { run = command } = {}) {
    if (typeof site.headersPolicy !== 'string' || site.headersPolicy.length === 0) {
        throw new Error('The Amplify site must configure headersPolicy before deployment')
    }
    let expected
    try {
        expected = await readFile(site.headersPolicy, 'utf8')
    } catch (error) {
        throw new Error(`Cannot read Amplify header policy ${site.headersPolicy}: ${error.message}`)
    }
    const result = await run(
        'aws',
        [
            'amplify',
            'get-app',
            '--app-id',
            site.appId,
            '--query',
            'app.customHeaders',
            '--output',
            'json'
        ],
        { allowFailure: true }
    )
    if (result.status !== 0) {
        throw new Error(
            `Reading Amplify custom headers for ${site.appId} failed: ${result.stderr.trim() || `status ${result.status}`}`
        )
    }
    let actual
    try {
        actual = JSON.parse(result.stdout)
    } catch (error) {
        throw new Error(
            `Amplify returned invalid custom headers for ${site.appId}: ${error.message}`
        )
    }
    if (
        typeof actual !== 'string' ||
        withoutTrailingNewline(actual) !== withoutTrailingNewline(expected)
    ) {
        throw new Error(
            `Amplify custom headers drifted for ${site.appId}; apply ${site.headersPolicy} with aws amplify update-app before deploying`
        )
    }
}

async function archiveArtifact(bucket, key, artifact, checksum, { run = command } = {}) {
    const existing = await run(
        'aws',
        ['s3api', 'head-object', '--bucket', bucket, '--key', key, '--output', 'json'],
        { allowFailure: true }
    )
    if (existing.status === 0) {
        const metadata = JSON.parse(existing.stdout).Metadata ?? {}
        if (metadata.sha256 !== checksum) {
            throw new Error(`Refusing checksum collision at s3://${bucket}/${key}`)
        }
        return
    }
    const code = awsErrorCode(existing.stderr)
    if (code !== '404' && code !== 'NoSuchKey' && code !== 'NotFound') {
        throw awsFailure('Checking archived artifact', bucket, key, existing)
    }
    await run('aws', [
        's3',
        'cp',
        artifact,
        `s3://${bucket}/${key}`,
        '--metadata',
        `sha256=${checksum}`,
        '--only-show-errors'
    ])
}

async function downloadArtifact(bucket, key, checksum, destination) {
    await command('aws', ['s3', 'cp', `s3://${bucket}/${key}`, destination, '--only-show-errors'])
    const actual = createHash('sha256')
        .update(Buffer.from(await Bun.file(destination).arrayBuffer()))
        .digest('hex')
    if (actual !== checksum)
        throw new Error(`Archived artifact checksum mismatch: expected ${checksum}, got ${actual}`)
}

function markDeploymentError(value, productionMutationPossible) {
    const error = value instanceof Error ? value : new Error(String(value))
    error.productionMutationPossible = productionMutationPossible
    return error
}

async function deployToAmplify(
    site,
    artifact,
    {
        beforeStart = async () => {},
        runAws = awsJson,
        fetcher = fetch,
        uploadTimeoutMs = UPLOAD_TIMEOUT_MS,
        now = () => Date.now(),
        sleep = Bun.sleep
    } = {}
) {
    let created
    try {
        created = await runAws([
            'amplify',
            'create-deployment',
            '--app-id',
            site.appId,
            '--branch-name',
            site.branch
        ])
        if (!created.jobId || !created.zipUploadUrl)
            throw new Error('Amplify returned an incomplete deployment')
        const upload = await fetcher(created.zipUploadUrl, {
            method: 'PUT',
            body: Bun.file(artifact),
            headers: { 'content-type': 'application/zip' },
            signal: AbortSignal.timeout(uploadTimeoutMs)
        })
        if (!upload.ok) throw new Error(`Amplify artifact upload returned HTTP ${upload.status}`)
        await beforeStart()
    } catch (error) {
        throw markDeploymentError(error, false)
    }

    try {
        await runAws([
            'amplify',
            'start-deployment',
            '--app-id',
            site.appId,
            '--branch-name',
            site.branch,
            '--job-id',
            created.jobId
        ])

        const deadline = now() + 30 * 60_000
        while (now() < deadline) {
            const result = await runAws([
                'amplify',
                'get-job',
                '--app-id',
                site.appId,
                '--branch-name',
                site.branch,
                '--job-id',
                created.jobId
            ])
            const status = result.job?.summary?.status
            if (TERMINAL.has(status)) {
                if (status !== 'SUCCEED')
                    throw new Error(`Amplify deployment ${created.jobId} ended with ${status}`)
                return created.jobId
            }
            await sleep(5_000)
        }
        throw new Error(`Timed out waiting for Amplify deployment ${created.jobId}`)
    } catch (error) {
        throw markDeploymentError(error, true)
    }
}

function sameJsonValue(left, right) {
    return JSON.stringify(left) === JSON.stringify(right)
}

function reconciliationIncident(message, causes = []) {
    const error = causes.length > 0 ? new AggregateError(causes, message) : new Error(message)
    error.reconciliationRequired = true
    error.durableLeaseRequired = true
    return error
}

function leaseEligibleForCleanup(lease, error) {
    return error.durableLeaseRequired ? null : lease
}

async function commitReleaseState(
    bucket,
    key,
    state,
    lease,
    { write = writeState, read = readState } = {}
) {
    try {
        await write(bucket, key, state, lease)
        return { recovered: false }
    } catch (writeError) {
        let observed
        try {
            observed = await read(bucket, key)
        } catch (readError) {
            throw reconciliationIncident(
                `Release state commit failed and its outcome cannot be read; do not mutate production again until s3://${bucket}/${key} is reconciled`,
                [writeError, readError]
            )
        }
        if (observed && !observed.lease && sameJsonValue(observed.state, state)) {
            return { recovered: true }
        }
        if (
            observed?.lease?.owner === lease.owner &&
            observed.eTag === lease.eTag &&
            sameJsonValue(observed.state, lease.previousState)
        ) {
            const error = new Error(
                `Release state commit failed before replacing s3://${bucket}/${key}: ${writeError.message}`,
                { cause: writeError }
            )
            error.compensationAllowed = true
            throw error
        }
        throw reconciliationIncident(
            `Release state commit failed and s3://${bucket}/${key} contains unexpected or concurrently owned state; production and release state require manual reconciliation`,
            [writeError]
        )
    }
}

async function prepareArchivedArtifact(
    config,
    siteName,
    site,
    bucket,
    checksum,
    temporary,
    contract,
    label,
    { download = downloadArtifact } = {}
) {
    const smokeTarget = artifactSmokeSite(site, contract)
    const key = objectKey(config, siteName, `artifacts/${checksum}.zip`)
    const artifact = path.join(temporary, `${label}-${checksum}.zip`)
    await download(bucket, key, checksum, artifact)
    return { artifact, checksum, smokeTarget }
}

async function executeCompensatedDeployment(
    site,
    target,
    fallback,
    commit,
    {
        deploy = deployToAmplify,
        smoke = smokeSite,
        beforeTargetStart = async () => {},
        beforeFallbackStart = async () => {},
        beforeCommit = async () => {}
    } = {}
) {
    let verification
    try {
        const jobId = await deploy(site, target.artifact, { beforeStart: beforeTargetStart })
        const probes = await smoke(target.smokeTarget)
        verification = { jobId, probes }
        await beforeCommit()
        await commit(verification)
        return verification
    } catch (error) {
        if (error.reconciliationRequired) throw error
        if (error.productionMutationPossible === false) throw error
        if (!fallback) {
            throw reconciliationIncident(
                `First deployment failed after an Amplify mutation may have begun (${error.message}); no prior artifact exists for compensation, so reconcile production before another release`,
                [error]
            )
        }
        try {
            await deploy(site, fallback.artifact, { beforeStart: beforeFallbackStart })
            await smoke(fallback.smokeTarget)
        } catch (compensationError) {
            throw reconciliationIncident(
                `Deployment failed (${error.message}); restoring prior artifact ${fallback.checksum} also failed (${compensationError.message}); production and release state require manual reconciliation`,
                [error, compensationError]
            )
        }
        throw new Error(
            `Deployment failed (${error.message}); restored and verified prior artifact ${fallback.checksum}`,
            { cause: error }
        )
    }
}

async function main() {
    const [action, siteName, configPath = 'ops/web-release.json'] = process.argv.slice(2)
    if (!['deploy', 'rollback'].includes(action) || !siteName) {
        throw new Error('Usage: bun scripts/amplify-release.mjs <deploy|rollback> <site> [config]')
    }
    const bucket = process.env.FYLO_WEB_RELEASE_BUCKET
    if (!bucket) throw new Error('FYLO_WEB_RELEASE_BUCKET is required')
    const config = JSON.parse(await readFile(configPath, 'utf8'))
    const site = config.sites?.[siteName]
    if (!site) throw new Error(`Unknown site ${JSON.stringify(siteName)}`)
    const activeContract = activeArtifactContract(site)
    await assertConditionalS3Support()
    await verifyAmplifyHeaderPolicy(site)
    const currentKey = objectKey(config, siteName, 'state/current.json')
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'fylo-amplify-release-'))
    let lease
    let operationError
    try {
        lease = await acquireLease(bucket, currentKey)
        const current = lease.previousState
        if (action === 'rollback') {
            if (!current?.previousChecksum) {
                throw new Error(
                    `No prior successful ${siteName} artifact is available for rollback`
                )
            }
            const target = current.previousChecksum
            const targetContract = artifactContractFor(site, current, target)
            const currentContract = artifactContractFor(site, current, current.checksum)
            const targetArtifact = await prepareArchivedArtifact(
                config,
                siteName,
                site,
                bucket,
                target,
                temporary,
                targetContract,
                'target'
            )
            const fallbackArtifact = await prepareArchivedArtifact(
                config,
                siteName,
                site,
                bucket,
                current.checksum,
                temporary,
                currentContract,
                'fallback'
            )
            lease = await refreshLease(bucket, currentKey, lease)
            const verification = await executeCompensatedDeployment(
                site,
                targetArtifact,
                fallbackArtifact,
                async (result) => {
                    const nextState = rollbackReleaseState(
                        current,
                        target,
                        result,
                        artifactContractMap([
                            [target, targetContract],
                            [current.checksum, currentContract]
                        ])
                    )
                    try {
                        await commitReleaseState(bucket, currentKey, nextState, lease)
                        lease = null
                    } catch (error) {
                        if (error.reconciliationRequired) lease = null
                        throw error
                    }
                },
                {
                    beforeTargetStart: async () => {
                        lease = await refreshLease(bucket, currentKey, lease, {
                            phase: 'mutating'
                        })
                    },
                    beforeFallbackStart: async () => {
                        lease = await refreshLease(bucket, currentKey, lease, {
                            phase: 'mutating'
                        })
                    },
                    beforeCommit: async () => {
                        try {
                            lease = await refreshLease(bucket, currentKey, lease, {
                                phase: 'mutating'
                            })
                        } catch (error) {
                            throw reconciliationIncident(
                                `Release lease ownership became uncertain before rollback state commit; do not mutate production again until s3://${bucket}/${currentKey} is reconciled`,
                                [error]
                            )
                        }
                    }
                }
            )
            console.log(
                JSON.stringify({
                    action,
                    site: siteName,
                    checksum: target,
                    jobId: verification.jobId,
                    verifiedProbeCount: verification.probes.length
                })
            )
            return
        }

        const artifact = await createWebArtifact(path.resolve(site.sourceDir), temporary)
        const artifactKey = objectKey(config, siteName, `artifacts/${artifact.checksum}.zip`)
        await archiveArtifact(bucket, artifactKey, artifact.output, artifact.checksum)
        const rollbackContract = current
            ? artifactContractFor(site, current, current.checksum)
            : null
        const fallbackArtifact = current
            ? await prepareArchivedArtifact(
                  config,
                  siteName,
                  site,
                  bucket,
                  current.checksum,
                  temporary,
                  rollbackContract,
                  'fallback'
              )
            : null
        const previousChecksum =
            current && current.checksum !== artifact.checksum
                ? current.checksum
                : current?.previousChecksum
        const previousContract = previousChecksum
            ? previousChecksum === current?.checksum
                ? rollbackContract
                : artifactContractFor(site, current, previousChecksum)
            : null
        lease = await refreshLease(bucket, currentKey, lease)
        const verification = await executeCompensatedDeployment(
            site,
            {
                artifact: artifact.output,
                checksum: artifact.checksum,
                smokeTarget: artifactSmokeSite(site, activeContract)
            },
            fallbackArtifact,
            async (result) => {
                const nextState = {
                    checksum: artifact.checksum,
                    previousChecksum,
                    artifactContracts: artifactContractMap([
                        [artifact.checksum, activeContract],
                        [previousChecksum, previousContract]
                    ]),
                    deployedAt: new Date().toISOString(),
                    appId: site.appId,
                    branch: site.branch,
                    jobId: result.jobId,
                    verifiedProbeCount: result.probes.length
                }
                try {
                    await commitReleaseState(bucket, currentKey, nextState, lease)
                    lease = null
                } catch (error) {
                    if (error.reconciliationRequired) lease = null
                    throw error
                }
            },
            {
                beforeTargetStart: async () => {
                    lease = await refreshLease(bucket, currentKey, lease, {
                        phase: 'mutating'
                    })
                },
                beforeFallbackStart: async () => {
                    lease = await refreshLease(bucket, currentKey, lease, {
                        phase: 'mutating'
                    })
                },
                beforeCommit: async () => {
                    try {
                        lease = await refreshLease(bucket, currentKey, lease, {
                            phase: 'mutating'
                        })
                    } catch (error) {
                        throw reconciliationIncident(
                            `Release lease ownership became uncertain before state commit; do not mutate production again until s3://${bucket}/${currentKey} is reconciled`,
                            [error]
                        )
                    }
                }
            }
        )
        console.log(
            JSON.stringify({
                action,
                site: siteName,
                checksum: artifact.checksum,
                jobId: verification.jobId,
                verifiedProbeCount: verification.probes.length
            })
        )
    } catch (error) {
        lease = leaseEligibleForCleanup(lease, error)
        operationError = error
        throw error
    } finally {
        await rm(temporary, { recursive: true, force: true })
        try {
            if (lease) await releaseLease(bucket, currentKey, lease)
        } catch (releaseError) {
            if (operationError) {
                throw new AggregateError(
                    [operationError, releaseError],
                    `${operationError.message}; release lease cleanup also failed: ${releaseError.message}`
                )
            }
            throw releaseError
        }
    }
}

export {
    acquireLease,
    activeArtifactContract,
    archiveArtifact,
    artifactContractFor,
    artifactContractMap,
    artifactSmokeSite,
    assertConditionalS3Support,
    awsErrorCode,
    command,
    commitReleaseState,
    deployToAmplify,
    executeCompensatedDeployment,
    leaseEligibleForCleanup,
    prepareArchivedArtifact,
    readState,
    refreshLease,
    releaseLease,
    rollbackReleaseState,
    verifyAmplifyHeaderPolicy,
    writeState
}

if (import.meta.main)
    main().catch((error) => {
        console.error(error.message)
        process.exitCode = 1
    })
