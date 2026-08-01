import { cp, mkdir, readFile, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const withWasm = process.argv.includes('--wasm')
const bunVersion = (
    process.env.FYLO_BUN_VERSION ??
    (await readFile(new URL('../.bun-version', import.meta.url), 'utf8'))
).trim()

if (Bun.version !== bunVersion) {
    throw new Error(`Browser builds require Bun ${bunVersion}; running ${Bun.version}`)
}

await mkdir(new URL('../dist-web/', import.meta.url), { recursive: true })
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

if (withWasm) {
    await buildWasm()
    await rm(new URL('../dist-web/fylo-index.wasm', import.meta.url), { force: true })
    await cp(
        new URL(
            '../target/wasm32-unknown-unknown/release/fylo_browser_index.wasm',
            import.meta.url
        ),
        new URL('../dist-web/fylo-index.wasm', import.meta.url)
    )
}

console.log(
    `Built dist-web/fylo.mjs, shared.js, dedicated.js${withWasm ? ', fylo-index.wasm' : ''}`
)

async function buildWasm() {
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
            'src/browser/wasm/Cargo.toml',
            '--release',
            '--target',
            'wasm32-unknown-unknown',
            '--locked'
        ],
        { ...process.env, RUSTC: rustc.trim() }
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
