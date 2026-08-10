import { access, readFile } from 'node:fs/promises'

const MACHINE_PROTOCOL_VERSION = 1
const operations = JSON.parse(await readFile('api/machine/v1/operations.json', 'utf8'))
const schema = JSON.parse(await readFile('api/machine/v1/schema.json', 'utf8'))
const errors = JSON.parse(await readFile('api/errors/v1.json', 'utf8'))
const queueSchema = JSON.parse(await readFile('api/queue/v1/schema.json', 'utf8'))
const oracleReleases = JSON.parse(await readFile('api/oracle/v1/releases.json', 'utf8'))
const fixture = JSON.parse(await readFile('tests/fixtures/rust-format-v1.json', 'utf8'))
const packageManifest = JSON.parse(await readFile('package.json', 'utf8'))
const publicEntry = await readFile('src/index.js', 'utf8')
const nativeClients = await Promise.all(
    [
        'clients/node/fylo.mjs',
        'clients/python/fylo.py',
        'clients/ruby/fylo.rb',
        'clients/php/fylo.php',
        'clients/go/fylo.go',
        'clients/rust/fylo.rs',
        'clients/csharp/Fylo.cs',
        'clients/java/Fylo.java',
        'clients/dart/fylo.dart'
    ].map(async (path) => [path, await readFile(path, 'utf8')])
)
const machineSource = await readFile('crates/fylo-machine/src/lib.rs', 'utf8')
const querySource = await readFile('crates/fylo-query/src/lib.rs', 'utf8')
const formatSource = await readFile('crates/fylo-format/src/lib.rs', 'utf8')
const storageSource = await readFile('crates/fylo-storage-native/src/lib.rs', 'utf8')
const storageWriteSource = await readFile('crates/fylo-storage-native/src/write.rs', 'utf8')
const queueSource = await readFile('crates/fylo-storage-native/src/queue.rs', 'utf8')
const engineSource = await readFile('crates/fylo-engine/src/lib.rs', 'utf8')
const wasmHostSource = await readFile('src/browser/wasm/index-scanner.js', 'utf8')
const ciSource = await readFile('.github/workflows/ci.yml', 'utf8')
const nightlySource = await readFile('.github/workflows/rust-nightly.yml', 'utf8')
const releaseSource = await readFile('.github/workflows/publish.yml', 'utf8')
const implementationSources = [
    machineSource,
    querySource,
    formatSource,
    storageSource,
    storageWriteSource,
    queueSource,
    engineSource,
    wasmHostSource
]

assert(operations.protocolVersion === MACHINE_PROTOCOL_VERSION, 'operation protocol version drift')
assert(
    schema.$defs.success.properties.protocolVersion.const === MACHINE_PROTOCOL_VERSION,
    'response schema protocol version drift'
)
assert(
    schema.$defs.request.properties.op.enum.length === 45,
    'filesystem-only machine registry must have 45 operations'
)

const registeredOperations = operations.operations.map(({ name }) => name).sort()
assertEqual(
    schema.$defs.request.properties.op.enum.slice().sort(),
    registeredOperations,
    'machine request schema operation drift'
)
for (const removed of ['backupStatus', 'backupReconcile']) {
    assert(
        !registeredOperations.includes(removed),
        `removed operation remains registered: ${removed}`
    )
}
for (const { name, class: operationClass, retry } of operations.operations) {
    assert(typeof name === 'string' && name.length > 0, 'operation name must be non-empty')
    assert(typeof operationClass === 'string', `${name} must declare a class`)
    assert(typeof retry === 'string', `${name} must declare retry behavior`)
    assert(machineSource.includes(`"${name}"`), `Rust machine does not implement ${name}`)
}

assert(
    machineSource.includes('DEFAULT_MAX_REQUEST_BYTES: usize = 1024 * 1024'),
    'request frame default drift'
)
assert(
    machineSource.includes('DEFAULT_MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024'),
    'response frame default drift'
)
assert(
    machineSource.includes('MAX_CONFIGURED_FRAME_BYTES: usize = 64 * 1024 * 1024'),
    'configured frame maximum drift'
)

for (const { code, retryable } of errors.errors) {
    assert(/^E[A-Z0-9_]+$/.test(code), `invalid stable error code: ${code}`)
    assert(typeof retryable === 'boolean', `${code} must declare retryability`)
    assert(
        implementationSources.some(
            (source) => source.includes(`"${code}"`) || source.includes(`'${code}'`)
        ) || ['EINVALIDDOCID', 'EARRAYOFOBJECTS', 'EDECRYPTFAILED', 'EACCES'].includes(code),
        `stable error registry contains an unimplemented code: ${code}`
    )
}

