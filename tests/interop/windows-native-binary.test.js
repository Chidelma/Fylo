import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const mustRunNatively = process.env.FYLO_REQUIRE_WINDOWS_NATIVE === '1'
const nativeWindows = process.platform === 'win32' && process.arch === 'x64'
const binary = path.resolve(process.env.FYLO_WINDOWS_BINARY ?? path.join('dist-bin', 'fylo.exe'))
const roots = []

if (mustRunNatively && !nativeWindows) {
    throw new Error(
        `The authoritative Windows executable test requires win32/x64, received ${process.platform}/${process.arch}`
    )
}

afterAll(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

async function invoke(request) {
    const child = Bun.spawn([binary, 'exec', '--request', JSON.stringify(request)], {
        stdout: 'pipe',
        stderr: 'pipe'
    })
    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited
    ])
    expect(exitCode, `fylo.exe stderr:\n${stderr}\nstdout:\n${stdout}`).toBe(0)
    const response = JSON.parse(stdout)
    expect(response.ok, stdout).toBe(true)
    return response.result
}

describe('native Windows x64 executable', () => {
    const windowsTest = nativeWindows ? test : test.skip

    windowsTest('reports the native release identity through the handshake', async () => {
        const identity = await invoke({ op: 'handshake' })
        const configuredCommit = process.env.FYLO_BUILD_COMMIT ?? process.env.GITHUB_SHA ?? ''
        const releaseBuild = /^[0-9a-f]{40}$/i.test(configuredCommit)
        const expectedBuildKind =
            process.env.FYLO_EXPECT_BUILD_KIND ??
            (releaseBuild ? 'release' : 'development-compiled')
        const expectedCommit =
            process.env.FYLO_EXPECT_COMMIT ?? (releaseBuild ? configuredCommit : 'unknown')

        expect(identity.buildTarget).toBe('windows-x64')
        expect(identity.buildKind).toBe(expectedBuildKind)
        expect(identity.commit).toBe(expectedCommit)
        expect(identity.capabilities.exclusiveRoot).toBe(true)
        expect(identity.capabilities.queryPagination.operations).toEqual([
            'findDocs',
            'findDeletedDocs'
        ])
        expect(identity.capabilities.wholeRootBackup).toBeUndefined()
    })

    windowsTest('persists and reads a document through the compiled machine protocol', async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), 'fylo-windows-binary-'))
        roots.push(root)
        const collection = 'native-windows'

        await invoke({ op: 'createCollection', root, collection })
        const id = await invoke({
            op: 'putData',
            root,
            collection,
            data: { platform: 'windows', persisted: true }
        })
        const result = await invoke({ op: 'getLatest', root, collection, id })

        expect(result[id]).toEqual({ platform: 'windows', persisted: true })
    })
})
