import { afterAll, describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const required =
    process.env.FYLO_REQUIRE_NATIVE_BINARY === '1' ||
    process.env.FYLO_REQUIRE_NATIVE_RELEASE === '1'
const binary = path.resolve(process.env.FYLO_BINARY ?? 'dist-bin/fylo')
const expectedBuildKind = process.env.FYLO_EXPECT_BUILD_KIND ?? 'release'
const expectedTarget =
    process.env.FYLO_EXPECT_TARGET ??
    `${process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}`
const roots = []

class ReleaseLoop {
    constructor(root, env = {}) {
        this.child = spawn(binary, ['exec', '--loop', '--root', root, '--exclusive-root'], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, ...env }
        })
        this.stderr = ''
        this.responses = []
        this.waiters = []
        this.exited = once(this.child, 'exit')
        this.child.stderr.setEncoding('utf8')
        this.child.stderr.on('data', (chunk) => {
            this.stderr += chunk
        })
        this.reader = createInterface({ input: this.child.stdout })
        this.reader.on('line', (line) => {
            const response = JSON.parse(line)
            const waiter = this.waiters.shift()
            if (waiter) waiter(response)
            else this.responses.push(response)
        })
    }

    async request(request, timeout = 5_000) {
        this.child.stdin.write(`${JSON.stringify(request)}\n`)
        if (this.responses.length > 0) return this.responses.shift()
        return await deadline(
            new Promise((resolve) => this.waiters.push(resolve)),
            timeout,
            `machine loop did not answer ${request.op}`
        )
    }

    async stop(crash = false) {
        if (this.child.exitCode !== null) return
        if (crash) this.child.kill(process.platform === 'win32' ? undefined : 'SIGKILL')
        else this.child.stdin.end()
        await this.exited
    }
}

async function deadline(promise, timeout, message) {
    let timer
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(message)), timeout)
            })
        ])
    } finally {
        clearTimeout(timer)
    }
}

async function waitForProcessExit(pid) {
    while (true) {
        try {
            process.kill(pid, 0)
        } catch (error) {
            if (error?.code === 'ESRCH') return
            throw error
        }
        await Bun.sleep(10)
    }
}

