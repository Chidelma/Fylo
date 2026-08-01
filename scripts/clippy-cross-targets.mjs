// Clippy only ever compiles the `cfg` blocks for the host target, so a lint
// error inside `#[cfg(target_os = "linux")]` or `#[cfg(windows)]` code stays
// invisible on a macOS workstation until CI fails. Checking the other targets
// locally closes that blind spot; it needs no linker because Clippy only
// checks.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'

const TARGETS = ['x86_64-unknown-linux-gnu', 'x86_64-pc-windows-gnu', 'aarch64-apple-darwin']
const PACKAGES = ['fylo-format', 'fylo-query', 'fylo-storage-native', 'fylo-engine', 'fylo-machine']

const toolchainConfig = await readFile(new URL('../rust-toolchain.toml', import.meta.url), 'utf8')
const toolchain = toolchainConfig.match(/^channel\s*=\s*"([^"]+)"\s*$/m)?.[1]
if (!toolchain) throw new Error('rust-toolchain.toml must define an exact channel')

const installed = await capture('rustup', [
    'target',
    'list',
    '--installed',
    '--toolchain',
    toolchain
])
const missing = TARGETS.filter((target) => !installed.includes(target))
if (missing.length > 0) {
    console.error(`Install the missing targets first: rustup target add ${missing.join(' ')}`)
    process.exit(1)
}

for (const target of TARGETS) {
    console.error(`clippy --target ${target}`)
    const environment = crossCompilerEnvironment(target)
    await run(
        process.execPath,
        [
            './scripts/run-rust.mjs',
            'cargo',
            'clippy',
            '--target',
            target,
            ...PACKAGES.flatMap((name) => ['-p', name]),
            '--all-features',
            '--',
            '-D',
            'warnings'
        ],
        environment
    )
}
console.log(`Clippy passed for ${TARGETS.join(', ')}`)

function run(command, args, environment = process.env) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { stdio: 'inherit', env: environment })
        child.once('error', reject)
        child.once('exit', (code) =>
            code === 0 ? resolve(undefined) : reject(new Error(`${command} exited with ${code}`))
        )
    })
}

function crossCompilerEnvironment(target) {
    if (target !== 'x86_64-unknown-linux-gnu' || process.platform !== 'darwin') {
        return process.env
    }
    const zig = findExecutable('zig')
    if (!zig) return process.env
    return {
        ...process.env,
        CC_x86_64_unknown_linux_gnu: `${zig} cc -target x86_64-linux-gnu`,
        AR_x86_64_unknown_linux_gnu: `${zig} ar`,
        // cc-rs otherwise appends Rust's target spelling, which Zig does not
        // accept in addition to its own `-target` argument.
        CRATE_CC_NO_DEFAULTS: '1'
    }
}

function findExecutable(name) {
    for (const directory of (process.env.PATH ?? '').split(delimiter)) {
        const candidate = join(directory, name)
        if (existsSync(candidate)) return candidate
    }
    return null
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
