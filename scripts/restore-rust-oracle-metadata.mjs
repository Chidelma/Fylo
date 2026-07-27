import { chmod, chown, lstat, readFile, utimes } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

import { listXattr, removeXattr, setXattr } from '../src/storage/xattr.js'

const directory = resolve(requiredOption('--input'))
const ownership = option('--ownership') ?? 'best-effort'
if (!['best-effort', 'require', 'skip'].includes(ownership)) {
    throw new Error('--ownership must be best-effort, require, or skip')
}
const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
const root = resolve(directory, manifest.root.path)
const metadataPath = resolve(directory, manifest.root.nativeMetadata)
const entries = (await readFile(metadataPath, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))

let xattrsApplied = 0
let ownershipApplied = 0
let ownershipSkipped = 0
for (const entry of entries.filter((entry) => entry.kind !== 'directory')) {
    const path = safePath(root, entry.path)
    const metadata = await lstat(path)
    if (entry.kind !== 'file' || !metadata.isFile()) {
        throw new Error(`oracle entry kind drift: ${entry.path}`)
    }
    await restoreXattrs(path, entry.xattrs ?? {})
    xattrsApplied += Object.keys(entry.xattrs ?? {}).length
    await chmod(path, entry.mode)
    await restoreOwnership(path, entry)
    await restoreMtime(path, entry.mtimeNs)
}

const directories = entries
    .filter((entry) => entry.kind === 'directory')
    .sort((left, right) => right.path.split('/').length - left.path.split('/').length)
for (const entry of directories) {
    const path = safePath(root, entry.path)
    const metadata = await lstat(path)
    if (!metadata.isDirectory()) throw new Error(`oracle directory kind drift: ${entry.path}`)
    await chmod(path, entry.mode)
    await restoreOwnership(path, entry)
    await restoreMtime(path, entry.mtimeNs)
}

console.log(
    JSON.stringify({
        format: 'fylo.released-oracle-restore.v1',
        entries: entries.length,
        xattrsApplied,
        ownershipApplied,
        ownershipSkipped
    })
)

async function restoreXattrs(path, expected) {
    const current = await listXattr(path)
    for (const name of current) {
        if (isFyloXattr(name) && !Object.hasOwn(expected, name)) {
            await removeXattr(path, name)
        }
    }
    for (const [name, encoded] of Object.entries(expected)) {
        if (!isFyloXattr(name)) throw new Error(`unsafe non-FYLO xattr in oracle: ${name}`)
        await setXattr(path, name, Buffer.from(encoded, 'base64'))
    }
}

async function restoreOwnership(path, entry) {
    if (ownership === 'skip') {
        ownershipSkipped++
        return
    }
    try {
        await chown(path, Number(entry.uid), Number(entry.gid))
        ownershipApplied++
    } catch (error) {
        if (ownership === 'require') throw error
        ownershipSkipped++
    }
}

async function restoreMtime(path, encodedNanoseconds) {
    const seconds = Number(BigInt(encodedNanoseconds)) / 1_000_000_000
    await utimes(path, seconds, seconds)
}

function safePath(rootPath, relativePath) {
    if (
        typeof relativePath !== 'string' ||
        relativePath.length === 0 ||
        relativePath.startsWith('/') ||
        relativePath.split('/').some((component) => !component || component === '..')
    ) {
        throw new Error(`unsafe oracle metadata path: ${relativePath}`)
    }
    const path = resolve(rootPath, ...relativePath.split('/'))
    if (path !== rootPath && !path.startsWith(`${rootPath}${sep}`)) {
        throw new Error(`oracle metadata path escapes root: ${relativePath}`)
    }
    return path
}

function isFyloXattr(name) {
    return name === 'user.fylo.access' || name.startsWith('user.fylo.')
}

function requiredOption(name) {
    const value = option(name)
    if (!value) throw new Error(`missing required option ${name}`)
    return value
}

function option(name) {
    const index = process.argv.indexOf(name)
    const value = index === -1 ? undefined : process.argv[index + 1]
    if (index !== -1 && (!value || value.startsWith('--'))) {
        throw new Error(`missing value for ${name}`)
    }
    return value
}
