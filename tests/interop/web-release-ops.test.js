import { describe, expect, test } from 'bun:test'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { runInNewContext } from 'node:vm'
import {
    acquireLease,
    activeArtifactContract,
    archiveArtifact,
    artifactContractFor,
    artifactContractMap,
    artifactSmokeSite,
    assertConditionalS3Support,
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
} from '../../scripts/amplify-release.mjs'
import { createWebArtifact } from '../../scripts/web-artifact.mjs'
import { verifyPagesRelease } from '../../scripts/pages-smoke.mjs'
import { smokeSite } from '../../scripts/web-smoke.mjs'

const execFileAsync = promisify(execFile)

function memoryS3() {
    const objects = new Map()
    let version = 0
    const error = (operation, code) => ({
        status: 255,
        stdout: '',
        stderr: `An error occurred (${code}) when calling the ${operation} operation: rejected`
    })
    const stored = (key, body) => {
        const eTag = `"v${(version += 1)}"`
        objects.set(key, { body, eTag, lastModified: new Date(version * 1_000).toISOString() })
        return eTag
    }
    return {
        get(key) {
            return objects.get(key)
        },
        setJson(key, value) {
            return stored(key, `${JSON.stringify(value)}\n`)
        },
        setRaw(key, value) {
            return stored(key, value)
        },
        async run(_program, args) {
            const operation = args[1]
            const key = args[args.indexOf('--key') + 1]
            const current = objects.get(key)
            if (operation === 'get-object') {
                if (!current) return error('GetObject', 'NoSuchKey')
                const destination = args[args.indexOf('--key') + 2]
                await writeFile(destination, current.body)
                return { status: 0, stdout: JSON.stringify({ ETag: current.eTag }), stderr: '' }
            }
            if (operation === 'put-object') {
                const absent = args.includes('--if-none-match')
                const expected = args[args.indexOf('--if-match') + 1]
                if ((absent && current) || (!absent && current?.eTag !== expected)) {
                    return error('PutObject', 'PreconditionFailed')
                }
                const body = await Bun.file(args[args.indexOf('--body') + 1]).text()
                const eTag = stored(key, body)
                return { status: 0, stdout: JSON.stringify({ ETag: eTag }), stderr: '' }
            }
            if (operation === 'delete-object') {
                const expected = args[args.indexOf('--if-match') + 1]
                if (!current || current.eTag !== expected) {
                    return error('DeleteObject', 'PreconditionFailed')
                }
                objects.delete(key)
                return { status: 0, stdout: '{}', stderr: '' }
            }
            throw new Error(`Unexpected fake S3 operation ${operation}`)
        }
    }
}

