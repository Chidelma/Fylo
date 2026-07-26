import { mkdtemp, rm } from 'node:fs/promises'
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
