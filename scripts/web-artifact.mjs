#!/usr/bin/env bun

import { createHash } from 'node:crypto'
import { chmod, copyFile, lstat, mkdir, mkdtemp, readdir, rm, utimes } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const EPOCH = new Date('2000-01-01T00:00:00.000Z')
const SYNC_CONFLICT = /conflicted copy/i

async function filesBelow(root, directory = root) {
    const files = []
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    )) {
        const target = path.join(directory, entry.name)
        if (SYNC_CONFLICT.test(entry.name))
            throw new Error(`Refusing sync-conflict file in web artifact: ${target}`)
        if (entry.isSymbolicLink()) throw new Error(`Refusing symlink in web artifact: ${target}`)
        if (entry.isDirectory()) files.push(...(await filesBelow(root, target)))
        else if (entry.isFile()) files.push(path.relative(root, target))
        else throw new Error(`Unsupported web artifact entry: ${target}`)
    }
    return files
}

async function run(command, args, cwd) {
    const child = Bun.spawn([command, ...args], {
        cwd,
        env: { ...process.env, TZ: 'UTC' },
        stdout: 'inherit',
        stderr: 'inherit'
    })
    const status = await child.exited
    if (status !== 0) throw new Error(`${command} exited with status ${status}`)
}

export async function createWebArtifact(source, outputDirectory) {
    const sourceStat = await lstat(source).catch(() => null)
    if (!sourceStat?.isDirectory()) throw new Error(`Web build directory does not exist: ${source}`)

    const relativeFiles = await filesBelow(source)
    if (relativeFiles.length === 0) throw new Error(`Web build directory is empty: ${source}`)
    if (!relativeFiles.includes('index.html'))
        throw new Error(`Web build has no index.html: ${source}`)

    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'fylo-web-artifact-'))
    const stage = path.join(temporaryRoot, 'stage')
    const candidate = path.join(temporaryRoot, 'artifact.zip')
    try {
        await mkdir(stage)
        for (const relative of relativeFiles) {
            const destination = path.join(stage, relative)
            await mkdir(path.dirname(destination), { recursive: true })
            await copyFile(path.join(source, relative), destination)
            await chmod(destination, 0o644)
            await utimes(destination, EPOCH, EPOCH)
        }
        await run('zip', ['-X', '-q', candidate, ...relativeFiles], stage)
        const bytes = await Bun.file(candidate).arrayBuffer()
        const checksum = createHash('sha256').update(Buffer.from(bytes)).digest('hex')
        await mkdir(outputDirectory, { recursive: true })
        const output = path.join(outputDirectory, `${checksum}.zip`)
        if (!(await Bun.file(output).exists())) await copyFile(candidate, output)
        return { checksum, output, files: relativeFiles.length, bytes: bytes.byteLength }
    } finally {
        await rm(temporaryRoot, { recursive: true, force: true })
    }
}

async function main() {
    const [source, outputDirectory = 'dist/releases'] = process.argv.slice(2)
    if (!source)
        throw new Error('Usage: bun scripts/web-artifact.mjs <dist/web> [artifact-directory]')
    const result = await createWebArtifact(path.resolve(source), path.resolve(outputDirectory))
    console.log(JSON.stringify(result))
}

if (import.meta.main)
    main().catch((error) => {
        console.error(error.message)
        process.exitCode = 1
    })
