// The synchronous side of the OPFS bridge.
//
// OPFS is only half synchronous: inside a Worker `createSyncAccessHandle` gives
// synchronous file I/O, but every directory operation returns a promise. The
// engine calls the host synchronously, so the async half has to be made to
// block — and a Worker sitting in `Atomics.wait` cannot receive a `postMessage`,
// so the answer cannot come back that way either.
//
// So one Worker owns *all* OPFS and this side shuttles every call through a
// `SharedArrayBuffer`: write the request, `Atomics.notify`, `Atomics.wait` for
// the reply. That is the same design `sqlite-wasm` uses, and it needs the page
// to be cross-origin isolated (`Cross-Origin-Opener-Policy: same-origin` and
// `Cross-Origin-Embedder-Policy: require-corp`) or `SharedArrayBuffer` does not
// exist.
//
// Layout: a 5-slot Int32 control block, then the payload area.
//   [0] state   [1] request bytes   [2] payload bytes   [3] status   [4] result

export const CONTROL_SLOTS = 5
export const STATE = 0
export const REQUEST_LEN = 1
export const PAYLOAD_LEN = 2
export const STATUS = 3
export const RESULT = 4

export const STATE_IDLE = 0
export const STATE_REQUEST = 1
export const STATE_RESPONSE = 2

/** Room for one raw file plus its framing; the engine bounds records well below this. */
export const BRIDGE_BYTES = 64 * 1024 * 1024

export function createBridgeBuffer() {
    return new SharedArrayBuffer(CONTROL_SLOTS * 4 + BRIDGE_BYTES)
}

/**
 * A `HostBackend` that performs every operation in the bridge Worker.
 *
 * @param {SharedArrayBuffer} buffer shared with the bridge Worker
 * @param {string} rootPath stripped from absolute paths before they cross
 */
export function createBridgeBackend(buffer, rootPath) {
    const control = new Int32Array(buffer, 0, CONTROL_SLOTS)
    const data = new Uint8Array(buffer, CONTROL_SLOTS * 4)
    const encoder = new TextEncoder()
    const decoder = new TextDecoder()

    const relative = (path) => relativeBridgePath(path, rootPath)

    /**
     * Send one call and block until the bridge answers.
     *
     * @returns {{ status: number, result: number, payload: Uint8Array }}
     */
    function call(request, payload) {
        const encoded = encoder.encode(JSON.stringify(request))
        if (encoded.length + (payload?.length ?? 0) > data.length) {
            const error = new Error(`bridge request exceeds ${data.length} bytes`)
            error.code = 'EFBIG'
            throw error
        }
        data.set(encoded, 0)
        if (payload?.length) data.set(payload, encoded.length)
        Atomics.store(control, REQUEST_LEN, encoded.length)
        Atomics.store(control, PAYLOAD_LEN, payload?.length ?? 0)
        Atomics.store(control, STATE, STATE_REQUEST)
        Atomics.notify(control, STATE)
        // Blocks this Worker. The bridge Worker is a different thread, so it is
        // free to run its promises while this one is parked.
        while (Atomics.load(control, STATE) !== STATE_RESPONSE) {
            Atomics.wait(control, STATE, STATE_REQUEST)
        }
        const status = Atomics.load(control, STATUS)
        const result = Atomics.load(control, RESULT)
        const length = Atomics.load(control, PAYLOAD_LEN)
        const answer = length > 0 ? data.slice(0, length) : new Uint8Array()
        Atomics.store(control, STATE, STATE_IDLE)
        if (status !== 0) {
            const error = new Error(decoder.decode(answer) || `bridge call failed: ${request.op}`)
            error.code = status === -2 ? 'ENOENT' : status === -17 ? 'EEXIST' : 'EIO'
            throw error
        }
        return { status, result, payload: answer }
    }

    return {
        open(path, flags) {
            return call({ op: 'open', path: relative(path), flags }).result
        },
        close(handle) {
            call({ op: 'close', handle })
        },
        readAt(handle, offset, into) {
            const { result, payload } = call({ op: 'read', handle, offset, length: into.length })
            into.set(payload.subarray(0, result))
            return result
        },
        writeAt(handle, offset, from) {
            return call({ op: 'write', handle, offset }, from).result
        },
        truncate(handle, length) {
            call({ op: 'truncate', handle, length })
        },
        flush(handle) {
            call({ op: 'flush', handle })
        },
        stat(path) {
            const { payload } = call({ op: 'stat', path: relative(path) })
            return JSON.parse(decoder.decode(payload))
        },
        mkdir(path, recursive) {
            call({ op: 'mkdir', path: relative(path), recursive })
        },
        unlink(path) {
            call({ op: 'unlink', path: relative(path) })
        },
        rmdir(path, recursive) {
            call({ op: 'rmdir', path: relative(path), recursive })
        },
        rename(from, to) {
            call({ op: 'rename', from: relative(from), to: relative(to) })
        },
        readDir(path) {
            const { payload } = call({ op: 'readDir', path: relative(path) })
            return JSON.parse(decoder.decode(payload))
        },
        readAttrs(path) {
            return call({ op: 'readAttrs', path: relative(path) }).payload
        },
        writeAttrs(path, manifest) {
            call({ op: 'writeAttrs', path: relative(path) }, manifest)
        },
        random(into) {
            crypto.getRandomValues(into)
        },
        nowUnixMs() {
            return Date.now()
        },
        log(message) {
            console.error(message)
        }
    }
}

/** Keep every host operation inside the root granted to this engine. */
export function relativeBridgePath(path, rootPath) {
    if (typeof path !== 'string' || typeof rootPath !== 'string' || !rootPath.startsWith('/')) {
        const error = new Error('bridge paths and roots must be absolute strings')
        error.code = 'EACCES'
        throw error
    }
    const root = rootPath.replace(/\/+$/, '') || '/'
    const rootParts = root.split('/').filter(Boolean)
    const basename = rootParts.at(-1) ?? 'root'
    const parent = root === '/' ? '/' : root.slice(0, root.lastIndexOf('/')) || '/'
    const leasePrefix = `${parent === '/' ? '' : parent}/.${basename}.fylo-root-owner.lock`
    if (path === leasePrefix || path === `${leasePrefix}.json`) {
        return path.slice(path.lastIndexOf('/') + 1)
    }
    const contained =
        root === '/' ? path.startsWith('/') : path === root || path.startsWith(`${root}/`)
    if (!contained) {
        const error = new Error(`bridge path escapes the granted root: ${path}`)
        error.code = 'EACCES'
        throw error
    }
    const relative = root === '/' ? path.slice(1) : path.slice(root.length).replace(/^\/+/, '')
    const parts = relative.split('/').filter(Boolean)
    if (parts.some((part) => part === '.' || part === '..')) {
        const error = new Error(`bridge path contains a traversal component: ${path}`)
        error.code = 'EACCES'
        throw error
    }
    return parts.join('/')
}
