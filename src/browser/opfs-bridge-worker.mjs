// The asynchronous side of the OPFS bridge.
//
// Owns every OPFS handle and serves the engine Worker over shared memory. It
// waits with `Atomics.waitAsync` rather than `Atomics.wait`, because blocking
// here would stop the promises this Worker exists to run.

import {
    CONTROL_SLOTS,
    PAYLOAD_LEN,
    REQUEST_LEN,
    RESULT,
    STATE,
    STATE_IDLE,
    STATE_REQUEST,
    STATE_RESPONSE,
    STATUS
} from './opfs-bridge.mjs'

const ATTRIBUTE_MANIFEST = '.fylo-attributes.json'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

self.onmessage = async (event) => {
    try {
        await serve(event.data)
    } catch (error) {
        // An unhandled rejection here is invisible: the engine Worker is parked
        // in `Atomics.wait` and cannot receive a message, so a bridge that dies
        // quietly looks exactly like a hang.
        self.postMessage({
            bridgeError: error instanceof Error ? `${error.message}` : String(error)
        })
    }
}

async function serve(message) {
    const { buffer, root } = message
    const control = new Int32Array(buffer, 0, CONTROL_SLOTS)
    const data = new Uint8Array(buffer, CONTROL_SLOTS * 4)
    const context = {
        root: await rootDirectory(root),
        handles: new Map(),
        next: 1,
        attributes: undefined
    }
    self.postMessage({ ready: true })
    for (;;) {
        // Wait on whatever the state currently is, not on a fixed value: after
        // a reply it is RESPONSE until the engine clears it, and asking to wait
        // for a value it does not hold returns synchronously. Awaiting that in
        // a loop spins the microtask queue, which starves the very promises
        // this Worker exists to run — the OPFS calls would never resolve.
        let observed = Atomics.load(control, STATE)
        while (observed !== STATE_REQUEST) {
            // `Atomics.waitAsync` where the engine supports it; a macrotask
            // poll otherwise. Either way this must never park the thread, or
            // the OPFS promises this Worker exists to run would not resolve.
            const waited =
                typeof Atomics.waitAsync === 'function'
                    ? Atomics.waitAsync(control, STATE, observed)
                    : { async: false }
            if (waited.async) await waited.value
            else await new Promise((resume) => setTimeout(resume, 0))
            observed = Atomics.load(control, STATE)
        }
        const requestLength = Atomics.load(control, REQUEST_LEN)
        const payloadLength = Atomics.load(control, PAYLOAD_LEN)
        // `slice`, not `subarray`: TextDecoder refuses a view backed by shared
        // memory, so the bytes have to be copied out first.
        const request = JSON.parse(decoder.decode(data.slice(0, requestLength)))
        const payload = data.slice(requestLength, requestLength + payloadLength)
        let status = 0
        let result = 0
        let answer = new Uint8Array()
        try {
            const outcome = await perform(context, request, payload)
            result = outcome.result ?? 0
            answer = outcome.payload ?? new Uint8Array()
        } catch (error) {
            status = error?.name === 'NotFoundError' ? -2 : error?.code === 'EEXIST' ? -17 : -5
            answer = encoder.encode(error instanceof Error ? error.message : String(error))
        }
        if (answer.length > data.length) {
            status = -5
            answer = encoder.encode(`bridge response exceeds ${data.length} bytes`)
        }
        data.set(answer, 0)
        Atomics.store(control, STATUS, status)
        Atomics.store(control, RESULT, result)
        Atomics.store(control, PAYLOAD_LEN, answer.length)
        Atomics.store(control, STATE, STATE_RESPONSE)
        Atomics.notify(control, STATE)
    }
}

async function perform(context, request, payload) {
    switch (request.op) {
        case 'open': {
            const create = (request.flags & 0b100) !== 0
            const exclusive = (request.flags & 0b1000) !== 0
            if (exclusive && (await exists(context, request.path))) {
                const error = new Error(`already exists: ${request.path}`)
                error.code = 'EEXIST'
                throw error
            }
            // The engine opens a *directory* to flush it after a rename, the
            // way POSIX requires. OPFS has no directory handle to flush and
            // `getFileHandle` on one throws, so a directory opens to a handle
            // whose flush and close do nothing. The rename it follows is
            // already durable, and `sync_directory` accepts that.
            if ((await stat(context, request.path)).kind === 2) {
                const handle = context.next++
                context.handles.set(handle, null)
                return { result: handle }
            }
            const file = await fileHandle(context, request.path, create || exclusive)
            const handle = context.next++
            context.handles.set(handle, await file.createSyncAccessHandle())
            return { result: handle }
        }
        case 'close': {
            context.handles.get(request.handle)?.close()
            context.handles.delete(request.handle)
            return {}
        }
        case 'noop':
            return {}
        case 'read': {
            const into = new Uint8Array(request.length)
            const read = required(context, request.handle).read(into, { at: request.offset })
            return { result: read, payload: into.subarray(0, read) }
        }
        case 'write':
            return {
                result: required(context, request.handle).write(payload, { at: request.offset })
            }
        case 'truncate':
            required(context, request.handle).truncate(request.length)
            return {}
        case 'flush': {
            // A directory handle has nothing to flush.
            const access = context.handles.get(request.handle)
            if (access === null) return {}
            required(context, request.handle).flush()
            return {}
        }
        case 'stat':
            return { payload: encoder.encode(JSON.stringify(await stat(context, request.path))) }
        case 'mkdir':
            await directory(context, request.path, true)
            return {}
        case 'unlink': {
            const { parent, name } = await parentOf(context, request.path, false)
            await parent.removeEntry(name)
            return {}
        }
        case 'rmdir': {
            const { parent, name } = await parentOf(context, request.path, false)
            await parent.removeEntry(name, { recursive: request.recursive })
            return {}
        }
        case 'rename':
            await rename(context, request.from, request.to)
            return {}
        case 'readDir': {
            const handle = await directory(context, request.path, false)
            const names = []
            for await (const name of handle.keys()) {
                if (name !== ATTRIBUTE_MANIFEST) names.push(name)
            }
            return { payload: encoder.encode(JSON.stringify(names)) }
        }
        case 'readAttrs': {
            const manifest = await loadAttributes(context)
            const stored = manifest[request.path]
            return { payload: stored ? decodeBase64(stored) : new Uint8Array() }
        }
        case 'writeAttrs': {
            const manifest = await loadAttributes(context)
            if (payload.length === 0) delete manifest[request.path]
            else manifest[request.path] = encodeBase64(payload)
            await saveAttributes(context, manifest)
            return {}
        }
        default:
            throw new Error(`unknown bridge operation: ${request.op}`)
    }
}