describe('web release operations', () => {
    test('creates checksum-addressed deterministic artifacts', async () => {
        const temporary = await mkdtemp(path.join(os.tmpdir(), 'fylo-artifact-test-'))
        try {
            const source = path.join(temporary, 'web')
            await mkdir(path.join(source, 'assets'), { recursive: true })
            await writeFile(path.join(source, 'index.html'), '<h1>Fylo</h1>')
            await writeFile(path.join(source, 'assets', 'app.js'), 'export default 1')
            const first = await createWebArtifact(source, path.join(temporary, 'one'))
            await writeFile(path.join(source, 'index.html'), '<h1>Fylo</h1>')
            const second = await createWebArtifact(source, path.join(temporary, 'two'))
            expect(first.checksum).toBe(second.checksum)
            expect(path.basename(first.output)).toBe(`${first.checksum}.zip`)
            expect(first.files).toBe(2)
        } finally {
            await rm(temporary, { recursive: true, force: true })
        }
    })

    test('refuses symlinks in deployment artifacts', async () => {
        const temporary = await mkdtemp(path.join(os.tmpdir(), 'fylo-artifact-link-test-'))
        try {
            await writeFile(path.join(temporary, 'index.html'), 'Fylo')
            await symlink(path.join(temporary, 'index.html'), path.join(temporary, 'alias.html'))
            await expect(createWebArtifact(temporary, path.join(temporary, 'out'))).rejects.toThrow(
                'Refusing symlink'
            )
        } finally {
            await rm(temporary, { recursive: true, force: true })
        }
    })

    test('refuses Dropbox conflict files in deployment artifacts', async () => {
        const temporary = await mkdtemp(path.join(os.tmpdir(), 'fylo-artifact-conflict-test-'))
        try {
            await writeFile(path.join(temporary, 'index.html'), 'Fylo')
            await writeFile(
                path.join(temporary, "index (Iyor Ezenma's conflicted copy 2026-08-09).html"),
                'stale Fylo'
            )
            await expect(createWebArtifact(temporary, path.join(temporary, 'out'))).rejects.toThrow(
                'Refusing sync-conflict file'
            )
        } finally {
            await rm(temporary, { recursive: true, force: true })
        }
    })

    test('web artifacts place the hostable site at the ZIP root', async () => {
        const temporary = await mkdtemp(path.join(os.tmpdir(), 'fylo-artifact-root-test-'))
        try {
            const source = path.join(temporary, 'web')
            await mkdir(path.join(source, 'shared', 'assets'), { recursive: true })
            await writeFile(path.join(source, 'index.html'), '<title>FX | Fylo Explorer</title>')
            await writeFile(path.join(source, 'shared', 'assets', 'app.js'), 'export default 1')
            const artifact = await createWebArtifact(source, path.join(temporary, 'release'))
            const { stdout } = await execFileAsync('unzip', ['-Z1', artifact.output])
            const files = stdout.trim().split('\n')

            expect(files).toContain('index.html')
            expect(files).toContain('shared/assets/app.js')
            expect(files).not.toContain('web/index.html')
        } finally {
            await rm(temporary, { recursive: true, force: true })
        }
    })

    test('web artifacts exclude Tachyon build metadata but retain its runtime files', async () => {
        const temporary = await mkdtemp(path.join(os.tmpdir(), 'fylo-artifact-tachyon-test-'))
        try {
            const source = path.join(temporary, 'web')
            await mkdir(path.join(source, '.tachyon', 'source-maps', 'nested'), {
                recursive: true
            })
            await mkdir(path.join(source, '.tachyon', 'view-ir'), { recursive: true })
            await writeFile(path.join(source, 'index.html'), '<h1>Fylo</h1>')
            await writeFile(path.join(source, '.tachyon', 'islands.js'), 'export const runtime = 1')
            await writeFile(path.join(source, '.tachyon', 'build-state.json'), '{"build":true}')
            await writeFile(
                path.join(source, '.tachyon', 'source-maps', 'nested', 'page.map'),
                '{"version":3}'
            )
            await writeFile(path.join(source, '.tachyon', 'view-ir', 'page.json'), '{"ir":true}')

            const artifact = await createWebArtifact(source, path.join(temporary, 'release'))
            const { stdout } = await execFileAsync('unzip', ['-Z1', artifact.output])
            const files = stdout.trim().split('\n')

            expect(files).toContain('index.html')
            expect(files).toContain('.tachyon/islands.js')
            expect(files).not.toContain('.tachyon/build-state.json')
            expect(files.some((file) => file.startsWith('.tachyon/source-maps/'))).toBe(false)
            expect(files.some((file) => file.startsWith('.tachyon/view-ir/'))).toBe(false)
            expect(artifact.files).toBe(2)
        } finally {
            await rm(temporary, { recursive: true, force: true })
        }
    })

    test('treats only explicit S3 missing-object errors as absent release state', async () => {
        const failure = (code, stderr) => async () => ({
            status: 255,
            stdout: '',
            stderr:
                stderr ??
                `An error occurred (${code}) when calling the GetObject operation: rejected`
        })

        for (const code of ['NoSuchKey', 'NotFound']) {
            await expect(
                readState('release-bucket', 'fylo/state/current.json', {
                    run: failure(code)
                })
            ).resolves.toBeNull()
        }
        await expect(
            readState('release-bucket', 'fylo/state/current.json', {
                run: failure('AccessDenied')
            })
        ).rejects.toThrow('AccessDenied')
        await expect(
            readState('release-bucket', 'fylo/state/current.json', {
                run: failure('', 'Could not connect to the endpoint URL')
            })
        ).rejects.toThrow('Could not connect to the endpoint URL')
    })

    test('fails closed for malformed persisted release state', async () => {
        const s3 = memoryS3()
        const key = 'fylo/state/current.json'
        s3.setRaw(key, '{not-json')
        await expect(readState('release-bucket', key, { run: s3.run })).rejects.toThrow(
            'Invalid release state'
        )

        s3.setJson(key, { checksum: 'not-a-checksum' })
        await expect(readState('release-bucket', key, { run: s3.run })).rejects.toThrow(
            'Invalid release state'
        )

        s3.setJson(key, {
            checksum: 'a'.repeat(64),
            artifactContracts: {
                ['b'.repeat(64)]: { requiredHeaders: {}, probes: [] }
            }
        })
        await expect(readState('release-bucket', key, { run: s3.run })).rejects.toThrow(
            'Invalid artifact b'
        )
    })

    test('selects the archived checksum contract for automatic rollback without weakening headers', async () => {
        const config = await Bun.file('ops/web-release.json').json()
        const site = config.sites.fylo
        const legacyChecksum = '0c14fea889d6ff7b69b75c40b506b92247353ec34d938c4221b93a3c7cd6aa6c'
        const contract = artifactContractFor(site, { checksum: legacyChecksum }, legacyChecksum)
        expect(contract.requiredScriptSrcTokens).toEqual(["'unsafe-eval'"])
        const smokeTarget = artifactSmokeSite(site, {
            ...contract,
            requiredHeaders: {
                'content-security-policy': 'weaker-value',
                'x-legacy-contract': 'required'
            },
            probes: contract.probes.map((probe, index) =>
                index === 0
                    ? {
                          ...probe,
                          requiredHeaders: {
                              'content-security-policy': 'per-probe-weaker-value',
                              'x-legacy-probe': 'required'
                          }
                      }
                    : probe
            )
        })

        expect(smokeTarget.probes.some((probe) => probe.path === '/imports.js')).toBe(true)
        expect(
            smokeTarget.probes.some((probe) => probe.path === '/shared/scripts/imports.js')
        ).toBe(false)
        expect(smokeTarget.requiredHeaders['content-security-policy']).toBe(
            site.requiredHeaders['content-security-policy']
        )
        expect(smokeTarget.requiredHeaders['x-legacy-contract']).toBe('required')
        expect(smokeTarget.probes[0].requiredHeaders['content-security-policy']).toBe(
            site.requiredHeaders['content-security-policy']
        )
        expect(smokeTarget.probes[0].requiredHeaders['x-legacy-probe']).toBe('required')
        const activeCsp = site.requiredHeaders['content-security-policy']
        const withCsp = (csp) => ({
            ...site,
            requiredHeaders: {
                ...site.requiredHeaders,
                'content-security-policy': csp
            }
        })
        expect(() =>
            artifactSmokeSite(withCsp(activeCsp.replace(" 'unsafe-eval'", '')), contract)
        ).toThrow("required token 'unsafe-eval'")
        expect(() =>
            artifactSmokeSite(
                withCsp(
                    activeCsp
                        .replace(" 'unsafe-eval'", '')
                        .replace("style-src 'self'", "style-src 'self' 'unsafe-eval'")
                ),
                contract
            )
        ).toThrow("required token 'unsafe-eval'")
        expect(() =>
            artifactSmokeSite(withCsp(`${activeCsp}; script-src 'unsafe-eval'`), contract)
        ).toThrow('exactly one non-empty script-src')
        expect(() =>
            artifactSmokeSite(
                withCsp(activeCsp.replace(/script-src [^;]+/, 'script-src')),
                contract
            )
        ).toThrow('exactly one non-empty script-src')
        expect(() =>
            artifactSmokeSite(withCsp(activeCsp.replace(/script-src [^;]+; /, '')), contract)
        ).toThrow('exactly one non-empty script-src')
    })

    test('rejects an incompatible archived contract before download or deployment', async () => {
        const config = await Bun.file('ops/web-release.json').json()
        const site = config.sites.fylo
        const checksum = '0c14fea889d6ff7b69b75c40b506b92247353ec34d938c4221b93a3c7cd6aa6c'
        const contract = artifactContractFor(site, null, checksum)
        const incompatibleSite = {
            ...site,
            requiredHeaders: {
                ...site.requiredHeaders,
                'content-security-policy': site.requiredHeaders['content-security-policy'].replace(
                    " 'unsafe-eval'",
                    ''
                )
            }
        }
        let downloads = 0
        let deployments = 0
        let smokes = 0

        await expect(
            (async () => {
                const target = await prepareArchivedArtifact(
                    config,
                    'fylo',
                    incompatibleSite,
                    'release-bucket',
                    checksum,
                    '/tmp',
                    contract,
                    'target',
                    { download: async () => downloads++ }
                )
                return executeCompensatedDeployment(
                    incompatibleSite,
                    target,
                    null,
                    async () => {},
                    {
                        deploy: async () => deployments++,
                        smoke: async () => smokes++
                    }
                )
            })()
        ).rejects.toThrow("required token 'unsafe-eval'")
        expect(downloads).toBe(0)
        expect(deployments).toBe(0)
        expect(smokes).toBe(0)
    })

    test('restores the preverified prior artifact when target smoke verification fails', async () => {
        const deployments = []
        const smokes = []
        let commits = 0
        const target = {
            artifact: '/tmp/target.zip',
            checksum: 'a'.repeat(64),
            smokeTarget: { generation: 'target' }
        }
        const fallback = {
            artifact: '/tmp/fallback.zip',
            checksum: 'b'.repeat(64),
            smokeTarget: { generation: 'fallback' }
        }

        await expect(
            executeCompensatedDeployment({}, target, fallback, async () => commits++, {
                deploy: async (_site, artifact) => {
                    deployments.push(artifact)
                    return `job-${deployments.length}`
                },
                smoke: async (smokeTarget) => {
                    smokes.push(smokeTarget.generation)
                    if (smokeTarget.generation === 'target') {
                        throw new Error('target smoke failed')
                    }
                    return [{ path: '/' }]
                }
            })
        ).rejects.toThrow(`restored and verified prior artifact ${fallback.checksum}`)
        expect(deployments).toEqual([target.artifact, fallback.artifact])
        expect(smokes).toEqual(['target', 'fallback'])
        expect(commits).toBe(0)
    })

    test('restores the preverified prior artifact when the conditional state commit fails', async () => {
        const deployments = []
        const smokes = []
        let commits = 0
        const target = {
            artifact: '/tmp/target.zip',
            checksum: 'a'.repeat(64),
            smokeTarget: { generation: 'target' }
        }
        const fallback = {
            artifact: '/tmp/fallback.zip',
            checksum: 'b'.repeat(64),
            smokeTarget: { generation: 'fallback' }
        }

        await expect(
            executeCompensatedDeployment(
                {},
                target,
                fallback,
                async () => {
                    commits++
                    throw new Error('conditional state commit failed')
                },
                {
                    deploy: async (_site, artifact) => {
                        deployments.push(artifact)
                        return `job-${deployments.length}`
                    },
                    smoke: async (smokeTarget) => {
                        smokes.push(smokeTarget.generation)
                        return [{ path: '/' }]
                    }
                }
            )
        ).rejects.toThrow(`restored and verified prior artifact ${fallback.checksum}`)
        expect(deployments).toEqual([target.artifact, fallback.artifact])
        expect(smokes).toEqual(['target', 'fallback'])
        expect(commits).toBe(1)
    })

    test('propagates refreshed mutating lease ETags through target, commit, and fallback starts', async () => {
        const stages = []
        let lease = { eTag: '"v1"', phase: 'preparing' }
        const refresh = async (stage) => {
            const version = Number.parseInt(lease.eTag.match(/\d+/)[0], 10) + 1
            lease = { eTag: `"v${version}"`, phase: 'mutating' }
            stages.push(`${stage}:${lease.eTag}`)
        }
        const target = {
            artifact: '/tmp/target.zip',
            checksum: 'a'.repeat(64),
            smokeTarget: { generation: 'target' }
        }
        const fallback = {
            artifact: '/tmp/fallback.zip',
            checksum: 'b'.repeat(64),
            smokeTarget: { generation: 'fallback' }
        }

        await expect(
            executeCompensatedDeployment(
                {},
                target,
                fallback,
                async () => {
                    stages.push(`commit:${lease.eTag}`)
                    throw new Error('known state commit failure')
                },
                {
                    deploy: async (_site, artifact, { beforeStart }) => {
                        await beforeStart()
                        stages.push(`start-${path.basename(artifact)}:${lease.eTag}`)
                        return `job-${path.basename(artifact)}`
                    },
                    smoke: async () => [{ path: '/' }],
                    beforeTargetStart: async () => refresh('target-fence'),
                    beforeCommit: async () => refresh('commit-fence'),
                    beforeFallbackStart: async () => refresh('fallback-fence')
                }
            )
        ).rejects.toThrow(`restored and verified prior artifact ${fallback.checksum}`)
        expect(stages).toEqual([
            'target-fence:"v2"',
            'start-target.zip:"v2"',
            'commit-fence:"v3"',
            'commit:"v3"',
            'fallback-fence:"v4"',
            'start-fallback.zip:"v4"'
        ])
    })

    test('does not compensate or raise an incident for a classified pre-start failure', async () => {
        const failure = new Error('upload failed before start')
        failure.productionMutationPossible = false
        let deployments = 0
        const error = await executeCompensatedDeployment(
            {},
            { artifact: '/tmp/target.zip', smokeTarget: {} },
            {
                artifact: '/tmp/fallback.zip',
                checksum: 'b'.repeat(64),
                smokeTarget: {}
            },
            async () => {},
            {
                deploy: async () => {
                    deployments++
                    throw failure
                }
            }
        ).catch((caught) => caught)

        expect(error).toBe(failure)
        expect(error.reconciliationRequired).toBeUndefined()
        expect(deployments).toBe(1)
        const preparingLease = { phase: 'preparing' }
        expect(leaseEligibleForCleanup(preparingLease, error)).toBe(preparingLease)
    })

    test('audits ambiguous state-write outcomes before allowing compensation', async () => {
        const previousState = { checksum: 'a'.repeat(64) }
        const intendedState = { checksum: 'b'.repeat(64), previousChecksum: 'a'.repeat(64) }
        const lease = {
            owner: 'release-a',
            eTag: '"leased"',
            previousState
        }
        const failedWrite = async () => {
            throw new Error('connection reset after write')
        }

        await expect(
            commitReleaseState('bucket', 'state.json', intendedState, lease, {
                write: failedWrite,
                read: async () => ({ state: intendedState, lease: null, eTag: '"committed"' })
            })
        ).resolves.toEqual({ recovered: true })

        const knownFailure = await commitReleaseState(
            'bucket',
            'state.json',
            intendedState,
            lease,
            {
                write: failedWrite,
                read: async () => ({
                    state: previousState,
                    lease: { owner: lease.owner },
                    eTag: lease.eTag
                })
            }
        ).catch((error) => error)
        expect(knownFailure.compensationAllowed).toBe(true)
        expect(knownFailure.message).toContain('failed before replacing')

        const concurrentFailure = await commitReleaseState(
            'bucket',
            'state.json',
            intendedState,
            lease,
            {
                write: failedWrite,
                read: async () => ({
                    state: previousState,
                    lease: { owner: 'release-b' },
                    eTag: '"concurrent"'
                })
            }
        ).catch((error) => error)
        expect(concurrentFailure.reconciliationRequired).toBe(true)
        expect(concurrentFailure.message).toContain('concurrently owned state')
    })

    test('reports distinct incidents when no compensation exists or compensation fails', async () => {
        const target = {
            artifact: '/tmp/target.zip',
            checksum: 'a'.repeat(64),
            smokeTarget: { generation: 'target' }
        }
        const postStartError = new Error('target deployment failed after start')
        postStartError.productionMutationPossible = true
        const firstDeployFailure = await executeCompensatedDeployment(
            {},
            target,
            null,
            async () => {},
            {
                deploy: async () => {
                    throw postStartError
                }
            }
        ).catch((error) => error)
        expect(firstDeployFailure.reconciliationRequired).toBe(true)
        expect(firstDeployFailure.durableLeaseRequired).toBe(true)
        expect(leaseEligibleForCleanup({ phase: 'mutating' }, firstDeployFailure)).toBeNull()
        expect(firstDeployFailure.message).toContain('First deployment failed')
        expect(firstDeployFailure.message).toContain('no prior artifact exists')

        const fallback = {
            artifact: '/tmp/fallback.zip',
            checksum: 'b'.repeat(64),
            smokeTarget: { generation: 'fallback' }
        }
        let deployment = 0
        const compensationFailure = await executeCompensatedDeployment(
            {},
            target,
            fallback,
            async () => {},
            {
                deploy: async () => {
                    deployment++
                    if (deployment === 2) throw new Error('fallback deployment failed')
                    return 'job-target'
                },
                smoke: async () => {
                    throw new Error('target smoke failed')
                }
            }
        ).catch((error) => error)
        expect(compensationFailure).toBeInstanceOf(AggregateError)
        expect(compensationFailure.reconciliationRequired).toBe(true)
        expect(compensationFailure.message).toContain('restoring prior artifact')
        expect(compensationFailure.message).toContain('also failed')
    })

    test('manual rollback swaps checksums and retains the exact target and reverse contracts', () => {
        const currentChecksum = 'a'.repeat(64)
        const targetChecksum = 'b'.repeat(64)
        const currentContract = {
            requiredHeaders: { 'x-generation': 'current' },
            probes: [{ path: '/shared/scripts/imports.js', contains: 'import' }]
        }
        const targetContract = {
            requiredHeaders: { 'x-generation': 'legacy' },
            probes: [{ path: '/imports.js', contains: 'tachyon' }]
        }
        const contracts = artifactContractMap([
            [targetChecksum, targetContract],
            [currentChecksum, currentContract]
        ])
        const state = rollbackReleaseState(
            {
                checksum: currentChecksum,
                previousChecksum: targetChecksum,
                artifactContracts: { stale: 'discarded' },
                appId: 'app-123',
                branch: 'master'
            },
            targetChecksum,
            { jobId: 'rollback-42', probes: [{ path: '/' }, { path: '/imports.js' }] },
            contracts,
            () => new Date('2026-08-11T12:00:00.000Z')
        )

        expect(state).toEqual({
            checksum: targetChecksum,
            previousChecksum: currentChecksum,
            artifactContracts: {
                [targetChecksum]: targetContract,
                [currentChecksum]: currentContract
            },
            deployedAt: '2026-08-11T12:00:00.000Z',
            appId: 'app-123',
            branch: 'master',
            jobId: 'rollback-42',
            verifiedProbeCount: 2
        })
        expect(artifactContractFor({}, state, state.checksum)).toBe(targetContract)
        expect(artifactContractFor({}, state, state.previousChecksum)).toBe(currentContract)
    })

    test('does not treat archived-artifact authorization or network failures as absence', async () => {
        for (const stderr of [
            'An error occurred (AccessDenied) when calling the HeadObject operation: denied',
            'Could not connect to the endpoint URL'
        ]) {
            await expect(
                archiveArtifact(
                    'release-bucket',
                    'fylo/artifacts/hash.zip',
                    'unused.zip',
                    'a'.repeat(64),
                    {
                        run: async () => ({ status: 255, stdout: '', stderr })
                    }
                )
            ).rejects.toThrow(
                stderr.includes('AccessDenied') ? 'AccessDenied' : 'Could not connect'
            )
        }
    })

    test('requires AWS CLI support for conditional S3 state operations', async () => {
        const supported = async (_program, args) => ({
            status: 0,
            stdout: JSON.stringify(
                args[1] === 'put-object' ? { IfMatch: '', IfNoneMatch: '' } : { IfMatch: '' }
            ),
            stderr: ''
        })
        await expect(assertConditionalS3Support(supported)).resolves.toBeUndefined()
        await expect(
            assertConditionalS3Support(async () => ({ status: 0, stdout: '{}', stderr: '' }))
        ).rejects.toThrow('upgrade AWS CLI')
    })

    test('kills timed-out subprocesses and bounds the presigned Amplify upload', async () => {
        const started = performance.now()
        await expect(
            command(process.execPath, ['-e', 'await Bun.sleep(10_000)'], { timeoutMs: 20 })
        ).rejects.toThrow('timed out after 20ms')
        expect(performance.now() - started).toBeLessThan(2_000)

        let beforeStartCalls = 0
        const uploadError = await deployToAmplify(
            { appId: 'app-123', branch: 'master' },
            '/tmp/not-read-by-fake-fetch.zip',
            {
                beforeStart: async () => beforeStartCalls++,
                uploadTimeoutMs: 20,
                runAws: async () => ({
                    jobId: 'job-1',
                    zipUploadUrl: 'https://upload.example/artifact.zip'
                }),
                fetcher: async (_url, { signal }) =>
                    new Promise((_resolve, reject) => {
                        signal.addEventListener('abort', () => reject(signal.reason), {
                            once: true
                        })
                    })
            }
        ).catch((error) => error)
        expect(uploadError.productionMutationPossible).toBe(false)
        expect(uploadError.name).toBe('TimeoutError')
        expect(beforeStartCalls).toBe(0)
    })

    test('fences immediately before start and classifies an ambiguous start failure as mutating', async () => {
        const events = []
        const startError = await deployToAmplify(
            { appId: 'app-123', branch: 'master' },
            '/tmp/not-read-by-fake-fetch.zip',
            {
                beforeStart: async () => events.push('fence'),
                fetcher: async () => {
                    events.push('upload')
                    return new Response('', { status: 200 })
                },
                runAws: async (args) => {
                    const operation = args[1]
                    events.push(operation)
                    if (operation === 'create-deployment') {
                        return {
                            jobId: 'job-1',
                            zipUploadUrl: 'https://upload.example/artifact.zip'
                        }
                    }
                    throw new Error('start response lost')
                }
            }
        ).catch((error) => error)

        expect(events).toEqual(['create-deployment', 'upload', 'fence', 'start-deployment'])
        expect(startError.productionMutationPossible).toBe(true)
    })

    test('fails before deployment when Amplify custom headers drift', async () => {
        const temporary = await mkdtemp(path.join(os.tmpdir(), 'fylo-amplify-policy-test-'))
        try {
            const policy = path.join(temporary, 'headers.yml')
            const expected = "customHeaders:\n  - pattern: '**'\n"
            await writeFile(policy, expected)
            const site = { appId: 'app-123', headersPolicy: policy }
            const response = (customHeaders) => async () => ({
                status: 0,
                stdout: JSON.stringify(customHeaders),
                stderr: ''
            })

            await expect(
                verifyAmplifyHeaderPolicy(site, { run: response(expected.slice(0, -1)) })
            ).resolves.toBeUndefined()
            await expect(
                verifyAmplifyHeaderPolicy(site, { run: response('customHeaders: []') })
            ).rejects.toThrow('aws amplify update-app')
            await expect(
                verifyAmplifyHeaderPolicy(site, {
                    run: async () => ({ status: 255, stdout: '', stderr: 'AccessDenied' })
                })
            ).rejects.toThrow('AccessDenied')
        } finally {
            await rm(temporary, { recursive: true, force: true })
        }
    })

    test('serializes releases, safely replaces stale leases, and rejects stale state writers', async () => {
        const s3 = memoryS3()
        const stateKey = 'fylo/state/current.json'
        const original = { checksum: 'a'.repeat(64) }
        s3.setJson(stateKey, original)
        const first = await acquireLease('release-bucket', stateKey, {
            run: s3.run,
            owner: 'release-a',
            now: () => 0,
            durationMs: 1_000
        })
        await expect(
            acquireLease('release-bucket', stateKey, {
                run: s3.run,
                owner: 'release-b',
                now: () => 500,
                durationMs: 1_000
            })
        ).rejects.toThrow('Another release owns')

        const second = await acquireLease('release-bucket', stateKey, {
            run: s3.run,
            owner: 'release-b',
            now: () => 1_001,
            durationMs: 1_000
        })
        await expect(
            releaseLease('release-bucket', stateKey, first, { run: s3.run })
        ).rejects.toThrow('lease no longer owned')

        const concurrent = { checksum: 'b'.repeat(64), previousChecksum: original.checksum }
        await writeState('release-bucket', stateKey, concurrent, second, { run: s3.run })
        await expect(
            writeState('release-bucket', stateKey, { checksum: 'c'.repeat(64) }, first, {
                run: s3.run
            })
        ).rejects.toThrow('Release lease ownership was lost')
        expect(JSON.parse(s3.get(stateKey).body)).toEqual(concurrent)

        const restoredKey = 'fylo/state/restored.json'
        s3.setJson(restoredKey, original)
        const restoredLease = await acquireLease('release-bucket', restoredKey, {
            run: s3.run,
            owner: 'release-restore',
            now: () => 2_000
        })
        await releaseLease('release-bucket', restoredKey, restoredLease, { run: s3.run })
        expect(JSON.parse(s3.get(restoredKey).body)).toEqual(original)

        const firstDeployKey = 'fylo/state/first.json'
        const firstDeployLease = await acquireLease('release-bucket', firstDeployKey, {
            run: s3.run,
            owner: 'release-first',
            now: () => 2_000
        })
        await releaseLease('release-bucket', firstDeployKey, firstDeployLease, { run: s3.run })
        expect(s3.get(firstDeployKey)).toBeUndefined()
    })

    test('never steals an expired mutating lease but replaces an expired preparing lease', async () => {
        const s3 = memoryS3()
        const state = { checksum: 'a'.repeat(64) }
        const expiredLease = (phase) => ({
            owner: `old-${phase}`,
            phase,
            acquiredAt: '1970-01-01T00:00:00.000Z',
            expiresAt: '1970-01-01T00:00:01.000Z'
        })
        const mutatingKey = 'fylo/state/mutating.json'
        s3.setJson(mutatingKey, { ...state, lease: expiredLease('mutating') })
        const blocked = await acquireLease('release-bucket', mutatingKey, {
            run: s3.run,
            owner: 'new-release',
            now: () => 2_000
        }).catch((error) => error)
        expect(blocked.reconciliationRequired).toBe(true)
        expect(blocked.durableLeaseRequired).toBe(true)
        expect(blocked.message).toContain('fenced by a mutating lease')

        const preparingKey = 'fylo/state/preparing.json'
        s3.setJson(preparingKey, { ...state, lease: expiredLease('preparing') })
        const acquired = await acquireLease('release-bucket', preparingKey, {
            run: s3.run,
            owner: 'new-release',
            now: () => 2_000
        })
        expect(acquired.phase).toBe('preparing')
        expect(acquired.owner).toBe('new-release')
    })

    test('rejects a stale ETag while moving a preparing lease to the mutating phase', async () => {
        const s3 = memoryS3()
        const key = 'fylo/state/current.json'
        s3.setJson(key, { checksum: 'a'.repeat(64) })
        const lease = await acquireLease('release-bucket', key, {
            run: s3.run,
            owner: 'release-a',
            now: () => 0
        })
        s3.setJson(key, {
            checksum: 'a'.repeat(64),
            lease: {
                owner: 'release-b',
                phase: 'preparing',
                acquiredAt: '1970-01-01T00:00:00.000Z',
                expiresAt: '1970-01-01T02:00:00.000Z'
            }
        })
        await expect(
            refreshLease('release-bucket', key, lease, {
                run: s3.run,
                now: () => 1_000,
                phase: 'mutating'
            })
        ).rejects.toThrow('lease ownership was lost')
    })

    test('verifies immutable and latest Pages assets, checksums, and equality', async () => {
        const files = new Map([
            ['fylo.js', 'loader'],
            ['fylo-web.mjs', 'engine'],
            ['shared.js', 'shared-worker'],
            ['dedicated.js', 'dedicated-worker'],
            ['fylo-index.wasm', 'wasm-scanner']
        ])
        const hashes = await Promise.all(
            [...files].map(async ([name, body]) => [
                name,
                new Bun.CryptoHasher('sha256').update(body).digest('hex')
            ])
        )
        const manifest = hashes.map(([name, hash]) => `${hash}  ${name}`).join('\n')
        const fetcher = async (input) => {
            const name = new URL(input).pathname.split('/').at(-1)
            const body = name === 'SHA256SUMS' ? manifest : files.get(name)
            return new Response(body, { status: body === undefined ? 404 : 200 })
        }
        await expect(
            verifyPagesRelease('https://pages.example/Fylo/', '26.29.03', fetcher)
        ).resolves.toEqual({
            version: '26.29.03',
            files: ['fylo.js', 'fylo-web.mjs', 'shared.js', 'dedicated.js', 'fylo-index.wasm']
        })
    })

    test('rejects stale latest Pages assets even when both manifests are internally valid', async () => {
        const immutable = new Map([
            ['fylo.js', 'loader'],
            ['fylo-web.mjs', 'engine'],
            ['shared.js', 'shared-worker'],
            ['dedicated.js', 'dedicated-worker'],
            ['fylo-index.wasm', 'wasm-scanner']
        ])
        const latest = new Map(immutable)
        latest.set('fylo-web.mjs', 'stale-engine')
        const manifestFor = (files) =>
            [...files]
                .map(
                    ([name, body]) =>
                        `${new Bun.CryptoHasher('sha256').update(body).digest('hex')}  ${name}`
                )
                .join('\n')
        const fetcher = async (input) => {
            const pathname = new URL(input).pathname
            const files = pathname.includes('/version/latest/') ? latest : immutable
            const name = pathname.split('/').at(-1)
            return new Response(name === 'SHA256SUMS' ? manifestFor(files) : files.get(name))
        }

        await expect(
            verifyPagesRelease('https://pages.example/Fylo/', '26.29.03', fetcher)
        ).rejects.toThrow('latest fylo-web.mjs differs from immutable 26.29.03')
    })

    test('rejects a missing latest Pages asset', async () => {
        const files = new Map([
            ['fylo.js', 'loader'],
            ['fylo-web.mjs', 'engine'],
            ['shared.js', 'shared-worker'],
            ['dedicated.js', 'dedicated-worker'],
            ['fylo-index.wasm', 'wasm-scanner']
        ])
        const manifest = [...files]
            .map(
                ([name, body]) =>
                    `${new Bun.CryptoHasher('sha256').update(body).digest('hex')}  ${name}`
            )
            .join('\n')
        const fetcher = async (input) => {
            const pathname = new URL(input).pathname
            const name = pathname.split('/').at(-1)
            if (pathname.includes('/version/latest/') && name === 'fylo-web.mjs') {
                return new Response('missing', { status: 404 })
            }
            return new Response(name === 'SHA256SUMS' ? manifest : files.get(name))
        }

        await expect(
            verifyPagesRelease('https://pages.example/Fylo/', '26.29.03', fetcher)
        ).rejects.toThrow('latest fylo-web.mjs returned HTTP 404')
    })

    test('fails a site smoke check when the marker is absent', async () => {
        const site = { origin: 'https://fylo.example', probes: [{ path: '/', contains: 'FYLO' }] }
        await expect(smokeSite(site, async () => new Response('wrong'))).rejects.toThrow(
            'expected marker'
        )
    })

    test('fails a site smoke check when a required response header is absent or changed', async () => {
        const site = {
            origin: 'https://fylo.example',
            requiredHeaders: {
                'strict-transport-security': 'max-age=31536000',
                'cache-control': 'no-cache, must-revalidate'
            },
            probes: [{ path: '/', contains: 'FYLO' }]
        }
        await expect(
            smokeSite(
                site,
                async () =>
                    new Response('FYLO', {
                        headers: { 'strict-transport-security': 'max-age=31536000' }
                    })
            )
        ).rejects.toThrow('unexpected cache-control header')
    })

    test('verifies configured CSS, JavaScript, component, worker, and Wasm assets', async () => {
        const site = {
            origin: 'https://fx.example',
            probes: [
                { path: '/', contains: 'Explorer', contentTypes: ['text/html'] },
                {
                    path: '/shared/assets/explorer.css',
                    contains: '.explorer',
                    contentTypes: ['text/css']
                },
                {
                    path: '/imports.js',
                    contains: 'shared/assets/fylo-web.mjs',
                    contentTypes: ['application/javascript']
                },
                {
                    path: '/components/explorer/app/tac.js',
                    contains: 'class Explorer',
                    contentTypes: ['application/javascript']
                },
                {
                    path: '/shared/assets/shared.js',
                    contains: 'src/browser/worker/shared.js',
                    contentTypes: ['application/javascript']
                },
                {
                    path: '/shared/assets/fylo-index.wasm',
                    startsWithHex: '0061736d',
                    contentTypes: ['application/wasm']
                }
            ]
        }
        const assets = new Map([
            ['/', ['<title>Explorer</title>', 'text/html; charset=utf-8']],
            ['/shared/assets/explorer.css', ['.explorer {}', 'text/css']],
            ['/imports.js', ["import('/shared/assets/fylo-web.mjs')", 'application/javascript']],
            [
                '/components/explorer/app/tac.js',
                ['export class Explorer {}', 'application/javascript']
            ],
            [
                '/shared/assets/shared.js',
                ['// src/browser/worker/shared.js', 'application/javascript']
            ],
            [
                '/shared/assets/fylo-index.wasm',
                [Uint8Array.from([0x00, 0x61, 0x73, 0x6d, 0x01]), 'application/wasm']
            ]
        ])
        const fetcher = async (input) => {
            const asset = assets.get(new URL(input).pathname)
            return asset
                ? new Response(asset[0], { headers: { 'content-type': asset[1] } })
                : new Response('missing', { status: 404 })
        }

        await expect(smokeSite(site, fetcher)).resolves.toHaveLength(site.probes.length)
    })

    test('rejects stripped assets before deployment can be marked current', async () => {
        const site = {
            origin: 'https://fx.example',
            probes: [
                {
                    path: '/shared/assets/explorer.css',
                    contains: '.explorer',
                    contentTypes: ['text/css']
                }
            ]
        }

        await expect(
            smokeSite(
                site,
                async () =>
                    new Response('<!doctype html><title>SPA fallback</title>', {
                        headers: { 'content-type': 'text/html' }
                    })
            )
        ).rejects.toThrow('unexpected content type')
    })

    test('production probe manifest accepts a complete FYLO bundle with required headers', async () => {
        const config = await Bun.file('ops/web-release.json').json()
        const root = path.resolve(import.meta.dir, '../..')
        await execFileAsync('bun', ['run', 'bundle'], { cwd: path.join(root, 'website') })

        const homepage = await Bun.file(path.join(root, 'website/dist/web/index.html')).text()
        const islands = await Bun.file(
            path.join(root, 'website/dist/web/.tachyon/islands.js')
        ).text()
        const serviceWorker = await Bun.file(
            path.join(root, 'website/dist/web/tachyon-sw.js')
        ).text()
        const registration = await Bun.file(
            path.join(root, 'website/dist/web/.tachyon/register-sw.js')
        ).text()
        const ownershipGuard = "marker.closest('tachyon-island') !== root"
        expect(islands.split(ownershipGuard)).toHaveLength(2)
        expect(homepage.split('/shared/scripts/imports.js')).toHaveLength(2)
        expect(serviceWorker).toContain('event.respondWith(fromNetwork(request))')
        expect(serviceWorker).not.toContain('cacheFirst')
        expect(serviceWorker).not.toContain('async function fromCache')
        expect(serviceWorker).toContain('url.origin !== self.location.origin')
        expect(serviceWorker).toContain("url.pathname.startsWith('/.tachyon/live-reload')")
        expect(serviceWorker).toContain('name.startsWith(PREFIX) && name !== CACHE')
        expect(registration).toContain("host === 'localhost'")
        expect(registration).toContain('registration.unregister()')
        const mime = new Map([
            ['.css', 'text/css'],
            ['.html', 'text/html'],
            ['.js', 'application/javascript'],
            ['.mjs', 'application/javascript'],
            ['.wasm', 'application/wasm']
        ])
        const staticFetcher =
            (directory, requiredHeaders = {}) =>
            async (input) => {
                let relative = new URL(input).pathname.slice(1)
                if (!relative || !path.extname(relative))
                    relative = path.join(relative, 'index.html')
                const file = Bun.file(path.join(directory, relative))
                if (!(await file.exists())) return new Response('missing', { status: 404 })
                return new Response(await file.arrayBuffer(), {
                    headers: {
                        'content-type': mime.get(path.extname(relative)) ?? 'text/plain',
                        ...requiredHeaders
                    }
                })
            }
        const websiteFetcher = staticFetcher(
            path.join(root, 'website/dist/web'),
            config.sites.fylo.requiredHeaders
        )

        await expect(smokeSite(config.sites.fylo, websiteFetcher)).resolves.toHaveLength(
            config.sites.fylo.probes.length
        )

        const finalPolicy = await Bun.file(config.sites.fylo.finalHeadersPolicy).text()
        const finalStyleHashes = new Set(
            [...finalPolicy.matchAll(/'sha256-([^']+)'/g)].map((match) => match[1])
        )
        const generatedStyleHashes = new Set()
        const htmlFiles = new Bun.Glob('**/*.html')
        for await (const relative of htmlFiles.scan(path.join(root, 'website/dist/web'))) {
            const html = await Bun.file(path.join(root, 'website/dist/web', relative)).text()
            const inlineScripts = [...html.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>/g)]
            expect(inlineScripts.length).toBeGreaterThan(0)
            expect(inlineScripts.every((match) => /\btype="speculationrules"/.test(match[1]))).toBe(
                true
            )
            expect(html).not.toMatch(/\son[a-z]+=/i)
            expect(html).not.toMatch(/\sstyle=/i)
            for (const match of html.matchAll(/<style>([\s\S]*?)<\/style>/g)) {
                generatedStyleHashes.add(createHash('sha256').update(match[1]).digest('base64'))
            }
        }
        expect(finalStyleHashes).toEqual(generatedStyleHashes)

        const transitionPolicy = await Bun.file(config.sites.fylo.headersPolicy).text()
        for (const hash of generatedStyleHashes) {
            expect(transitionPolicy).toContain(`'sha256-${hash}'`)
        }
        expect(transitionPolicy).toContain("'sha256-BFiBhqPWHJntZh+bkcvub23pJ3N2o+3u+92sBneTe5g='")
        expect(transitionPolicy).not.toContain("'unsafe-inline'")
        expect(transitionPolicy).toContain("'unsafe-eval'")
    })

    test('a controlling website worker converges new HTML and stable JavaScript before offline fallback', async () => {
        const root = path.resolve(import.meta.dir, '../..')
        await execFileAsync('bun', ['run', 'bundle'], { cwd: path.join(root, 'website') })
        const source = await Bun.file(path.join(root, 'website/dist/web/tachyon-sw.js')).text()
        const listeners = new Map()
        const stored = new Map()
        const keyFor = (request) => (typeof request === 'string' ? request : request.url)
        const response = (body) => ({
            ok: true,
            type: 'basic',
            clone: () => response(body),
            text: async () => body
        })
        const cache = {
            match: async (request) => stored.get(keyFor(request)),
            put: async (request, value) => stored.set(keyFor(request), value)
        }
        const pageUrl = 'https://fylo.example/'
        const runtimeUrl = 'https://fylo.example/shared/scripts/imports.js'
        const networkBodies = new Map([
            [pageUrl, 'new-page'],
            [runtimeUrl, 'new-runtime']
        ])
        stored.set(pageUrl, response('old-page'))
        stored.set(runtimeUrl, response('old-runtime'))
        let online = true
        let networkRequests = 0
        runInNewContext(source, {
            URL,
            caches: {
                keys: async () => [],
                delete: async () => true,
                open: async () => cache
            },
            fetch: async (request) => {
                networkRequests++
                if (!online) throw new Error('offline')
                return response(networkBodies.get(keyFor(request)))
            },
            self: {
                location: { origin: 'https://fylo.example' },
                clients: { claim: async () => {} },
                skipWaiting: async () => {},
                addEventListener: (type, listener) => listeners.set(type, listener)
            }
        })

        const dispatch = async (request) => {
            let result
            listeners.get('fetch')({ request, respondWith: (promise) => (result = promise) })
            return result
        }
        const pageRequest = { method: 'GET', mode: 'navigate', url: pageUrl }
        const runtimeRequest = { method: 'GET', mode: 'cors', url: runtimeUrl }
        expect(await (await dispatch(pageRequest)).text()).toBe('new-page')
        expect(await (await dispatch(runtimeRequest)).text()).toBe('new-runtime')
        expect(networkRequests).toBe(2)
        expect(await stored.get(pageUrl).text()).toBe('new-page')
        expect(await stored.get(runtimeUrl).text()).toBe('new-runtime')

        online = false
        expect(await (await dispatch(pageRequest)).text()).toBe('new-page')
        expect(await (await dispatch(runtimeRequest)).text()).toBe('new-runtime')
        expect(networkRequests).toBe(4)
    })

    test('keeps operational runbooks available to a clean checkout', async () => {
        const runbooks = ['docs/operations/web-release.md']
        for (const runbook of runbooks) {
            await expect(Bun.file(runbook).exists()).resolves.toBe(true)
            await expect(
                execFileAsync('git', ['check-ignore', '--no-index', '--quiet', runbook], {
                    cwd: path.resolve(import.meta.dir, '../..')
                })
            ).rejects.toMatchObject({ code: 1 })
        }
    })

    test('wires Pages post-deploy verification and documents rollback', async () => {
        const workflow = await Bun.file('.github/workflows/pages.yml').text()
        const runbook = await Bun.file('docs/operations/web-release.md').text()
        expect(workflow).toContain('bun scripts/pages-smoke.mjs')
        expect(runbook).toContain('git revert <bad-gh-pages-commit>')
        expect(runbook).toContain('bun scripts/amplify-release.mjs rollback fylo')
        expect(runbook).not.toContain('bun scripts/amplify-release.mjs rollback fxp')
    })

    test('installs every web workspace before compiled interop bundles run', async () => {
        for (const path of ['.github/workflows/ci.yml', '.github/workflows/publish.yml']) {
            const workflow = await Bun.file(path).text()
            const index = workflow.indexOf('    binary-interop:')
            expect(index).toBeGreaterThan(-1)
            const binaryInterop = workflow.slice(index)

            expect(binaryInterop).toContain('(cd website && bun install --frozen-lockfile)')
            expect(binaryInterop).toContain('(cd explorer && bun install --frozen-lockfile)')
            expect(
                binaryInterop.indexOf('(cd website && bun install --frozen-lockfile)')
            ).toBeLessThan(binaryInterop.indexOf('bun run test:interop'))
            expect(
                binaryInterop.indexOf('(cd explorer && bun install --frozen-lockfile)')
            ).toBeLessThan(binaryInterop.indexOf('bun run test:interop'))
        }
    })

    test('uses pinned Bun, Rust, and TACHYON toolchains for every browser release path', async () => {
        const bunVersion = (await Bun.file('.bun-version').text()).trim()
        const rustToolchain = await Bun.file('rust-toolchain.toml').text()
        const build = await Bun.file('scripts/build-browser.mjs').text()
        const rootPackage = await Bun.file('package.json').json()
        const websitePackage = await Bun.file('website/package.json').json()
        const explorerPackage = await Bun.file('explorer/package.json').json()
        const vendorInstaller = await Bun.file('scripts/install-vendor-bins.sh').text()
        const tachyonPatch = await Bun.file('scripts/patch-tachyon-runtime.mjs').text()

        expect(bunVersion).toBe('1.3.11')
        expect(rustToolchain).toContain('channel = "1.97.1"')
        expect(rustToolchain).toContain('targets = ["wasm32-unknown-unknown"]')
        expect(build).toContain("readFile(new URL('../.bun-version'")
        expect(build).toContain("readFile(new URL('../rust-toolchain.toml'")
        expect(build).toContain("'--locked'")
        expect(vendorInstaller).toContain("TACHYON_VERSION='v26.33.01'")
        expect(websitePackage.scripts.bundle).toContain('ty bundle')
        expect(websitePackage.scripts.bundle).toContain('patch-tachyon-runtime.mjs')
        expect(tachyonPatch).toContain("marker.closest('tachyon-island') !== root")
        expect(tachyonPatch).toContain('refusing to apply the 26.33.01 nested-island patch')
        expect(tachyonPatch).toContain('refusing to apply the 26.33.01 network-first patch')
        expect(tachyonPatch).toContain('/shared/scripts/imports.js')
        expect(explorerPackage.scripts.bundle).toContain('@d31ma/tachyon/src/cli/index.js bundle')
        expect(websitePackage.devDependencies?.['@d31ma/tachyon']).toBeUndefined()
        expect(explorerPackage.devDependencies?.['@d31ma/tachyon']).toContain(
            'github:d31ma/Tachyon#'
        )
        for (const packageJson of [rootPackage, websitePackage, explorerPackage]) {
            expect(packageJson.packageManager).toBe(`bun@${bunVersion}`)
        }
        for (const workflowPath of ['.github/workflows/ci.yml', '.github/workflows/publish.yml']) {
            const workflow = await Bun.file(workflowPath).text()
            expect(workflow).not.toContain('bun-version: latest')
            expect(workflow).toContain('bun-version-file: .bun-version')
        }
    })

    test('pins the FYLO Amplify target, security policy, and checksum-verified rollback', async () => {
        const config = await Bun.file('ops/web-release.json').json()
        const release = await Bun.file('scripts/amplify-release.mjs').text()
        const transitionPolicy = await Bun.file(config.sites.fylo.headersPolicy).text()
        const finalPolicy = await Bun.file(config.sites.fylo.finalHeadersPolicy).text()
        const runbook = await Bun.file('docs/operations/web-release.md').text()
        expect(config.sites.fylo).toMatchObject({
            appId: 'dhq9jgfyq7uv2',
            origin: 'https://fylo.del.ma',
            headersPolicy: 'ops/fylo-amplify-custom-headers-transition-v1.yml',
            finalHeadersPolicy: 'ops/fylo-amplify-custom-headers-v1.yml'
        })
        expect(config.sites.fxp).toBeUndefined()
        for (const policy of [transitionPolicy, finalPolicy]) {
            expect(policy).toContain('key: Strict-Transport-Security')
            expect(policy).toContain('key: X-Content-Type-Options')
            expect(policy).toContain('key: Referrer-Policy')
            expect(policy).toContain('key: Permissions-Policy')
            expect(policy).toContain('key: Content-Security-Policy')
            expect(policy).toContain("script-src 'self' 'inline-speculation-rules'")
            expect(policy).toContain("style-src 'self' 'sha256-")
            expect(policy).not.toContain("'unsafe-inline'")
            expect(policy).toContain('value: no-cache, must-revalidate')
        }
        expect(transitionPolicy).toContain("'unsafe-eval'")
        expect(finalPolicy).not.toContain("'unsafe-eval'")
        expect(transitionPolicy).toContain("'sha256-BFiBhqPWHJntZh+bkcvub23pJ3N2o+3u+92sBneTe5g='")
        expect(finalPolicy).not.toContain("'sha256-BFiBhqPWHJntZh+bkcvub23pJ3N2o+3u+92sBneTe5g='")
        const transitionLines = transitionPolicy.split('\n')
        const cspKey = transitionLines.findIndex((line) =>
            line.includes('key: Content-Security-Policy')
        )
        expect(cspKey).toBeGreaterThan(-1)
        expect(transitionLines[cspKey + 1].trim()).toBe('value: >-')
        expect(transitionLines[cspKey + 2].trim()).toBe(
            config.sites.fylo.requiredHeaders['content-security-policy']
        )
        for (const checksum of [
            '0c14fea889d6ff7b69b75c40b506b92247353ec34d938c4221b93a3c7cd6aa6c',
            '16e24d877d60e40aa88f1611492d8abd42174ea7b669f482e0977dcf22554736'
        ]) {
            expect(config.sites.fylo.artifactContracts[checksum].requiredScriptSrcTokens).toEqual([
                "'unsafe-eval'"
            ])
            expect(config.sites.fylo.artifactContracts[checksum].probes).toContainEqual(
                expect.objectContaining({ path: '/imports.js' })
            )
        }
        expect(runbook).toContain('aws amplify update-app')
        expect(runbook).toContain(config.sites.fylo.headersPolicy)
        expect(runbook).toContain(config.sites.fylo.finalHeadersPolicy)
        expect(runbook).toContain('previousChecksum')
        expect(runbook).toContain('checksum-bound')
        expect(runbook).toContain('AsyncFunction')
        expect(runbook).toContain('Removing `unsafe-eval` at this promotion is mandatory')
        expect(release).toContain("'create-deployment'")
        expect(release).toContain("'start-deployment'")
        expect(release).toContain("'get-job'")
        expect(release).toContain('Archived artifact checksum mismatch')
        expect(release).toContain('restored and verified prior artifact')
        expect(release).toContain('production and release state require manual reconciliation')
        expect(release).toContain('no prior artifact exists for compensation')
        expect(release).toContain('previousChecksum')
        expect(release).toContain('verifiedProbeCount')
    })
})