afterAll(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

describe.skipIf(!required)('exact native release root lease', () => {
    test('binds identity, canonical aliases, stale metadata, and crash takeover', async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), 'fylo-native-release-lease-'))
        roots.push(root)
        const alias = `${root}-alias`
        roots.push(alias)
        await symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir')

        const first = new ReleaseLoop(root)
        const identity = await first.request({ op: 'handshake' })
        expect(identity).toMatchObject({
            ok: true,
            result: {
                buildKind: expectedBuildKind,
                buildTarget: expectedTarget,
                capabilities: { exclusiveRoot: true }
            }
        })

        const contender = new ReleaseLoop(alias)
        expect(await contender.request({ op: 'handshake' })).toMatchObject({
            ok: false,
            error: { code: 'EROOTLOCKED' }
        })
        await contender.stop()
        await first.stop()

        const canonical = await realpath(root)
        const sentinel = path.join(
            path.dirname(canonical),
            `.${path.basename(canonical)}.fylo-root-owner.lock`
        )
        await writeFile(
            `${sentinel}.json`,
            JSON.stringify({ version: 1, root: canonical, owner: 'stale', pid: process.pid })
        )

        const crashOwner = new ReleaseLoop(alias)
        expect((await crashOwner.request({ op: 'handshake' })).ok).toBe(true)
        const currentMetadata = JSON.parse(await readFile(`${sentinel}.json`, 'utf8'))
        expect(currentMetadata.owner).not.toBe('stale')
        await crashOwner.stop(true)

        const replacement = new ReleaseLoop(root)
        expect((await replacement.request({ op: 'handshake' })).ok).toBe(true)
        await replacement.stop()
    })

    test('reports disk pressure, keeps the loop responsive, and restarts cleanly (#89)', async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), 'fylo-native-disk-pressure-'))
        roots.push(root)
        const identifier = '4VRNF52JPCO'

        const seed = new ReleaseLoop(root)
        expect((await seed.request({ op: 'handshake' })).ok).toBe(true)
        expect(
            (
                await seed.request({
                    op: 'createCollection',
                    collection: 'messages',
                    kind: 'document'
                })
            ).ok
        ).toBe(true)
        expect(
            (
                await seed.request({
                    op: 'putData',
                    collection: 'messages',
                    id: identifier,
                    data: { body: 'before pressure' }
                })
            ).ok
        ).toBe(true)
        await seed.stop()

        const pressured = new ReleaseLoop(root, {
            FYLO_RUST_FAILPOINT: 'before-file-write',
            FYLO_RUST_FAILPOINT_ACTION: 'enospc'
        })
        expect((await pressured.request({ op: 'handshake' })).ok).toBe(true)
        const failed = await pressured.request({
            op: 'batchPutData',
            collection: 'messages',
            batch: [
                { id: '4VRNF52JPCP', data: { body: 'one' } },
                { id: '4VRNF52JPCQ', data: { body: 'two' } }
            ]
        })
        expect(failed).toMatchObject({
            ok: false,
            error: { code: 'ENATIVE_IO' }
        })
        expect(failed.error.code).not.toBe('EUNKNOWN')

        const survivor = await pressured.request({
            op: 'getDoc',
            collection: 'messages',
            id: identifier
        })
        expect(survivor).toMatchObject({
            ok: true,
            result: { [identifier]: { body: 'before pressure' } }
        })
        await pressured.stop()

        const restarted = new ReleaseLoop(root)
        expect((await restarted.request({ op: 'handshake' })).ok).toBe(true)
        const put = await restarted.request({
            op: 'putData',
            collection: 'messages',
            id: '4VRNF52JPCR',
            data: { body: 'after pressure' }
        })
        expect(put.ok).toBe(true)
        expect(
            await restarted.request({
                op: 'getDoc',
                collection: 'messages',
                id: '4VRNF52JPCR'
            })
        ).toMatchObject({
            ok: true,
            result: { '4VRNF52JPCR': { body: 'after pressure' } }
        })
        await restarted.stop()
    })

    test.skipIf(process.platform === 'win32')(
        'reaps the validator and closes machine stdout on process exit (#89)',
        async () => {
            const root = await mkdtemp(path.join(os.tmpdir(), 'fylo-native-pipe-owner-'))
            roots.push(root)
            const schema = path.join(root, 'schema')
            const validator = path.join(root, 'fake-chex.sh')
            const pidFile = path.join(root, 'fake-chex.pid')
            await mkdir(schema)
            await writeFile(
                path.join(schema, 'messages.schema.json'),
                JSON.stringify({ type: 'object' })
            )
            await writeFile(
                validator,
                `#!/bin/sh\nprintf '%s\\n' "$$" > "$FYLO_CHEX_PID_FILE"\nIFS= read -r request || exit 1\nprintf '%s\\n' '{"ok":true,"result":{"body":"validated"}}'\nwhile :; do sleep 1; done\n`
            )
            await chmod(validator, 0o755)

            const loop = new ReleaseLoop(root, {
                FYLO_CHEX_BINARY: validator,
                FYLO_CHEX_PID_FILE: pidFile
            })
            const response = await loop.request({
                op: 'schemaValidate',
                collection: 'messages',
                schemaDir: schema,
                document: { body: 'input' }
            })
            expect(response).toMatchObject({
                ok: true,
                result: { valid: true, document: { body: 'validated' } }
            })

            const validatorPid = Number((await readFile(pidFile, 'utf8')).trim())
            await deadline(
                waitForProcessExit(validatorPid),
                1_000,
                'schema validator outlived the request that owned it'
            )
            const stdoutClosed = once(loop.reader, 'close')
            loop.child.kill('SIGKILL')
            await deadline(loop.exited, 5_000, 'machine loop did not exit after SIGKILL')
            await deadline(
                stdoutClosed,
                1_000,
                'machine stdout remained open after its process exited'
            )
        }
    )
})
