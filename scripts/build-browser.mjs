import { cp, mkdir, readFile, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const engineOnly = process.argv.includes('--engine-only')
const withWasm = process.argv.includes('--wasm') || engineOnly
const bunVersion = (
    process.env.FYLO_BUN_VERSION ??
    (await readFile(new URL('../.bun-version', import.meta.url), 'utf8'))
).trim()

if (Bun.version !== bunVersion) {
    throw new Error(`Browser builds require Bun ${bunVersion}; running ${Bun.version}`)
}

await mkdir(new URL('../dist-web/', import.meta.url), { recursive: true })
if (!engineOnly) {
    await run('bun', [
        'build',
        './src/browser/index.js',
        '--target=browser',
        '--outfile',
        './dist-web/fylo.mjs'
    ])
    await run('bun', [
        'build',
        './src/browser/worker/shared.js',
        '--target=browser',
        '--outfile',
        './dist-web/shared.js'
    ])
    await run('bun', [
        'build',
        './src/browser/worker/dedicated.js',
        '--target=browser',
        '--outfile',
        './dist-web/dedicated.js'
    ])
}

// The index kernel accelerates queries beside the JavaScript core; the browser
// engine is the whole engine. Both are wasm32-unknown-unknown, so they share
// one toolchain setup.
// The engine reaches `getrandom` through both 0.3 and 0.4 (aes-gcm pulls the
// latter), and neither supports wasm32-unknown-unknown without a backend. Both
// majors call the same `__getrandom_v03_custom` symbol, which `fylo-wasm`
// exports over the host table, so one cfg covers them. It stays scoped to this
// build: the index kernel has no such shim to satisfy the flag.
const CUSTOM_ENTROPY = '--cfg getrandom_backend="custom"'

const WASM_ARTIFACTS = [
    ['fylo_browser_index.wasm', 'fylo-index.wasm', 'src/browser/wasm/Cargo.toml', ''],
    ['fylo_wasm.wasm', 'fylo-browser.wasm', 'crates/fylo-wasm/Cargo.toml', CUSTOM_ENTROPY]
]

if (withWasm) {
    const artifacts = engineOnly ? WASM_ARTIFACTS.slice(1) : WASM_ARTIFACTS
    for (const [built, published, manifest, rustflags] of artifacts) {
        await buildWasm(manifest, rustflags)
        await rm(new URL(`../dist-web/${published}`, import.meta.url), { force: true })
        await cp(
            new URL(`../target/wasm32-unknown-unknown/release/${built}`, import.meta.url),
            new URL(`../dist-web/${published}`, import.meta.url)
        )
    }
}

if (engineOnly) {
    console.log('Built dist-web/fylo-browser.wasm')
} else {
    console.log(
        `Built dist-web/fylo.mjs, shared.js, dedicated.js${
            withWasm ? `, ${WASM_ARTIFACTS.map(([, published]) => published).join(', ')}` : ''
        }`
    )
}

async function buildWasm(manifest, rustflags) {
    const toolchain = await rustToolchain()
    const rustc = await capture('rustup', ['which', 'rustc', '--toolchain', toolchain]).catch(
        async () => {
            await run('rustup', ['toolchain', 'install', toolchain, '--profile', 'minimal'])
            return await capture('rustup', ['which', 'rustc', '--toolchain', toolchain])
        }
    )
    await run('rustup', ['target', 'add', 'wasm32-unknown-unknown', '--toolchain', toolchain])
    await run(
        'rustup',
        [
            'run',
            toolchain,
            'cargo',
            'build',
            '--manifest-path',
            manifest,
            '--release',
            '--target',
            'wasm32-unknown-unknown',
            '--locked'
        ],
        {
            ...process.env,
            RUSTC: rustc.trim(),
            RUSTFLAGS: [process.env.RUSTFLAGS, rustflags].filter(Boolean).join(' ')
        }
    )
}

async function rustToolchain() {
    const config = await readFile(new URL('../rust-toolchain.toml', import.meta.url), 'utf8')
    const channel = config.match(/^channel\s*=\s*"([^"]+)"\s*$/m)?.[1]
    if (!channel) throw new Error('rust-toolchain.toml must define an exact channel')
    return channel
}

/** @param {string} command @param {string[]} args @param {NodeJS.ProcessEnv=} env */
async function run(command, args, env = process.env) {
    await new Promise((resolve, reject) => {
        const child = spawn(command, args, { cwd: root, stdio: 'inherit', env })
        child.once('error', reject)
        child.once('exit', (code) =>
            code === 0 ? resolve(undefined) : reject(new Error(`${command} exited with ${code}`))
        )
    })
}

/** @param {string} command @param {string[]} args */
async function capture(command, args) {
    return await new Promise((resolve, reject) => {
        const child = spawn(command, args, { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] })
        let output = ''
        child.stdout.on('data', (chunk) => (output += chunk))
        child.once('error', reject)
        child.once('exit', (code) =>
            code === 0 ? resolve(output) : reject(new Error(`${command} exited with ${code}`))
        )
    })
}
