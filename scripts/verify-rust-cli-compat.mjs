import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { platform, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const workspace = await mkdtemp(join(tmpdir(), 'fylo-rust-cli-'))
const root = join(workspace, 'root')
const schemaRoot = join(workspace, 'schema')

try {
    if (process.env.FYLO_SKIP_RUST_BUILD !== '1') {
        await required([
            process.execPath,
            './scripts/run-rust.mjs',
            'cargo',
            'build',
            '--locked',
            '-p',
            'fylo-cli',
            '--bin',
            'fylo-rust'
        ])
    }
    const binary = process.env.FYLO_RUST_BINARY
        ? resolve(process.env.FYLO_RUST_BINARY)
        : join(
              process.cwd(),
              'target',
              'debug',
              platform() === 'win32' ? 'fylo-rust.exe' : 'fylo-rust'
          )
    const releasedBinary = process.env.FYLO_RELEASED_BINARY
        ? resolve(process.env.FYLO_RELEASED_BINARY)
        : null
    await mkdir(root, { recursive: true })

    const help = (await required([binary, 'help'])).stdout
    const flagHelp = (await required([binary, '--help'])).stdout
    const execHelp = (await required([binary, 'exec', '--help'])).stdout
    assert(help === flagHelp && help === execHelp, 'Rust CLI help entry points drift')
    assert(help.startsWith('Usage:\n  fylo checkout'), 'Rust CLI help uses a preview binary name')
    assert(
        !help.includes('fylo backup ') && !help.includes('--backup-'),
        'Rust CLI still exposes S3 backup'
    )
    assert(!help.includes('--worm'), 'Rust CLI still exposes retired WORM mode')
    if (releasedBinary) {
        // v26.30.06 prints help for the positional `help` token but exits as
        // an unknown command. `--help` is its successful canonical entrypoint.
        const releasedHelp = (await required([releasedBinary, '--help'])).stdout
        for (const command of compatibilityCommandLines()) {
            assert(help.includes(command), `Rust CLI help omitted ${command}`)
            assert(releasedHelp.includes(command), `released CLI help omitted ${command}`)
        }
        assert(
            releasedHelp.includes('fylo backup ') && releasedHelp.includes('--backup-bucket'),
            'released oracle no longer exposes the intentionally removed S3 surface'
        )
        assert(
            normalizeIntentionalCliDeltas(help) === normalizeIntentionalCliDeltas(releasedHelp),
            `Rust CLI help drifted from release outside the intentional S3 and WORM removals\n--- released\n${releasedHelp}--- Rust\n${help}`
        )
        for (const option of ['--page-size', '--align', '--no-pager']) {
            assert(help.includes(option), `Rust CLI help omitted ${option}`)
            assert(releasedHelp.includes(option), `released CLI help omitted ${option}`)
        }
    }

    const versionText = await required([binary, 'version'])
    const expectedVersion = (await readFile('VERSION', 'utf8')).trim()
    assert(versionText.stdout.trim() === expectedVersion, 'Rust CLI text version drift')
    const identity = JSON.parse((await required([binary, 'version', '--output', 'json'])).stdout)
    assert(identity.runtimeVersion === expectedVersion, 'Rust CLI JSON version drift')
    assert(identity.capabilities.handshake === true, 'Rust CLI identity omitted handshake support')
    assert(
        identity.capabilities.wholeRootBackup === undefined,
        'Rust CLI identity still exposes S3 backup'
    )
    if (releasedBinary) {
        const releasedIdentity = JSON.parse(
            (await required([releasedBinary, 'version', '--output', 'json'])).stdout
        )
        const releasedCapabilities = structuredClone(releasedIdentity.capabilities)
        delete releasedCapabilities.wholeRootBackup
        assert(
            JSON.stringify(identity.capabilities) === JSON.stringify(releasedCapabilities),
            'Rust capability identity drifted outside the intentional S3 removal'
        )
        assert(
            JSON.stringify(identity.machine) === JSON.stringify(releasedIdentity.machine),
            'Rust machine framing identity drifted from release'
        )
    }

    const handshake = JSON.parse(
        (await required([binary, 'exec', '--request', '-', '--root', root], '{"op":"handshake"}'))
            .stdout
    )
    assert(
        handshake.ok === true && handshake.result.runtimeVersion === expectedVersion,
        'one-shot exec drift'
    )
    const failed = await run([binary, 'exec', '--request', '{"op":"unknown"}', '--root', root])
    assert(
        failed.exitCode !== 0 && JSON.parse(failed.stdout).error.code === 'EUNSUPPORTEDOP',
        'one-shot exec failure drift'
    )

    const seedBinary = releasedBinary ?? binary
    await machine(seedBinary, root, { op: 'createCollection', collection: 'posts' })
    const id = await machine(seedBinary, root, {
        op: 'putData',
        collection: 'posts',
        data: { title: 'Hello', published: true }
    })
    await machine(seedBinary, root, {
        op: 'putData',
        collection: 'posts',
        data: { title: 'World', published: false }
    })

    const inspect = await jsonCommand([binary, 'inspect', 'posts', '--root', root, '--json'])
    assert(inspect.collection === 'posts' && inspect.docsStored === 2, 'positional inspect drift')
    const get = await jsonCommand([binary, 'get', 'posts', id, '--root', root, '--json'])
    assert(get[id].title === 'Hello', 'positional get drift')
    const latest = await jsonCommand([
        binary,
        'latest',
        'posts',
        id,
        '--root',
        root,
        '--id-only',
        '--json'
    ])
    assert(latest.id === id, 'latest --id-only JSON drift')

    const status = await jsonCommand([binary, 'status', '--root', root, '--json'])
    assert(
        status.branch === 'main' && status.clean === false,
        'status did not initialize repository'
    )
    const commit = await jsonCommand([binary, 'commit', '-m', 'initial', '--root', root, '--json'])
    assert(commit.message === 'initial', 'commit command drift')
    const branch = await jsonCommand([
        binary,
        'checkout',
        '-b',
        'feature/cli',
        '--root',
        root,
        '--json'
    ])
    assert(branch.branch === 'feature/cli', 'nested checkout command drift')
    const branches = await jsonCommand([binary, 'branch', '--root', root, '--json'])
    assert(branches.current === 'feature/cli', 'branch command drift')

    // The released filesystem scanner does not promise row order, so compare
    // one selected row byte-for-byte and test multi-row presence separately.
    const sqlArguments = [
        'sql',
        "SELECT * FROM posts WHERE title = 'Hello'",
        '--root',
        root,
        '--no-pager'
    ]
    const sql = await required([binary, ...sqlArguments])
    assert(sql.stdout.includes('Hello'), 'positional SQL did not return the row')
    if (releasedBinary) {
        const releasedSql = await required([releasedBinary, ...sqlArguments])
        assert(
            sql.stdout === releasedSql.stdout,
            `Rust SELECT table output drifted from release\n--- released\n${releasedSql.stdout}--- Rust\n${sql.stdout}`
        )
        const pagedArguments = [
            'sql',
            "SELECT * FROM posts WHERE title = 'Hello'",
            '--root',
            root,
            '--page-size',
            '1',
            '--align',
            'left',
            '--no-pager'
        ]
        const rustPaged = await required([binary, ...pagedArguments])
        const releasedPaged = await required([releasedBinary, ...pagedArguments])
        assert(
            rustPaged.stdout === releasedPaged.stdout,
            'Rust paged SELECT table output drifted from release'
        )
    }
    const inserted = await required([
        binary,
        'sql',
        "INSERT INTO posts (title) VALUES ('Second')",
        '--root',
        root
    ])
    assert(inserted.stdout.trim().length > 0, 'positional SQL mutation returned no identifier')

    const temporary = await machine(binary, root, {
        op: 'putData',
        collection: 'posts',
        data: { title: 'Temporary' }
    })
    await machine(binary, root, { op: 'delDoc', collection: 'posts', id: temporary })
    const deleted = await jsonCommand([binary, 'deleted', 'posts', '--root', root, '--json'])
    assert(deleted[temporary].title === 'Temporary', 'deleted command drift')
    const restored = await jsonCommand([
        binary,
        'restore',
        'posts',
        temporary,
        '--root',
        root,
        '--json'
    ])
    assert(restored.restored === true && restored.id === temporary, 'restore command drift')

    await mkdir(join(schemaRoot, 'posts', 'history'), { recursive: true })
    await writeFile(
        join(schemaRoot, 'posts', 'manifest.json'),
        JSON.stringify({ current: 'v1', versions: [{ v: 'v1' }] })
    )
    await writeFile(
        join(schemaRoot, 'posts', 'history', 'v1.schema.json'),
        JSON.stringify({ title: '^.+$' })
    )
    const schema = await jsonCommand([
        binary,
        'schema',
        'inspect',
        'posts',
        '--schema-dir',
        schemaRoot,
        '--root',
        root,
        '--json'
    ])
    assert(schema.current === 'v1', 'schema inspect command drift')
    const validated = await jsonCommand([
        binary,
        'schema',
        'validate',
        'posts',
        '{"title":"Schema CLI"}',
        '--schema-dir',
        schemaRoot,
        '--root',
        root,
        '--json'
    ])
    assert(validated.valid === true, 'schema validate command drift')

    console.log('Verified Rust direct CLI compatibility surface and one-shot machine execution')
} finally {
    await rm(workspace, { recursive: true, force: true })
}

async function machine(binary, root, request) {
    const response = JSON.parse(
        (await required([binary, 'exec', '--request', JSON.stringify(request), '--root', root]))
            .stdout
    )
    assert(response.ok === true, `machine operation failed: ${JSON.stringify(response.error)}`)
    return response.result
}

async function jsonCommand(command) {
    return JSON.parse((await required(command)).stdout)
}

async function required(command, stdin = '') {
    const result = await run(command, stdin)
    if (result.exitCode !== 0) {
        throw new Error(
            `${command.join(' ')} failed (${result.exitCode}): ${result.stderr || result.stdout}`
        )
    }
    return result
}

async function run(command, stdin = '') {
    const child = Bun.spawn(command, {
        cwd: process.cwd(),
        env: process.env,
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe'
    })
    if (stdin) child.stdin.write(stdin)
    child.stdin.end()
    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited
    ])
    return { stdout, stderr, exitCode }
}

