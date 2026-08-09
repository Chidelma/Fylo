// The Worker that owns a FYLO root in a browser.
//
// Two things have to be true before the engine may touch storage, and both are
// the host's job rather than the module's:
//
// 1. **Synchronous storage.** `FileSystemSyncAccessHandle` exists only inside a
//    dedicated Worker, and the engine calls the host synchronously.
// 2. **One writer.** WASI and browsers have no advisory file locking, so the
//    handshake reports `exclusiveRoot: false` and the module does not pretend
//    otherwise. Web Locks is the browser's equivalent, and holding one for the
//    life of the session is what actually keeps a second tab out.
//
// Protocol: post `{ id, ndjson }`, receive `{ id, ndjson }` or `{ id, error }`.

import { createHostImports, exec } from './host-vfs.mjs'
import { createBridgeBackend } from './opfs-bridge.mjs'

/** @type {WebAssembly.Instance | undefined} */
let instance
/** @type {(() => void) | undefined} */
let releaseLock
/** @type {string | undefined} */
let lastHostError

// Progress markers. A Worker parked in `Atomics.wait` cannot report where it
// stopped, so a hang is otherwise indistinguishable from slow work.
const trace = (step) => self.postMessage({ trace: step })

self.onmessage = async (event) => {
    const { id, ndjson, moduleUrl, root } = event.data ?? {}
    try {
        trace('received')
        if (!instance) instance = await open(moduleUrl, root ?? '/fylo', event.data.buffer)
        trace('executing')
        const answer = exec(instance, ndjson, trace)
        trace('executed')
        self.postMessage({ id, ndjson: answer, hostError: lastHostError })
    } catch (error) {
        self.postMessage({ id, error: error instanceof Error ? error.message : String(error) })
    }
}

async function open(moduleUrl, root, buffer) {
    if (!buffer) {
        throw new Error(
            'fylo-wasm needs a SharedArrayBuffer bridge for OPFS; the page must be ' +
                'cross-origin isolated (COOP: same-origin, COEP: require-corp). ' +
                `SharedArrayBuffer is ${typeof SharedArrayBuffer}, crossOriginIsolated is ` +
                `${globalThis.crossOriginIsolated === true}.`
        )
    }
    trace('locking')
    await acquireRootLock(root)
    trace('locked')
    const backend = createBridgeBackend(buffer, root)
    let created
    const imports = createHostImports({
        memory: () => created.exports.memory,
        backend,
        onError: (message) => {
            lastHostError = message
        }
    })
    trace('instantiating')
    created = (await WebAssembly.instantiateStreaming(fetch(moduleUrl), imports)).instance
    trace('instantiated')
    return created
}

/**
 * Hold the root's Web Lock for the life of this Worker.
 *
 * A second tab asking for the same root waits rather than corrupting it. The
 * lock is released when the Worker is terminated or the page goes away, which
 * is the same lifetime an operating system gives a file lock — and unlike a
 * lock file, a crashed tab leaves nothing stale behind.
 */
async function acquireRootLock(root) {
    if (!globalThis.navigator?.locks) return
    await new Promise((granted, failed) => {
        navigator.locks
            .request(`fylo-root:${root}`, { mode: 'exclusive' }, () => {
                granted(undefined)
                // Held until this promise resolves, i.e. until `releaseLock`.
                return new Promise((release) => {
                    releaseLock = release
                })
            })
            .catch(failed)
    })
}

self.addEventListener('close', () => releaseLock?.())
