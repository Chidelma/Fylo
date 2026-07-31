// Phase 5 crash gate: kill the native writer at every declared durable
// transition and prove the root still recovers to one valid state.
//
// The failpoint list comes from the binary, not from this file, and every
// declared point must be reached by some scenario. A new failpoint therefore
// cannot be added without either being exercised here or failing this gate,
// which is the property a hand-maintained list cannot give.
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { platform, tmpdir } from 'node:os'
import { join } from 'node:path'

import Fylo from '../src/index.js'
import { shardOf } from '../src/core/shard.js'
import { getXattr } from '../src/storage/xattr.js'

const workspace = await mkdtemp(join(tmpdir(), 'fylo-rust-crash-'))
const template = join(workspace, 'template')
const collection = 'records'
const fileCollection = 'assets'
const identifier = '4VRNF52JPCO'
const secondIdentifier = '4VRNF52JPCP'
const fileIdentifier = '4VRNF52JPCQ'
const deletedIdentifier = '4VRNF52JPCR'

try {
    await mkdir(template, { recursive: true })
    const seed = new Fylo(template, { versioning: { autoCommit: false } })
    await seed[collection].create()
    await seed[fileCollection].create({ kind: 'file' })
    await seed[collection].put(identifier, { name: 'Ada', score: 42 })
    await seed[collection].put(secondIdentifier, { name: 'Grace', score: 50 })
    await seed[collection].put(deletedIdentifier, { name: 'Linus', score: 1 })
    await seed[collection].delete(deletedIdentifier)
    const seededFile = String(
        await seed[fileCollection]
            .put(new File([new Uint8Array([1, 2, 3, 4])], 'seed.bin'), { key: '/seed.bin' })
            .metadata({ source: 'seed' })
    )
    await seed.close()

    // Raw files keep their durable key in an extended attribute. Some
    // filesystems — a CI runner's tmpfs among them — silently carry none, and a
    // collection seeded there is unreadable through no fault of the writer. Ask
    // the attribute directly: a recovery of a stable collection would answer
    // without ever reading a raw file.
    const extendedAttributes =
        getXattr(
            join(
                template,
                '.buckets',
                fileCollection,
                'docs',
                shardOf(seededFile),
                `${seededFile}.bin`
            ),
            'user.fylo.key'
        ) !== null

    // A versioned root is a separate template: the repository failpoints are
    // only reachable where `.fylo-vcs` exists.
    const versionedTemplate = join(workspace, 'versioned-template')
    await mkdir(versionedTemplate, { recursive: true })
    const versionedSeed = new Fylo(versionedTemplate)
    await versionedSeed[collection].create()
    await versionedSeed[collection].put(identifier, { name: 'Ada', score: 42 })
    await versionedSeed[collection].put(secondIdentifier, { name: 'Grace', score: 50 })
    await versionedSeed.close()

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

    const { failpoints } = JSON.parse((await run(binary, ['failpoints'])).stdout)
    assert(Array.isArray(failpoints) && failpoints.length > 0, 'Rust declared no failpoints')

    const scenarios = [
        {
            name: 'put-document',
            args: (root) => [
                'put-document',
                '--root',
                root,
                '--collection',
                collection,
                '--id',
                '4VRNF52JPD0',
                '--document',
                '{"name":"Hopper","score":7}'
            ]
        },
        {
            name: 'put-file',
            args: (root) => [
                'put-file',
                '--root',
                root,
                '--collection',
                fileCollection,
                '--id',
                fileIdentifier,
                '--bytes-hex',
                '0a0b0c',
                '--key',
                '/crash.bin',
                '--extension',
                '.bin',
                '--metadata',
                '{"source":"crash"}'
            ]
        },
        {
            name: 'patch-document',
            args: (root) => [
                'patch-document',
                '--root',
                root,
                '--collection',
                collection,
                '--id',
                identifier,
                '--document',
                '{"name":"Ada","score":99}'
            ]
        },
        {
            name: 'patch-fields',
            args: (root) => [
                'patch-fields',
                '--root',
                root,
                '--collection',
                collection,
                '--id',
                identifier,
                '--changes',
                '{"score":51}'
            ]
        },
        {
            name: 'delete-document',
            args: (root) => [
                'delete-document',
                '--root',
                root,
                '--collection',
                collection,
                '--id',
                identifier
            ]
        },
        {
            name: 'set-metadata',
            args: (root) => [
                'set-metadata',
                '--root',
                root,
                '--collection',
                collection,
                '--id',
                identifier,
                '--record',
                '{"reviewer":"crash"}'
            ]
        },
        {
            name: 'set-access',
            args: (root) => [
                'set-access',
                '--root',
                root,
                '--collection',
                collection,
                '--id',
                identifier,
                '--mode',
                '640'
            ]
        },
        {
            name: 'sql-update',
            args: (root) => [
                'sql',
                '--root',
                root,
                '--statement',
                `UPDATE ${collection} SET score = 77 WHERE name = 'Ada'`
            ]
        },
        {
            name: 'sql-delete',
            args: (root) => [
                'sql',
                '--root',
                root,
                '--statement',
                `DELETE FROM ${collection} WHERE name = 'Grace'`
            ]
        },
        {
            name: 'restore-document',
            args: (root) => [
                'restore-document',
                '--root',
                root,
                '--collection',
                collection,
                '--id',
                deletedIdentifier
            ]
        },
        {
            name: 'reshard',
            args: (root) => ['reshard', '--root', root, '--collection', collection, '--width', '3']
        },
        {
            name: 'commit',
            template: () => versionedTemplate,
            prepare: async (binary, root) => {
                await run(binary, [
                    'patch-fields',
                    '--root',
                    root,
                    '--collection',
                    collection,
                    '--id',
                    identifier,
                    '--changes',
                    '{"score":61}'
                ])
            },
            args: (root) => ['commit', '--root', root, '--message', 'crash matrix commit']
        }
    ].filter((scenario) => extendedAttributes || !scenario.name.includes('file'))

    // Each durable transition is interrupted two ways. `abort` loses the
    // process, so the next opener must recover the journal. `enospc` is an
    // ordinary I/O error, so the writer must roll back in place and leave
    // nothing for recovery to do — a distinction the crash case cannot make.
    const ACTIONS = ['abort', 'enospc']
    const reached = new Set()
    const unsupported = new Set()
    let interrupted = 0
    for (const failpoint of failpoints) {
        for (const scenario of scenarios) {
            for (const action of ACTIONS) {
                const root = join(workspace, `${failpoint}--${scenario.name}--${action}`)
                await cp(scenario.template ? scenario.template() : template, root, {
                    recursive: true
                })
                if (scenario.prepare) await scenario.prepare(binary, root)
                const failed = await run(binary, scenario.args(root), {
                    FYLO_RUST_FAILPOINT: failpoint,
                    FYLO_RUST_FAILPOINT_ACTION: action
                })
                // A mutation the platform does not offer at all never reaches
                // the transition, so it is not evidence either way.
                if (failed.exitCode === 0 || failed.stderr.includes('ENATIVE_UNSUPPORTED')) {
                    if (failed.stderr.includes('ENATIVE_UNSUPPORTED')) {
                        unsupported.add(`${scenario.name} (${failed.stderr.trim().slice(0, 60)})`)
                    }
                    await rm(root, { recursive: true, force: true })
                    continue
                }
                reached.add(failpoint)
                interrupted++
                if (action === 'enospc') {
                    assert(
                        /disk|space|full/i.test(failed.stderr),
                        `${failpoint}/${scenario.name}: a full volume was not reported as one: ${failed.stderr.trim()}`
                    )
                }
                await assertRecoverable(binary, root, failpoint, scenario.name, action)
                await rm(root, { recursive: true, force: true })
            }
        }
    }

    // A transition guarding a capability the platform lacks cannot be reached
    // here, and pretending otherwise would either fail honest runs or hide a
    // real gap. Each exemption names the capability it needs and is printed, so
    // a platform's reduced coverage is visible in the log rather than implied.
    const REQUIRES = {
        'before-file-write': 'extended attributes',
        'after-file-rename': 'extended attributes',
        'after-file-sync': 'extended attributes',
        'after-chown': 'POSIX ownership',
        'after-chmod': 'POSIX ownership',
        'after-access-marker': 'POSIX ownership'
    }
    const available = {
        'extended attributes': extendedAttributes,
        'POSIX ownership': platform() !== 'win32'
    }
    if (!extendedAttributes) {
        console.error(
            'skipped raw-file scenarios: this filesystem does not carry extended attributes'
        )
    }
    for (const skipped of unsupported) console.error(`skipped unsupported here: ${skipped}`)

    const uncovered = failpoints.filter((name) => !reached.has(name))
    const exempt = uncovered.filter((name) => available[REQUIRES[name]] === false)
    for (const name of exempt) {
        console.error(`not reachable here: ${name} requires ${REQUIRES[name]}`)
    }
    const missing = uncovered.filter((name) => !exempt.includes(name))
    assert(
        missing.length === 0,
        `no scenario reaches these declared failpoints: ${missing.join(', ')}`
    )
    console.log(
        `Recovered ${interrupted} interrupted native mutations across ${failpoints.length} failpoints`
    )
} finally {
    await rm(workspace, { recursive: true, force: true })
}