function assert(condition, message) {
    if (!condition) throw new Error(message)
}

function compatibilityCommandLines() {
    return [
        'fylo checkout ',
        'fylo branch ',
        'fylo commit ',
        'fylo log ',
        'fylo status ',
        'fylo diff ',
        'fylo restore-commit ',
        'fylo merge ',
        'fylo version ',
        'fylo sql ',
        'fylo exec --request ',
        'fylo exec --loop ',
        'fylo inspect ',
        'fylo get ',
        'fylo latest ',
        'fylo rebuild ',
        'fylo verify ',
        'fylo deleted ',
        'fylo restore ',
        'fylo schema inspect ',
        'fylo schema current ',
        'fylo schema history ',
        'fylo schema doctor ',
        'fylo schema validate ',
        'fylo schema materialize '
    ]
}

function normalizeIntentionalCliDeltas(help) {
    return help
        .replaceAll(' [--worm]', '')
        .replaceAll(' [--backup-bucket <name> --backup-prefix <prefix>]', '')
        .split('\n')
        .filter(
            (line) =>
                !/^\s+fylo backup /.test(line) &&
                !/^\s+--worm\s/.test(line) &&
                !/^\s+--backup-/.test(line) &&
                !/^\s+--destination /.test(line)
        )
        .join('\n')
        .trimEnd()
}
