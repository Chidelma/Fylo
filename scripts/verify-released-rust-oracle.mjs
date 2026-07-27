import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { assertEqual, hashRoot } from './rust-golden-root-lib.mjs'

const directory = resolve(requiredOption('--input'))
const rustBinary = resolve(
    option('--rust-binary') ??
        join('target', 'debug', process.platform === 'win32' ? 'fylo-rust.exe' : 'fylo-rust')
)
const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
if (manifest.format !== 'fylo.released-oracle.v1') {
    throw new Error(`Unsupported released oracle: ${manifest.format}`)
}
const root = join(directory, manifest.root.path)
const before = await hashRoot(root)
assertEqual(before.digest, manifest.root.digest, 'released root digest before Rust reads')

const document = manifest.probes.document
const rustDocument = await rustJson([
    'get',
    '--root',
    root,
    '--collection',
    document.collection,
    '--id',
    document.id
])
assertEqual(
    rustDocument.document,
    document.value[document.id],
    'released document body in Rust'
)
assertEqual(rustDocument.metadata.id, document.id, 'released document ID in Rust')

const protectedDocument = manifest.probes.protectedDocument
const denied = await rustFailure([
    'get',
    '--root',
    root,
    '--collection',
    protectedDocument.collection,
    '--id',
    protectedDocument.id
])
if (!denied.includes('EACCES')) throw new Error('Rust did not deny an unscoped protected read')
const protectedRecord = await rustJson([
    'get',
    '--root',
    root,
    '--collection',
    protectedDocument.collection,
    '--id',
    protectedDocument.id,
    '--uid',
    String(protectedDocument.access.uid),
    '--groups',
    String(protectedDocument.access.gid)
])
assertEqual(
    protectedRecord.document,
    protectedDocument.value[protectedDocument.id],
    'released protected document in Rust'
)

const query = manifest.probes.query
const rustQuery = await rustJson([
    'find',
    '--root',
    root,
    '--collection',
    query.collection,
    '--query',
    JSON.stringify(query.query)
])
assertEqual(
    Object.fromEntries(rustQuery.map((record) => [record.metadata.id, record.document])),
    query.value,
    'released query result in Rust'
)

const file = manifest.probes.file
const rustFile = await rustJson([
    'get-file',
    '--root',
    root,
    '--collection',
    file.collection,
    '--id',
    file.id
])
const expectedFile = file.value[file.id]
for (const field of [
    'key',
    'extension',
    'contentType',
    'contentLength',
    'etag',
    'checksumSHA256'
]) {
    assertEqual(rustFile.file[field], expectedFile[field], `released raw-file ${field} in Rust`)
}
assertEqual(
    Buffer.from(rustFile.bytesHex, 'hex').toString('base64'),
    file.bytesBase64,
    'released raw-file bytes in Rust'
)
assertEqual(rustFile.customMetadata, expectedFile.meta, 'released raw-file metadata in Rust')

const history = await rustJson(['log', '--root', root, '--limit', '100'])
assertEqual(
    history.commits[0].id,
    manifest.probes.version.commit.id,
    'released version head in Rust'
)
const versionVerification = await rustJson(['verify-history', '--root', root, '--limit', '100'])
if (!versionVerification.contentIntegrity || !versionVerification.historyComplete) {
    throw new Error('Rust did not verify the released version DAG')
}

const after = await hashRoot(root)
assertEqual(after.digest, before.digest, 'released root digest after Rust reads')
console.log(
    `Verified released FYLO ${manifest.producer.version} ${manifest.producer.buildTarget} root with Rust`
)

async function rustJson(argumentsList) {
    const result = await run(argumentsList)
    if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout)
    return JSON.parse(result.stdout)
}

async function rustFailure(argumentsList) {
    const result = await run(argumentsList)
    if (result.exitCode === 0) throw new Error('Rust unexpectedly accepted a denied operation')
    return `${result.stderr}\n${result.stdout}`
}

async function run(argumentsList) {
    const subprocess = Bun.spawn([rustBinary, ...argumentsList], {
        cwd: process.cwd(),
        env: process.env,
        stdout: 'pipe',
        stderr: 'pipe'
    })
    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(subprocess.stdout).text(),
        new Response(subprocess.stderr).text(),
        subprocess.exited
    ])
    return { stdout, stderr, exitCode }
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
