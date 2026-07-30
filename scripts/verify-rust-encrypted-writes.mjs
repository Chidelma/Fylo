import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { platform, tmpdir } from 'node:os'
import { join } from 'node:path'

import Fylo from '../src/index.js'
import { shardOf } from '../src/core/shard.js'

const workspace = await mkdtemp(join(tmpdir(), 'fylo-rust-encrypted-'))
const root = join(workspace, 'root')
const schemaRoot = join(workspace, 'schema')
const collection = 'secrets'
const identifier = '4VRNF52JPCO'
const encryptionKey = 'rust-encrypted-write-interop-key-32-bytes'
const cipherSalt = 'rust-encrypted-write-interop-salt'
const previous = {
    schema: process.env.FYLO_SCHEMA,
    key: process.env.FYLO_ENCRYPTION_KEY,
    salt: process.env.FYLO_CIPHER_SALT
}

try {
    await mkdir(root, { recursive: true })
    await mkdir(join(schemaRoot, collection, 'history'), { recursive: true })
    await writeFile(
        join(schemaRoot, collection, 'manifest.json'),
        JSON.stringify({ current: 'v1', versions: [{ v: 'v1' }] })
    )
    await writeFile(
        join(schemaRoot, collection, 'history', 'v1.schema.json'),
        JSON.stringify({ $encrypted: ['secret', 'nested/verifier'] })
    )
    process.env.FYLO_SCHEMA = schemaRoot
    process.env.FYLO_ENCRYPTION_KEY = encryptionKey
    process.env.FYLO_CIPHER_SALT = cipherSalt

    const seed = new Fylo(root, { versioning: { autoCommit: false } })
    await seed[collection].create()
    await seed.close()

    await command([
        process.execPath,
        './scripts/run-rust.mjs',
        'cargo',
        'build',
        '--locked',
        '-p',
        'fylo-cli',
        '--bin',
        'fylo-write-preview'
    ])
    const binary = join(
        process.cwd(),
        'target',
        'debug',
        platform() === 'win32' ? 'fylo-write-preview.exe' : 'fylo-write-preview'
    )

    await runRequired(binary, [
        'put-document',
        '--root',
        root,
        '--collection',
        collection,
        '--id',
        identifier,
        '--document',
        JSON.stringify({
            kind: 'security-event',
            secret: 'correct horse/battery staple',
            nested: { verifier: 42 }
        })
    ])

    const stored = JSON.parse(
        await readFile(
            join(
                root,
                '.collections',
                collection,
                'docs',
                shardOf(identifier),
                `${identifier}.json`
            ),
            {
                encoding: 'utf8'
            }
        )
    )
    assert(stored.kind === 'security-event', 'Rust encrypted a field the schema did not declare')
    assert(
        !('_v' in stored),
        'Rust stamped a schema version outside FYLO_STRICT, where JavaScript does not'
    )
    assert(String(stored.secret).startsWith('v2.'), 'Rust stored a declared field as plaintext')
    assert(
        String(stored.nested.verifier).startsWith('v2.'),
        'Rust stored a declared nested field as plaintext'
    )

    const reader = new Fylo(root, { versioning: { autoCommit: false } })
    await reader.ready()
    const document = (await reader[collection].get(identifier).once())[identifier]
    assert(
        document.secret === 'correct horse/battery staple',
        'JavaScript could not decrypt the Rust ciphertext'
    )
    assert(document.nested.verifier === 42, 'JavaScript lost the Rust encrypted typed value')
    await reader.close()

    const rejected = await run(
        binary,
        [
            'put-document',
            '--root',
            root,
            '--collection',
            collection,
            '--id',
            '4VRNF52JPCP',
            '--document',
            JSON.stringify({ secret: 'unwritable' })
        ],
        { FYLO_ENCRYPTION_KEY: 'short' }
    )
    assert(rejected.exitCode !== 0, 'Rust accepted an invalid encryption key')
    assert(
        !rejected.stderr.includes('unwritable'),
        'Rust leaked plaintext through an encryption error'
    )
    const survivors = new Fylo(root, { versioning: { autoCommit: false } })
    await survivors.ready()
    const inspection = await survivors[collection].inspect()
    assert(Number(inspection.docsStored) === 1, 'A rejected encrypted write left a document behind')
    await survivors.close()

    // CHEX validation is a strict-mode contract in both engines: without
    // FYLO_STRICT neither validates nor stamps `_v`, so the native writer must
    // not either.
    await mkdir(join(schemaRoot, 'strict', 'history'), { recursive: true })
    await writeFile(
        join(schemaRoot, 'strict', 'manifest.json'),
        JSON.stringify({ current: 'v1', versions: [{ v: 'v1' }] })
    )
    await writeFile(
        join(schemaRoot, 'strict', 'history', 'v1.schema.json'),
        JSON.stringify({ name: '^[A-Za-z ]+$', level: '^[0-9]+$' })
    )
    const strictSeed = new Fylo(root, { versioning: { autoCommit: false } })
    await strictSeed.strict.create()
    await strictSeed.close()

    const invalid = await run(
        binary,
        [
            'put-document',
            '--root',
            root,
            '--collection',
            'strict',
            '--id',
            '4VRNF52JPCQ',
            '--document',
            JSON.stringify({ name: 'Ada', level: 'not-a-number' })
        ],
        { FYLO_STRICT: '1' }
    )
    assert(invalid.exitCode !== 0, 'Rust stored a document CHEX rejects under FYLO_STRICT')
    assert(invalid.stderr.includes('ESCHEMA'), `Rust schema error-code drift: ${invalid.stderr}`)

    await runRequired(
        binary,
        [
            'put-document',
            '--root',
            root,
            '--collection',
            'strict',
            '--id',
            '4VRNF52JPCR',
            '--document',
            JSON.stringify({ name: 'Ada', level: '3' })
        ],
        { FYLO_STRICT: '1' }
    )
    const strictStored = JSON.parse(
        await readFile(
            join(
                root,
                '.collections',
                'strict',
                'docs',
                shardOf('4VRNF52JPCR'),
                '4VRNF52JPCR.json'
            ),
            {
                encoding: 'utf8'
            }
        )
    )
    assert(strictStored._v === 'v1', 'Rust did not stamp the head schema version under FYLO_STRICT')
    const strictReader = new Fylo(root, { versioning: { autoCommit: false } })
    await strictReader.ready()
    const strictDocument = (await strictReader.strict.get('4VRNF52JPCR').once())['4VRNF52JPCR']
    assert(strictDocument.name === 'Ada', 'JavaScript could not read the CHEX-validated write')
    await strictReader.close()

    console.log('Verified Rust field encryption round-trips through the JavaScript engine')
} finally {
    restore('FYLO_SCHEMA', previous.schema)
    restore('FYLO_ENCRYPTION_KEY', previous.key)
    restore('FYLO_CIPHER_SALT', previous.salt)
    await rm(workspace, { recursive: true, force: true })
}

function restore(name, value) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
}

async function runRequired(binary, arguments_, overrides = {}) {
    const result = await run(binary, arguments_, overrides)
    if (result.exitCode !== 0) {
        throw new Error(`fylo-write-preview failed (${arguments_.join(' ')}): ${result.stderr}`)
    }
    return result
}

async function run(binary, arguments_, overrides = {}) {
    const environment = { ...process.env, ...overrides }
    for (const [name, value] of Object.entries(overrides)) {
        if (value === undefined) delete environment[name]
    }
    const subprocess = Bun.spawn([binary, ...arguments_], {
        cwd: process.cwd(),
        env: environment,
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

async function command(arguments_) {
    const subprocess = Bun.spawn(arguments_, {
        cwd: process.cwd(),
        env: process.env,
        stdout: 'inherit',
        stderr: 'inherit'
    })
    const exitCode = await subprocess.exited
    if (exitCode !== 0) throw new Error(`command failed (${exitCode}): ${arguments_.join(' ')}`)
}

function assert(condition, message) {
    if (!condition) throw new Error(message)
}
