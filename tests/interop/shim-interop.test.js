import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const roots = []
const repoRoot = process.cwd()
const binaryPath = path.join(
    repoRoot,
    'dist-bin',
    process.platform === 'win32' ? 'fylo.exe' : 'fylo'
)
const shimRoot = path.join(repoRoot, 'clients')

/**
 * @param {string[]} args
 * @param {{ cwd?: string, stdin?: string, timeout?: number, env?: Record<string, string> }} [options]
 */
async function run(args, options = {}) {
    const proc = Bun.spawn(args, {
        cwd: options.cwd ?? repoRoot,
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', ...options.env },
        stdin: options.stdin === undefined ? 'ignore' : new Blob([options.stdin]),
        stdout: 'pipe',
        stderr: 'pipe'
    })
    const timeout = setTimeout(() => proc.kill(), options.timeout ?? 60_000)
    try {
        const [stdout, stderr, exitCode] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited
        ])
        return { stdout, stderr, exitCode }
    } finally {
        clearTimeout(timeout)
    }
}

/**
 * @param {string} label
 * @param {Awaited<ReturnType<typeof run>>} result
 */
function expectSuccess(label, result) {
    expect(result.exitCode, `${label} stderr:\n${result.stderr}\nstdout:\n${result.stdout}`).toBe(0)
}

/**
 * @param {string} prefix
 */
async function tempRoot(prefix) {
    const root = await mkdtemp(path.join(os.tmpdir(), prefix))
    roots.push(root)
    return root
}

/**
 * @param {string} command
 */
async function requireCommand(command) {
    const result = await run(['bash', '-lc', `command -v ${command}`])
    expectSuccess(`required command ${command}`, result)
}

beforeAll(async () => {
    await mkdir(path.dirname(binaryPath), { recursive: true })
    if (process.env.FYLO_SKIP_BINARY_BUILD === '1') return
    const build = await run(['bun', 'run', 'build:exe'], { timeout: 120_000 })
    expectSuccess('bun run build:exe', build)
})

