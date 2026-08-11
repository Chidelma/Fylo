// @ts-nocheck -- dependency-free drop-in shim; behavior is verified by the cross-language corpus.
// Fylo client — drives the `fylo` binary's persistent NDJSON loop.
//
// For JS/TS apps that consume the compiled binary instead of importing the npm
// package. No dependencies (node:child_process only). Requires the `fylo`
// binary on PATH (brew/scoop) or an explicit path. One long-lived subprocess
// keeps the engine warm across calls.
//
//   import { Fylo } from './fylo.mjs'
//   const db = new Fylo('/path/to/db')
//   await db.createCollection('users')
//   const id = await db.putData('users', { name: 'Ada', role: 'admin' })
//   const doc = await db.getLatest('users', id)
//   const admins = await db.findDocs('users', { $ops: [{ role: { $eq: 'admin' } }] })
//   await db.close()
//
// Each operation method builds the request and resolves with the op's `result`
// (rejecting on failure). Method names mirror the machine-protocol op names.
// `request(op)` remains a raw escape hatch resolving with the full response
// object — use it for ops without a dedicated method (branching, schema, ...).
// Requests are queued: each resolves with its own response line, in order.

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'

const MAX_SHARD_WIDTH = 4
const DEFAULT_MAX_REQUEST_BYTES = 1024 * 1024
const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024
const MAX_FRAME_BYTES = 64 * 1024 * 1024
const responseDecoder = new TextDecoder('utf-8', { fatal: true })
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

function protocolError(code, message) {
    const error = new Error(message)
    error.code = code
    return error
}

function frameLimit(value, fallback, name, minimum) {
    const limit = value ?? fallback
    if (!Number.isSafeInteger(limit) || limit < minimum || limit > MAX_FRAME_BYTES) {
        throw new RangeError(`${name} must be an integer between ${minimum} and ${MAX_FRAME_BYTES}`)
    }
    return limit
}

function environmentError(path, line, message) {
    return new SyntaxError(`${path}:${line}: ${message}`)
}

function quotedEnvironmentValue(path, line, input, quote) {
    let value = ''
    for (let index = 1; index < input.length; index += 1) {
        const character = input[index]
        if (character === quote) {
            const trailing = input.slice(index + 1).trim()
            if (trailing && !trailing.startsWith('#')) {
                throw environmentError(path, line, 'unexpected characters after quoted value')
            }
            return value
        }
        if (quote === '"' && character === '\\') {
            index += 1
            if (index >= input.length) {
                throw environmentError(path, line, 'unterminated escape sequence')
            }
            const escaped = input[index]
            value +=
                escaped === 'n'
                    ? '\n'
                    : escaped === 'r'
                      ? '\r'
                      : escaped === 't'
                        ? '\t'
                        : escaped === '"' || escaped === '\\'
                          ? escaped
                          : `\\${escaped}`
            continue
        }
        value += character
    }
    throw environmentError(path, line, 'unterminated quoted value')
}

function parseEnvironmentFile(path) {
    let source
    try {
        source = readFileSync(path, 'utf8')
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        throw new Error(`cannot read FYLO environment file ${path}: ${detail}`)
    }
    if (source.charCodeAt(0) === 0xfeff) source = source.slice(1)
    const values = Object.create(null)
    for (const [index, original] of source.split(/\r?\n/).entries()) {
        const line = index + 1
        let entry = original.trim()
        if (!entry || entry.startsWith('#')) continue
        if (/^export\s+/.test(entry)) entry = entry.replace(/^export\s+/, '')
        const separator = entry.indexOf('=')
        if (separator < 0) throw environmentError(path, line, 'expected NAME=VALUE')
        const name = entry.slice(0, separator).trim()
        if (!ENVIRONMENT_NAME.test(name)) {
            throw environmentError(
                path,
                line,
                `invalid environment variable name ${JSON.stringify(name)}`
            )
        }
        const input = entry.slice(separator + 1).trimStart()
        if (input.startsWith('"') || input.startsWith("'")) {
            values[name] = quotedEnvironmentValue(path, line, input, input[0])
            continue
        }
        const comment = input.indexOf('#')
        values[name] = (comment < 0 ? input : input.slice(0, comment)).trimEnd()
    }
    return values
}