for (const line of (await readFile('api/machine/v1/fixtures.ndjson', 'utf8'))
    .split('\n')
    .filter(Boolean)) {
    const parsed = JSON.parse(line)
    assert(parsed && typeof parsed === 'object' && !Array.isArray(parsed), 'invalid NDJSON fixture')
    assert(registeredOperations.includes(parsed.op), `unknown fixture operation: ${parsed.op}`)
}

assert(
    storageWriteSource.includes('fylo.local-fs.index.v1'),
    'prefix index format identifier drift'
)
assert(storageWriteSource.includes('fylo.collection-transaction.v1'), 'transaction format drift')
assert(storageWriteSource.includes('fylo.collection-generation.v1'), 'generation format drift')
for (const [definition, format] of [
    ['manifest', 'fylo.queue.v1'],
    ['receiptKey', 'fylo.queue-receipt-key.v1'],
    ['message', 'fylo.queue-message.v1'],
    ['consumer', 'fylo.queue-consumer.v1'],
    ['dedupe', 'fylo.queue-dedupe.v1'],
    ['deadLetter', 'fylo.queue-dead-letter.v1']
]) {
    assert(
        queueSchema.$defs[definition].properties.format.const === format,
        `${definition} queue schema format drift`
    )
    assert(queueSource.includes(`"${format}"`), `${definition} queue implementation format drift`)
}
for (const definition of ['message', 'consumer', 'dedupe', 'deadLetter']) {
    const properties = queueSchema.$defs[definition].properties
    for (const name of ['topic', 'group']) {
        if (properties[name] === undefined) continue
        assert(properties[name].maxLength === 127, `${definition}.${name} character limit drift`)
        assert(properties[name]['x-maxBytes'] === 127, `${definition}.${name} byte limit drift`)
        const pattern = new RegExp(properties[name].pattern, 'u')
        assert(pattern.test('queue.name'), `${definition}.${name} rejects a valid name`)
        for (const invalid of ['bad/name', 'bad\\name', 'bad\nname', 'bad\u007fname']) {
            assert(!pattern.test(invalid), `${definition}.${name} accepts an unsafe name`)
        }
    }
}
for (const name of ['topic', 'group']) {
    const property = schema.$defs.request.properties[name]
    assert(property.maxLength === 127, `machine ${name} character limit drift`)
    assert(property['x-maxBytes'] === 127, `machine ${name} byte limit drift`)
    assert(
        property.pattern === queueSchema.$defs.consumer.properties[name].pattern,
        `machine ${name} character policy drift`
    )
}
assert(queueSource.includes('MAX_NAME_BYTES: usize = 127'), 'queue runtime name limit drift')
assert(
    queueSource.includes('MAX_QUEUE_SCAN_BYTES: u64 = 64 * 1024 * 1024'),
    'queue scan-work budget drift'
)
assert(
    queueSchema.$defs.consumer.properties.acknowledged.maxProperties === 1000,
    'queue acknowledged-receipt retention drift'
)
assert(
    queueSchema.$defs.consumer.properties.acknowledgedOrder.maxItems === 1000 &&
        queueSchema.$defs.consumer.properties.acknowledgedOrder.uniqueItems === true,
    'queue acknowledgement-recency order drift'
)
assert(
    queueSource.includes('MAX_ACKNOWLEDGED_RECEIPTS: usize = 1_000'),
    'queue runtime acknowledged-receipt retention drift'
)
for (const testCase of fixture.documents) {
    if (testCase.valid) {
        assert(
            JSON.stringify(testCase.input) === testCase.encoded,
            `${testCase.name} canonical bytes drift`
        )
    } else {
        assert(/^E[A-Z0-9_]+$/.test(testCase.errorCode), `${testCase.name} lacks a stable error`)
    }
}
for (const testCase of fixture.metadata) {
    assertEqual(
        { ...testCase.custom, ...testCase.canonical },
        testCase.expected,
        `${testCase.name} metadata precedence drift`
    )
}