/**
 * A crash may leave the mutation applied or rolled back — both are valid — but
 * the root must always open, recover idempotently, and land on a stable even
 * generation with an index that matches its documents.
 */
async function assertRecoverable(binary, root, failpoint, scenario, action) {
    const label = `${failpoint}/${scenario}/${action}`

    const first = await run(binary, ['recover', '--root', root, '--collection', collection])
    assert(first.exitCode === 0, `${label}: Rust recovery failed: ${first.stderr}`)
    if (action === 'enospc') {
        // The writer stayed alive, so it owed itself a rollback before
        // returning the error. Anything left for recovery means it did not.
        assert(
            JSON.parse(first.stdout).recovered === false,
            `${label}: a failed write left its journal behind instead of rolling back`
        )
    }
    const second = await run(binary, ['recover', '--root', root, '--collection', collection])
    assert(second.exitCode === 0, `${label}: repeated recovery failed: ${second.stderr}`)
    assert(
        JSON.parse(second.stdout).recovered === false,
        `${label}: recovery is not idempotent — the second pass still had work`
    )

    const database = new Fylo(root, { versioning: { autoCommit: false } })
    await database.ready()
    try {
        for (const name of [collection, fileCollection]) {
            const inspection = await database[name].inspect()
            assert(
                Number.isFinite(Number(inspection.docsStored)),
                `${label}: ${name} is unreadable after recovery`
            )
            assert(
                Number(inspection.indexedDocs) === Number(inspection.docsStored),
                `${label}: ${name} index disagrees with its documents after recovery: ${JSON.stringify(inspection)}`
            )
        }
        const survivor = (await database[collection].get(secondIdentifier).once())[secondIdentifier]
        assert(
            survivor !== undefined || scenario === 'sql-delete',
            `${label}: an untouched document disappeared`
        )
    } finally {
        await database.close()
    }
}

async function run(binary, arguments_, overrides = {}) {
    const subprocess = Bun.spawn([binary, ...arguments_], {
        cwd: process.cwd(),
        env: { ...process.env, ...overrides },
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
