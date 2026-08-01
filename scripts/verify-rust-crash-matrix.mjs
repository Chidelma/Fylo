// Phase 5 crash gate: kill the native writer at every declared durable
// transition and prove the root still recovers to one valid state.
//
// The failpoint list comes from the binary, not from this file, and every
// declared point must be reached by some scenario. A new failpoint therefore
// cannot be added without either being exercised here or failing this gate,
// which is the property a hand-maintained list cannot give.
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { platform, tmpdir } from 'node:os'
import { join } from 'node:path'

import { Fylo } from '../clients/node/fylo.mjs'

const workspace = await realpath(await mkdtemp(join(tmpdir(), 'fylo-rust-crash-')))
const template = join(workspace, 'template')
const collection = 'records'
const fileCollection = 'assets'
const identifier = '4VRNF52JPCO'
const secondIdentifier = '4VRNF52JPCP'
const fileIdentifier = '4VRNF52JPCQ'
const crashFileIdentifier = '4VRNF52JPCS'
const deletedIdentifier = '4VRNF52JPCR'
const binary = join(
    process.cwd(),
    'target',
    'debug',
    platform() === 'win32' ? 'fylo-write-preview.exe' : 'fylo-write-preview'
)
const machineBinary = join(
    process.cwd(),
    'target',
    'debug',
    platform() === 'win32' ? 'fylo-rust.exe' : 'fylo-rust'
)

