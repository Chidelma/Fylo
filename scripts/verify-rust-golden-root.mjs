import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import Fylo from '../src/index.js'
import { assertEqual, hashRoot } from './rust-golden-root-lib.mjs'

const input = option('--input')
if (!input) throw new Error('Usage: verify-rust-golden-root.mjs --input <fixture-directory>')

const directory = resolve(input)
const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
const previousEnvironment = {
    schema: process.env.FYLO_SCHEMA,
    key: process.env.FYLO_ENCRYPTION_KEY,
    salt: process.env.FYLO_CIPHER_SALT
}
const supportedFormats = ['fylo.rust-golden-root.v1', 'fylo.released-oracle.v1']
if (!supportedFormats.includes(manifest.format)) {
    throw new Error(`Unsupported golden-root manifest: ${manifest.format}`)
}
if (manifest.format === 'fylo.released-oracle.v1') {
    assertEqual(manifest.producer.buildKind, 'release', 'released producer build kind')
    assertEqual(
        manifest.producer.version,
        manifest.producer.releaseTag.replace(/^v/, ''),
        'released producer version'
    )
    const nativeMetadata = await readFile(join(directory, manifest.root.nativeMetadata), 'utf8')
    assertEqual(
        sha256(nativeMetadata),
        manifest.root.nativeMetadataSha256,
        'native metadata digest'
    )
    const schemaRoot = join(directory, manifest.schema.path)
    const schemaTree = await hashRoot(schemaRoot)
    assertEqual(schemaTree.digest, manifest.schema.digest, 'schema root digest')
    process.env.FYLO_SCHEMA = schemaRoot
    process.env.FYLO_ENCRYPTION_KEY = manifest.schema.testCredentials.key
    process.env.FYLO_CIPHER_SALT = manifest.schema.testCredentials.salt
    for (const [caseName, testCase] of Object.entries(manifest.cases)) {
        const caseTree = await hashRoot(join(directory, testCase.path))
        assertEqual(caseTree.digest, testCase.digest, `${caseName} digest`)
        if (typeof testCase.expectedError?.code !== 'string') {
            throw new Error(`${caseName} has no released error code`)
        }
    }
}
const operationFrames = (await readFile(join(directory, manifest.operations), 'utf8'))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
if (operationFrames.length < 7) throw new Error('Golden-root operation log is incomplete')

const root = join(directory, manifest.root.path)
const tree = await hashRoot(root)
assertEqual(tree.digest, manifest.root.digest, 'root digest')
assertEqual(tree.entries.length, manifest.root.entries, 'root entry count')

const database = new Fylo(root, { versioning: { autoCommit: false } })
try {
    const document = manifest.probes.document
    assertEqual(
        await database[document.collection].get(document.id).once(),
        document.value,
        'document probe'
    )
    assertMetadataEqual(
        await database[document.collection].get(document.id).metadata(),
        document.metadata,
        'document metadata probe',
        manifest.format
    )

    const protectedDocument = manifest.probes.protectedDocument
    const protectedGet = protectedDocument.access
        ? database[protectedDocument.collection]
              .get(protectedDocument.id)
              .as({ uid: protectedDocument.access.uid })
        : database[protectedDocument.collection].get(protectedDocument.id).once()
    assertEqual(await protectedGet, protectedDocument.value, 'protected document probe')

    const query = manifest.probes.query
    assertEqual(
        await collect(database[query.collection].find(query.query), manifest.format),
        query.value,
        'query probe'
    )
    const deleted = manifest.probes.deleted
    assertEqual(
        await collect(database[deleted.collection].find.deleted(deleted.query), manifest.format),
        deleted.value,
        'deleted-document probe'
    )

    const file = manifest.probes.file
    assertFileValueEqual(
        await database[file.collection].get(file.id).once(),
        file.value,
        file.id,
        manifest.format
    )
    assertMetadataEqual(
        await database[file.collection].get(file.id).metadata(),
        file.metadata,
        'file metadata probe',
        manifest.format
    )
    assertEqual(
        Buffer.from(await database[file.collection].get(file.id).bytes()).toString('base64'),
        file.bytesBase64,
        'file bytes probe'
    )
    if (manifest.probes.encrypted) {
        const encrypted = manifest.probes.encrypted
        assertEqual(
            await database[encrypted.collection].get(encrypted.id).once(),
            encrypted.value,
            'encrypted document probe'
        )
    }
} finally {
    await database.close()
}
const after = await hashRoot(root)
assertEqual(after.digest, manifest.root.digest, 'root digest after verification')
restoreEnvironment('FYLO_SCHEMA', previousEnvironment.schema)
restoreEnvironment('FYLO_ENCRYPTION_KEY', previousEnvironment.key)
restoreEnvironment('FYLO_CIPHER_SALT', previousEnvironment.salt)

console.log(
    `Verified ${manifest.format} from FYLO ${manifest.producer.version} with ${operationFrames.length} operations`
)

async function collect(cursor, format) {
    const values = []
    for await (const value of cursor.collect()) values.push(value)
    return format === 'fylo.released-oracle.v1' ? Object.assign({}, ...values) : values
}

function option(name) {
    const index = process.argv.indexOf(name)
    return index === -1 ? null : process.argv[index + 1]
}

function sha256(value) {
    return createHash('sha256').update(value).digest('hex')
}

function assertMetadataEqual(actual, expected, label, format) {
    if (format !== 'fylo.released-oracle.v1') {
        assertEqual(actual, expected, label)
        return
    }
    const timestampFields = ['mtime', 'updatedAt', 'lastModified']
    const actualStable = { ...actual }
    const expectedStable = { ...expected }
    for (const field of timestampFields) {
        if (Object.hasOwn(expectedStable, field)) {
            const drift = Math.abs(Number(actualStable[field]) - Number(expectedStable[field]))
            if (!Number.isFinite(drift) || drift > 1) {
                throw new Error(`${label} ${field} drift exceeds 1ms: ${drift}`)
            }
        }
        delete actualStable[field]
        delete expectedStable[field]
    }
    assertEqual(actualStable, expectedStable, label)
}

function assertFileValueEqual(actual, expected, id, format) {
    if (format !== 'fylo.released-oracle.v1') {
        assertEqual(actual, expected, 'file probe')
        return
    }
    const actualRecord = actual[id]
    const expectedRecord = expected[id]
    // A released binary predating the checksum-stamp fix recorded a raw file's
    // mtime before writing its alternate data stream, and that write moved the
    // time forward. The current engine reports what the file actually says, so
    // on Windows the recorded value may legitimately be earlier. Only that
    // direction is tolerated, and only there: an earlier actual, or any drift
    // on a platform whose xattr writes leave mtime alone, is still a failure.
    const drift = Number(actualRecord?.lastModified) - Number(expectedRecord?.lastModified)
    const releasedWindowsStamp = process.platform === 'win32' && drift > 0
    if (!Number.isFinite(drift) || (Math.abs(drift) > 1 && !releasedWindowsStamp)) {
        throw new Error(`file probe lastModified drift exceeds 1ms: ${drift}`)
    }
    assertEqual(
        { ...actual, [id]: { ...actualRecord, lastModified: 0 } },
        { ...expected, [id]: { ...expectedRecord, lastModified: 0 } },
        'file probe'
    )
}

function restoreEnvironment(name, value) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
}
