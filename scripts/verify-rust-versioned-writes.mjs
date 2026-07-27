import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { platform, tmpdir } from 'node:os'
import { join } from 'node:path'

import Fylo from '../src/index.js'
import { VersionRepository } from '../src/versioning/repository.js'

const workspace = await mkdtemp(join(tmpdir(), 'fylo-rust-versioned-'))
const root = join(workspace, 'root')
const collection = 'records'
const identifier = '4VRNF52JPCO'

try {
    await mkdir(root, { recursive: true })
    const seed = new Fylo(root)
    await seed[collection].create()
    await seed[collection].put(identifier, { name: 'Ada', score: 42 })
    await seed.close()

    await command([
        process.execPath,
        './scripts/run-rust.mjs',
        'cargo',
        'build',
        '--locked',
        '-p',
        'fylo-cli',
        '--bin',
        'fylo-write-preview'
    ])
    const binary = join(
        process.cwd(),
        'target',
        'debug',
        platform() === 'win32' ? 'fylo-write-preview.exe' : 'fylo-write-preview'
    )

    const repository = new VersionRepository(root)
    const before = await repository.log({ limit: 50 })
    assert(before.length > 0, 'JavaScript did not seed a commit history')

    const clean = await commit(binary, 'no-op auto-commit')
    assert(clean === null, 'Rust committed an unchanged working tree')

    await runRequired(binary, [
        'patch-document',
        '--root',
        root,
        '--collection',
        collection,
        '--id',
        identifier,
        '--document',
        '{"name":"Grace","score":50}'
    ])
    const created = await commit(binary, 'native document patch')
    assert(typeof created === 'string', 'Rust did not commit a changed working tree')

    const after = await repository.log({ limit: 50 })
    assert(after.length === before.length + 1, 'Rust commit did not extend the history')
    assert(after[0].id === created, 'Rust commit is not the branch head')
    assert(after[0].message === 'native document patch', 'Rust commit message drift')
    assert(after[0].parents[0] === before[0].id, 'Rust commit did not record its parent')

    const status = await repository.status()
    assert(status.clean, `JavaScript sees the Rust commit as dirty: ${JSON.stringify(status.diff)}`)

    const committed = await repository.diff(created, 'WORKTREE')
    assert(
        committed.counts.total === 0,
        `Rust commit tree differs from the working tree: ${JSON.stringify(committed.changes)}`
    )

    await command([
        process.execPath,
        './scripts/run-rust.mjs',
        'cargo',
        'build',
        '--locked',
        '-p',
        'fylo-cli',
        '--bin',
        'fylo-rust'
    ])
    const reader = join(
        process.cwd(),
        'target',
        'debug',
        platform() === 'win32' ? 'fylo-rust.exe' : 'fylo-rust'
    )
    const verified = JSON.parse(
        (await runRequired(reader, ['verify-history', '--root', root])).stdout
    )
    assert(
        verified.contentIntegrity === true && verified.historyComplete === true,
        'Rust could not verify its own commit objects'
    )
    assert(
        verified.commitsVerified >= after.length,
        'Rust verified fewer commits than JavaScript logged'
    )
    assert(verified.head === created, 'Rust verification does not see its own commit as head')

    const repeated = await commit(binary, 'native document patch')
    assert(repeated === null, 'Rust auto-commit is not idempotent')

    console.log('Verified Rust content-addressed commits against the JavaScript repository')
} finally {
    await rm(workspace, { recursive: true, force: true })
}

async function commit(binary, message) {
    const result = await runRequired(binary, ['commit', '--root', root, '--message', message])
    return JSON.parse(result.stdout).result
}

async function runRequired(binary, arguments_) {
    const result = await run(binary, arguments_)
    if (result.exitCode !== 0) {
        throw new Error(`fylo-write-preview failed: ${result.stderr}`)
    }
    return result
}

async function run(binary, arguments_, overrides = {}) {
    const subprocess = Bun.spawn([binary, ...arguments_], {
        cwd: process.cwd(),
        env: { ...process.env, ...overrides },
        stdout: 'pipe',
        stderr: 'pipe'
    })
    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(subprocess.stdout).text(),
        new Response(subprocess.stderr).text(),
        subprocess.exited
    ])
    return { stdout, stderr, exitCode }
}

async function command(arguments_) {
    const subprocess = Bun.spawn(arguments_, {
        cwd: process.cwd(),
        env: process.env,
        stdout: 'inherit',
        stderr: 'inherit'
    })
    const exitCode = await subprocess.exited
    if (exitCode !== 0) throw new Error(`command failed (${exitCode}): ${arguments_.join(' ')}`)
}

function assert(condition, message) {
    if (!condition) throw new Error(message)
}
