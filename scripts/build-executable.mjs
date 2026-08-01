import { chmod, copyFile, mkdir, rm } from 'node:fs/promises'
import path from 'node:path'

const TARGETS = new Map([
    ['bun-linux-x64', ['x86_64-unknown-linux-gnu', 'linux-x64']],
    ['bun-linux-arm64', ['aarch64-unknown-linux-gnu', 'linux-arm64']],
    ['bun-darwin-x64', ['x86_64-apple-darwin', 'macos-x64']],
    ['bun-darwin-arm64', ['aarch64-apple-darwin', 'macos-arm64']],
    ['bun-windows-x64', ['x86_64-pc-windows-msvc', 'windows-x64']],
    ['x86_64-unknown-linux-gnu', ['x86_64-unknown-linux-gnu', 'linux-x64']],
    ['aarch64-unknown-linux-gnu', ['aarch64-unknown-linux-gnu', 'linux-arm64']],
    ['x86_64-apple-darwin', ['x86_64-apple-darwin', 'macos-x64']],
    ['aarch64-apple-darwin', ['aarch64-apple-darwin', 'macos-arm64']],
    ['x86_64-pc-windows-msvc', ['x86_64-pc-windows-msvc', 'windows-x64']]
])

function releaseCommit() {
    const candidate = process.env.FYLO_BUILD_COMMIT ?? process.env.GITHUB_SHA
    return candidate && /^[0-9a-f]{40}$/i.test(candidate) ? candidate : 'unknown'
}

function hostBuildTarget() {
    const platform =
        process.platform === 'darwin'
            ? 'macos'
            : process.platform === 'win32'
              ? 'windows'
              : process.platform
    return `${platform}-${process.arch}`
}

function parseArguments(argv) {
    let target
    let output
    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index]
        if (argument !== '--target' && argument !== '--outfile') {
            throw new Error(`Unknown build argument: ${argument}`)
        }
        const value = argv[++index]
        if (!value) throw new Error(`Missing value for ${argument}`)
        if (argument === '--target') target = value
        else output = value
    }
    return { target, output }
}

function targetConfiguration(target) {
    if (!target) return { rustTarget: undefined, identity: hostBuildTarget() }
    const configuration = TARGETS.get(target)
    if (!configuration) throw new Error(`Unsupported FYLO build target: ${target}`)
    return { rustTarget: configuration[0], identity: configuration[1] }
}

async function run(command, options = {}) {
    const child = Bun.spawn(command, {
        env: options.env ?? process.env,
        stdin: 'inherit',
        stdout: options.capture ? 'pipe' : 'inherit',
        stderr: options.capture ? 'pipe' : 'inherit'
    })
    if (!options.capture) return { exitCode: await child.exited }
    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited
    ])
    return { stdout, stderr, exitCode }
}

const options = parseArguments(process.argv.slice(2))
const target = targetConfiguration(options.target)
const output = path.resolve(
    options.output ?? path.join('dist-bin', process.platform === 'win32' ? 'fylo.exe' : 'fylo')
)
const commit = releaseCommit()
const buildKind =
    process.env.FYLO_BUILD_KIND ?? (commit === 'unknown' ? 'development-compiled' : 'release')
if (!['development-compiled', 'native-rust-preview', 'release'].includes(buildKind)) {
    throw new Error(`Unsupported FYLO build kind: ${buildKind}`)
}
if (buildKind === 'release' && commit === 'unknown') {
    throw new Error('A release build requires FYLO_BUILD_COMMIT or GITHUB_SHA')
}

const cargo = [
    process.execPath,
    './scripts/run-rust.mjs',
    'cargo',
    'build',
    '--release',
    '--locked',
    '-p',
    'fylo-cli',
    '--bin',
    'fylo-rust'
]
if (target.rustTarget) cargo.push('--target', target.rustTarget)
const build = await run(cargo, {
    env: {
        ...process.env,
        FYLO_BUILD_COMMIT: commit,
        FYLO_BUILD_KIND: buildKind,
        FYLO_BUILD_TARGET: target.identity
    }
})
if (build.exitCode !== 0) process.exit(build.exitCode)

const targetIsWindows = target.identity.startsWith('windows-')
const executable = targetIsWindows ? 'fylo-rust.exe' : 'fylo-rust'
const built = path.resolve(
    'target',
    ...(target.rustTarget ? [target.rustTarget] : []),
    'release',
    executable
)
await mkdir(path.dirname(output), { recursive: true })
await rm(output, { force: true })
await copyFile(built, output)
if (!targetIsWindows) await chmod(output, 0o755)

const probe = await run([output, 'version', '--output', 'json'], { capture: true })
if (probe.exitCode !== 0) {
    throw new Error(`Built FYLO executable failed its identity probe: ${probe.stderr.trim()}`)
}
const identity = JSON.parse(probe.stdout)
if (
    identity.commit !== commit ||
    identity.buildKind !== buildKind ||
    identity.buildTarget !== target.identity
) {
    throw new Error(
        `Built FYLO identity mismatch: ${JSON.stringify({
            expected: { commit, buildKind, buildTarget: target.identity },
            actual: identity
        })}`
    )
}
