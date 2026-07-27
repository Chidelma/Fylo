// Clippy only ever compiles the `cfg` blocks for the host target, so a lint
// error inside `#[cfg(target_os = "linux")]` or `#[cfg(windows)]` code stays
// invisible on a macOS workstation until CI fails. Checking the other targets
// locally closes that blind spot; it needs no linker because Clippy only
// checks.
import { spawn } from 'node:child_process'

const TARGETS = ['x86_64-unknown-linux-gnu', 'x86_64-pc-windows-gnu', 'aarch64-apple-darwin']
const PACKAGES = ['fylo-format', 'fylo-query', 'fylo-storage-native', 'fylo-engine', 'fylo-machine']

const installed = await capture('rustup', ['target', 'list', '--installed'])
const missing = TARGETS.filter((target) => !installed.includes(target))
if (missing.length > 0) {
    console.error(`Install the missing targets first: rustup target add ${missing.join(' ')}`)
    process.exit(1)
}

for (const target of TARGETS) {
    console.error(`clippy --target ${target}`)
    await run('cargo', [
        'clippy',
        '--target',
        target,
        ...PACKAGES.flatMap((name) => ['-p', name]),
        '--all-features',
        '--',
        '-D',
        'warnings'
    ])
}
console.log(`Clippy passed for ${TARGETS.join(', ')}`)

function run(command, args) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { stdio: 'inherit' })
        child.once('error', reject)
        child.once('exit', (code) =>
            code === 0 ? resolve(undefined) : reject(new Error(`${command} exited with ${code}`))
        )
    })
}

function capture(command, args) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'inherit'] })
        let output = ''
        child.stdout.on('data', (chunk) => (output += chunk))
        child.once('error', reject)
        child.once('exit', () => resolve(output))
    })
}