function childEnvironment(config) {
    if (config === undefined) return undefined
    const overrides = typeof config === 'string' ? parseEnvironmentFile(config) : config
    if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
        throw new TypeError('env must be a .env file path or an environment variable object')
    }
    const environment = Object.create(null)
    for (const [name, value] of Object.entries(process.env)) {
        environment[process.platform === 'win32' ? name.toUpperCase() : name] = value
    }
    for (const [name, value] of Object.entries(overrides)) {
        if (!name || name.includes('=') || name.includes('\0')) {
            throw new TypeError(`invalid environment variable name ${JSON.stringify(name)}`)
        }
        const environmentName = process.platform === 'win32' ? name.toUpperCase() : name
        if (value === undefined || value === null) {
            delete environment[environmentName]
        } else {
            const environmentValue = String(value)
            if (environmentValue.includes('\0')) {
                throw new TypeError(
                    `invalid environment variable value for ${JSON.stringify(name)}: NUL is not allowed`
                )
            }
            environment[environmentName] = environmentValue
        }
    }
    return environment
}

// Property access that isn't a real method/field falls through to a collection
// facade, so `db.users.put(...)` works alongside `db.putData('users', ...)`.
const RESERVED = new Set(['then'])
const FACADE = {
    get(target, prop, receiver) {
        if (typeof prop === 'symbol' || RESERVED.has(prop) || prop in target) {
            return Reflect.get(target, prop, receiver)
        }
        return target.collection(String(prop))
    }
}

export class Fylo {
    /**
     * @param {string} root
     * @param {{ binary?: string, env?: string | Record<string, string | number | boolean | null | undefined>, exclusiveRoot?: boolean, strictSchema?: boolean, shardWidth?: number, maxRequestBytes?: number, maxResponseBytes?: number }} [opts]
     */
    constructor(root, opts = {}) {
        const args = ['exec', '--loop', '--root', root]
        if (opts.exclusiveRoot) args.push('--exclusive-root')
        this.maxRequestBytes = frameLimit(
            opts.maxRequestBytes,
            DEFAULT_MAX_REQUEST_BYTES,
            'maxRequestBytes',
            256
        )
        this.maxResponseBytes = frameLimit(
            opts.maxResponseBytes,
            DEFAULT_MAX_RESPONSE_BYTES,
            'maxResponseBytes',
            1024
        )
        args.push('--max-request-bytes', String(this.maxRequestBytes))
        args.push('--max-response-bytes', String(this.maxResponseBytes))
        // Direct constructor knobs become CLI flags, letting one host drive
        // different roots without changing its own process environment.
        if (opts.strictSchema) args.push('--strict-schema')
        if (opts.shardWidth !== undefined) {
            if (
                !Number.isInteger(opts.shardWidth) ||
                opts.shardWidth < 0 ||
                opts.shardWidth > MAX_SHARD_WIDTH
            ) {
                throw new TypeError(`shardWidth must be an integer from 0 to ${MAX_SHARD_WIDTH}`)
            }
            args.push('--shard-width', String(opts.shardWidth))
        }
        this._proc = spawn(opts.binary ?? 'fylo', args, {
            stdio: ['pipe', 'pipe', 'inherit'],
            env: childEnvironment(opts.env)
        })
        this._queue = [] // pending { resolve, reject } in request order
        this._responseBuffer = Buffer.allocUnsafe(this.maxResponseBytes)
        this._responseLength = 0
        this._responseOversized = false
        this._proc.stdout.on('data', (chunk) => this._onData(chunk))
        this._proc.on('close', () => {
            const err = new Error('fylo process exited')
            for (const p of this._queue.splice(0)) p.reject(err)
        })
        // Surface spawn failures (e.g. binary missing) instead of crashing on an
        // unhandled 'error' event.
        this._proc.on('error', (err) => {
            for (const p of this._queue.splice(0)) p.reject(err)
        })
        // The child may reject startup and close stdin after already writing a
        // structured response (for example EROOTLOCKED). Suppress the stream's
        // EPIPE event so stdout/exit remains the authoritative outcome.
        this._proc.stdin.on('error', () => {})
        this.ready = this._sendOp('handshake', {}).then((identity) => {
            if (
                identity?.machine?.maxRequestBytes !== this.maxRequestBytes ||
                identity?.machine?.maxResponseBytes !== this.maxResponseBytes
            ) {
                this._proc.kill()
                throw protocolError(
                    'EPROTOCOL_LIMIT',
                    'FYLO handshake frame limits do not match the client configuration'
                )
            }
            this.identity = identity
            return identity
        })
        void this.ready.catch(() => {})
        this.queue = Object.freeze({
            publish: (topic, payload, options = {}) => this.queuePublish(topic, payload, options),
            claim: (topic, group, options = {}) => this.queueClaim(topic, group, options),
            ack: (topic, group, delivery, receipt) =>
                this.queueAck(
                    topic,
                    group,
                    typeof delivery === 'string' ? delivery : delivery.id,
                    receipt ?? delivery.receipt
                ),
            nack: (topic, group, delivery, options = {}) =>
                this.queueNack(
                    topic,
                    group,
                    typeof delivery === 'string' ? delivery : delivery.id,
                    typeof delivery === 'string' ? options.receipt : delivery.receipt,
                    options
                ),
            extend: (topic, group, delivery, receiptOrTimeout, visibilityTimeoutMs) =>
                this.queueExtend(
                    topic,
                    group,
                    typeof delivery === 'string' ? delivery : delivery.id,
                    typeof delivery === 'string' ? receiptOrTimeout : delivery.receipt,
                    typeof delivery === 'string' ? visibilityTimeoutMs : receiptOrTimeout
                ),
            stats: (topic, group) => this.queueStats(topic, group),
            deadLetters: (topic, group, limit) => this.queueDeadLetters(topic, group, limit),
            process: (topic, group, handler, options = {}) =>
                this.queueProcess(topic, group, handler, options),
            consumer: (topic, group, options = {}) => this.queueConsumer(topic, group, options)
        })
        return new Proxy(this, FACADE)
    }

