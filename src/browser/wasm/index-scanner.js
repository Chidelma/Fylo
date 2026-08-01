const ENCODER = new TextEncoder()
const DECODER = new TextDecoder()
const WASM_ERROR = -1
const WASM_ABI_VERSION = 1
const INITIAL_OUTPUT_CAPACITY = 64 * 1024
const MAX_SNAPSHOT_BYTES = 256 * 1024 * 1024
const MAX_QUERY_BYTES = 1024 * 1024
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024

export class FyloWasmError extends Error {
    /**
     * @param {'EWASM_FETCH' | 'EWASM_COMPILE' | 'EWASM_INSTANTIATE' | 'EWASM_ABI' | 'EWASM_SNAPSHOT' | 'EWASM_QUERY' | 'EWASM_MEMORY'} code
     * @param {string} message
     * @param {{ cause?: unknown }=} options
     */
    constructor(code, message, options = {}) {
        super(`[${code}] ${message}`, options)
        this.name = 'FyloWasmError'
        this.code = code
    }
}

/** @type {Map<string, Promise<WebAssembly.Module>>} */
const MODULE_CACHE = new Map()

/**
 * Compiles the scanner once per worker/global and creates an isolated Wasm
 * instance per collection. Each instance owns one warm immutable snapshot.
 */
export class WasmIndexScannerFactory {
    /** @param {{ url?: string | URL, module?: WebAssembly.Module }=} options */
    constructor(options = {}) {
        this.module = options.module
        this.url = options.url
            ? new URL(String(options.url), import.meta.url)
            : siblingAssetUrl('./fylo-index.wasm')
        /** @type {Promise<WebAssembly.Module> | null} */
        this.modulePromise = null
    }

    /** @returns {Promise<void>} */
    async ready() {
        await this.loadModule()
    }

    /** @returns {Promise<WebAssembly.Module>} */
    async loadModule() {
        if (this.module) return this.module
        if (this.modulePromise) return await this.modulePromise
        const key = this.url.href
        let pending = MODULE_CACHE.get(key)
        if (!pending) {
            pending = (async () => {
                let response
                try {
                    response = await fetch(this.url)
                } catch (cause) {
                    throw new FyloWasmError(
                        'EWASM_FETCH',
                        `Unable to fetch FYLO Wasm index scanner from ${this.url.href}`,
                        { cause }
                    )
                }
                if (!response.ok) {
                    throw new FyloWasmError(
                        'EWASM_FETCH',
                        `Unable to load FYLO Wasm index scanner: HTTP ${response.status}`
                    )
                }
                try {
                    return await WebAssembly.compile(await response.arrayBuffer())
                } catch (cause) {
                    throw new FyloWasmError(
                        'EWASM_COMPILE',
                        'Unable to compile FYLO Wasm index scanner',
                        { cause }
                    )
                }
            })()
            MODULE_CACHE.set(key, pending)
            pending.catch(() => MODULE_CACHE.delete(key))
        }
        this.modulePromise = pending
        return await pending
    }

    /** @returns {Promise<WasmIndexScanner>} */
    async create() {
        try {
            const instance = await WebAssembly.instantiate(await this.loadModule(), {})
            return new WasmIndexScanner(instance)
        } catch (cause) {
            if (cause instanceof FyloWasmError) throw cause
            throw new FyloWasmError(
                'EWASM_INSTANTIATE',
                'Unable to instantiate FYLO Wasm index scanner',
                { cause }
            )
        }
    }
}

export class WasmIndexScanner {
    /** @param {WebAssembly.Instance} instance */
    constructor(instance) {
        const exports = /** @type {Record<string, any>} */ (instance.exports)
        if (!(exports.memory instanceof WebAssembly.Memory)) {
            throw new FyloWasmError('EWASM_ABI', 'FYLO Wasm index scanner did not export memory')
        }
        for (const name of [
            'abi_version',
            'allocate',
            'deallocate',
            'load_snapshot',
            'scan_queries'
        ]) {
            if (typeof exports[name] !== 'function') {
                throw new FyloWasmError(
                    'EWASM_ABI',
                    `FYLO Wasm index scanner did not export ${name}`
                )
            }
        }
        const actualVersion = exports.abi_version()
        if (actualVersion !== WASM_ABI_VERSION) {
            throw new FyloWasmError(
                'EWASM_ABI',
                `Unsupported FYLO Wasm index ABI ${actualVersion}; expected ${WASM_ABI_VERSION}`
            )
        }
        this.memory = exports.memory
        this.allocate = exports.allocate
        this.deallocate = exports.deallocate
        this.loadSnapshotExport = exports.load_snapshot
        this.scanQueriesExport = exports.scan_queries
        this.outputPointer = 0
        this.outputCapacity = 0
    }

