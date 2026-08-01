import { createHash } from 'node:crypto'
import { chmod, copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { arch, platform, release } from 'node:os'
import { basename, join, resolve } from 'node:path'

const arguments_ = process.argv.slice(2)
const binary = resolve(requiredOption('--binary'))
const output = resolve(option('--output') ?? 'target/candidate')
const label = option('--label') ?? `${platform()}-${arch()}`
const allowDirty = arguments_.includes('--allow-dirty')
const expectedVersion = (await readFile('VERSION', 'utf8')).trim()
const commit = (await command(['git', 'rev-parse', 'HEAD'])).trim()

if (!/^[0-9a-f]{40}$/i.test(commit)) throw new Error(`invalid source commit: ${commit}`)
const dirty = Boolean((await command(['git', 'status', '--porcelain'])).trim())
if (!allowDirty && dirty) {
    throw new Error('candidate staging requires a clean working tree')
}

const identity = JSON.parse(await command([binary, 'version', '--output', 'json']))
if (identity.runtimeVersion !== expectedVersion) {
    throw new Error(
        `candidate version mismatch: binary ${identity.runtimeVersion}, source ${expectedVersion}`
    )
}
if (identity.commit !== commit) {
    throw new Error(`candidate commit mismatch: binary ${identity.commit}, source ${commit}`)
}
if (
    identity.buildKind !== 'native-rust-preview' ||
    identity.protocolVersion !== 1 ||
    identity.capabilities?.handshake !== true ||
    identity.capabilities?.wholeRootBackup !== undefined
) {
    throw new Error('candidate binary does not identify as the mutating Rust preview')
}

await mkdir(output, { recursive: true })
const extension = platform() === 'win32' ? '.exe' : ''
const assetName = `fylo-rust-${label}${extension}`
const asset = join(output, assetName)
await copyFile(binary, asset)
if (platform() !== 'win32') await chmod(asset, 0o755)
const bytes = await readFile(asset)
const digest = createHash('sha256').update(bytes).digest('hex')
const info = await stat(asset)
const rustc = await command([process.execPath, './scripts/run-rust.mjs', 'rustc', '-Vv'])
const manifest = {
    format: 'fylo.rust-candidate.v1',
    generatedAt: new Date().toISOString(),
    source: { commit, clean: !dirty, version: expectedVersion },
    artifact: {
        name: assetName,
        bytes: info.size,
        sha256: digest,
        identity
    },
    environment: {
        os: platform(),
        release: release(),
        architecture: arch(),
        label,
        rustc: rustc.trim()
    },
    evidenceProfile: 'candidate',
    productSupportTier: 'developer-preview',
    releaseEligible: false
}
const manifestPath = join(output, `${basename(assetName, extension)}.manifest.json`)
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
await writeFile(join(output, `${assetName}.sha256`), `${digest}  ${assetName}\n`)
console.log(JSON.stringify({ asset, manifest: manifestPath, sha256: digest }, null, 2))

function requiredOption(name) {
    const value = option(name)
    if (value === undefined) throw new Error(`missing ${name}`)
    return value
}

function option(name) {
    const index = arguments_.indexOf(name)
    if (index === -1) return undefined
    const value = arguments_[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${name}`)
    return value
}

async function command(commandArguments) {
    const child = Bun.spawn(commandArguments, {
        cwd: process.cwd(),
        env: process.env,
        stdout: 'pipe',
        stderr: 'pipe'
    })
    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited
    ])
    if (exitCode !== 0) {
        throw new Error(
            `${commandArguments.join(' ')} failed (${exitCode}): ${stderr.trim() || stdout.trim()}`
        )
    }
    return stdout
}