assert(
    publicEntry.includes('../clients/node/fylo.mjs'),
    'the package entry must be a thin native-binary client'
)
assert(packageManifest.bin === undefined, 'the removed JavaScript CLI remains packaged')
assert(
    packageManifest.scripts['build:exe:javascript'] === undefined,
    'the removed JavaScript executable remains buildable'
)
for (const [path, source] of nativeClients) {
    assert(!source.includes('--worm'), `the retired WORM option remains in ${path}`)
}
for (const [path, marker] of [
    ['clients/node/fylo.mjs', 'queueConsumer'],
    ['clients/python/fylo.py', 'queue_consumer'],
    ['clients/ruby/fylo.rb', 'queue_consumer'],
    ['clients/php/fylo.php', 'FyloQueueConsumer'],
    ['clients/go/fylo.go', 'QueueConsumerOptions'],
    ['clients/rust/fylo.rs', 'QueueConsumerOptions'],
    ['clients/java/Fylo.java', '@interface QueueConsumer'],
    ['clients/csharp/Fylo.cs', 'FyloQueueConsumerAttribute'],
    ['clients/dart/fylo.dart', 'FyloQueueConsumer']
]) {
    const source = nativeClients.find(([candidate]) => candidate === path)?.[1]
    assert(source?.includes(marker), `${path} lacks its queue consumer adapter`)
}

for (const path of [
    'src/api/fylo.js',
    'src/cli/index.js',
    'src/cache/query.js',
    'src/observability/events.js',
    'src/queue/local.js',
    'src/replication/sync.js',
    'src/schema/registry.js',
    'src/versioning/repository.js',
    'src/storage/engine.js',
    'src/storage/transactions.js',
    'scripts/build-javascript-executable.mjs',
    'tests/integration/basic.test.js',
    'tests/collection/collection.test.js'
]) {
    assert(!(await pathExists(path)), `legacy native implementation remains: ${path}`)
}

for (const [name, source] of [
    ['CI', ciSource],
    ['release', releaseSource]
]) {
    assert(!source.includes('tests/integration/'), `${name} workflow still runs legacy tests`)
    assert(
        !source.includes('build:exe:javascript'),
        `${name} workflow still builds the legacy engine`
    )
    assert(source.includes('cargo test'), `${name} workflow does not run Rust tests`)
}
assert(
    releaseSource.includes('verify-rust-release-machine-parity.mjs'),
    'release CI must retain immutable previous-release compatibility proof'
)
for (const [script, markers] of [
    ['rust:check', ['--workspace', '--all-targets', '--all-features', '--locked']],
    ['rust:clippy', ['--workspace', '--all-targets', '--all-features', '--locked']],
    ['rust:test', ['--workspace', '--all-targets', '--all-features', '--locked']],
    ['rust:doc', ['--workspace', '--all-features', '--no-deps', '--locked']]
]) {
    const command = packageManifest.scripts[script]
    assert(typeof command === 'string', `missing ${script} qualification command`)
    for (const marker of markers) {
        assert(command.includes(marker), `${script} must include ${marker}`)
    }
}
for (const marker of [
    'workflow_call:',
    'bun run rust:check',
    'bun run rust:doc',
    'RUSTDOCFLAGS: -D warnings',
    'cargo-deny --version 0.19.7 --locked',
    'cargo-llvm-cov --version 0.8.6 --locked',
    'cargo-cyclonedx --version 0.5.7 --locked',
    'cargo-auditable --version 0.7.0 --locked'
]) {
    assert(ciSource.includes(marker), `CI qualification is missing ${marker}`)
}
for (const sanitizer of ['address', 'leak', 'thread']) {
    assert(
        nightlySource.includes(`-Zsanitizer=${sanitizer}`),
        `scheduled qualification is missing ${sanitizer} sanitizer`
    )
}

assert(oracleReleases.format === 'fylo.released-oracle-sources.v1', 'oracle registry drift')
for (const release of oracleReleases.releases) {
    assert(release.tag === `v${release.version}`, 'oracle tag/version drift')
    assert(/^[0-9a-f]{40}$/.test(release.commit), 'oracle commit must be a SHA-1')
    for (const [target, asset] of Object.entries(release.assets)) {
        assert(typeof target === 'string' && target.length > 0, 'oracle target is empty')
        assert(/^[0-9a-f]{64}$/.test(asset.sha256), `${target} oracle checksum is invalid`)
    }
}

console.log(
    `Verified Rust-only machine protocol v${MACHINE_PROTOCOL_VERSION}, ` +
        `${registeredOperations.length} operations, ${errors.errors.length} stable errors, ` +
        `and format fixture v${fixture.schemaVersion}`
)

function assert(value, message) {
    if (!value) throw new Error(message)
}

function assertEqual(actual, expected, message) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(
            `${message}\nexpected: ${JSON.stringify(expected)}\nactual: ${JSON.stringify(actual)}`
        )
    }
}

async function pathExists(path) {
    try {
        await access(path)
        return true
    } catch (error) {
        if (error?.code === 'ENOENT') return false
        throw error
    }
}