    /**
     * Collection-scoped facade with short method names, so
     * `db.collection('users').put(data)` reads like the browser client. The
     * dynamic sugar `db.users.put(data)` resolves here too.
     * @param {string} name
     */
    collection(name) {
        return {
            create: (kind) => this.createCollection(name, kind),
            drop: () => this.dropCollection(name),
            inspect: () => this.inspectCollection(name),
            rebuild: () => this.rebuildCollection(name),
            put: (data, meta) => this.putData(name, data, meta),
            putFile: (file, fileOptions, meta) => this.putFile(name, file, fileOptions, meta),
            get: (id) => this.getDoc(name, id),
            getMeta: (id) => this.getMeta(name, id),
            setMeta: (id, meta) => this.setMeta(name, id, meta),
            latest: (id, onlyId) => this.getLatest(name, id, onlyId),
            patch: (id, newDoc, oldDoc) => this.patchDoc(name, id, newDoc, oldDoc),
            delete: (id) => this.delDoc(name, id),
            restore: (id) => this.restoreDoc(name, id),
            find: (query) => this.findDocs(name, query),
            findPage: (query, page) => this.findDocsPage(name, query, page)
        }
    }

    _onData(chunk) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        let start = 0
        while (start < bytes.byteLength) {
            const newline = bytes.indexOf(0x0a, start)
            const end = newline === -1 ? bytes.byteLength : newline
            this._appendResponse(bytes.subarray(start, end))
            if (newline === -1) return

            if (this._responseOversized) {
                this._abortProtocol(
                    protocolError(
                        'EFRAME_RESPONSE_TOO_LARGE',
                        `FYLO response exceeds ${this.maxResponseBytes} bytes`
                    )
                )
                return
            }
            const pending = this._queue.shift()
            if (pending) {
                try {
                    const text = responseDecoder.decode(
                        this._responseBuffer.subarray(0, this._responseLength)
                    )
                    pending.resolve(JSON.parse(text))
                } catch {
                    const error = protocolError(
                        'EFRAME_RESPONSE_INVALID',
                        'FYLO returned malformed UTF-8 or JSON'
                    )
                    pending.reject(error)
                    this._abortProtocol(error)
                    return
                }
            }
            this._responseLength = 0
            this._responseOversized = false
            start = newline + 1
        }
    }

    _appendResponse(bytes) {
        if (this._responseOversized || bytes.byteLength === 0) return
        if (bytes.byteLength > this.maxResponseBytes - this._responseLength) {
            this._responseLength = 0
            this._responseOversized = true
            return
        }
        this._responseBuffer.set(bytes, this._responseLength)
        this._responseLength += bytes.byteLength
    }

    _abortProtocol(error) {
        for (const pending of this._queue.splice(0)) pending.reject(error)
        this._proc.kill()
    }

    /** Send one raw machine-protocol op; resolves with the full response object. */
    request(op) {
        return new Promise((resolve, reject) => {
            if (this._proc.exitCode !== null) return reject(new Error('fylo process exited'))
            let payload
            try {
                payload = Buffer.from(JSON.stringify(op), 'utf8')
            } catch (error) {
                reject(error)
                return
            }
            if (payload.byteLength > this.maxRequestBytes) {
                reject(
                    protocolError(
                        'EFRAME_REQUEST_TOO_LARGE',
                        `FYLO request exceeds ${this.maxRequestBytes} bytes`
                    )
                )
                return
            }
            this._queue.push({ resolve, reject })
            this._proc.stdin.write(Buffer.concat([payload, Buffer.from('\n')]))
        })
    }

    /** Build an op, send it, and resolve with `result` (rejects on failure). */
    async _sendOp(op, fields) {
        const payload = { op }
        for (const [key, value] of Object.entries(fields)) {
            if (value !== undefined) payload[key] = value
        }
        const response = await this.request(payload)
        if (!response.ok) {
            const error = new Error(response.error?.message ?? 'fylo error')
            if (response.error?.name) error.name = response.error.name
            if (response.error?.code) error.code = response.error.code
            throw error
        }
        return response.result
    }

    async _op(op, fields) {
        await this.ready
        return await this._sendOp(op, fields)
    }

    handshake() {
        return this.ready
    }

    /**
     * Defer an operation by one microtask so a same-expression `.as(...)` call
     * can attach trusted UID/GID/mode and virtual-group context first.
     */
    _accessOp(op, fields) {
        let access
        let started = false
        const operation = Promise.resolve().then(() => {
            started = true
            return this._op(op, { ...fields, access })
        })
        return Object.assign(operation, {
            as(input) {
                if (started) throw new Error('as() must be called before the operation starts')
                access = input
                return operation
            }
        })
    }

    // --- Collections ---
    createCollection(collection, kind = 'document') {
        return this._op('createCollection', { collection, kind })
    }
    dropCollection(collection) {
        return this._op('dropCollection', { collection })
    }
    inspectCollection(collection) {
        return this._op('inspectCollection', { collection })
    }
    rebuildCollection(collection) {
        return this._op('rebuildCollection', { collection })
    }

    // --- Durable serverless queue ---
    queuePublish(topic, payload, options = {}) {
        return this._op('queuePublish', {
            topic,
            payload,
            delayMs: options.delayMs,
            idempotencyKey: options.idempotencyKey
        })
    }
    queueClaim(topic, group, options = {}) {
        return this._op('queueClaim', {
            topic,
            group,
            maxMessages: options.maxMessages,
            visibilityTimeoutMs: options.visibilityTimeoutMs,
            maxAttempts: options.maxAttempts
        })
    }
    queueAck(topic, group, id, receipt) {
        return this._op('queueAck', { topic, group, id, receipt })
    }
    queueNack(topic, group, id, receipt, options = {}) {
        return this._op('queueNack', {
            topic,
            group,
            id,
            receipt,
            delayMs: options.delayMs,
            reason: options.reason
        })
    }
    queueExtend(topic, group, id, receipt, visibilityTimeoutMs) {
        return this._op('queueExtend', {
            topic,
            group,
            id,
            receipt,
            visibilityTimeoutMs
        })
    }
    queueStats(topic, group) {
        return this._op('queueStats', { topic, group })
    }
    queueDeadLetters(topic, group, limit) {
        return this._op('queueDeadLetters', { topic, group, limit })
    }
    /** Process one bounded batch and settle every claimed delivery. */
    async queueProcess(topic, group, handler, options = {}) {
        if (typeof handler !== 'function') throw new TypeError('queue handler must be a function')
        const deliveries = await this.queueClaim(topic, group, {
            maxMessages: options.maxMessages,
            visibilityTimeoutMs: options.visibilityTimeoutMs,
            maxAttempts: options.maxAttempts
        })
        const result = {
            claimed: deliveries.length,
            acknowledged: 0,
            retried: 0,
            deadLettered: 0
        }
        for (const delivery of deliveries) {
            let failed = false
            try {
                await handler(delivery)
            } catch {
                failed = true
            }
            if (!failed) {
                await this.queueAck(topic, group, delivery.id, delivery.receipt)
                result.acknowledged += 1
            } else {
                const settled = await this.queueNack(topic, group, delivery.id, delivery.receipt, {
                    delayMs: options.retryDelayMs,
                    reason: 'queue handler failed'
                })
                if (settled.deadLettered) result.deadLettered += 1
                else result.retried += 1
            }
        }
        return result
    }
    /**
     * ECMAScript/TypeScript decorator factory. The returned function also
     * wraps an ordinary handler, so no decorator syntax is required.
     */
    queueConsumer(topic, group, options = {}) {
        const db = this
        return (handler, context) => {
            if (typeof handler !== 'function') {
                throw new TypeError('queue consumer can decorate only a function or method')
            }
            const consumer = async function (...args) {
                return db.queueProcess(
                    topic,
                    group,
                    (delivery) => handler.call(this, delivery, ...args),
                    options
                )
            }
            Object.defineProperty(consumer, 'name', {
                value: context?.name ? String(context.name) : handler.name,
                configurable: true
            })
            consumer.queueConsumer = Object.freeze({ topic, group, ...options })
            return consumer
        }
    }

    // --- Documents ---
    putData(collection, data, meta) {
        return this._accessOp('putData', { collection, data, meta })
    }
    batchPutData(collection, batch) {
        return this._accessOp('batchPutData', { collection, batch })
    }
    putFile(collection, file, fileOptions, meta) {
        return this._accessOp('putData', { collection, file, fileOptions, meta })
    }
    getDoc(collection, id) {
        return this._accessOp('getDoc', { collection, id })
    }
    getMeta(collection, id) {
        return this._accessOp('getMeta', { collection, id })
    }
    setMeta(collection, id, meta) {
        return this._accessOp('setMeta', { collection, id, meta })
    }
    getLatest(collection, id, onlyId = false) {
        return this._accessOp('getLatest', { collection, id, onlyId })
    }
    patchDoc(collection, id, newDoc, oldDoc) {
        return this._accessOp('patchDoc', { collection, id, newDoc, oldDoc })
    }
    patchDocs(collection, update) {
        return this._accessOp('patchDocs', { collection, update })
    }
    delDoc(collection, id) {
        return this._accessOp('delDoc', { collection, id })
    }
    delDocs(collection, criteria) {
        return this._accessOp('delDocs', { collection, delete: criteria })
    }
    restoreDoc(collection, id) {
        return this._accessOp('restoreDoc', { collection, id })
    }

    // --- Query ---
    findDocs(collection, query) {
        return this._accessOp('findDocs', { collection, query })
    }
    findDeletedDocs(collection, query = {}) {
        return this._accessOp('findDeletedDocs', { collection, query })
    }
    findDocsPage(collection, query, page = {}) {
        return this._accessOp('findDocs', { collection, query, page })
    }
    findDeletedDocsPage(collection, query = {}, page = {}) {
        return this._accessOp('findDeletedDocs', { collection, query, page })
    }
    joinDocs(join) {
        return this._accessOp('joinDocs', { join })
    }
    executeSQL(sql, access) {
        return this._op('executeSQL', { sql, access })
    }
    /**
     * Tagged-template SQL — interpolated values are escaped, so
     * ``db.sql`SELECT * FROM users WHERE name = ${name}` `` is injection-safe.
     * @param {TemplateStringsArray} strings
     * @param {...unknown} values
     */
    sql(strings, ...values) {
        let statement = strings[0]
        for (let i = 0; i < values.length; i++) {
            statement += Fylo._sqlValue(values[i]) + strings[i + 1]
        }
        let access
        let started = false
        const operation = Promise.resolve().then(() => {
            started = true
            return this.executeSQL(statement, access)
        })
        return Object.assign(operation, {
            as(input) {
                if (started) throw new Error('as() must be called before SQL execution starts')
                access = input
                return operation
            }
        })
    }
    /** Escape one scalar into a SQL literal. */
    static _sqlValue(value) {
        if (value === null || value === undefined) return 'NULL'
        if (typeof value === 'number') {
            if (!Number.isFinite(value)) throw new Error('SQL value must be a finite number')
            return String(value)
        }
        if (typeof value === 'boolean') return value ? 'true' : 'false'
        if (typeof value === 'bigint') return value.toString()
        if (value instanceof Date) return `'${value.toISOString().replaceAll("'", "''")}'`
        if (typeof value === 'object') throw new Error('SQL values must be scalar')
        return `'${String(value).replaceAll("'", "''")}'`
    }
    importBulkData(collection, url, limitOrOptions) {
        return this._op('importBulkData', { collection, url, limitOrOptions })
    }

    /** Close stdin so the loop ends, and wait for the process to exit. */
    close() {
        return new Promise((resolve) => {
            if (this._proc.exitCode !== null) return resolve()
            this._proc.on('exit', () => resolve())
            this._proc.stdin.end()
        })
    }
}