try {
    await command([
        process.execPath,
        './scripts/run-rust.mjs',
        'cargo',
        'build',
        '--locked',
        '-p',
        'fylo-cli',
        '--bin',
        'fylo-write-preview',
        '--bin',
        'fylo-rust'
    ])

    await mkdir(template, { recursive: true })
    const seedFile = join(workspace, 'seed.bin')
    await writeFile(seedFile, new Uint8Array([1, 2, 3, 4]))
    const seed = new Fylo(template, { binary: machineBinary, exclusiveRoot: true })
    await seed.ready
    await requestRequired(seed, { op: 'createCollection', collection, kind: 'document' })
    await requestRequired(seed, {
        op: 'createCollection',
        collection: fileCollection,
        kind: 'file'
    })
    await requestRequired(seed, {
        op: 'putData',
        collection,
        id: identifier,
        data: { name: 'Ada', score: 42 }
    })
    await requestRequired(seed, {
        op: 'putData',
        collection,
        id: secondIdentifier,
        data: { name: 'Grace', score: 50 }
    })
    await requestRequired(seed, {
        op: 'putData',
        collection,
        id: deletedIdentifier,
        data: { name: 'Linus', score: 1 }
    })
    await requestRequired(seed, { op: 'delDoc', collection, id: deletedIdentifier })
    const seededFile = await requestRequired(seed, {
        op: 'putData',
        collection: fileCollection,
        id: fileIdentifier,
        file: { path: seedFile, key: '/seed.bin' },
        meta: { source: 'seed' }
    })
    const seededMetadata = await requestRequired(seed, {
        op: 'getMeta',
        collection: fileCollection,
        id: seededFile
    })
    await seed.close()

    // A successful raw-file metadata read proves that this filesystem carries
    // the platform metadata used to recover the durable key.
    const extendedAttributes = seededMetadata.key === '/seed.bin'

    // A versioned root is a separate template: the repository failpoints are
    // only reachable where `.fylo-vcs` exists.
    const versionedTemplate = join(workspace, 'versioned-template')
    await mkdir(versionedTemplate, { recursive: true })
    const versionedSeed = new Fylo(versionedTemplate, {
        binary: machineBinary,
        exclusiveRoot: true
    })
    await versionedSeed.ready
    await requestRequired(versionedSeed, {
        op: 'createCollection',
        collection,
        kind: 'document'
    })
    await requestRequired(versionedSeed, {
        op: 'putData',
        collection,
        id: identifier,
        data: { name: 'Ada', score: 42 }
    })
    await requestRequired(versionedSeed, {
        op: 'putData',
        collection,
        id: secondIdentifier,
        data: { name: 'Grace', score: 50 }
    })
    await requestRequired(versionedSeed, { op: 'commit', message: 'crash matrix seed' })
    await versionedSeed.close()

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
                crashFileIdentifier,
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

    // Each durable transition is interrupted three ways. `abort` loses the
    // process, so the next opener must recover the journal. `enospc` and
    // `edquot` are ordinary I/O errors, so the writer must roll back in place
    // and leave nothing for recovery to do — a distinction the crash case
    // cannot make.
    const ACTIONS = ['abort', 'enospc', 'edquot']
    const reached = new Set()
    const unsupported = new Set()
    let interrupted = 0
    for (const failpoint of failpoints) {
        for (const scenario of scenarios) {
            for (const action of ACTIONS) {
                const root = join(workspace, `${failpoint}--${scenario.name}--${action}`)
                await cloneRoot(scenario.template ? scenario.template() : template, root)
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
                if (action === 'edquot') {
                    assert(
                        /quota/i.test(failed.stderr),
                        `${failpoint}/${scenario.name}: quota exhaustion was not reported as one: ${failed.stderr.trim()}`
                    )
                }
                await assertRecoverable(binary, root, failpoint, scenario, action)
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
    const label = `${failpoint}/${scenario.name}/${action}`
    const recoveryCollection = scenario.name === 'put-file' ? fileCollection : collection

    const first = await run(binary, ['recover', '--root', root, '--collection', recoveryCollection])
    assert(first.exitCode === 0, `${label}: Rust recovery failed: ${first.stderr}`)
    if (action !== 'abort') {
        // The writer stayed alive, so it owed itself a rollback before
        // returning the error. Anything left for recovery means it did not.
        assert(
            JSON.parse(first.stdout).recovered === false,
            `${label}: a failed write left its journal behind instead of rolling back`
        )
    }
    const second = await run(binary, [
        'recover',
        '--root',
        root,
        '--collection',
        recoveryCollection
    ])
    assert(second.exitCode === 0, `${label}: repeated recovery failed: ${second.stderr}`)
    assert(
        JSON.parse(second.stdout).recovered === false,
        `${label}: recovery is not idempotent — the second pass still had work`
    )

    const database = new Fylo(root, { binary: machineBinary, exclusiveRoot: true })
    await database.ready
    try {
        const expectedCollections = scenario.template ? [collection] : [collection, fileCollection]
        for (const name of expectedCollections) {
            const inspection = await database.inspectCollection(name)
            assert(
                Number.isFinite(Number(inspection.docsStored)),
                `${label}: ${name} is unreadable after recovery`
            )
            assert(
                Number(inspection.indexedDocs) === Number(inspection.docsStored),
                `${label}: ${name} index disagrees with its documents after recovery: ${JSON.stringify(inspection)}`
            )
        }
        const survivor = (await database.getDoc(collection, secondIdentifier))[secondIdentifier]
        assert(
            survivor !== undefined || scenario.name === 'sql-delete',
            `${label}: an untouched document disappeared`
        )
    } finally {
        await database.close()
    }
}

/**
 * Copy a seeded root, extended attributes included.
 *
 * `fs.cp` carries contents and mode but not extended attributes, so a cloned
 * raw file loses the durable key it is read by — silently, and only on the
 * platforms where the copy is not a filesystem-level clone. The fixture has to
 * survive being cloned or the gate tests a root the engine never wrote.
 */
async function cloneRoot(source, target) {
    await mkdir(target, { recursive: true })
    const [command, args, okExit] =
        platform() === 'win32'
            ? [
                  'robocopy',
                  [source, target, '/E', '/COPYALL', '/NFL', '/NDL', '/NJH', '/NJS', '/NP'],
                  8
              ]
            : ['cp', ['-a', `${source}/.`, target], 1]
    const subprocess = Bun.spawn([command, ...args], {
        cwd: process.cwd(),
        env: process.env,
        stdout: 'pipe',
        stderr: 'pipe'
    })
    const [stderr, exitCode] = await Promise.all([
        new Response(subprocess.stderr).text(),
        subprocess.exited
    ])
    // robocopy reports copied/extra files with codes below 8; only 8 and above
    // are failures.
    if (exitCode >= okExit) throw new Error(`cloning ${source} failed (${exitCode}): ${stderr}`)
}

async function requestRequired(database, request) {
    const response = await database.request(request)
    if (!response.ok) {
        throw new Error(
            `${request.op} failed (${response.error?.code}): ${response.error?.message}`
        )
    }
    return response.result
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
