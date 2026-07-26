import { readFile } from 'node:fs/promises'

import {
    DEFAULT_MAX_REQUEST_FRAME_BYTES,
    DEFAULT_MAX_RESPONSE_FRAME_BYTES,
    MACHINE_PROTOCOL_VERSION,
    MAX_CONFIGURED_FRAME_BYTES,
    parseMachineFrame
} from '../src/cli/protocol.js'
import { assertIndexableDocument } from '../src/storage/prefix-index.js'

const operations = JSON.parse(await readFile('api/machine/v1/operations.json', 'utf8'))
const schema = JSON.parse(await readFile('api/machine/v1/schema.json', 'utf8'))
const errors = JSON.parse(await readFile('api/errors/v1.json', 'utf8'))
const fixture = JSON.parse(await readFile('tests/fixtures/rust-format-v1.json', 'utf8'))
const machineSource = await readFile('src/cli/machine.js', 'utf8')
const protocolSource = await readFile('src/cli/protocol.js', 'utf8')
const queryPageSource = await readFile('src/cli/query-page.js', 'utf8')
const rootLeaseSource = await readFile('src/cli/root-lease.js', 'utf8')
const storageSource = await readFile('src/storage/prefix-index.js', 'utf8')
const transactionSource = await readFile('src/storage/transactions.js', 'utf8')

assert(operations.protocolVersion === MACHINE_PROTOCOL_VERSION, 'operation protocol version drift')
assert(
    schema.$defs.success.properties.protocolVersion.const === MACHINE_PROTOCOL_VERSION,
    'response schema protocol version drift'
)
assert(DEFAULT_MAX_REQUEST_FRAME_BYTES === 1024 * 1024, 'request frame default drift')
assert(DEFAULT_MAX_RESPONSE_FRAME_BYTES === 8 * 1024 * 1024, 'response frame default drift')
assert(MAX_CONFIGURED_FRAME_BYTES === 64 * 1024 * 1024, 'configured frame maximum drift')

const typedef = machineSource.match(/@typedef \{'([^}]+)'\} MachineOperation/)?.[1]
assert(typedef, 'MachineOperation typedef not found')
const sourceOperations = typedef
    .split("' | '")
    .map((name) => name.replaceAll("'", ''))
    .sort()
const registeredOperations = operations.operations.map(({ name }) => name).sort()
assertEqual(sourceOperations, registeredOperations, 'machine operation registry drift')
assertEqual(
    schema.$defs.request.properties.op.enum.slice().sort(),
    registeredOperations,
    'machine request schema operation drift'
)

for (const { name, class: operationClass, retry } of operations.operations) {
    assert(typeof name === 'string' && name.length > 0, 'operation name must be non-empty')
    assert(typeof operationClass === 'string', `${name} must declare a class`)
    assert(typeof retry === 'string', `${name} must declare retry behavior`)
}

for (const { code, retryable } of errors.errors) {
    assert(/^E[A-Z0-9_]+$/.test(code), `invalid stable error code: ${code}`)
    assert(typeof retryable === 'boolean', `${code} must declare retryability`)
    assert(
        machineSource.includes(`'${code}'`) ||
            protocolSource.includes(`'${code}'`) ||
            queryPageSource.includes(`'${code}'`) ||
            rootLeaseSource.includes(`'${code}'`) ||
            code === 'EINVALIDDOCID' ||
            code === 'EARRAYOFOBJECTS' ||
            code === 'EDECRYPTFAILED' ||
            code === 'EACCES',
        `stable error registry contains an unimplemented code: ${code}`
    )
}

for (const line of (await readFile('api/machine/v1/fixtures.ndjson', 'utf8'))
    .split('\n')
    .filter(Boolean)) {
    const parsed = parseMachineFrame(new TextEncoder().encode(line))
    assert(parsed && typeof parsed === 'object' && !Array.isArray(parsed), 'invalid NDJSON fixture')
    assert(registeredOperations.includes(parsed.op), `unknown fixture operation: ${parsed.op}`)
}

assert(storageSource.includes("'fylo.local-fs.index.v1'"), 'prefix index format identifier drift')
assert(
    transactionSource.includes("'fylo.collection-transaction.v1'"),
    'transaction format identifier drift'
)
assert(
    transactionSource.includes("'fylo.collection-generation.v1'"),
    'generation format identifier drift'
)

for (const testCase of fixture.documents) {
    let error = null
    try {
        if (!isRecord(testCase.input)) {
            error = { code: 'EDOCUMENTROOT' }
        } else {
            assertIndexableDocument(testCase.input)
        }
    } catch (failure) {
        error = failure
    }
    if (testCase.valid) {
        assert(error === null, `${testCase.name} unexpectedly failed`)
        assert(JSON.stringify(testCase.input) === testCase.encoded, `${testCase.name} bytes drift`)
    } else {
        assert(error?.code === testCase.errorCode, `${testCase.name} error-code drift`)
    }
}

for (const testCase of fixture.metadata) {
    const merged = { ...testCase.custom, ...testCase.canonical }
    assertEqual(merged, testCase.expected, `${testCase.name} metadata precedence drift`)
}

console.log(
    `Verified machine protocol v${MACHINE_PROTOCOL_VERSION}, ${registeredOperations.length} ` +
        `operations, ${errors.errors.length} stable errors, and format fixture v${fixture.schemaVersion}`
)

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
}

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
