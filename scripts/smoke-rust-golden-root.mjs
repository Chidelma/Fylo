import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repository = fileURLToPath(new URL('../', import.meta.url))
const temporary = await mkdtemp(join(tmpdir(), 'fylo-rust-golden-'))
const fixture = join(temporary, 'fixture')

try {
    await run(['./scripts/generate-rust-golden-root.mjs', '--output', fixture])
    await run(['./scripts/verify-rust-golden-root.mjs', '--input', fixture])
    await run([
        './scripts/run-rust.mjs',
        'cargo',
        'run',
        '--quiet',
        '--locked',
        '-p',
        'fylo-cli',
        '--bin',
        'fylo-rust',
        '--',
        'inspect',
        '--root',
        join(fixture, 'root'),
        '--collection',
        'people'
    ])
    await run([
        './scripts/run-rust.mjs',
        'cargo',
        'run',
        '--quiet',
        '--locked',
        '-p',
        'fylo-cli',
        '--bin',
        'fylo-rust',
        '--',
        'log',
        '--root',
        join(fixture, 'root'),
        '--limit',
        '10'
    ])
    await run([
        './scripts/run-rust.mjs',
        'cargo',
        'run',
        '--quiet',
        '--locked',
        '-p',
        'fylo-cli',
        '--bin',
        'fylo-rust',
        '--',
        'verify-history',
        '--root',
        join(fixture, 'root'),
        '--limit',
        '10'
    ])
    await run([
        './scripts/run-rust.mjs',
        'cargo',
        'run',
        '--quiet',
        '--locked',
        '-p',
        'fylo-cli',
        '--bin',
        'fylo-rust',
        '--',
        'verify-index',
        '--root',
        join(fixture, 'root'),
        '--collection',
        'people'
    ])
    const manifest = JSON.parse(await readFile(join(fixture, 'manifest.json'), 'utf8'))
    await run([
        './scripts/run-rust.mjs',
        'cargo',
        'run',
        '--quiet',
        '--locked',
        '-p',
        'fylo-cli',
        '--bin',
        'fylo-rust',
        '--',
        'get-file',
        '--root',
        join(fixture, 'root'),
        '--collection',
        manifest.probes.file.collection,
        '--id',
        manifest.probes.file.id
    ])
    const operations = (await readFile(join(fixture, manifest.operations), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
    const deletedId = operations.find((entry) => entry.operation === 'delete document')?.input?.id
    if (!deletedId) throw new Error('Golden root is missing the deleted-document operation')
    await run([
        './scripts/run-rust.mjs',
        'cargo',
        'run',
        '--quiet',
        '--locked',
        '-p',
        'fylo-cli',
        '--bin',
        'fylo-rust',
        '--',
        'get-deleted',
        '--root',
        join(fixture, 'root'),
        '--collection',
        'people',
        '--id',
        deletedId
    ])
    console.log('Verified generated JavaScript golden root with the Rust read-only engine')
} finally {
    await rm(temporary, { recursive: true, force: true })
}

async function run(arguments_) {
    const child = Bun.spawn([process.execPath, ...arguments_], {
        cwd: repository,
        stdout: 'inherit',
        stderr: 'inherit'
    })
    const exitCode = await child.exited
    if (exitCode !== 0) throw new Error(`${arguments_[0]} exited with ${exitCode}`)
}