afterAll(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

describe('client shim interop via fylo exec --loop', () => {
    test('every binary-backed language shim exposes bounded query continuation', async () => {
        const contracts = new Map([
            ['node/fylo.mjs', ['findDocsPage', 'findDeletedDocsPage']],
            ['python/fylo.py', ['find_docs_page', 'find_deleted_docs_page']],
            ['ruby/fylo.rb', ['find_docs_page', 'find_deleted_docs_page']],
            ['php/fylo.php', ['findDocsPage', 'findDeletedDocsPage']],
            ['go/fylo.go', ['FindDocsPage', 'FindDeletedDocsPage']],
            ['rust/fylo.rs', ['find_docs_page', 'find_deleted_docs_page']],
            ['java/Fylo.java', ['findDocsPage', 'findDeletedDocsPage']],
            ['csharp/Fylo.cs', ['FindDocsPage', 'FindDeletedDocsPage']],
            ['dart/fylo.dart', ['findDocsPage', 'findDeletedDocsPage']]
        ])
        for (const [relative, methods] of contracts) {
            const source = await readFile(path.join(shimRoot, relative), 'utf8')
            for (const method of methods) expect(source, relative).toContain(method)
        }
    })

    test('every binary-backed language shim exposes the durable queue lifecycle', async () => {
        const contracts = new Map([
            [
                'node/fylo.mjs',
                [
                    'queuePublish',
                    'queueClaim',
                    'queueAck',
                    'queueNack',
                    'queueExtend',
                    'queueStats',
                    'queueDeadLetters'
                ]
            ],
            [
                'python/fylo.py',
                [
                    'queue_publish',
                    'queue_claim',
                    'queue_ack',
                    'queue_nack',
                    'queue_extend',
                    'queue_stats',
                    'queue_dead_letters'
                ]
            ],
            [
                'ruby/fylo.rb',
                [
                    'queue_publish',
                    'queue_claim',
                    'queue_ack',
                    'queue_nack',
                    'queue_extend',
                    'queue_stats',
                    'queue_dead_letters'
                ]
            ],
            [
                'php/fylo.php',
                [
                    'queuePublish',
                    'queueClaim',
                    'queueAck',
                    'queueNack',
                    'queueExtend',
                    'queueStats',
                    'queueDeadLetters'
                ]
            ],
            [
                'go/fylo.go',
                [
                    'QueuePublish',
                    'QueueClaim',
                    'QueueAck',
                    'QueueNack',
                    'QueueExtend',
                    'QueueStats',
                    'QueueDeadLetters'
                ]
            ],
            [
                'rust/fylo.rs',
                [
                    'queue_publish',
                    'queue_claim',
                    'queue_ack',
                    'queue_nack',
                    'queue_extend',
                    'queue_stats',
                    'queue_dead_letters'
                ]
            ],
            [
                'java/Fylo.java',
                [
                    'queuePublish',
                    'queueClaim',
                    'queueAck',
                    'queueNack',
                    'queueExtend',
                    'queueStats',
                    'queueDeadLetters'
                ]
            ],
            [
                'csharp/Fylo.cs',
                [
                    'QueuePublish',
                    'QueueClaim',
                    'QueueAck',
                    'QueueNack',
                    'QueueExtend',
                    'QueueStats',
                    'QueueDeadLetters'
                ]
            ],
            [
                'dart/fylo.dart',
                [
                    'queuePublish',
                    'queueClaim',
                    'queueAck',
                    'queueNack',
                    'queueExtend',
                    'queueStats',
                    'queueDeadLetters'
                ]
            ]
        ])
        for (const [relative, methods] of contracts) {
            const source = await readFile(path.join(shimRoot, relative), 'utf8')
            for (const method of methods) expect(source, relative).toContain(method)
        }
    })

    test('every binary-backed shim exposes an idiomatic queue consumer decorator', async () => {
        const contracts = new Map([
            ['node/fylo.mjs', ['queueProcess', 'queueConsumer', 'queue handler failed']],
            ['python/fylo.py', ['queue_process', 'queue_consumer', 'queue handler failed']],
            ['ruby/fylo.rb', ['queue_process', 'queue_consumer', 'queue handler failed']],
            [
                'php/fylo.php',
                ['FyloQueueConsumer', 'queueProcess', 'runQueueConsumer', 'queue handler failed']
            ],
            [
                'go/fylo.go',
                ['QueueConsumerOptions', 'QueueProcess', 'QueueConsumer', 'queue handler failed']
            ],
            [
                'rust/fylo.rs',
                ['QueueConsumerOptions', 'queue_process', 'queue_consumer', 'queue handler failed']
            ],
            [
                'java/Fylo.java',
                [
                    '@interface QueueConsumer',
                    'queueProcess',
                    'runQueueConsumer',
                    'queue handler failed'
                ]
            ],
            [
                'csharp/Fylo.cs',
                [
                    'FyloQueueConsumerAttribute',
                    'QueueProcess',
                    'RunQueueConsumer',
                    'queue handler failed'
                ]
            ],
            [
                'dart/fylo.dart',
                ['FyloQueueConsumer', 'queueProcess', 'queueConsumer', 'queue handler failed']
            ]
        ])
        for (const [relative, markers] of contracts) {
            const source = await readFile(path.join(shimRoot, relative), 'utf8')
            for (const marker of markers) expect(source, relative).toContain(marker)
        }
    })

    test('Python shim drives the persistent loop', async () => {
        await requireCommand('python3')
        const root = await tempRoot('fylo-python-shim-')
        const script = `
import asyncio, json, os, sys
sys.path.insert(0, ${JSON.stringify(path.join(shimRoot, 'python'))})
from fylo import Fylo

with Fylo(${JSON.stringify(root)}, binary=${JSON.stringify(binaryPath)}) as db:
    published = db.queue_publish('python.jobs', {'job': 1}, idempotency_key='python-1')
    delivery = db.queue_claim('python.jobs', 'python-worker')[0]
    assert delivery['id'] == published['id'], delivery
    db.queue_ack('python.jobs', 'python-worker', delivery['id'], delivery['receipt'])
    assert db.queue_stats('python.jobs', 'python-worker')['retired'] == 1
    db.queue_publish('python.decorated', {'job': 2})
    handled = []
    @db.queue_consumer('python.decorated', 'decorated-worker')
    def consume(delivery):
        handled.append(delivery['payload']['job'])
    summary = consume()
    assert handled == [2] and summary['acknowledged'] == 1, summary
    db.queue_publish('python.decorated.async', {'job': 3})
    @db.queue_consumer('python.decorated.async', 'decorated-worker')
    async def consume_async(delivery):
        await asyncio.sleep(0)
        handled.append(delivery['payload']['job'])
    async_summary = asyncio.run(consume_async())
    assert handled[-1] == 3 and async_summary['acknowledged'] == 1, async_summary
    db.queue_publish('python.decorated.fail', {'job': 4})
    @db.queue_consumer('python.decorated.fail', 'decorated-worker', max_attempts=1)
    def consume_failure(delivery):
        raise RuntimeError('FYLO_SENTINEL_SECRET_MUST_NOT_PERSIST')
    failure_summary = consume_failure()
    failure_letters = db.queue_dead_letters('python.decorated.fail', 'decorated-worker')
    assert failure_summary['deadLettered'] == 1, failure_summary
    assert failure_letters[0]['reason'] == 'queue handler failed', failure_letters
    assert 'FYLO_SENTINEL_SECRET_MUST_NOT_PERSIST' not in json.dumps(failure_letters), failure_letters
    db.create_collection('users')
    doc_id = db.put_data('users', {'name': 'Ada', 'score': 90})
    doc = db.get_latest('users', doc_id)
    found = db.find_docs('users', {'$ops': [{'score': {'$gte': 50}}]})
    db.set_meta('users', doc_id, {'source': 'python', 'reviewed': False})
    initial_meta = db.get_meta('users', doc_id)
    db.set_meta('users', doc_id, {'source': None})
    meta = db.get_meta('users', doc_id)
    assert initial_meta['source'] == 'python' and initial_meta['reviewed'] is False, initial_meta
    assert initial_meta['id'] == doc_id and initial_meta['createdAt'] > 0, initial_meta
    assert 'source' not in meta and meta['reviewed'] is False, meta
    access = {'uid': os.getuid(), 'mode': 0o600}
    sql_id = db.sql("INSERT INTO users (name, score, scope) VALUES ('SQL Ada', 91, 'private-sql')", access)
    assert db.sql("SELECT * FROM users WHERE scope = 'private-sql'") == {}
    owner_rows = db.sql("SELECT * FROM users WHERE scope = 'private-sql'", {'uid': os.getuid()})
    assert owner_rows[sql_id]['name'] == 'SQL Ada', owner_rows
    print(json.dumps({'ok': True, 'id': doc_id, 'doc': doc, 'found': found, 'meta': meta}))
`
        const result = await run(['python3', '-c', script])
        expectSuccess('python shim interop', result)
        expect(existsSync(path.join(shimRoot, 'python', '__pycache__'))).toBe(false)
        const parsed = JSON.parse(result.stdout)
        expect(parsed.ok).toBe(true)
        expect(parsed.found[parsed.id].name).toBe('Ada')
    })

    test('Node shim drives the persistent loop', async () => {
        await requireCommand('node')
        const root = await tempRoot('fylo-node-shim-')
        const script = `
import { Fylo } from ${JSON.stringify(path.join(shimRoot, 'node', 'fylo.mjs'))}
const db = new Fylo(${JSON.stringify(root)}, {
  binary: ${JSON.stringify(binaryPath)},
  maxRequestBytes: 1024,
  maxResponseBytes: 4096,
})
try {
  const identity = await db.handshake()
  if (identity.protocolVersion !== 1) throw new Error('bad handshake protocol')
  if (identity.machine.maxRequestBytes !== 1024) throw new Error('bad handshake request limit')
  let bounded = false
  try {
    await db.request({ op: 'handshake', pad: 'x'.repeat(1100) })
  } catch (error) {
    bounded = error.code === 'EFRAME_REQUEST_TOO_LARGE'
  }
  if (!bounded) throw new Error('oversized Node request was not rejected')
  const published = await db.queue.publish('node.jobs', { job: 1 }, { idempotencyKey: 'node-1' })
  const retried = await db.queue.publish('node.jobs', { job: 1 }, { idempotencyKey: 'node-1' })
  if (published.id !== retried.id || !retried.deduplicated) throw new Error('queue publish was not idempotent')
  const [delivery] = await db.queue.claim('node.jobs', 'node-worker')
  if (delivery.id !== published.id) throw new Error('queue claim returned the wrong message')
  await db.queue.ack('node.jobs', 'node-worker', delivery)
  const queueStats = await db.queue.stats('node.jobs', 'node-worker')
  if (queueStats.retired !== 1 || queueStats.available !== 0) throw new Error('queue ack was not durable')
  await db.queue.publish('node.decorated', { job: 2 })
  const handled = []
  const consume = db.queue.consumer('node.decorated', 'decorated-worker')(async (item) => {
    handled.push(item.payload.job)
  })
  const consumed = await consume()
  if (handled[0] !== 2 || consumed.acknowledged !== 1) throw new Error('queue decorator did not ack')
  await db.queue.publish('node.decorated.fail', { job: 3 })
  const fail = db.queue.consumer('node.decorated.fail', 'decorated-worker', { maxAttempts: 1 })(
    async () => { throw new Error('FYLO_SENTINEL_SECRET_MUST_NOT_PERSIST') }
  )
  const failed = await fail()
  if (failed.deadLettered !== 1) throw new Error('queue decorator did not dead-letter')
  const failureLetters = await db.queue.deadLetters('node.decorated.fail', 'decorated-worker')
  if (failureLetters[0]?.reason !== 'queue handler failed') {
    throw new Error('queue decorator did not use the generic failure reason')
  }
  if (JSON.stringify(failureLetters).includes('FYLO_SENTINEL_SECRET_MUST_NOT_PERSIST')) {
    throw new Error('queue decorator persisted handler exception text')
  }
  await db.createCollection('users')
  const id = await db.putData('users', { name: 'Ada', score: 90 })
  await db.batchPutData('users', Array.from({ length: 12 }, (_, index) => ({
    name: \`page-\${index}\`,
    score: index,
  })))
  const doc = await db.getLatest('users', id)
  const found = await db.findDocs('users', { $ops: [{ score: { $gte: 50 } }] })
  const pagedIds = []
  let page = { limit: 5 }
  do {
    const result = await db.findDocsPage('users', { $onlyIds: true }, page)
    pagedIds.push(...result.items)
    page = result.nextCursor ? { limit: 5, cursor: result.nextCursor } : null
  } while (page)
  if (pagedIds.length !== 13 || new Set(pagedIds).size !== 13) throw new Error('bad page traversal')
  await db.setMeta('users', id, { source: 'node', reviewed: false })
  const initialMeta = await db.getMeta('users', id)
  await db.setMeta('users', id, { source: null })
  const meta = await db.getMeta('users', id)
  if (initialMeta.source !== 'node' || initialMeta.reviewed !== false) throw new Error('bad initial metadata')
  if ('source' in meta || meta.reviewed !== false) throw new Error('bad updated metadata')
  const uid = process.getuid()
  const sqlId = await db.sql\`INSERT INTO users (name, score, scope) VALUES (\${'SQL Ada'}, \${91}, \${'private-sql'})\`.as({ uid, mode: 0o600 })
  const anonymousRows = await db.sql\`SELECT * FROM users WHERE scope = \${'private-sql'}\`
  if (sqlId in anonymousRows) throw new Error('anonymous SQL leaked protected row')
  const ownerRows = await db.sql\`SELECT * FROM users WHERE scope = \${'private-sql'}\`.as({ uid })
  if (ownerRows[sqlId]?.name !== 'SQL Ada') throw new Error('owner SQL could not read row')
  const updated = await db.sql\`UPDATE users SET score = \${92} WHERE scope = \${'private-sql'}\`.as({ uid })
  if (updated !== 1) throw new Error('owner SQL could not update row')
  const deleted = await db.sql\`DELETE FROM users WHERE scope = \${'private-sql'}\`.as({ uid })
  if (deleted !== 1) throw new Error('owner SQL could not delete row')
  console.log(JSON.stringify({ ok: true, id, doc, found, meta }))
} finally {
  await db.close()
}
`
        const result = await run(['node', '--input-type=module', '-e', script])
        expectSuccess('node shim interop', result)
        const parsed = JSON.parse(result.stdout)
        expect(parsed.ok).toBe(true)
        expect(parsed.found[parsed.id].name).toBe('Ada')
    })

    test('Node shim can enforce one exclusive owner for a root', async () => {
        await requireCommand('node')
        const root = await tempRoot('fylo-node-exclusive-')
        const script = `
import { Fylo } from ${JSON.stringify(path.join(shimRoot, 'node', 'fylo.mjs'))}
const first = new Fylo(${JSON.stringify(root)}, {
  binary: ${JSON.stringify(binaryPath)},
  exclusiveRoot: true,
})
let second
try {
  await first.handshake()
  second = new Fylo(${JSON.stringify(root)}, {
    binary: ${JSON.stringify(binaryPath)},
    exclusiveRoot: true,
  })
  let rejected = false
  try {
    await second.handshake()
  } catch (error) {
    rejected = error.code === 'EROOTLOCKED'
  }
  if (!rejected) throw new Error('competing root owner was not rejected')
  await first.createCollection('still-owned')
  console.log(JSON.stringify({ ok: true }))
} finally {
  if (second) await second.close()
  await first.close()
}
`
        const result = await run(['node', '--input-type=module', '-e', script])
        expectSuccess('Node exclusive-root interop', result)
        expect(JSON.parse(result.stdout).ok).toBe(true)
    })

    test.skipIf(process.platform === 'win32' || !process.getuid)(
        'Node shim applies trusted virtual-group access to documents and raw files (#68)',
        async () => {
            await requireCommand('node')
            const root = await tempRoot('fylo-node-access-')
            const source = path.join(root, 'tenant-attachment.txt')
            await writeFile(source, 'private attachment')
            const script = `
import { Fylo } from ${JSON.stringify(path.join(shimRoot, 'node', 'fylo.mjs'))}
const db = new Fylo(${JSON.stringify(root)}, { binary: ${JSON.stringify(binaryPath)} })
const gid = process.getgid()
const memberUid = process.getuid() + 10001
const member = { uid: memberUid, groups: [gid] }
const outsider = { uid: memberUid + 1, groups: [] }
try {
  await db.createCollection('messages')
  await db.createCollection('attachments', 'file')

  const id = await db.putData('messages', { tenant: 'domain-a', title: 'draft' }).as({ gid, mode: 0o660 })
  const found = await db.findDocs('messages', { tenant: 'domain-a' }).as(member)
  if (found[id]?.title !== 'draft') throw new Error('trusted group could not query document')
  const hidden = await db.findDocs('messages', { tenant: 'domain-a' }).as({ uid: memberUid, groups: [] })
  if (id in hidden) throw new Error('virtual group membership leaked between requests')

  await db.patchDoc('messages', id, { title: 'updated' }).as(member)
  await db.setMeta('messages', id, { source: 'node-access' }).as(member)
  const meta = await db.getMeta('messages', id).as(member)
  if (meta.source !== 'node-access') throw new Error('trusted group could not access metadata')

  let denied = false
  try {
    await db.getDoc('messages', id).as(outsider)
  } catch (error) {
    denied = error.code === 'EACCES'
  }
  if (!denied) throw new Error('outsider document read did not fail with EACCES')

  await db.delDoc('messages', id).as(member)
  const deleted = await db.findDeletedDocs('messages').as(member)
  if (!deleted[id]) throw new Error('trusted group could not query deleted document')
  await db.restoreDoc('messages', id).as(member)

  const fileId = await db.putFile(
    'attachments',
    { path: ${JSON.stringify(source)}, key: '/domain-a/attachment.txt' },
    { maxBytes: 64 }
  ).as({ gid, mode: 0o660 })
  const file = await db.getDoc('attachments', fileId).as(member)
  if (file[fileId]?.key !== '/domain-a/attachment.txt') {
    throw new Error('trusted group could not read raw-file manifest')
  }
  const files = await db.findDocs('attachments', { key: '/domain-a/attachment.txt' }).as(member)
  if (!files[fileId]) throw new Error('trusted group could not query raw-file bucket')

  denied = false
  try {
    await db.delDoc('attachments', fileId).as(outsider)
  } catch (error) {
    denied = error.code === 'EACCES'
  }
  if (!denied) throw new Error('outsider raw-file delete did not fail with EACCES')
  await db.delDoc('attachments', fileId).as(member)
  console.log(JSON.stringify({ ok: true }))
} finally {
  await db.close()
}
`
            const result = await run(['node', '--input-type=module', '-e', script])
            expectSuccess('node virtual-group access interop', result)
            expect(JSON.parse(result.stdout).ok).toBe(true)
        }
    )

    test('Node shim keeps the compiled loop alive after a raw-file path put (#65)', async () => {
        await requireCommand('node')
        const root = await tempRoot('fylo-node-raw-loop-')
        const source = path.join(root, 'hello.txt')
        await writeFile(source, 'hello attachment')
        const script = `
import { Fylo } from ${JSON.stringify(path.join(shimRoot, 'node', 'fylo.mjs'))}
const db = new Fylo(${JSON.stringify(root)}, { binary: ${JSON.stringify(binaryPath)} })
try {
  await db.createCollection('assets', 'file')
  const response = await db.request({
    op: 'putData',
    collection: 'assets',
    file: { path: ${JSON.stringify(source)}, key: '/hello.txt' },
    fileOptions: { maxBytes: 16 },
  })
  if (!response.ok) throw new Error(response.error?.message ?? 'raw-file put failed')
  const first = await db.getDoc('assets', response.result)
  const second = await db.getDoc('assets', response.result)
  if (!first[response.result] || !second[response.result]) {
    throw new Error('compiled loop lost the raw file')
  }
  console.log(JSON.stringify({ ok: true }))
} finally {
  await db.close()
}
`
        const result = await run(['node', '--input-type=module', '-e', script])
        expectSuccess('node raw-file loop regression', result)
        expect(JSON.parse(result.stdout).ok).toBe(true)
    })

    test('Ruby shim drives the persistent loop', async () => {
        await requireCommand('ruby')
        const root = await tempRoot('fylo-ruby-shim-')
        const script = `
$LOAD_PATH.unshift(${JSON.stringify(path.join(shimRoot, 'ruby'))})
require 'fylo'
require 'json'

db = Fylo.new(${JSON.stringify(root)}, binary: ${JSON.stringify(binaryPath)})
begin
  db.create_collection('users')
  id = db.put_data('users', { 'name' => 'Ada', 'score' => 90 })
  doc = db.get_latest('users', id)
  found = db.find_docs('users', { '$ops' => [{ 'score' => { '$gte' => 50 } }] })
  db.set_meta('users', id, { 'source' => 'ruby', 'reviewed' => false })
  initial_meta = db.get_meta('users', id)
  db.set_meta('users', id, { 'source' => nil })
  meta = db.get_meta('users', id)
  raise 'bad initial metadata' unless initial_meta['source'] == 'ruby' && initial_meta['reviewed'] == false
  raise 'missing canonical metadata' unless initial_meta['id'] == id && initial_meta['createdAt'] > 0
  raise 'bad updated metadata' unless !meta.key?('source') && meta['reviewed'] == false
  db.queue_publish('ruby.decorated', { 'job' => 2 })
  handled = []
  consume = db.queue_consumer('ruby.decorated', 'decorated-worker') do |delivery|
    handled << delivery.fetch('payload').fetch('job')
  end
  summary = consume.call
  raise 'queue consumer wrapper did not ack' unless handled == [2] && summary['acknowledged'] == 1
  access = { 'uid' => Process.uid, 'mode' => 0o600 }
  sql_id = db.sql("INSERT INTO users (name, score, scope) VALUES ('SQL Ada', 91, 'private-sql')", access)
  raise 'anonymous SQL leaked protected row' unless db.sql("SELECT * FROM users WHERE scope = 'private-sql'").empty?
  owner_rows = db.sql("SELECT * FROM users WHERE scope = 'private-sql'", { 'uid' => Process.uid })
  raise 'owner SQL could not read row' unless owner_rows[sql_id]['name'] == 'SQL Ada'
  puts JSON.generate({ ok: true, id: id, doc: doc, found: found, meta: meta })
ensure
  db.close
end
`
        const result = await run(['ruby', '-e', script])
        expectSuccess('ruby shim interop', result)
        const parsed = JSON.parse(result.stdout)
        expect(parsed.ok).toBe(true)
        expect(parsed.found[parsed.id].name).toBe('Ada')
    })
})