    /** @param {Uint8Array} snapshot */
    loadSnapshot(snapshot) {
        const bytes = snapshot instanceof Uint8Array ? snapshot : new Uint8Array(snapshot)
        if (bytes.byteLength > MAX_SNAPSHOT_BYTES) {
            throw new FyloWasmError(
                'EWASM_SNAPSHOT',
                `FYLO Wasm snapshot exceeds ${MAX_SNAPSHOT_BYTES} bytes`
            )
        }
        const pointer = this.allocateRegion(bytes.byteLength, 'snapshot')
        try {
            if (bytes.byteLength > 0) {
                try {
                    new Uint8Array(this.memory.buffer, pointer, bytes.byteLength).set(bytes)
                } catch (cause) {
                    throw new FyloWasmError(
                        'EWASM_MEMORY',
                        'Unable to copy the FYLO index snapshot into Wasm memory',
                        { cause }
                    )
                }
            }
            if (this.loadSnapshotExport(pointer, bytes.byteLength) === WASM_ERROR) {
                throw new FyloWasmError(
                    'EWASM_SNAPSHOT',
                    'FYLO Wasm index scanner rejected the snapshot'
                )
            }
        } finally {
            this.deallocate(pointer, bytes.byteLength)
        }
    }

    /**
     * @param {Array<{ prefix: string, range?: { op: '$gt' | '$gte' | '$lt' | '$lte', value: string } }>} queries
     * @returns {string[]}
     */
    scanQueries(queries) {
        let input
        try {
            input = ENCODER.encode(JSON.stringify(queries))
        } catch (cause) {
            throw new FyloWasmError('EWASM_QUERY', 'Unable to encode the FYLO Wasm query', {
                cause
            })
        }
        if (input.byteLength > MAX_QUERY_BYTES) {
            throw new FyloWasmError(
                'EWASM_QUERY',
                `FYLO Wasm query exceeds ${MAX_QUERY_BYTES} bytes`
            )
        }
        const inputPointer = this.allocateRegion(input.byteLength, 'query')
        try {
            new Uint8Array(this.memory.buffer, inputPointer, input.byteLength).set(input)
        } catch (cause) {
            this.deallocate(inputPointer, input.byteLength)
            throw new FyloWasmError(
                'EWASM_MEMORY',
                'Unable to copy the FYLO query into Wasm memory',
                { cause }
            )
        }
        this.ensureOutput(Math.max(this.outputCapacity, INITIAL_OUTPUT_CAPACITY))
        try {
            let required = this.scanQueriesExport(
                inputPointer,
                input.byteLength,
                this.outputPointer,
                this.outputCapacity
            )
            if (required === WASM_ERROR)
                throw new FyloWasmError('EWASM_QUERY', 'FYLO Wasm index scanner rejected the query')
            if (required > this.outputCapacity) {
                if (required > MAX_OUTPUT_BYTES) {
                    throw new FyloWasmError(
                        'EWASM_MEMORY',
                        `FYLO Wasm scan output exceeds ${MAX_OUTPUT_BYTES} bytes`
                    )
                }
                this.ensureOutput(required)
                required = this.scanQueriesExport(
                    inputPointer,
                    input.byteLength,
                    this.outputPointer,
                    this.outputCapacity
                )
            }
            if (required === WASM_ERROR || required > this.outputCapacity) {
                throw new FyloWasmError(
                    'EWASM_MEMORY',
                    'FYLO Wasm index scan failed after resizing its output buffer'
                )
            }
            return DECODER.decode(new Uint8Array(this.memory.buffer, this.outputPointer, required))
                .split('\n')
                .filter(Boolean)
        } finally {
            this.deallocate(inputPointer, input.byteLength)
        }
    }

    /** @param {number} capacity */
    ensureOutput(capacity) {
        if (capacity <= this.outputCapacity) return
        if (capacity > MAX_OUTPUT_BYTES) {
            throw new FyloWasmError(
                'EWASM_MEMORY',
                `FYLO Wasm output allocation exceeds ${MAX_OUTPUT_BYTES} bytes`
            )
        }
        const pointer = this.allocateRegion(capacity, 'output')
        if (this.outputPointer) this.deallocate(this.outputPointer, this.outputCapacity)
        this.outputCapacity = capacity
        this.outputPointer = pointer
    }

    /**
     * @param {number} length
     * @param {'snapshot' | 'query' | 'output'} purpose
     * @returns {number}
     */
    allocateRegion(length, purpose) {
        try {
            const pointer = this.allocate(length)
            if (
                !Number.isSafeInteger(pointer) ||
                pointer < 0 ||
                pointer + length > this.memory.buffer.byteLength
            ) {
                throw new RangeError('allocator returned an invalid linear-memory region')
            }
            return pointer
        } catch (cause) {
            if (cause instanceof FyloWasmError) throw cause
            throw new FyloWasmError(
                'EWASM_MEMORY',
                `Unable to allocate Wasm memory for the FYLO ${purpose}`,
                { cause }
            )
        }
    }

    close() {
        if (this.outputPointer) this.deallocate(this.outputPointer, this.outputCapacity)
        this.outputPointer = 0
        this.outputCapacity = 0
    }
}

/** @param {true | { url?: string | URL, module?: WebAssembly.Module }} options */
export function createWasmIndexScannerFactory(options) {
    return new WasmIndexScannerFactory(options === true ? {} : options)
}

/** @param {string} path @returns {URL} */
function siblingAssetUrl(path) {
    const base = new URL(import.meta.url)
    const asset = new URL(path, base)
    asset.search = base.search
    return asset
}