async function rootDirectory(root) {
    let directory = await navigator.storage.getDirectory()
    for (const part of pathParts(root)) {
        directory = await directory.getDirectoryHandle(part, { create: true })
    }
    return directory
}

async function directory(context, path, create) {
    let handle = context.root
    for (const part of pathParts(path)) {
        handle = await handle.getDirectoryHandle(part, { create })
    }
    return handle
}

async function parentOf(context, path, create) {
    const parts = pathParts(path)
    if (parts.length === 0) throw new Error('an entry path must name a child of the root')
    return {
        parent: await directory(context, parts.slice(0, -1).join('/'), create),
        name: parts.at(-1)
    }
}

function pathParts(path) {
    const parts = String(path).split('/').filter(Boolean)
    if (parts.some((part) => part === '.' || part === '..')) {
        const error = new Error(`OPFS path contains a traversal component: ${path}`)
        error.code = 'EACCES'
        throw error
    }
    return parts
}

async function fileHandle(context, path, create) {
    const { parent, name } = await parentOf(context, path, create)
    return parent.getFileHandle(name, { create })
}

async function exists(context, path) {
    try {
        await fileHandle(context, path, false)
        return true
    } catch {
        return false
    }
}

async function stat(context, path) {
    const parts = path.split('/').filter(Boolean)
    if (parts.length === 0) return { kind: 2, len: 0, modifiedMs: 0 }
    try {
        const { parent, name } = await parentOf(context, path, false)
        try {
            const file = await (await parent.getFileHandle(name)).getFile()
            return { kind: 1, len: file.size, modifiedMs: Math.trunc(file.lastModified) }
        } catch {
            await parent.getDirectoryHandle(name)
            return { kind: 2, len: 0, modifiedMs: 0 }
        }
    } catch {
        return { kind: 0, len: 0, modifiedMs: 0 }
    }
}

async function rename(context, from, to) {
    const source = await fileHandle(context, from, false)
    const { parent, name } = await parentOf(context, to, true)
    if (typeof source.move === 'function') {
        await source.move(parent, name)
        return
    }
    // No `move`: copy then unlink. Not atomic, which is why an interrupted
    // write is recovered by FYLO's transaction journal rather than by the
    // filesystem.
    const bytes = new Uint8Array(await (await source.getFile()).arrayBuffer())
    const target = await parent.getFileHandle(name, { create: true })
    const access = await target.createSyncAccessHandle()
    try {
        access.truncate(0)
        access.write(bytes, { at: 0 })
        access.flush()
    } finally {
        access.close()
    }
    const origin = await parentOf(context, from, false)
    await origin.parent.removeEntry(origin.name)
}

async function loadAttributes(context) {
    if (context.attributes) return context.attributes
    try {
        const handle = await context.root.getFileHandle(ATTRIBUTE_MANIFEST)
        context.attributes = JSON.parse(await (await handle.getFile()).text())
    } catch {
        context.attributes = {}
    }
    return context.attributes
}

async function saveAttributes(context, manifest) {
    context.attributes = manifest
    const handle = await context.root.getFileHandle(ATTRIBUTE_MANIFEST, { create: true })
    const access = await handle.createSyncAccessHandle()
    try {
        const bytes = encoder.encode(JSON.stringify(manifest))
        access.truncate(0)
        access.write(bytes, { at: 0 })
        access.flush()
    } finally {
        access.close()
    }
}

function required(context, handle) {
    const access = context.handles.get(handle)
    if (!access) {
        const error = new Error(`unknown handle ${handle}`)
        error.code = 'EBADF'
        throw error
    }
    return access
}

function encodeBase64(bytes) {
    let binary = ''
    for (const byte of bytes) binary += String.fromCharCode(byte)
    return btoa(binary)
}

function decodeBase64(text) {
    const binary = atob(text)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    return bytes
}
