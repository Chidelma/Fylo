const ENCODER = new TextEncoder()
const DECODER = new TextDecoder()
const WASM_ERROR = -1
const WASM_ABI_VERSION = 1
const INITIAL_OUTPUT_CAPACITY = 64 * 1024

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
            pending = fetch(this.url).then(async (response) => {
                if (!response.ok) {
                    throw new Error(`Unable to load FYLO Wasm index scanner: ${response.status}`)
                }
                return await WebAssembly.compile(await response.arrayBuffer())
            })
            MODULE_CACHE.set(key, pending)
            pending.catch(() => MODULE_CACHE.delete(key))
        }
        this.modulePromise = pending
        return await pending
    }

    /** @returns {Promise<WasmIndexScanner>} */
    async create() {
        const instance = await WebAssembly.instantiate(await this.loadModule(), {})
        return new WasmIndexScanner(instance)
    }
}

export class WasmIndexScanner {
    /** @param {WebAssembly.Instance} instance */
    constructor(instance) {
        const exports = /** @type {Record<string, any>} */ (instance.exports)
        if (!(exports.memory instanceof WebAssembly.Memory)) {
            throw new Error('FYLO Wasm index scanner did not export memory')
        }
        for (const name of [
            'abi_version',
            'allocate',
            'deallocate',
            'load_snapshot',
            'scan_queries'
        ]) {
            if (typeof exports[name] !== 'function') {
                throw new Error(`FYLO Wasm index scanner did not export ${name}`)
            }
        }
        const actualVersion = exports.abi_version()
        if (actualVersion !== WASM_ABI_VERSION) {
            throw new Error(
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
        const pointer = this.allocate(bytes.byteLength)
        try {
            if (bytes.byteLength > 0) {
                new Uint8Array(this.memory.buffer, pointer, bytes.byteLength).set(bytes)
            }
            if (this.loadSnapshotExport(pointer, bytes.byteLength) === WASM_ERROR) {
                throw new Error('FYLO Wasm index scanner rejected the snapshot')
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
        const input = ENCODER.encode(JSON.stringify(queries))
        const inputPointer = this.allocate(input.byteLength)
        new Uint8Array(this.memory.buffer, inputPointer, input.byteLength).set(input)
        this.ensureOutput(Math.max(this.outputCapacity, INITIAL_OUTPUT_CAPACITY))
        try {
            let required = this.scanQueriesExport(
                inputPointer,
                input.byteLength,
                this.outputPointer,
                this.outputCapacity
            )
            if (required === WASM_ERROR)
                throw new Error('FYLO Wasm index scanner rejected the query')
            if (required > this.outputCapacity) {
                this.ensureOutput(required)
                required = this.scanQueriesExport(
                    inputPointer,
                    input.byteLength,
                    this.outputPointer,
                    this.outputCapacity
                )
            }
            if (required === WASM_ERROR || required > this.outputCapacity) {
                throw new Error('FYLO Wasm index scan failed after resizing its output buffer')
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
        if (this.outputPointer) this.deallocate(this.outputPointer, this.outputCapacity)
        this.outputCapacity = capacity
        this.outputPointer = this.allocate(capacity)
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
