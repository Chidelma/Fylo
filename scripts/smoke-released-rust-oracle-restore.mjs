import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const input = resolve(requiredOption('--input'))
const workspace = await mkdtemp(join(tmpdir(), 'fylo-oracle-restore-'))
const restored = join(workspace, 'oracle')

try {
    await cp(input, restored, {
        recursive: true,
        force: false,
        preserveTimestamps: false
    })
    await run([
        './scripts/restore-rust-oracle-metadata.mjs',
        '--input',
        restored,
        '--ownership',
        'best-effort'
    ])
    await run(['./scripts/verify-rust-golden-root.mjs', '--input', restored])
    await run(['./scripts/verify-released-rust-oracle.mjs', '--input', restored])
    console.log('Verified released-oracle content and metadata restoration')
} finally {
    await rm(workspace, { recursive: true, force: true })
}

async function run(argumentsList) {
    const subprocess = Bun.spawn([process.execPath, ...argumentsList], {
        cwd: process.cwd(),
        env: process.env,
        stdout: 'inherit',
        stderr: 'inherit'
    })
    const exitCode = await subprocess.exited
    if (exitCode !== 0) throw new Error(`${argumentsList[0]} exited with ${exitCode}`)
}

function requiredOption(name) {
    const index = process.argv.indexOf(name)
    const value = index === -1 ? undefined : process.argv[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`missing required option ${name}`)
    return value
}
