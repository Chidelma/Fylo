import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, readlink } from 'node:fs/promises'
import { relative } from 'node:path'

export async function hashRoot(root) {
    const entries = []
    await walk(root, root, entries)
    entries.sort((left, right) => left.path.localeCompare(right.path))
    return {
        algorithm: 'sha256',
        digest: sha256(JSON.stringify(entries)),
        entries
    }
}

async function walk(root, directory, entries) {
    const children = await readdir(directory, { withFileTypes: true })
    children.sort((left, right) => left.name.localeCompare(right.name))
    for (const child of children) {
        const path = `${directory}/${child.name}`
        const metadata = await lstat(path)
        const entry = {
            path: relative(root, path).replaceAll('\\', '/'),
            kind: child.isDirectory() ? 'directory' : child.isSymbolicLink() ? 'symlink' : 'file',
            mode: metadata.mode & 0o777,
            size: metadata.size
        }
        if (child.isSymbolicLink()) {
            entry.target = await readlink(path)
        } else if (child.isFile()) {
            entry.sha256 = sha256(await readFile(path))
        }
        entries.push(entry)
        if (child.isDirectory()) await walk(root, path, entries)
    }
}

function sha256(value) {
    return createHash('sha256').update(value).digest('hex')
}

export function stableJson(value) {
    if (Array.isArray(value)) return value.map(stableJson)
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(
        Object.entries(value)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, child]) => [key, stableJson(child)])
    )
}

export function assertEqual(actual, expected, label) {
    const left = JSON.stringify(stableJson(actual))
    const right = JSON.stringify(stableJson(expected))
    if (left !== right) {
        throw new Error(`${label} mismatch\nexpected: ${right}\nactual:   ${left}`)
    }
}
