import { afterAll, describe, expect, test } from 'bun:test'
import { readFile, readdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { runMachineRequest } from '../../src/cli/machine.js'
import { createTestRoot } from '../helpers/root.js'

const roots = []

async function createRoot(prefix) {
    const root = await createTestRoot(prefix)
    roots.push(root)
    return root
}

/**
 * @param {string[]} args
 * @param {string} cwd
 * @param {string=} stdinText
 */
async function run(args, cwd, stdinText) {
    const proc = Bun.spawn(['bun', ...args], {
        cwd,
        stdin: stdinText === undefined ? 'ignore' : new Blob([stdinText]),
        stdout: 'pipe',
        stderr: 'pipe'
    })

    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited
    ])

    return { stdout, stderr, exitCode }
}

afterAll(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

describe('CLI machine interface', () => {
    test('help and package metadata expose only the fylo command', async () => {
        const repo = process.cwd()
        const help = await run(['src/cli/index.js', '--help'], repo)
        expect(help.exitCode).toBe(0)
        expect(help.stdout).toContain('fylo exec --request')
        expect(help.stdout).toContain('fylo backup verify')
        expect(help.stdout).toContain('--backup-bucket')
        expect(help.stdout).toContain('fylo inspect <collection>')
        expect(help.stdout).toContain('fylo sql "<SQL>"')
        expect(help.stdout).not.toContain('fylo.exec')
        expect(help.stdout).not.toContain('fylo.admin')
        expect(help.stdout).not.toContain('fylo.query')

        const manifest = JSON.parse(await readFile(path.join(repo, 'package.json'), 'utf8'))
        expect(manifest.bin).toEqual({ fylo: 'src/cli/index.js' })
    })

    test('exec handles JSON requests from inline payloads and stdin', async () => {
        const repo = process.cwd()
        const root = await createRoot('fylo-machine-')

        const createResponse = await run(
            [
                'src/cli/index.js',
                'exec',
                '--request',
                JSON.stringify({
                    requestId: 'create-1',
                    op: 'createCollection',
                    root,
                    collection: 'machine-posts'
                })
            ],
            repo
        )
        expect(createResponse.exitCode).toBe(0)
        const createPayload = JSON.parse(createResponse.stdout)
        expect(createPayload.ok).toBe(true)
        expect(createPayload.protocolVersion).toBe(1)
        expect(createPayload.requestId).toBe('create-1')
        expect(createPayload.result.collection).toBe('machine-posts')

        if (process.getuid) {
            const access = { uid: process.getuid(), mode: 0o600 }
            const insertResponse = await run(
                [
                    'src/cli/index.js',
                    'exec',
                    '--request',
                    JSON.stringify({
                        op: 'executeSQL',
                        root,
                        sql: "INSERT INTO machine-posts (title, scope) VALUES ('Private SQL', 'machine-access')",
                        access
                    })
                ],
                repo
            )
            expect(insertResponse.exitCode).toBe(0)
            const sqlId = JSON.parse(insertResponse.stdout).result

            const anonymousResponse = await run(
                [
                    'src/cli/index.js',
                    'exec',
                    '--request',
                    JSON.stringify({
                        op: 'executeSQL',
                        root,
                        sql: "SELECT * FROM machine-posts WHERE scope = 'machine-access'"
                    })
                ],
                repo
            )
            expect(JSON.parse(anonymousResponse.stdout).result).toEqual({})

            const ownerResponse = await run(
                [
                    'src/cli/index.js',
                    'exec',
                    '--request',
                    JSON.stringify({
                        op: 'executeSQL',
                        root,
                        sql: "SELECT * FROM machine-posts WHERE scope = 'machine-access'",
                        access: { uid: process.getuid() }
                    })
                ],
                repo
            )
            expect(JSON.parse(ownerResponse.stdout).result[sqlId].title).toBe('Private SQL')

            const gid = process.getgroups()[0]
            const groupInsertResponse = await run(
                [
                    'src/cli/index.js',
                    'exec',
                    '--request',
                    JSON.stringify({
                        op: 'executeSQL',
                        root,
                        sql: "INSERT INTO machine-posts (title, scope) VALUES ('Group SQL', 'machine-group-access')",
                        access: { gid, mode: 0o660 }
                    })
                ],
                repo
            )
            expect(groupInsertResponse.exitCode).toBe(0)
            const groupId = JSON.parse(groupInsertResponse.stdout).result
            const groupInfo = await stat(
                path.join(
                    root,
                    '.collections',
                    'machine-posts',
                    'docs',
                    groupId.slice(0, 2),
                    `${groupId}.json`
                )
            )
            expect(groupInfo.uid).toBe(process.getuid())
            expect(groupInfo.gid).toBe(gid)
            expect(groupInfo.mode & 0o777).toBe(0o660)
        }

        const putResponse = await run(
            [
                'src/cli/index.js',
                'exec',
                '--request',
                JSON.stringify({
                    op: 'putData',
                    root,
                    collection: 'machine-posts',
                    data: { title: 'Interop', published: true }
                })
            ],
            repo
        )
        expect(putResponse.exitCode).toBe(0)
        const putPayload = JSON.parse(putResponse.stdout)
        expect(putPayload.ok).toBe(true)
        const docId = putPayload.result

        const latestResponse = await run(
            ['src/cli/index.js', 'exec', '--request', '-'],
            repo,
            JSON.stringify({
                requestId: 'latest-1',
                op: 'getLatest',
                root,
                collection: 'machine-posts',
                id: docId
            })
        )
        expect(latestResponse.exitCode).toBe(0)
        const latestPayload = JSON.parse(latestResponse.stdout)
        expect(latestPayload.ok).toBe(true)
        expect(Object.values(latestPayload.result)[0].title).toBe('Interop')

        const queryResponse = await run(
            [
                'src/cli/index.js',
                'exec',
                '--request',
                JSON.stringify({
                    op: 'findDocs',
                    root,
                    collection: 'machine-posts',
                    query: { published: true }
                })
            ],
            repo
        )
        expect(queryResponse.exitCode).toBe(0)
        const queryPayload = JSON.parse(queryResponse.stdout)
        expect(queryPayload.ok).toBe(true)
        expect(queryPayload.result[docId].title).toBe('Interop')

        const deleteResponse = await run(
            [
                'src/cli/index.js',
                'exec',
                '--request',
                JSON.stringify({
                    op: 'delDoc',
                    root,
                    collection: 'machine-posts',
                    id: docId
                })
            ],
            repo
        )
        expect(deleteResponse.exitCode).toBe(0)

        const deletedResponse = await run(
            [
                'src/cli/index.js',
                'exec',
                '--request',
                JSON.stringify({
                    op: 'findDeletedDocs',
                    root,
                    collection: 'machine-posts',
                    query: { $deleted: { $gte: 0 } }
                })
            ],
            repo
        )
        expect(deletedResponse.exitCode).toBe(0)
        const deletedPayload = JSON.parse(deletedResponse.stdout)
        expect(deletedPayload.ok).toBe(true)
        expect(deletedPayload.result[docId].title).toBe('Interop')

        const restoreResponse = await run(
            [
                'src/cli/index.js',
                'exec',
                '--request',
                JSON.stringify({
                    op: 'restoreDoc',
                    root,
                    collection: 'machine-posts',
                    id: docId
                })
            ],
            repo
        )
        expect(restoreResponse.exitCode).toBe(0)
        expect(JSON.parse(restoreResponse.stdout).result).toEqual({ restored: true, id: docId })
    })

    test('reports disabled whole-root backup through the machine contract', async () => {
        const response = await runMachineRequest(
            { op: 'backupStatus' },
            { root: await createRoot('fylo-machine-backup-status-') }
        )
        expect(response.ok).toBe(true)
        expect(response.result).toEqual({
            configured: false,
            state: 'disabled',
            runs: 0
        })

        const reconcile = await runMachineRequest(
            { op: 'backupReconcile' },
            { root: await createRoot('fylo-machine-backup-reconcile-') }
        )
        expect(reconcile.ok).toBe(false)
        expect(reconcile.error.code).toBe('EBACKUPNOTCONFIGURED')
    })

    test('every machine failure carries a stable error code (#79)', async () => {
        const root = await createRoot('fylo-machine-error-codes-')
        const overrides = { root, cache: new Map() }
        await runMachineRequest({ op: 'createCollection', collection: 'coded' }, overrides)

        const probes = [
            [{ op: 'noSuchOperation' }, 'EUNSUPPORTEDOP'],
            [{ op: 'getDoc', id: '0'.repeat(26) }, 'EBADREQUEST'],
            [{ op: 'getDoc', collection: 'coded', id: 'SOMEID' }, 'EINVALIDDOCID'],
            [{ op: 'putData', collection: 'coded', data: { a: 1 }, access: 7 }, 'EBADREQUEST'],
            [
                { op: 'putData', collection: 'coded', data: { a: 1 }, access: { groups: [1] } },
                'EBADREQUEST'
            ],
            [{ op: 'findDocs', collection: 'coded', query: {}, page: { limit: 0 } }, 'EBADREQUEST']
        ]
        for (const [request, code] of probes) {
            const response = await runMachineRequest(request, overrides)
            expect(response.ok).toBe(false)
            expect(response.error.code).toBe(code)
        }

        const unclassified = await runMachineRequest(
            { op: 'importBulkData', collection: 'coded', url: 'not a url', format: 'json' },
            overrides
        )
        expect(unclassified.ok).toBe(false)
        expect(typeof unclassified.error.code).toBe('string')
        expect(unclassified.error.code.length).toBeGreaterThan(0)
    })

    test('rejects arrays of objects deterministically and leaves no partial state (#82)', async () => {
        const root = await createRoot('fylo-machine-array-objects-')
        const overrides = { root, cache: new Map() }
        await runMachineRequest({ op: 'createCollection', collection: 'events' }, overrides)
        const docsDir = path.join(root, '.collections', 'events', 'docs')

        for (const data of [
            { kind: 'e', items: [{ a: 'b' }] },
            { items: [{ a: 1 }] },
            { state: { deep: { deeper: [{ a: 'b' }] } } }
        ]) {
            const response = await runMachineRequest(
                { op: 'putData', collection: 'events', data },
                overrides
            )
            expect(response.ok).toBe(false)
            expect(response.error.code).toBe('EARRAYOFOBJECTS')
            expect(response.error.message).toContain('own collection')
        }

        // A rejected put must never reach disk: no document survives the three failures.
        expect(await readdir(docsDir).catch(() => [])).toEqual([])

        for (const data of [
            { items: ['plain', 'strings'] },
            { items: [] },
            { nested: { a: 'b' } }
        ]) {
            const accepted = await runMachineRequest(
                { op: 'putData', collection: 'events', data },
                overrides
            )
            expect(accepted.ok).toBe(true)
        }

        const stored = await runMachineRequest(
            { op: 'findDocs', collection: 'events', query: { $onlyIds: true } },
            overrides
        )
        expect(stored.result).toHaveLength(3)

        const patched = await runMachineRequest(
            {
                op: 'patchDoc',
                collection: 'events',
                id: stored.result[0],
                newDoc: { items: [{ a: 'b' }] }
            },
            overrides
        )
        expect(patched.ok).toBe(false)
        expect(patched.error.code).toBe('EARRAYOFOBJECTS')
    })

    test('exec exposes version-control operations for language-agnostic callers', async () => {
        const repo = process.cwd()
        const root = await createRoot('fylo-machine-vcs-')

        const createResponse = await run(
            [
                'src/cli/index.js',
                'exec',
                '--request',
                JSON.stringify({
                    op: 'createCollection',
                    root,
                    collection: 'machine-vcs'
                })
            ],
            repo
        )
        expect(createResponse.exitCode).toBe(0)

        const putMainResponse = await run(
            [
                'src/cli/index.js',
                'exec',
                '--request',
                JSON.stringify({
                    op: 'putData',
                    root,
                    versioning: { autoCommit: false },
                    collection: 'machine-vcs',
                    data: { title: 'main' }
                })
            ],
            repo
        )
        expect(putMainResponse.exitCode).toBe(0)

        const initialCommitResponse = await run(
            [
                'src/cli/index.js',
                'exec',
                '--request',
                JSON.stringify({
                    op: 'commit',
                    root,
                    message: 'machine main snapshot'
                })
            ],
            repo
        )
        expect(initialCommitResponse.exitCode).toBe(0)
        const initialCommitPayload = JSON.parse(initialCommitResponse.stdout)
        expect(initialCommitPayload.ok).toBe(true)

        const checkoutResponse = await run(
            [
                'src/cli/index.js',
                'exec',
                '--request',
                JSON.stringify({
                    op: 'checkout',
                    root,
                    branch: 'machine/feature',
                    create: true
                })
            ],
            repo
        )
        expect(checkoutResponse.exitCode).toBe(0)
        const checkoutPayload = JSON.parse(checkoutResponse.stdout)
        expect(checkoutPayload.result.branch).toBe('machine/feature')

        const putFeatureResponse = await run(
            [
                'src/cli/index.js',
                'exec',
                '--request',
                JSON.stringify({
                    op: 'putData',
                    root,
                    versioning: { autoCommit: false },
                    collection: 'machine-vcs',
                    data: { title: 'feature' }
                })
            ],
            repo
        )
        expect(putFeatureResponse.exitCode).toBe(0)

        const branchResponse = await run(
            ['src/cli/index.js', 'exec', '--request', JSON.stringify({ op: 'branch', root })],
            repo
        )
        expect(branchResponse.exitCode).toBe(0)
        const branchPayload = JSON.parse(branchResponse.stdout)
        expect(branchPayload.result.current).toBe('machine/feature')

        const featureCommitResponse = await run(
            [
                'src/cli/index.js',
                'exec',
                '--request',
                JSON.stringify({
                    op: 'commit',
                    root,
                    message: 'machine feature snapshot'
                })
            ],
            repo
        )
        expect(featureCommitResponse.exitCode).toBe(0)
        const featureCommitPayload = JSON.parse(featureCommitResponse.stdout)

        const logResponse = await run(
            ['src/cli/index.js', 'exec', '--request', JSON.stringify({ op: 'log', root })],
            repo
        )
        expect(logResponse.exitCode).toBe(0)
        const logPayload = JSON.parse(logResponse.stdout)
        expect(logPayload.result.map((commit) => commit.message)).toEqual([
            'machine feature snapshot',
            'machine main snapshot'
        ])

        const dirtyPutResponse = await run(
            [
                'src/cli/index.js',
                'exec',
                '--request',
                JSON.stringify({
                    op: 'putData',
                    root,
                    versioning: { autoCommit: false },
                    collection: 'machine-vcs',
                    data: { title: 'dirty' }
                })
            ],
            repo
        )
        expect(dirtyPutResponse.exitCode).toBe(0)

        const statusResponse = await run(
            ['src/cli/index.js', 'exec', '--request', JSON.stringify({ op: 'status', root })],
            repo
        )
        expect(statusResponse.exitCode).toBe(0)
        const statusPayload = JSON.parse(statusResponse.stdout)
        expect(statusPayload.result.clean).toBe(false)
        expect(statusPayload.result.diff.counts.added).toBe(1)

        const diffResponse = await run(
            ['src/cli/index.js', 'exec', '--request', JSON.stringify({ op: 'diff', root })],
            repo
        )
        expect(diffResponse.exitCode).toBe(0)
        const diffPayload = JSON.parse(diffResponse.stdout)
        expect(diffPayload.result.counts.total).toBe(1)

        const guardedRestoreResponse = await run(
            [
                'src/cli/index.js',
                'exec',
                '--request',
                JSON.stringify({
                    op: 'restoreCommit',
                    root,
                    id: initialCommitPayload.result.id
                })
            ],
            repo
        )
        expect(guardedRestoreResponse.exitCode).toBe(1)
        const guardedRestorePayload = JSON.parse(guardedRestoreResponse.stdout)
        expect(guardedRestorePayload.ok).toBe(false)
        expect(guardedRestorePayload.error.message).toContain(
            'Working tree has uncommitted changes'
        )

        const forcedRestoreResponse = await run(
            [
                'src/cli/index.js',
                'exec',
                '--request',
                JSON.stringify({
                    op: 'restoreCommit',
                    root,
                    id: featureCommitPayload.result.id,
                    force: true
                })
            ],
            repo
        )
        expect(forcedRestoreResponse.exitCode).toBe(0)
        const forcedRestorePayload = JSON.parse(forcedRestoreResponse.stdout)
        expect(forcedRestorePayload.result.restored).toBe(featureCommitPayload.result.id)

        const checkoutMainResponse = await run(
            [
                'src/cli/index.js',
                'exec',
                '--request',
                JSON.stringify({
                    op: 'checkout',
                    root,
                    branch: 'main'
                })
            ],
            repo
        )
        expect(checkoutMainResponse.exitCode).toBe(0)

        const mergeResponse = await run(
            [
                'src/cli/index.js',
                'exec',
                '--request',
                JSON.stringify({
                    op: 'merge',
                    root,
                    source: 'machine/feature'
                })
            ],
            repo
        )
        expect(mergeResponse.exitCode).toBe(0)
        const mergePayload = JSON.parse(mergeResponse.stdout)
        expect(mergePayload.result).toMatchObject({
            branch: 'main',
            source: featureCommitPayload.result.id,
            mode: 'fast-forward',
            merged: true,
            head: featureCommitPayload.result.id
        })
    })

    test('exec ingests raw files from absolute paths for non-JavaScript callers', async () => {
        const repo = process.cwd()
        const root = await createRoot('fylo-machine-file-')
        const source = path.join(root, 'machine-source.txt')
        await Bun.write(source, 'machine raw bytes')

        const createResponse = await run(
            [
                'src/cli/index.js',
                'exec',
                '--request',
                JSON.stringify({
                    op: 'createCollection',
                    root,
                    collection: 'machine-files',
                    kind: 'file'
                })
            ],
            repo
        )
        expect(createResponse.exitCode).toBe(0)
        expect(JSON.parse(createResponse.stdout).result.kind).toBe('file')

        const putResponse = await run(
            [
                'src/cli/index.js',
                'exec',
                '--request',
                JSON.stringify({
                    op: 'putData',
                    root,
                    collection: 'machine-files',
                    file: {
                        path: source,
                        key: '/machine/imports/source.txt'
                    }
                })
            ],
            repo
        )
        expect(putResponse.exitCode).toBe(0)
        const id = JSON.parse(putResponse.stdout).result
        expect(
            await Bun.file(
                path.join(root, '.buckets', 'machine-files', 'docs', id.slice(0, 2), `${id}.txt`)
            ).text()
        ).toBe('machine raw bytes')

        const getResponse = await run(
            [
                'src/cli/index.js',
                'exec',
                '--request',
                JSON.stringify({
                    op: 'getDoc',
                    root,
                    collection: 'machine-files',
                    id
                })
            ],
            repo
        )
        expect(getResponse.exitCode).toBe(0)
        expect(JSON.parse(getResponse.stdout).result[id].key).toBe('/machine/imports/source.txt')
    })

    test.skipIf(process.platform === 'win32' || !process.getuid)(
        'scopes trusted virtual groups across cached document and raw-file operations',
        async () => {
            const root = await createRoot('fylo-machine-access-')
            const overrides = { root, cache: new Map() }
            const gid = process.getgid?.() ?? process.getgroups()[0]
            const memberUid = process.getuid() + 10_001
            const outsiderUid = memberUid + 1
            const member = { uid: memberUid, groups: [gid] }
            const noGroups = { uid: memberUid, groups: [] }
            const outsider = { uid: outsiderUid, groups: [] }

            for (const [collection, kind] of [
                ['tenant-docs', 'document'],
                ['tenant-files', 'file']
            ]) {
                const created = await runMachineRequest(
                    { op: 'createCollection', collection, kind },
                    overrides
                )
                expect(created.ok).toBe(true)
            }

            const putDoc = await runMachineRequest(
                {
                    op: 'putData',
                    collection: 'tenant-docs',
                    data: { tenant: 'domain-a', title: 'private' },
                    access: { gid, mode: 0o660 }
                },
                overrides
            )
            expect(putDoc.ok).toBe(true)
            const docId = String(putDoc.result)

            const memberQuery = await runMachineRequest(
                {
                    op: 'findDocs',
                    collection: 'tenant-docs',
                    query: { tenant: 'domain-a' },
                    access: member
                },
                overrides
            )
            expect(memberQuery.ok).toBe(true)
            expect(memberQuery.result).toHaveProperty(docId)

            const sameUidWithoutGroup = await runMachineRequest(
                {
                    op: 'findDocs',
                    collection: 'tenant-docs',
                    query: { tenant: 'domain-a' },
                    access: noGroups
                },
                overrides
            )
            expect(sameUidWithoutGroup.ok).toBe(true)
            expect(sameUidWithoutGroup.result).toEqual({})

            const deniedDoc = await runMachineRequest(
                {
                    op: 'getDoc',
                    collection: 'tenant-docs',
                    id: docId,
                    access: outsider
                },
                overrides
            )
            expect(deniedDoc.ok).toBe(false)
            expect(deniedDoc.error.code).toBe('EACCES')

            const patched = await runMachineRequest(
                {
                    op: 'patchDoc',
                    collection: 'tenant-docs',
                    id: docId,
                    newDoc: { title: 'member update' },
                    access: member
                },
                overrides
            )
            expect(patched.ok).toBe(true)

            const source = path.join(root, 'attachment.txt')
            await Bun.write(source, 'domain-a attachment')
            const putFile = await runMachineRequest(
                {
                    op: 'putData',
                    collection: 'tenant-files',
                    file: { path: source, key: '/mail/attachment.txt' },
                    access: { gid, mode: 0o660 }
                },
                overrides
            )
            expect(putFile.ok).toBe(true)
            const fileId = String(putFile.result)

            const memberFile = await runMachineRequest(
                {
                    op: 'getDoc',
                    collection: 'tenant-files',
                    id: fileId,
                    access: member
                },
                overrides
            )
            expect(memberFile.ok).toBe(true)
            expect(memberFile.result[fileId].key).toBe('/mail/attachment.txt')

            const deniedFile = await runMachineRequest(
                {
                    op: 'delDoc',
                    collection: 'tenant-files',
                    id: fileId,
                    access: outsider
                },
                overrides
            )
            expect(deniedFile.ok).toBe(false)
            expect(deniedFile.error.code).toBe('EACCES')

            const deletedFile = await runMachineRequest(
                {
                    op: 'delDoc',
                    collection: 'tenant-files',
                    id: fileId,
                    access: member
                },
                overrides
            )
            expect(deletedFile.ok).toBe(true)
        }
    )

    test('exec returns structured JSON errors with non-zero exits', async () => {
        const repo = process.cwd()

        const response = await run(
            ['src/cli/index.js', 'exec', '--request', JSON.stringify({ op: 'unknownOperation' })],
            repo
        )
        expect(response.exitCode).toBe(1)
        expect(response.stderr).toBe('')
        const payload = JSON.parse(response.stdout)
        expect(payload.ok).toBe(false)
        expect(payload.error.message).toContain('Unsupported machine operation')
    })
})
