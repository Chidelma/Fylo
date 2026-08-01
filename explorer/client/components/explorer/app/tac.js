// FYLO Explorer — browses a real FYLO root through the File System Access
// API. The engine bundle (/shared/assets/fylo-web.mjs) runs against an
// FsaFilesystem wrapped in a copy-on-write overlay, so index rebuilds land in
// RAM and the picked folder is never written to. Write mode is opt-in: it
// re-arms the handle as readwrite and drops the overlay, so every mutation
// goes through the engine into the real root (documents, indexes, journals).

import { valueType, fieldValue, defaultRegex, parseField } from './field-model.js'
import { rawInfo, canDecodeImage, canPlayMedia } from './raw-preview.js'
import { readVersions, vcsObjectPath, readWriteActivity } from './versioning.js'
import { fileIconSvg, folderIconSvg } from './file-icons.js'
import { highlightToHtml } from './highlight.js'
import { normalizeShardLayout, shardCandidates, shardOf } from './sharding.js'

export { historicalShardCandidates, legacyShardOf, shardCandidates, shardOf } from './sharding.js'

const DOC_LIST_CAP = 500 // ponytail: flat cap; add paging when a root outgrows it
const FILE_SEARCH_CAP = 500
export const EXPLORER_LIMITS = Object.freeze({
    rawPreviewBytes: 32 * 1024 * 1024,
    importBytes: 16 * 1024 * 1024,
    importRecords: 10_000,
    exportBytes: 64 * 1024 * 1024,
    exportRecords: 10_000,
    uploadBytes: 64 * 1024 * 1024
})

const BUILD_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/

/** @param {unknown} value @returns {string} */
export function validatedBuildToken(value) {
    if (value === undefined || value === null || value === '') return ''
    const token = String(value)
    if (!BUILD_TOKEN.test(token)) throw new Error('Invalid FYLO Explorer build token')
    return token
}

/** @param {unknown} build @param {string} [origin] @returns {string} */
export function engineAssetUrl(
    build,
    origin = globalThis.location?.origin ?? 'https://fylo.invalid'
) {
    const base = new URL(origin)
    if (!/^https?:$/.test(base.protocol)) throw new Error('Invalid FYLO Explorer asset origin')
    const asset = new URL('/shared/assets/fylo-web.mjs', base)
    if (asset.origin !== base.origin || asset.pathname !== '/shared/assets/fylo-web.mjs') {
        throw new Error('Invalid FYLO Explorer asset URL')
    }
    const token = validatedBuildToken(build)
    if (token) asset.searchParams.set('v', token)
    return asset.href
}

function limitError(operation, actual, maximum) {
    return `${operation} is limited to ${formatBytes(maximum)}; selected input is ${formatBytes(actual)}. Use the FYLO CLI for larger data.`
}

function formatBytes(bytes) {
    const mib = bytes / (1024 * 1024)
    return `${Number.isInteger(mib) ? mib : mib.toFixed(1)} MiB`
}

function safeRecord() {
    return Object.create(null)
}

/** Missing entries use POSIX codes in memory and DOMException names in browser storage. */
function isMissingFilesystemEntry(error) {
    const filesystemError = /** @type {{ code?: unknown, name?: unknown }} */ (error)
    return filesystemError?.code === 'ENOENT' || filesystemError?.name === 'NotFoundError'
}

function copySafeJson(value) {
    if (Array.isArray(value)) return value.map(copySafeJson)
    if (typeof value !== 'object' || value === null) return value
    const target = safeRecord()
    for (const [key, nested] of Object.entries(value)) target[key] = copySafeJson(nested)
    return target
}

// Each resizable pane boundary → the pane it sizes and the grid var that drives
// both the track width and its grip's left offset. `list` (the doc-list in the
// collections view) and `editor` (the SQL console) share the Documents section
// but keep distinct vars so their widths persist independently.
// In the document view the Document pane is the flexible filler, so the aux
// panes to its right (schema/metadata/versions) are sized/positioned from the
// RIGHT edge — dragging their left grip resizes them while the filler absorbs.
const PANE_RESIZE = {
    sidebar: { selector: 'nav.explorer-pane', cssVar: '--ex-sidebar-w' },
    list: { selector: 'section[aria-label="Documents"]', cssVar: '--ex-list-w' },
    editor: { selector: 'section[aria-label="Documents"]', cssVar: '--ex-editor-w' },
    schema: { selector: 'section[aria-label="Schema"]', cssVar: '--ex-schema-w', fromRight: true },
    metadata: {
        selector: 'section[aria-label="Metadata"]',
        cssVar: '--ex-metadata-w',
        fromRight: true
    },
    versions: {
        selector: 'section[aria-label="Versions"]',
        cssVar: '--ex-versions-w',
        fromRight: true
    }
}

// Aux columns collapse to a thin vertical-label strip.
const COLLAPSED_W = '2.4rem'

const PANE_DEFAULT_WIDTH = {
    sidebar: 200,
    list: 220,
    editor: 360,
    schema: 240,
    metadata: 200,
    versions: 220
}

/**
 * Calculate a separator's next value without coupling keyboard behavior to the
 * DOM. Arrow keys move by 10 px (50 with Shift); Home/End jump to the bounds.
 * @param {number} current
 * @param {string} key
 * @param {boolean} [shiftKey]
 * @param {number} [min]
 * @param {number} [max]
 * @returns {number | null}
 */
export function resizeValueForKey(current, key, shiftKey = false, min = 120, max = 1200) {
    if (key === 'Home') return min
    if (key === 'End') return max
    const step = shiftKey ? 50 : 10
    if (key === 'ArrowLeft' || key === 'ArrowDown') return Math.max(min, current - step)
    if (key === 'ArrowRight' || key === 'ArrowUp') return Math.min(max, current + step)
    return null
}

/** Keep a fixed popup inside the visible viewport with a small edge margin. */
export function clampPopupPosition(
    x,
    y,
    popupWidth,
    popupHeight,
    viewportWidth,
    viewportHeight,
    margin = 8
) {
    return {
        x: Math.max(margin, Math.min(x, viewportWidth - popupWidth - margin)),
        y: Math.max(margin, Math.min(y, viewportHeight - popupHeight - margin))
    }
}

/** Roving-focus target for the required menu navigation keys. */
export function menuIndexForKey(current, length, key) {
    if (length < 1) return null
    if (key === 'ArrowDown') return (current + 1) % length
    if (key === 'ArrowUp') return (current - 1 + length) % length
    if (key === 'Home') return 0
    if (key === 'End') return length - 1
    return null
}

/**
 * Find raw files by basename only, keeping their object-key path so a result
 * can reopen the appropriate Miller-column folder. Limiting rendered results
 * protects the Explorer from a very broad search over a large bucket.
 * @param {Iterable<[string, string]>} entries
 * @param {string} query
 * @param {number} [limit]
 * @returns {{ matches: { id: string, key: string, name: string, path: string }[], total: number }}
 */
export function findFileNameMatches(entries, query, limit = FILE_SEARCH_CAP) {
    const needle = String(query).trim().toLowerCase()
    if (!needle) return { matches: [], total: 0 }
    const matches = []
    let total = 0
    for (const [id, rawKey] of entries) {
        const key = String(rawKey)
        const slash = key.lastIndexOf('/')
        const name = key.slice(slash + 1)
        if (!name.toLowerCase().includes(needle)) continue
        total++
        if (matches.length < limit) {
            matches.push({ id, key, name, path: slash < 0 ? '/' : key.slice(0, slash + 1) })
        }
    }
    matches.sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key))
    return { matches, total }
}

// Cached code-editor text metrics (monospace advance, line height, padding).
// Module-scoped, not an instance field: the diagnostics tooltip is positioned
// from a pointer handler, and assigning `this.X` there triggers a synchronous
// Tac morph that would detach the element we're mid-updating.
let CODE_METRICS = null

// highlight.js langs treated as "code" for identifier diagnostics — markup,
// data and prose are excluded (flagging identifiers there is just noise).
const CODE_LANGS = new Set([
    'javascript',
    'typescript',
    'python',
    'ruby',
    'go',
    'rust',
    'java',
    'c',
    'cpp',
    'bash'
])

// True when `a` and `b` differ by exactly one edit (substitution / insertion /
// deletion) whose changed character is not a digit (so enumerated names like
// data1/data2 aren't treated as typos of each other).
function nearMiss(a, b) {
    if (a === b) return false
    const la = a.length
    const lb = b.length
    if (Math.abs(la - lb) > 1) return false
    if (la === lb) {
        let at = -1
        for (let i = 0; i < la; i++) {
            if (a[i] === b[i]) continue
            if (at >= 0) return false
            at = i
        }
        return at >= 0 && !/\d/.test(a[at]) && !/\d/.test(b[at])
    }
    const short = la < lb ? a : b
    const long = la < lb ? b : a
    let i = 0
    let j = 0
    let extra = -1
    while (i < short.length && j < long.length) {
        if (short[i] === long[j]) {
            i++
            j++
        } else {
            if (extra >= 0) return false
            extra = j
            j++
        }
    }
    if (extra < 0) extra = long.length - 1 // the unmatched char is the trailing one
    return !/\d/.test(long[extra])
}

// Heuristic identifier diagnostics (no semantics — buffer text only): an
// identifier used exactly once that is a near-miss of a more-frequently used
// identifier is flagged as a probable typo. Reuses the autocomplete vocabulary.
function codeDiagnostics(text) {
    const re = /[A-Za-z_$][A-Za-z0-9_$]*/g
    /** @type {Map<string, number>} */
    const freq = new Map()
    /** @type {{ word: string, index: number }[]} */
    const occ = []
    let match
    while ((match = re.exec(text))) {
        occ.push({ word: match[0], index: match.index })
        freq.set(match[0], (freq.get(match[0]) ?? 0) + 1)
    }
    const vocab = [...freq.keys()]
    const diags = []
    for (const { word, index } of occ) {
        if (word.length < 4 || freq.get(word) !== 1) continue
        let best = ''
        let bestFreq = 1
        for (const other of vocab) {
            const f = freq.get(other) ?? 0
            if (f < 2 || f <= bestFreq || !nearMiss(word, other)) continue
            best = other
            bestFreq = f
        }
        if (!best) continue
        const before = text.slice(0, index)
        const line = before.length - before.replaceAll('\n', '').length
        const col = index - (before.lastIndexOf('\n') + 1)
        diags.push({
            line,
            col,
            len: word.length,
            message: `“${word}” looks like a typo — did you mean “${best}”?`
        })
        if (diags.length >= 50) break
    }
    return diags
}

// SQL keywords offered by the console's autocomplete (single tokens, so a
// prefix match works against the word under the caret).
const SQL_KEYWORDS = [
    'SELECT',
    'FROM',
    'WHERE',
    'AND',
    'OR',
    'NOT',
    'NULL',
    'ORDER',
    'BY',
    'GROUP',
    'HAVING',
    'LIMIT',
    'OFFSET',
    'INSERT',
    'INTO',
    'VALUES',
    'UPDATE',
    'SET',
    'DELETE',
    'CREATE',
    'TABLE',
    'DROP',
    'LIKE',
    'IN',
    'IS',
    'AS',
    'JOIN',
    'LEFT',
    'RIGHT',
    'INNER',
    'OUTER',
    'ON',
    'COUNT',
    'SUM',
    'AVG',
    'MIN',
    'MAX',
    'DISTINCT',
    'ASC',
    'DESC',
    'BETWEEN'
]

const FILTER_KEYWORDS = ['AND', 'OR', 'LIKE', 'TRUE', 'FALSE', 'NULL']

// Feature detection decides support; this is only a human-friendly label for
// the unsupported-browser guidance shown to the user.
export function browserLabel(userAgent = '') {
    const ua = String(userAgent)
    if (/FxiOS/i.test(ua)) return 'Firefox on iOS'
    if (/Firefox/i.test(ua)) return 'Firefox'
    if (/EdgiOS|EdgA/i.test(ua)) return 'Microsoft Edge on mobile'
    if (/Edg\//i.test(ua)) return 'Microsoft Edge'
    if (/CriOS/i.test(ua)) return 'Chrome on iOS'
    if (/Chrome|Chromium/i.test(ua)) return 'Chrome'
    if (/Safari/i.test(ua)) return 'Safari'
    return 'This browser'
}

export default class {
    /** @type {'boot' | 'unsupported' | 'pick' | 'open'} */
    status = 'boot'
    /** Browser name shown only when File System Access is unavailable. */
    unsupportedBrowser = 'This browser'

    /** @type {{ name: string, handle: any }[]} */
    roots = []

    rootName = ''
    /** @type {string[]} document collections (.collections) */
    collections = []
    /** @type {string[]} buckets — raw files, Blob/File (.buckets) */
    buckets = []
    /** @type {string} */
    active = ''
    /** @type {string[]} */
    docIds = []
    /** @type {string[] | null} ids matching the active filter */
    filtered = null
    filter = ''
    /** @type {{ text: string, kind: string }[]} autocomplete suggestions for the SQL WHERE filter */
    filterSuggest = []
    /** @type {string[]} sampled field paths for the active document collection */
    filterColumns = []
    selectedId = ''
    /** @type {string} pretty-printed JSON of the selected document */
    selectedJson = ''
    /** @type {string} blob URL when the selected entry is raw bytes */
    rawUrl = ''
    rawSize = 0
    /** @type {'' | 'image' | 'video' | 'audio' | 'pdf' | 'frame' | 'text' | 'other'} */
    previewKind = ''
    /** @type {string} decoded contents when the raw file is text */
    rawText = ''
    /** @type {string} the editable buffer for a text file (mirrors the textarea) */
    rawDraft = ''
    /** @type {boolean} the text preview was cut at the inline cap (edit disabled) */
    rawTruncated = false
    /** @type {string} syntax-highlighted HTML of the text (highlight.js) */
    rawHtml = ''
    /** @type {{ text: string }[]} identifier suggestions from the file's own text */
    rawSuggest = []
    /** Pixel offset of the code-editor suggestion dropdown, under the caret. */
    rawSuggestPos = { left: 8, top: 8 }
    /** @type {{ line: number, col: number, len: number, message: string }[]} code diagnostics */
    rawDiags = []
    /** @type {string} the stored filename (with extension) of the raw file */
    rawName = ''
    /** @type {{ key: string, id: string, mime: string, size: string, modified: string } | null} */
    rawMeta = null
    error = ''
    writable = false
    lockWarning = false
    /** @type {'' | 'new' | 'edit'} */
    editing = ''
    draft = ''
    /**
     * In-place edit model: one entry per top-level field. `value` is a string
     * for the input; object/array values are held as compact JSON. Drives both
     * the Document pane (editable values) and the Schema pane (editable types).
     * @type {{ key: string, type: string, value: string, regex: string }[]}
     */
    editFields = []
    /** @type {Record<string, string>} per-collection regex schema (field → pattern) */
    schema = safeRecord()
    /** @type {string} document id awaiting delete confirmation ('' = no dialog) */
    confirmId = ''
    /**
     * Committed versions of the selected document/file, newest first — one per
     * distinct content hash walking the branch history.
     * @type {{ commit: string, hash: string, message: string, at: string }[]}
     */
    versions = []
    /** @type {{ commit: string, hash: string, message: string, at: string } | null} version pending restore */
    restoreVer = null
    /** @type {{ id: string, collection: string, fields: number, version: string, size: string, modified: string } | null} */
    docMeta = null
    showDeleted = false
    /** @type {string[]} */
    deletedIds = []
    /** @type {'docs' | 'sql' | 'overview' | 'export'} */
    view = 'docs'
    /**
     * Last page within the current root, persisted to localStorage (Tac `$$`)
     * so a reload restores where you were instead of resetting to the picker.
     * @type {{ rootName: string, view: string, active: string, folderPath: string } | null}
     */
    $$route = null
    /** @type {{ name: string, kind: string, count: number }[]} */
    overviewRows = []
    overviewTotals = { collections: 0, buckets: 0, items: 0, commits: 0 }
    /** Aggregate write-activity timeline for the Overview graph. */
    overviewChart = { series: [], from: 0, to: 0, buckets: 24 }
    /** Whether an export/import job is running (disables the tool's buttons). */
    toolBusy = false
    /** Result banner for the export/import tool. */
    toolMessage = ''
    /** @type {Record<string, string>} collection → 'document' | 'file' */
    kinds = safeRecord()
    folderPath = '/'
    /** Current case-insensitive filename search within the active bucket. */
    fileSearch = ''
    /** @type {{ id: string, key: string, name: string, path: string }[]} rendered filename matches */
    fileMatches = []
    /** Full match count; `fileMatches` is capped to keep broad searches responsive. */
    fileMatchTotal = 0
    /**
     * Finder-style Miller columns: one entry per folder level, left to right.
     * @type {{ index: number, path: string, selected: string, folders: string[], files: { name: string, id: string, key: string }[] }[]}
     */
    columns = []
    /** @type {Record<string, number>} drag-set Miller-column widths, keyed by column */
    colw = {}
    /** @type {Record<string, number>} drag-set pane widths (collections/SQL views) */
    panew = {}
    /**
     * Collapsed aux columns — collapsed by default so the document/file stays
     * the focus; click a strip to expand it.
     * @type {Record<string, boolean>}
     */
    collapsed = { schema: true, metadata: true, versions: true, meta: true, fversions: true }
    sqlText = ''
    /** @type {{ text: string, kind: string }[]} autocomplete suggestions for the SQL editor */
    sqlSuggest = []
    /** Pixel offset of the suggestion dropdown, anchored under the caret. */
    sqlSuggestPos = { left: 8, top: 8 }
    /** @type {string} syntax-highlighted HTML of the SQL editor's contents */
    sqlHtml = ''
    sqlResult = ''
    /** True when a SQL query completed successfully but returned zero rows. */
    sqlEmpty = false
    /** @type {Record<string, any> | null} rows of a row-shaped SQL result */
    sqlData = null
    /** @type {string[]} TTIDs of the current SQL result */
    sqlRows = []
    /** @type {number} in-flight async operations (drives the progress bar) */
    busy = 0

    /** @type {Record<string, 'added' | 'updated' | 'deleted'>} transient row flashes */
    flashes = safeRecord()

    // --- Filebrowser-style file/folder ops (rename / copy / move) ---
    /** @type {{ x: number, y: number, target: any } | null} right-click menu */
    rowMenu = null
    /** @type {{ target: any, value: string } | null} rename dialog */
    renameFor = null
    /** @type {{ mode: 'copy' | 'move', target: any, dest: string } | null} copy/move picker */
    picker = null
    /** @type {any} delete-confirm target ('' = no dialog) */
    deleteFor = null
    /** @type {HTMLElement | null} row that opened the current menu/dialog */
    _actionOpener = null
    /** Stable row identity used if Tachyon replaces the opener while a dialog is open. */
    _actionOpenerKey = ''
    /** @type {MutationObserver | null} keeps dialog background inert after rerenders */
    _dialogObserver = null
    /** Firestore-style change flash: mark a row, clear after the animation. */
    flash(id, type) {
        this.flashes = { ...this.flashes, [id]: type }
        setTimeout(() => {
            // only clear our own flash — a newer one on the same row wins
            if (this.flashes[id] !== type) return
            const { [id]: _gone, ...rest } = this.flashes
            this.flashes = rest
        }, 1400)
    }

    rowClass(id) {
        let cls = 'explorer-row'
        if (this.selectedId === id) cls += ' is-selected'
        if (this.flashes[id]) cls += ` flash-${this.flashes[id]}`
        return cls
    }

    // --- Firestore-style path bar ---

    crumbs() {
        /** @type {{ label: string, kind: string, path?: string }[]} */
        const list = [{ label: this.rootName, kind: 'root' }]
        if (this.view === 'sql') {
            list.push({ label: 'sql', kind: this.selectedId ? 'collection' : 'leaf' })
            if (this.selectedId) list.push({ label: this.selectedId, kind: 'leaf' })
            return list
        }
        if (this.view === 'overview' || this.view === 'export') {
            list.push({ label: this.view, kind: 'leaf' })
            return list
        }
        if (this.active) list.push({ label: this.active, kind: 'collection' })
        if (this.active && this.isFileCollection()) {
            let acc = '/'
            for (const segment of this.folderPath.split('/').filter(Boolean)) {
                acc += `${segment}/`
                list.push({ label: segment, kind: 'folder', path: acc })
            }
        }
        if (this.selectedId) list.push({ label: this.selectedId, kind: 'leaf' })
        return list
    }

    crumbGo(crumb) {
        if (crumb.kind === 'root') {
            this.closeTool()
            this.backToCollections()
        } else if (crumb.kind === 'collection') {
            this.backToDocs()
            if (this.isFileCollection()) this.openFolder('/')
        } else if (crumb.kind === 'folder') {
            this.backToDocs()
            this.openFolder(crumb.path)
        }
    }

    // The document pane only exists once there's something to show in it.
    // Buckets show a selected file's preview as the next Miller column instead
    // (Finder-style), so they never open the far-right document pane.
    hasDoc() {
        if (this.view === 'sql') return !!this.selectedId || !!this.sqlResult || this.sqlEmpty
        if (this.isFileCollection()) return false
        return !!this.selectedId || !!this.editing
    }

    // Which pane the single-column (mobile) layout shows via `m-*`; desktop shows
    // all. `has-columns` widens the middle pane for the Miller-column strip;
    // `show-doc` adds the detail panes only once there's content.
    paneClass() {
        const columns =
            this.view === 'docs' && this.active && this.isFileCollection() ? ' has-columns' : ''
        const doc = this.hasDoc() ? ' show-doc' : ''
        if (this.view === 'overview' || this.view === 'export') return 'm-tool v-tool'
        if (this.view === 'sql') {
            const rows = this.sqlRows.length > 0 ? ' has-rows' : ''
            return `m-sql v-sql${rows}${doc}`
        }
        // Document collection (not a bucket): cap the TTID-list column at ~1/3.
        const docs = this.active && !this.isFileCollection() ? ' v-docs' : ''
        // Mobile single-pane state. A file's preview lives in the Documents
        // Miller strip, so a selected file keeps `m-docs`; only documents open
        // the stacked detail pane (`m-doc`).
        const mobile = !this.active
            ? 'm-collections'
            : this.isFileCollection()
              ? 'm-docs'
              : this.editing || this.selectedId
                ? 'm-doc'
                : 'm-docs'
        return `${mobile}${columns}${doc}${docs}`
    }

    backToCollections() {
        this.active = ''
        this.selectedId = ''
        this.editing = ''
        this.releaseRaw()
        this.saveRoute()
    }

    backToDocs() {
        this.selectedId = ''
        this.editing = ''
        this.releaseRaw()
        this.saveRoute()
    }

    dismissError() {
        this.error = ''
    }

    /**
     * Run one UI operation with the busy indicator on.
     * @template T @param {() => Promise<T>} body @returns {Promise<T | undefined>}
     */
    async track(body) {
        this.busy++
        try {
            return await body()
        } finally {
            this.busy--
        }
    }

    async lib() {
        // A constrained same-origin URL works under strict CSP without eval or
        // Function-constructor indirection. The build token only reaches a
        // query parameter after an allowlist check.
        const asset = engineAssetUrl(globalThis.__FYLO_BUILD)
        this._lib ??= await import(asset)
        return this._lib
    }

    @onMount
    async boot() {
        // Child components report actions through the pub/sub hub instead of
        // threading callbacks down as props (see <explorer-versions> / -confirm).
        this.tac.subscribe('explorer:restore', (v) => this.askRestore(v))
        this.tac.subscribe('explorer:confirm', (action) => {
            if (action === 'delete') this.confirmDelete()
            else if (action === 'restore') this.confirmRestore()
        })
        this.tac.subscribe('explorer:cancel', (action) => {
            if (action === 'delete') this.cancelDelete()
            else if (action === 'restore') this.cancelRestore()
        })
        this.tac.subscribe('explorer:export', (name) => this.doExport(name))
        this.tac.subscribe('explorer:import', (payload) => this.doImport(payload))
        if (typeof globalThis.showDirectoryPicker !== 'function') {
            this.unsupportedBrowser = browserLabel(globalThis.navigator?.userAgent)
            this.status = 'unsupported'
            return
        }
        const { listRecentRoots } = await this.lib()
        const handles = await listRecentRoots()
        this.roots = handles.map((handle) => ({ name: handle.name, handle }))
        this.status = 'pick'
        await this.restoreLastSession(handles)
    }

    // Restore the last session: if the root we were on is still a granted recent
    // handle, reconnect silently and jump back to the same page. (A root whose
    // permission has lapsed can't be re-armed without a user gesture, so we leave
    // it on the picker — one click reopens it.)
    async restoreLastSession(handles) {
        const wanted = this.$$route?.rootName
        if (!wanted) return
        const last = handles.find((h) => h.name === wanted)
        if (!last || !(await this.canAutoConnect(last))) return
        try {
            await this.connect(last)
            await this.applyRoute()
        } catch {
            this.status = 'pick'
        }
    }

    // True only when a stored handle is usable WITHOUT prompting (OPFS handles,
    // or a File System Access grant that is still 'granted'). Never requests —
    // that needs a user gesture the page-load moment doesn't have.
    async canAutoConnect(handle) {
        const q = /** @type {{ queryPermission?: Function }} */ (/** @type {unknown} */ (handle))
        if (typeof q.queryPermission !== 'function') return true
        try {
            return (await q.queryPermission.call(handle, { mode: 'read' })) === 'granted'
        } catch {
            return false
        }
    }

    // Snapshot the current page into the persisted route (localStorage via `$$`).
    saveRoute() {
        if (this.status !== 'open') return
        this.$$route = {
            rootName: this.rootName,
            view: this.view,
            active: this.active,
            folderPath: this.folderPath
        }
    }

    // Re-navigate to the persisted page after a fresh connect. Only the current
    // root's route applies; a stale collection/folder is ignored gracefully.
    async applyRoute() {
        const route = this.$$route
        if (!route || route.rootName !== this.rootName) return
        if (route.view === 'overview') return await this.openOverview()
        if (route.view === 'export') return this.openExport()
        if (route.view === 'sql') return this.openSql()
        if (route.active && this.kinds[route.active]) {
            await this.pick(route.active)
            if (this.isFileCollection() && route.folderPath && route.folderPath !== '/') {
                this.openFolder(route.folderPath)
            }
        }
    }

    // A FYLO root is identified by at least one of its reserved directories.
    // We probe the handle directly so "missing" is distinct from "empty".
    async looksLikeFyloRoot(handle) {
        for (const marker of ['.collections', '.buckets', '.fylo-catalog', '.fylo-vcs']) {
            try {
                await handle.getDirectoryHandle(marker)
                return true
            } catch {
                // NotFoundError — keep probing the remaining markers.
            }
        }
        return false
    }

    async openPicker() {
        try {
            const { pickFyloRoot, forgetRecentRoot } = await this.lib()
            const handle = await pickFyloRoot()
            if (!(await this.looksLikeFyloRoot(handle))) {
                this.error = `“${handle.name}” isn’t a FYLO folder — pick the folder that contains .collections/ or .buckets/.`
                await forgetRecentRoot(handle.name).catch(() => {})
                return
            }
            await this.connect(handle)
            this.saveRoute()
        } catch (err) {
            if (err?.name !== 'AbortError') this.error = String(err?.message ?? err)
        }
    }

    async reopen(recent) {
        try {
            const { ensureRootPermission } = await this.lib()
            if (!(await ensureRootPermission(recent.handle))) {
                this.error = `Access to "${recent.name}" was not granted`
                return
            }
            if (!(await this.looksLikeFyloRoot(recent.handle))) {
                this.error = `“${recent.name}” isn’t a FYLO folder anymore — it has no .collections or .buckets.`
                return
            }
            await this.connect(recent.handle)
            await this.applyRoute()
        } catch (err) {
            this.error = String(err?.message ?? err)
        }
    }

    async forget(recent) {
        const { forgetRecentRoot } = await this.lib()
        await forgetRecentRoot(recent.name)
        this.roots = this.roots.filter((root) => root.name !== recent.name)
    }

    async connect(handle, writable = false) {
        const { FsaFilesystem, createOverlayFilesystem, createBrowserClient } = await this.lib()
        await this._db?.close?.()
        this._handle = handle
        const direct = new FsaFilesystem(handle)
        this._fs = writable ? direct : createOverlayFilesystem(direct)
        this._db = createBrowserClient({
            storage: {
                type: 'fsa',
                handle,
                access: writable ? 'readwrite' : 'overlay'
            },
            worker: true,
            wasm: true
        })
        this._rebuilt = new Set()
        await this._db.ready()
        // The on-disk namespace is the kind: .collections holds documents,
        // .buckets holds buckets (raw files, Blob/File). No catalog read needed.
        const clean = (list) => list.filter((name) => !name.startsWith('.')).sort()
        this.collections = clean(await this._fs.list('/.collections').catch(() => []))
        this.buckets = clean(await this._fs.list('/.buckets').catch(() => []))
        this.kinds = safeRecord()
        for (const name of this.collections) this.kinds[name] = 'document'
        for (const name of this.buckets) this.kinds[name] = 'file'
        this.shardLayouts = safeRecord()
        await Promise.all(
            [...this.collections, ...this.buckets].map(async (name) => {
                const descriptor = await this._fs
                    .readText(`/.fylo-catalog/collections/${name}.json`)
                    .then(JSON.parse)
                    .catch(() => ({}))
                this.shardLayouts[name] = normalizeShardLayout(descriptor)
            })
        )
        this.view = 'docs'
        this.rootName = handle.name
        this.writable = writable
        this.lockWarning = writable && (await this.hasLiveLocks())
        this.active = ''
        this.selectedId = ''
        this.editing = ''
        this.showDeleted = false
        this.error = ''
        this.status = 'open'
    }

    // On-disk namespace for a collection: .buckets for buckets (files), else
    // .collections. Every filesystem path in the Explorer routes through this.
    baseDir(collection) {
        return this.kinds[collection] === 'file' ? '.buckets' : '.collections'
    }

    shardLayout(collection) {
        return this.shardLayouts?.[collection] ?? normalizeShardLayout()
    }

    recordShards(collection, id) {
        return shardCandidates(id, this.shardLayout(collection))
    }

    recordDirectory(collection, namespace, shard) {
        const root = `/${this.baseDir(collection)}/${collection}/${namespace}`
        return shard ? `${root}/${shard}` : root
    }

    writeRecordDirectory(collection, namespace, id) {
        return this.recordDirectory(
            collection,
            namespace,
            shardOf(id, this.shardLayout(collection).width)
        )
    }

    async recordPath(collection, namespace, id, suffix) {
        for (const shard of this.recordShards(collection, id)) {
            const path = `${this.recordDirectory(collection, namespace, shard)}/${id}${suffix}`
            if (await this._fs.exists(path)) return path
        }
        return `${this.writeRecordDirectory(collection, namespace, id)}/${id}${suffix}`
    }

    // Advisory only — there is no cross-process locking between a browser tab
    // and a running desktop fylo; this just surfaces likely concurrent use.
    async hasLiveLocks() {
        for (const name of [...(this.collections ?? []), ...(this.buckets ?? [])]) {
            const locks = await this._fs
                .list(`/${this.baseDir(name)}/${name}/locks`)
                .catch(() => [])
            if (locks.length > 0) return true
        }
        return false
    }

    async enableWrites() {
        return await this.track(async () => {
            try {
                const { ensureRootPermission, FsaFilesystem, createBrowserClient } =
                    await this.lib()
                if (!(await ensureRootPermission(this._handle, { mode: 'readwrite' }))) {
                    this.error = 'Write access was not granted'
                    return
                }
                // Swap the read-only copy-on-write overlay for the real filesystem
                // and rebuild the client, but keep the page exactly as it is: the
                // open document/file editor just becomes editable. Only the write
                // plumbing changes — no navigation/selection state is touched
                // (unlike connect(), which resets the whole view).
                await this._db?.close?.()
                this._fs = new FsaFilesystem(this._handle)
                this._db = createBrowserClient({
                    storage: {
                        type: 'fsa',
                        handle: this._handle,
                        access: 'readwrite'
                    },
                    worker: true,
                    wasm: true
                })
                this._rebuilt = new Set()
                await this._db.ready()
                this.writable = true
                this.lockWarning = await this.hasLiveLocks()
                this.error = ''
            } catch (err) {
                this.error = String(err?.message ?? err)
            }
        })
    }

    async pick(name) {
        return await this.track(async () => {
            this.active = name
            this.view = 'docs'
            this.filter = ''
            this.filterSuggest = []
            this.filterColumns = []
            this.filtered = null
            this.clearFileSearch()
            this.selectedId = ''
            this.selectedJson = ''
            this.editing = ''
            this.showDeleted = false
            this.releaseRaw()
            this.docIds = await this.listDocIds(name)
            if (!this.isFileCollection()) void this.collectFilterColumns()
            if (this.isFileCollection()) {
                await this.loadKeyMap(name)
                this.openFolder('/')
            } else {
                this.schema = safeRecord()
                await this.loadSchema(name)
            }
            this.saveRoute()
        })
    }

    isFileCollection() {
        return this.kinds[this.active] === 'file'
    }

    // VS Code–style bucket icons (rendered via `{!...}` — raw SVG markup).
    fileIcon(name) {
        return fileIconSvg(name)
    }

    folderIcon() {
        return folderIconSvg()
    }

    // --- File collections: folder tree from the key index ---
    // Object keys live in xattrs (unreadable from a browser) but are mirrored
    // into the plain-text prefix index as `key/eq/<encoded>/<id>` entries in
    // keys.snapshot/keys.wal — readable with nothing but file access.

    async loadKeyMap(collection) {
        const indexRoot = `/${this.baseDir(collection)}/${collection}/index`
        /** @type {Set<string>} */
        const entries = new Set()
        const snapshot = await this._fs.readText(`${indexRoot}/keys.snapshot`).catch(() => '')
        for (const line of snapshot.split('\n')) if (line) entries.add(line)
        const wal = await this._fs.readText(`${indexRoot}/keys.wal`).catch(() => '')
        for (const line of wal.split('\n')) {
            if (!line) continue
            const op = line[0]
            const entry = line.slice(2) // '+\t' / '-\t'
            if (op === '+') entries.add(entry)
            else if (op === '-') entries.delete(entry)
        }
        /** @type {Map<string, string>} id → object key */
        this._keyMap = new Map()
        for (const entry of entries) {
            if (!entry.startsWith('key/eq/')) continue
            const segments = entry.split('/')
            if (segments.length !== 4) continue
            // values are segment-encoded twice: once as a value, once for the path
            this._keyMap.set(segments[3], decodeURIComponent(decodeURIComponent(segments[2])))
        }
        this.refreshFileSearch()
    }

    refreshFileSearch() {
        const result = findFileNameMatches(this._keyMap ?? [], this.fileSearch)
        this.fileMatches = result.matches
        this.fileMatchTotal = result.total
    }

    fileSearchCountLabel() {
        const shown = this.fileMatches.length
        const capped = this.fileMatchTotal > shown ? '+' : ''
        return `${shown}${capped} ${this.fileMatchTotal === 1 ? 'match' : 'matches'}`
    }

    fileSearchInput(event) {
        this.fileSearch = event.target.value
        this.refreshFileSearch()
    }

    fileSearchKey(event) {
        if (event.key !== 'Escape' || !this.fileSearch) return
        event.preventDefault()
        this.clearFileSearch()
    }

    clearFileSearch() {
        this.fileSearch = ''
        this.fileMatches = []
        this.fileMatchTotal = 0
    }

    openFileSearchMatch(file) {
        this.clearFileSearch()
        this.openFolder(file.path)
        const column = this.columns[this.columns.length - 1]
        if (column) this.pickFile(column, file)
    }

    /** One folder level's entries, straight from the key map. */
    levelEntries(path) {
        /** @type {Set<string>} */
        const folders = new Set()
        /** @type {{ name: string, id: string, key: string }[]} */
        const files = []
        for (const [id, key] of this._keyMap ?? []) {
            if (!key.startsWith(path)) continue
            const rest = key.slice(path.length)
            const slash = rest.indexOf('/')
            if (slash === -1) files.push({ name: rest, id, key })
            else folders.add(rest.slice(0, slash))
        }
        return {
            folders: [...folders].sort(),
            files: files.sort((a, b) => a.name.localeCompare(b.name))
        }
    }

    /** Rebuild the Miller columns so the rightmost column shows `path`. */
    openFolder(path) {
        this.folderPath = path
        this.selectedId = ''
        this.selectedJson = ''
        this.releaseRaw()
        const segments = path.split('/').filter(Boolean)
        /** @type {typeof this.columns} */
        const columns = []
        let acc = '/'
        for (let index = 0; index <= segments.length; index++) {
            columns.push({
                index,
                path: acc,
                selected: segments[index] ?? '',
                ...this.levelEntries(acc)
            })
            if (index < segments.length) acc += `${segments[index]}/`
        }
        this.columns = columns
        this.scrollColumnsEnd()
        this.saveRoute()
    }

    // --- Bucket rename / move / copy ---------------------------------------
    // Buckets index each file with a single `key/eq/<enc>/<id>` entry (see
    // uploadFile / loadKeyMap). These ops maintain that same entry directly on
    // the filesystem: rename/move reassign the key in place (no byte rewrite),
    // copy duplicates the bytes under a fresh id.

    /** Segment encoding used in `key/eq/<enc>/<id>` (double-encoded). */
    encodeKeyEntry(key) {
        return encodeURIComponent(encodeURIComponent(key))
    }

    /** True if any active file already holds `key`. */
    keyTaken(key) {
        for (const existing of this._keyMap?.values() ?? []) if (existing === key) return true
        return false
    }

    /** Physical bytes path + extension for a file id. */
    async fileBytesPath(collection, id) {
        for (const shard of this.recordShards(collection, id)) {
            const base = this.recordDirectory(collection, 'docs', shard)
            let names
            try {
                names = await this._fs.list(base)
            } catch (error) {
                if (isMissingFilesystemEntry(error)) continue
                throw error
            }
            const name = names.find((entry) => entry === id || entry.startsWith(`${id}.`))
            if (name) return { path: `${base}/${name}`, ext: name.slice(id.length) }
        }
        return null
    }

    /** Append lines to keys.wal, then refresh the key map + columns. */
    async commitKeyWal(collection, lines) {
        if (lines.length === 0) return
        await this._fs.appendText(
            `/${this.baseDir(collection)}/${collection}/index/keys.wal`,
            lines.join('')
        )
        await this.loadKeyMap(collection)
        this.openFolder(this.folderPath)
    }

    /** (id, key) pairs a target covers: one file, or every file under a folder. */
    targetEntries(target) {
        if (target.kind === 'file') return [{ id: target.id, key: target.key }]
        /** @type {{ id: string, key: string }[]} */
        const out = []
        for (const [id, key] of this._keyMap ?? []) {
            if (key.startsWith(target.prefix)) out.push({ id, key })
        }
        return out
    }

    /** Reassign every entry's key: `map(oldKey) -> newKey`. Collision-checked. */
    async reassign(entries, map) {
        const moves = entries.map(({ id, key }) => ({ id, oldKey: key, newKey: map(key) }))
        for (const { oldKey, newKey } of moves) {
            if (newKey !== oldKey && this.keyTaken(newKey)) {
                throw new Error(`"${newKey}" already exists`)
            }
        }
        const lines = moves
            .filter((m) => m.newKey !== m.oldKey)
            .map(
                ({ id, oldKey, newKey }) =>
                    `-\tkey/eq/${this.encodeKeyEntry(oldKey)}/${id}\n` +
                    `+\tkey/eq/${this.encodeKeyEntry(newKey)}/${id}\n`
            )
        await this.commitKeyWal(this.active, lines)
    }

    /** Duplicate every entry's bytes under fresh ids: `map(oldKey) -> newKey`. */
    async duplicate(entries, map) {
        const { TTID } = await this.lib()
        const targets = entries.map(({ id, key }) => ({ id, newKey: map(key) }))
        for (const { newKey } of targets) {
            if (this.keyTaken(newKey)) throw new Error(`"${newKey}" already exists`)
        }
        /** @type {string[]} */
        const lines = []
        for (const { id, newKey } of targets) {
            const src = await this.fileBytesPath(this.active, id)
            if (!src) continue
            const newId = TTID.generate()
            const bytes = await this._fs.readBytes(src.path)
            await this._fs.writeBytes(
                `${this.writeRecordDirectory(this.active, 'docs', newId)}/${newId}${src.ext}`,
                bytes
            )
            lines.push(`+\tkey/eq/${this.encodeKeyEntry(newKey)}/${newId}\n`)
        }
        await this.commitKeyWal(this.active, lines)
    }

    // --- UI: context menu + rename dialog + copy/move folder picker ---------

    /** Open the row action menu from pointer or keyboard (writes must be enabled). */
    openRowMenu(event, target, keyboard = false) {
        event.preventDefault()
        event.stopPropagation()
        if (!this.writable) return
        const opener = event.currentTarget
        const rect = opener?.getBoundingClientRect?.() ?? { left: 0, bottom: 0 }
        this._actionOpener = opener ?? null
        this._actionOpenerKey = opener?.getAttribute?.('data-action-key') ?? ''
        this.rowMenu = {
            x: keyboard ? rect.left : Number(event.clientX ?? rect.left),
            y: keyboard ? rect.bottom : Number(event.clientY ?? rect.bottom),
            target
        }
        this.activateMenu()
    }

    menuFile(event, file) {
        this.openRowMenu(event, { kind: 'file', id: file.id, key: file.key, name: file.name })
    }

    menuFolder(event, column, folder) {
        this.openRowMenu(event, {
            kind: 'folder',
            prefix: `${column.path}${folder}/`,
            name: folder
        })
    }

    menuDoc(event, id) {
        this.openRowMenu(event, { kind: 'doc', id })
    }

    rowMenuKey(event, target) {
        if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return
        this.openRowMenu(event, target, true)
    }

    menuFileKey(event, file) {
        this.rowMenuKey(event, { kind: 'file', id: file.id, key: file.key, name: file.name })
    }

    menuFolderKey(event, column, folder) {
        this.rowMenuKey(event, {
            kind: 'folder',
            prefix: `${column.path}${folder}/`,
            name: folder
        })
    }

    menuDocKey(event, id) {
        this.rowMenuKey(event, { kind: 'doc', id })
    }

    activateMenu() {
        queueMicrotask(() => {
            const menu = document.querySelector('.explorer-menu')
            if (!menu || !this.rowMenu) return
            const position = clampPopupPosition(
                this.rowMenu.x,
                this.rowMenu.y,
                menu.getBoundingClientRect().width,
                menu.getBoundingClientRect().height,
                globalThis.innerWidth,
                globalThis.innerHeight
            )
            menu.style.left = `${position.x}px`
            menu.style.top = `${position.y}px`
            menu.querySelector('[role="menuitem"]')?.focus()
        })
    }

    menuKey(event) {
        const items = [...event.currentTarget.querySelectorAll('[role="menuitem"]')]
        if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            this.closeMenus()
            return
        }
        const current = Math.max(0, items.indexOf(document.activeElement))
        const next = menuIndexForKey(current, items.length, event.key)
        if (next === null) return
        event.preventDefault()
        items[next]?.focus()
    }

    /** Actions for the open context menu, by target kind. */
    menuItems() {
        if (this.rowMenu?.target?.kind === 'doc') {
            return [
                { label: 'Edit', action: 'edit' },
                { label: 'Delete…', action: 'delete', danger: true }
            ]
        }
        return [
            { label: 'Rename…', action: 'rename' },
            { label: 'Copy to…', action: 'copy' },
            { label: 'Move to…', action: 'move' },
            { label: 'Delete…', action: 'delete', danger: true }
        ]
    }

    runMenuAction(action) {
        const kind = this.rowMenu?.target?.kind
        if (action === 'edit') this.startDocEdit()
        else if (action === 'rename') this.startRename()
        else if (action === 'copy') this.startPicker('copy')
        else if (action === 'move') this.startPicker('move')
        else if (action === 'delete') kind === 'doc' ? this.startDocDelete() : this.startDelete()
    }

    startDocEdit() {
        const target = this.rowMenu?.target
        this.rowMenu = null
        this._actionOpener = null
        this._actionOpenerKey = ''
        if (target) void this.editDoc(target.id)
    }

    startDocDelete() {
        const target = this.rowMenu?.target
        this.rowMenu = null
        if (target) this.askDelete(target.id)
    }

    renameKey(event) {
        if (event.key === 'Enter') this.confirmRename()
    }

    closeMenus() {
        this.rowMenu = null
        this.restoreActionFocus()
    }

    restoreActionFocus() {
        const opener = this._actionOpener
        const openerKey = this._actionOpenerKey
        this._actionOpener = null
        this._actionOpenerKey = ''
        queueMicrotask(() => {
            const replacement = openerKey
                ? [...(globalThis.document?.querySelectorAll?.('[data-action-key]') ?? [])].find(
                      (candidate) => candidate.getAttribute('data-action-key') === openerKey
                  )
                : null
            const target = opener?.isConnected !== false ? opener : replacement
            target?.focus?.()
        })
    }

    /** Move focus into a dialog and isolate everything behind it. */
    activateDialog(kind) {
        queueMicrotask(() => {
            const root = document.querySelector('.explorer')
            const dialog = document.querySelector(`[data-explorer-dialog="${kind}"]`)
            if (!root || !dialog) return
            ;(dialog.querySelector('[data-autofocus]') ?? dialog).focus()
            const isolate = () => {
                for (const child of root.children) {
                    if (child.classList.contains('explorer-overlay')) continue
                    child.setAttribute('inert', '')
                    child.setAttribute('data-explorer-inerted', '')
                }
            }
            isolate()
            this._dialogObserver?.disconnect()
            this._dialogObserver = new MutationObserver(isolate)
            this._dialogObserver.observe(root, { childList: true, subtree: true })
        })
    }

    deactivateDialog() {
        this._dialogObserver?.disconnect()
        this._dialogObserver = null
        const root = document.querySelector('.explorer')
        for (const child of root?.querySelectorAll('[data-explorer-inerted]') ?? []) {
            child.removeAttribute('inert')
            child.removeAttribute('data-explorer-inerted')
        }
        this.restoreActionFocus()
    }

    dialogKey(event, kind) {
        if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            if (kind === 'rename') this.cancelRename()
            else if (kind === 'picker') this.cancelPicker()
            else this.cancelEntryDelete()
            return
        }
        if (event.key !== 'Tab') return
        const focusable = [
            ...event.currentTarget.querySelectorAll(
                'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
            )
        ]
        if (focusable.length === 0) {
            event.preventDefault()
            event.currentTarget.focus()
            return
        }
        const first = focusable[0]
        const last = focusable.at(-1)
        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault()
            last.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first.focus()
        }
    }

    /** All folder paths (each ending in '/') for the copy/move destination list. */
    folderChoices() {
        const set = new Set(['/'])
        for (const key of this._keyMap?.values() ?? []) {
            const parts = key.split('/').filter(Boolean)
            let acc = '/'
            for (let i = 0; i < parts.length - 1; i++) {
                acc += `${parts[i]}/`
                set.add(acc)
            }
        }
        return [...set].sort()
    }

    startRename() {
        const target = this.rowMenu?.target
        this.rowMenu = null
        if (target) {
            this.renameFor = { target, value: target.name }
            this.activateDialog('rename')
        }
    }

    cancelRename() {
        this.renameFor = null
        this.deactivateDialog()
    }

    renameInput(event) {
        if (this.renameFor) this.renameFor = { ...this.renameFor, value: event.target.value }
    }

    async confirmRename() {
        const dialog = this.renameFor
        if (!dialog) return
        const name = dialog.value.trim()
        this.renameFor = null
        this.deactivateDialog()
        if (!name || name.includes('/')) return
        await this.track(async () => {
            try {
                const target = dialog.target
                if (target.kind === 'file') {
                    const folder = target.key.slice(0, target.key.lastIndexOf('/') + 1)
                    await this.reassign([{ id: target.id, key: target.key }], () => folder + name)
                } else {
                    const parent = target.prefix.slice(
                        0,
                        target.prefix.slice(0, -1).lastIndexOf('/') + 1
                    )
                    const next = `${parent}${name}/`
                    await this.reassign(
                        this.targetEntries(target),
                        (key) => next + key.slice(target.prefix.length)
                    )
                }
            } catch (err) {
                this.error = String(err?.message ?? err)
            }
        })
    }

    startPicker(mode) {
        const target = this.rowMenu?.target
        this.rowMenu = null
        if (target) {
            this.picker = { mode, target, dest: '/' }
            this.activateDialog('picker')
        }
    }

    cancelPicker() {
        this.picker = null
        this.deactivateDialog()
    }

    /** Perform the pending copy/move into `dest`. */
    async pickDest(dest) {
        const dialog = this.picker
        this.picker = null
        this.deactivateDialog()
        if (!dialog) return
        await this.track(async () => {
            try {
                const target = dialog.target
                const entries = this.targetEntries(target)
                // file -> dest/name; folder -> dest/folderName/<suffix>
                const map =
                    target.kind === 'file'
                        ? () => dest + target.name
                        : (key) => `${dest}${target.name}/${key.slice(target.prefix.length)}`
                if (dialog.mode === 'copy') await this.duplicate(entries, map)
                else await this.reassign(entries, map)
            } catch (err) {
                this.error = String(err?.message ?? err)
            }
        })
    }

    startDelete() {
        const target = this.rowMenu?.target
        this.rowMenu = null
        if (target) {
            this.deleteFor = target
            this.activateDialog('delete')
        }
    }

    cancelEntryDelete() {
        this.deleteFor = null
        this.deactivateDialog()
    }

    async runDelete() {
        const target = this.deleteFor
        this.deleteFor = null
        this.deactivateDialog()
        if (!target) return
        await this.track(async () => {
            try {
                await this.deleteEntry(target)
            } catch (err) {
                this.error = String(err?.message ?? err)
            }
        })
    }

    /**
     * Soft-delete a file (or every file under a folder): move the bytes into
     * `.deleted/` (so "Show deleted" can surface them) and drop the key entry.
     */
    async deleteEntry(target) {
        /** @type {string[]} */
        const lines = []
        /** @type {string[]} */
        const failures = []
        for (const { id, key } of this.targetEntries(target)) {
            try {
                const src = await this.fileBytesPath(this.active, id)
                if (src) {
                    const deletedDir = this.writeRecordDirectory(this.active, '.deleted', id)
                    await this._fs.mkdir(deletedDir, { recursive: true })
                    await this._fs.move(src.path, `${deletedDir}/${id}${src.ext}`)
                }
                lines.push(`-\tkey/eq/${this.encodeKeyEntry(key)}/${id}\n`)
            } catch (error) {
                failures.push(`${key}: ${String(error?.message ?? error)}`)
            }
        }
        await this.commitKeyWal(this.active, lines)
        if (this.showDeleted) await this.refreshDeleted()
        if (failures.length) {
            throw new Error(
                `Some files could not be moved to deleted storage: ${failures.join('; ')}`
            )
        }
    }

    // --- Resizable Miller columns ---
    // A drag-set width (px) wins over the CSS flex sizing; an un-dragged preview
    // column keeps its `flex: 1` fill. Widths are keyed by column so they persist
    // across the rerenders that navigating the folder tree triggers.
    colStyle(key) {
        if (this.collapsed[key]) return `flex:0 0 ${COLLAPSED_W};width:${COLLAPSED_W}`
        const w = this.colw[key]
        return w ? `flex:0 0 ${w}px;width:${w}px` : ''
    }

    columnWidth(key) {
        if (this.colw[key]) return this.colw[key]
        if (key === 'preview') return 320
        if (key === 'meta' || key === 'fversions') return 240
        return 200
    }

    startResize(event, key) {
        event.preventDefault()
        const col = event.target.closest('.explorer-col')
        if (!col) return
        const startX = event.clientX
        const startW = col.getBoundingClientRect().width
        let width = startW
        const move = (e) => {
            width = Math.max(120, startW + (e.clientX - startX))
            // paint directly during the drag; committing to state on every move
            // would morph the DOM out from under the pointer
            col.style.flex = `0 0 ${width}px`
            col.style.width = `${width}px`
        }
        const up = () => {
            document.removeEventListener('pointermove', move)
            document.removeEventListener('pointerup', up)
            this.colw = { ...this.colw, [key]: Math.round(width) }
        }
        document.addEventListener('pointermove', move)
        document.addEventListener('pointerup', up)
    }

    resizeColumnKey(event, key) {
        const col = event.target.closest('.explorer-col')
        if (!col) return
        const current = Math.round(col.getBoundingClientRect().width || this.columnWidth(key))
        const width = resizeValueForKey(current, event.key, event.shiftKey)
        if (width === null) return
        event.preventDefault()
        col.style.flex = `0 0 ${width}px`
        col.style.width = `${width}px`
        event.target.setAttribute('aria-valuenow', String(width))
        this.colw = { ...this.colw, [key]: width }
    }

    // --- Resizable panes (collections/document view) ---
    // The sidebar and the TTID-list widths become CSS custom properties on the
    // grid container; the grips are positioned off the same vars so they always
    // sit on the track boundary. Persisted in state so they survive rerenders.
    // Grid track widths as CSS custom properties (the grips are positioned off
    // the same vars). Collapsed aux columns shrink to a thin label strip; the
    // Document pane is the 1fr filler that absorbs resizes so nothing is cut off.
    bodyStyle() {
        const parts = []
        for (const [name, px] of [
            ['--ex-sidebar-w', this.panew.sidebar],
            ['--ex-list-w', this.panew.list],
            ['--ex-editor-w', this.panew.editor]
        ]) {
            if (px) parts.push(`${name}:${px}px`)
        }
        for (const key of ['schema', 'metadata', 'versions']) {
            if (this.collapsed[key]) parts.push(`--ex-${key}-w:${COLLAPSED_W}`)
            else if (this.panew[key]) parts.push(`--ex-${key}-w:${this.panew[key]}px`)
        }
        return parts.join(';')
    }

    paneWidth(key) {
        return this.panew[key] ?? PANE_DEFAULT_WIDTH[key]
    }

    toggleCollapse(key) {
        this.collapsed = { ...this.collapsed, [key]: !this.collapsed[key] }
    }

    startPaneResize(event, key) {
        event.preventDefault()
        const body = event.target.closest('.explorer-body')
        if (!body) return
        const { selector, cssVar, fromRight } = PANE_RESIZE[key]
        const pane = body.querySelector(selector)
        const startX = event.clientX
        const startW = pane.getBoundingClientRect().width
        // The Document pane (v-docs) or the last pane (v-sql) is the 1fr filler
        // that absorbs the change. Cap growth so it never shrinks past the
        // filler's grid `minmax(<min>, 1fr)` min — otherwise the filler stops
        // there and the row overflows / the last column gets cut off.
        const isDocs = body.classList.contains('v-docs')
        const FLEX_MIN = isDocs ? 240 : 320
        const visible = [...body.children].filter(
            (c) =>
                !c.classList.contains('explorer-pane-grip') && c.getBoundingClientRect().width > 0
        )
        const flex = isDocs
            ? body.querySelector('section[aria-label="Document"]')
            : visible[visible.length - 1]
        const maxW =
            flex && flex !== pane
                ? startW + Math.max(0, flex.getBoundingClientRect().width - FLEX_MIN)
                : Infinity
        let width = startW
        const move = (e) => {
            const delta = fromRight ? startX - e.clientX : e.clientX - startX
            width = Math.min(maxW, Math.max(140, startW + delta))
            body.style.setProperty(cssVar, `${width}px`)
        }
        const up = () => {
            document.removeEventListener('pointermove', move)
            document.removeEventListener('pointerup', up)
            this.panew = { ...this.panew, [key]: Math.round(width) }
        }
        document.addEventListener('pointermove', move)
        document.addEventListener('pointerup', up)
    }

    resizePaneKey(event, key) {
        const body = event.target.closest('.explorer-body')
        if (!body) return
        const { selector, cssVar } = PANE_RESIZE[key]
        const pane = body.querySelector(selector)
        if (!pane) return
        const current = Math.round(pane.getBoundingClientRect().width || this.paneWidth(key))
        const width = resizeValueForKey(current, event.key, event.shiftKey, 140, 1200)
        if (width === null) return
        event.preventDefault()
        body.style.setProperty(cssVar, `${width}px`)
        event.target.setAttribute('aria-valuenow', String(width))
        this.panew = { ...this.panew, [key]: width }
    }

    pickFolder(column, folder) {
        this.openFolder(`${column.path}${folder}/`)
    }

    pickFile(column, file) {
        // truncate any deeper columns; mark the file selected in its column
        this.columns = this.columns
            .slice(0, column.index + 1)
            .map((c) => (c.index === column.index ? { ...c, selected: file.name } : c))
        this.folderPath = column.path
        this.select(file.id)
        // reveal the preview column that select() appends after this one
        this.scrollColumnsEnd()
    }

    // Reveal the newest column, Finder-style: scroll only as far as needed so the
    // child column is fully visible while its parent stays in view. On a phone
    // (full-width pager) land on the file's preview if one just opened, not the
    // trailing details/versions page.
    scrollColumnsEnd() {
        if (typeof document === 'undefined') return
        setTimeout(() => {
            const mobile = window.innerWidth <= 760
            const scrollEl =
                (mobile && document.querySelector('.explorer-col--preview')) ||
                document.querySelector('.explorer-col:last-child')
            scrollEl?.scrollIntoView({
                behavior: 'smooth',
                inline: mobile ? 'start' : 'end',
                block: 'nearest'
            })
        }, 80)
    }

    async listDocIds(collection) {
        const docsRoot = `/${this.baseDir(collection)}/${collection}/docs`
        const buckets = await this._fs.list(docsRoot).catch(() => [])
        /** @type {string[]} */
        const ids = []
        for (const bucket of buckets) {
            for (const file of await this._fs.list(`${docsRoot}/${bucket}`).catch(() => [])) {
                // file docs keep their original extension (<ttid>.<ext>)
                ids.push(file.split('.')[0])
                if (ids.length >= DOC_LIST_CAP) return ids.sort()
            }
        }
        return ids.sort()
    }

    visibleIds() {
        return this.filtered ?? this.docIds
    }

    docCountLabel() {
        const shown = this.visibleIds().length
        const capped = this.filtered === null && shown >= DOC_LIST_CAP ? '+' : ''
        return `${shown}${capped} ${this.filtered === null ? 'documents' : 'matches'}`
    }

    filterKey(event) {
        this.filter = event.target.value
        this.updateFilterSuggest(event.target)
        if (event.key === 'Escape' && this.filterSuggest.length) {
            event.preventDefault()
            this.filterSuggest = []
        } else if (event.key === 'Tab' && this.filterSuggest.length) {
            event.preventDefault()
            this.applyFilterSuggest(this.filterSuggest[0].text)
        } else if (event.key === 'Enter') this.applyFilter()
    }

    filterInput(event) {
        this.filter = event.target.value
        this.updateFilterSuggest(event.target)
    }

    async applyFilter() {
        return await this.track(async () => {
            this.error = ''
            this.filterSuggest = []
            const where = this.filter.trim().replace(/^where\s+/i, '')
            if (!where) {
                this.filtered = null
                return
            }
            try {
                // Indexes are accelerators: first query per collection rebuilds the
                // index into the in-memory overlay, leaving the real root untouched.
                if (!this._rebuilt.has(this.active)) {
                    await this._db.collection(this.active).rebuild()
                    this._rebuilt.add(this.active)
                }
                const ids = await this._db._sql(`SELECT _id FROM ${this.active} WHERE ${where}`)
                this.filtered = Array.isArray(ids) ? ids.sort() : Object.keys(ids).sort()
            } catch (err) {
                this.error = String(err?.message ?? err)
            }
        })
    }

    // --- Filter autocomplete (WHERE keywords + active collection fields) ---

    updateFilterSuggest(input) {
        const token = this.currentSqlToken(input.value, input.selectionStart)
        if (token.value.length < 1) {
            this.filterSuggest = []
            return
        }
        const lower = token.value.toLowerCase()
        const seen = new Set()
        const suggestions = []
        for (const [list, kind] of [
            [FILTER_KEYWORDS, 'kw'],
            [this.filterColumns, 'col']
        ]) {
            for (const candidate of list) {
                const normalized = candidate.toLowerCase()
                if (normalized.startsWith(lower) && normalized !== lower && !seen.has(normalized)) {
                    seen.add(normalized)
                    suggestions.push({ text: candidate, kind })
                    if (suggestions.length >= 8) break
                }
            }
            if (suggestions.length >= 8) break
        }
        this.filterSuggest = suggestions
    }

    applyFilterSuggest(word) {
        const input = document.querySelector('.explorer-search-input')
        if (!input) return
        const { start, end } = this.wordSpan(input.value, input.selectionStart, /[A-Za-z0-9_.]/)
        const next = input.value.slice(0, start) + word + input.value.slice(end)
        this.filterSuggest = []
        this.setEditorCaret('.explorer-search-input', input, next, start + word.length, (value) => {
            this.filter = value
        })
    }

    async collectFilterColumns() {
        const collection = this.active
        const keys = new Set()
        try {
            for (const id of this.docIds.slice(0, 5)) {
                const manifest = await this._db.collection(collection).get(id).once()
                const record = manifest?.[id]
                if (record && typeof record === 'object') this.flattenKeys(record, '', 3, keys)
            }
        } catch {
            // Suggestions remain available for SQL keywords when a sample cannot be read.
        }
        if (this.active !== collection) return
        this.filterColumns = [...keys].sort()
        const input =
            typeof document === 'undefined'
                ? null
                : document.querySelector('.explorer-search-input')
        if (input) this.updateFilterSuggest(input)
    }

    async select(id) {
        return await this.track(async () => {
            this.selectedId = id
            this.selectedJson = ''
            this.releaseRaw()
            this.error = ''
            // Buckets store bytes and aren't known to the (document-only) engine
            // — read their raw bytes straight from the filesystem.
            if (this.isFileCollection()) {
                await this.loadRaw(id)
                await this.loadVersions(id)
                return
            }
            try {
                const manifest = await this._db.collection(this.active).get(id).once()
                if (manifest && manifest[id] !== undefined) {
                    this.selectedJson = JSON.stringify(manifest[id], null, 2)
                    this.docMeta = await this.buildDocMeta(id, manifest[id])
                    await this.loadVersions(id)
                    return
                }
                await this.loadRaw(id)
            } catch (_) {
                await this.loadRaw(id)
            }
        })
    }

    // Browser-readable metadata for a document: id, size (compact JSON bytes on
    // disk), field count, schema version (_v), and the file's mtime.
    async buildDocMeta(id, obj) {
        const path = await this.recordPath(this.active, 'docs', id, '.json')
        const modifiedMs = await this._fs.mtimeMs(path).catch(() => 0)
        const bytes = new TextEncoder().encode(JSON.stringify(obj)).byteLength
        const isObject = obj && typeof obj === 'object' && !Array.isArray(obj)
        return {
            id,
            collection: this.active,
            fields: isObject ? Object.keys(obj).filter((k) => k !== '_v').length : 0,
            version: isObject && obj._v != null ? String(obj._v) : '—',
            size: bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${bytes} B`,
            modified: modifiedMs ? new Date(modifiedMs).toLocaleString() : '—'
        }
    }

    // --- Version history (read FYLO's git-like .fylo-vcs store directly) ---

    async loadVersions(id) {
        const filename = this.isFileCollection() ? this.rawName : `${id}.json`
        this.versions = await readVersions(this._fs, {
            collection: this.active,
            id,
            filename,
            shardLayout: this.shardLayout(this.active)
        })
    }

    // Metadata rows for the <explorer-meta> panes (document + file details).
    docMetaEntries() {
        const m = this.docMeta
        if (!m) return []
        return [
            { label: 'TTID', value: m.id },
            { label: 'Collection', value: m.collection },
            { label: 'Fields', value: String(m.fields) },
            { label: 'Version', value: m.version },
            { label: 'Size', value: m.size },
            { label: 'Modified', value: m.modified }
        ]
    }

    rawMetaEntries() {
        const m = this.rawMeta
        if (!m) return []
        return [
            { label: 'Key', value: m.key },
            { label: 'TTID', value: m.id },
            { label: 'Type', value: m.mime },
            { label: 'Size', value: m.size },
            { label: 'Modified', value: m.modified }
        ]
    }

    // The newest entry (head) is the current content; the rest are restorable.
    versionRows() {
        return this.versions.map((v, i) => ({
            ...v,
            current: i === 0,
            at: v.at ? new Date(v.at).toLocaleString() : ''
        }))
    }

    // --- Restore a past version (with confirmation) ---

    askRestore(version) {
        this.restoreVer = version
    }

    cancelRestore() {
        this.restoreVer = null
    }

    // Body suffix for the <explorer-confirm> restore dialog (the prefix + id are
    // separate props).
    restoreBodyPost() {
        const when = this.restoreVer?.at || this.restoreVer?.commit || ''
        return ` will be replaced with the version from ${when}. This overwrites the working copy.`
    }

    confirmRestore() {
        const version = this.restoreVer
        this.restoreVer = null
        if (version) this.restoreVersion(version)
    }

    // Restore the version's committed blob as the current content. Documents go
    // back through the engine (patch → cache + index stay consistent); files are
    // raw bytes written straight to disk. The browser writes no commit, so the
    // history list is unchanged — a later desktop commit records the restore.
    // ponytail: patch merges, so fields added after the restored version remain;
    // a full replace needs engine support.
    async restoreVersion(version) {
        return await this.track(async () => {
            this.error = ''
            const id = this.selectedId
            try {
                const bytes = await this._fs.readBytes(vcsObjectPath(version.hash))
                if (this.isFileCollection()) {
                    await this._fs.writeBytes(this._rawPath, bytes)
                    await this.loadRaw(id)
                    await this.loadVersions(id)
                } else {
                    const obj = JSON.parse(new TextDecoder().decode(bytes))
                    // drop FYLO-internal fields (e.g. _v) before patching
                    const data = Object.fromEntries(
                        Object.entries(obj).filter(([k]) => !k.startsWith('_'))
                    )
                    await this._db.collection(this.active).patch(id, data)
                    await this.select(id) // reloads json, meta, and versions
                }
                this.flash(id, 'updated')
            } catch (err) {
                this.error = String(err?.message ?? err)
            }
        })
    }

    // Raw-file collections store bytes under the doc id with the original
    // extension — locate by listing the bucket, then preview/download.
    async loadRaw(id) {
        const stored = await this.fileBytesPath(this.active, id)
        if (!stored) {
            this.error = `Could not read ${id}`
            return
        }
        try {
            const path = stored.path
            const name = path.slice(path.lastIndexOf('/') + 1)
            const size = await this._fs.size(path)
            if (size > EXPLORER_LIMITS.rawPreviewBytes) {
                throw new Error(limitError('Raw preview', size, EXPLORER_LIMITS.rawPreviewBytes))
            }
            const bytes = await this._fs.readBytes(path)
            const { mime, kind: k0, lang } = rawInfo(name)
            const url = URL.createObjectURL(new Blob([bytes], { type: mime }))
            let kind = k0
            let text = ''
            let truncated = false
            if (kind === 'text') {
                const CAP = 512 * 1024 // don't inline megabytes of text
                truncated = bytes.byteLength > CAP
                text =
                    new TextDecoder().decode(bytes.subarray(0, CAP)) +
                    (truncated ? '\n\n… (truncated — download for the full file)' : '')
            } else if (kind === 'image' && mime !== 'image/svg+xml') {
                // Media `error` events don't bubble, so Tac's delegated on:error
                // never fires — pre-validate the bytes decode; if not, fall back
                // to the download prompt instead of a broken player.
                if (!(await canDecodeImage(url))) kind = 'other'
            } else if (kind === 'video' || kind === 'audio') {
                if (!(await canPlayMedia(url, kind))) kind = 'other'
            }
            // File metadata the browser can actually read (see canDecodeImage note).
            const modifiedMs = await this._fs.mtimeMs(path).catch(() => 0)
            // A different file may have been selected during the async probe.
            if (this.selectedId !== id) {
                URL.revokeObjectURL(url)
                return
            }
            this._rawPath = path
            this._rawMime = mime
            this._rawLang = lang
            this.rawUrl = url
            this.rawSize = bytes.byteLength
            this.rawName = name
            this.rawText = text
            this.rawDraft = text
            this.rawTruncated = truncated
            this.previewKind = kind
            this.highlightRaw() // sets rawHtml from rawDraft (text kinds only)
            this.rawMeta = {
                key: this._keyMap?.get(id) || '—',
                id,
                mime,
                size: this.rawSizeLabel().replace(/[()]/g, ''),
                modified: modifiedMs ? new Date(modifiedMs).toLocaleString() : '—'
            }
        } catch (err) {
            this.error = String(err?.message ?? err)
        }
    }

    rawSizeLabel() {
        const kib = this.rawSize / 1024
        return kib >= 1024 ? `(${(kib / 1024).toFixed(1)} MiB)` : `(${Math.ceil(kib)} KiB)`
    }

    // A media/image element that can't decode the bytes (unsupported codec or a
    // corrupt file) falls back to the plain download prompt instead of showing
    // a broken player.
    previewFailed() {
        this.previewKind = 'other'
    }

    releaseRaw() {
        if (this.rawUrl) URL.revokeObjectURL(this.rawUrl)
        this.rawUrl = ''
        this.rawSize = 0
        this.previewKind = ''
        this.rawText = ''
        this.rawDraft = ''
        this.rawTruncated = false
        this.rawHtml = ''
        this.rawSuggest = []
        this.rawDiags = []
        this.rawName = ''
        this.rawMeta = null
        this.docMeta = null
        this.versions = []
        this._rawPath = ''
        this._rawMime = ''
        this._rawLang = undefined
    }

    // Syntax-highlight the editable text buffer; non-text previews carry no HTML.
    // Diagnostics run only for recognised code languages, not prose/markup/data.
    highlightRaw() {
        const isText = this.previewKind === 'text'
        this.rawHtml = isText ? highlightToHtml(this.rawDraft, this._rawLang) : ''
        this.rawDiags =
            isText && CODE_LANGS.has(this._rawLang) ? codeDiagnostics(this.rawDraft) : []
    }

    rawEditInput(event) {
        this.rawDraft = event.target.value
        this.highlightRaw()
        this.updateRawSuggest(event.target)
    }

    // --- Code editor word completion ---
    // Language-agnostic: suggests identifiers the file itself already contains
    // (like an editor's word-based completion) — no per-language keyword lists.

    // The identifier being typed: the run of identifier characters at the caret.
    currentWord(value, caret) {
        let start = caret
        while (start > 0 && /[A-Za-z0-9_$]/.test(value[start - 1])) start -= 1
        return { start, end: caret, value: value.slice(start, caret) }
    }

    updateRawSuggest(textarea) {
        const token = this.currentWord(textarea.value, textarea.selectionStart)
        this._rawToken = token
        if (token.value.length < 2) {
            this.rawSuggest = []
            return
        }
        const prefix = token.value.toLowerCase()
        const words = new Set()
        const re = /[A-Za-z_$][A-Za-z0-9_$]*/g
        let match
        while ((match = re.exec(textarea.value))) {
            const word = match[0]
            if (word.length >= 2 && word !== token.value && word.toLowerCase().startsWith(prefix)) {
                words.add(word)
            }
        }
        this.rawSuggest = [...words]
            .sort()
            .slice(0, 8)
            .map((text) => ({ text }))
        if (this.rawSuggest.length) this.rawSuggestPos = this.caretXY(textarea, token.start)
    }

    // The full identifier span around `caret` in `value` (backward + forward),
    // per `wordRe`. Recomputed live at apply time so a suggestion always replaces
    // the whole word — trusting a stale stored token merges typo + suggestion.
    wordSpan(value, caret, wordRe) {
        let start = caret
        let end = caret
        while (start > 0 && wordRe.test(value[start - 1])) start -= 1
        while (end < value.length && wordRe.test(value[end])) end += 1
        return { start, end }
    }

    // Commit an editor edit + caret directly on the DOM. Setting `.value` to match
    // the reactive field means Tac's `:value` rerender is a no-op and leaves the
    // caret alone (assigning the field via `after()` after keeps them in sync);
    // the microtask re-asserts the caret in case a rerender still lands.
    setEditorCaret(selector, textarea, value, caret, after) {
        textarea.value = value
        textarea.focus()
        textarea.setSelectionRange(caret, caret)
        after(value)
        queueMicrotask(() => {
            const ta = document.querySelector(selector)
            if (ta) {
                ta.focus()
                ta.setSelectionRange(caret, caret)
            }
        })
    }

    // Replace the identifier under the caret with the chosen word, then refocus.
    applyRawSuggest(word) {
        const ta = document.querySelector('.explorer-fileedit-input')
        if (!ta) return
        const { start, end } = this.wordSpan(ta.value, ta.selectionStart, /[A-Za-z0-9_$]/)
        const next = ta.value.slice(0, start) + word + ta.value.slice(end)
        this.rawSuggest = []
        this.setEditorCaret('.explorer-fileedit-input', ta, next, start + word.length, (v) => {
            this.rawDraft = v
            this.highlightRaw()
        })
    }

    // Gutter contents: one line number per source line of `text`.
    lineNumbers(text) {
        const count = text ? text.split('\n').length : 1
        let out = ''
        for (let i = 1; i <= count; i++) out += `${i}\n`
        return out
    }

    // Tab accepts the top suggestion when the dropdown is open; otherwise it
    // inserts four spaces (indent). Escape dismisses the dropdown.
    rawEditKey(event) {
        if (event.key === 'Escape' && this.rawSuggest.length) {
            event.preventDefault()
            this.rawSuggest = []
            return
        }
        if (event.key !== 'Tab') return
        if (this.rawSuggest.length) {
            event.preventDefault()
            this.applyRawSuggest(this.rawSuggest[0].text)
            return
        }
        if (!this.writable || this.rawTruncated) return
        event.preventDefault()
        const ta = event.target
        const start = ta.selectionStart
        const end = ta.selectionEnd
        const indent = '    '
        ta.value = ta.value.slice(0, start) + indent + ta.value.slice(end)
        this.rawDraft = ta.value
        this.highlightRaw()
        const caret = start + indent.length
        queueMicrotask(() => {
            ta.selectionStart = ta.selectionEnd = caret
        })
    }

    // Keep the highlight layer, line-number gutter, and diagnostics overlay
    // aligned with the textarea as it scrolls (gutter tracks vertical only).
    rawEditScroll(event) {
        const code = event.target.parentElement
        const pre = code?.querySelector('.explorer-fileedit-hl')
        if (pre) {
            pre.scrollTop = event.target.scrollTop
            pre.scrollLeft = event.target.scrollLeft
        }
        const gutter = code?.parentElement?.querySelector('.explorer-fileedit-gutter')
        if (gutter) gutter.scrollTop = event.target.scrollTop
        const diags = code?.querySelector('.explorer-fileedit-diags-inner')
        if (diags)
            diags.style.transform = `translate(${-event.target.scrollLeft}px, ${-event.target.scrollTop}px)`
    }

    // Editor text metrics (monospace advance, line height, padding), measured
    // once from the live textarea and cached module-side (see CODE_METRICS).
    codeMetrics() {
        if (CODE_METRICS) return CODE_METRICS
        const ta = document.querySelector('.explorer-fileedit-input')
        if (!ta) return { charW: 8, lineHeight: 20, padL: 11, padT: 10 }
        const cs = getComputedStyle(ta)
        const ctx = document.createElement('canvas').getContext('2d')
        ctx.font = `${cs.fontSize} ${cs.fontFamily}`
        CODE_METRICS = {
            charW: ctx.measureText('M').width || 8,
            lineHeight: parseFloat(cs.lineHeight) || 20,
            padL: parseFloat(cs.paddingLeft) || 11,
            padT: parseFloat(cs.paddingTop) || 10
        }
        return CODE_METRICS
    }

    // Inline style for a diagnostic's wavy underline, in editor content pixels.
    // The underline itself carries the message as a native `title` tooltip.
    squiggleStyle(diag) {
        const m = this.codeMetrics()
        const left = m.padL + diag.col * m.charW
        const top = m.padT + diag.line * m.lineHeight + m.lineHeight - 3
        return `left:${left}px;top:${top}px;width:${diag.len * m.charW}px`
    }

    // Write the edited text back over the file's bytes (write mode only). The
    // object key is unchanged, so the index needs no update — but the xattr
    // checksum can't be re-stamped from a browser (same caveat as uploadFile);
    // a desktop `verify`/`rebuild` re-derives it.
    async saveRaw() {
        if (!this.writable || !this._rawPath) return
        return await this.track(async () => {
            this.error = ''
            try {
                const bytes = new TextEncoder().encode(this.rawDraft)
                await this._fs.writeBytes(this._rawPath, bytes)
                if (this.rawUrl) URL.revokeObjectURL(this.rawUrl)
                this.rawUrl = URL.createObjectURL(new Blob([bytes], { type: this._rawMime }))
                this.rawSize = bytes.byteLength
                this.rawText = this.rawDraft
                this.rawTruncated = false
                this.rawMeta = {
                    ...this.rawMeta,
                    size: this.rawSizeLabel().replace(/[()]/g, ''),
                    modified: new Date().toLocaleString()
                }
                this.flash(this.selectedId, 'updated')
            } catch (err) {
                this.error = String(err?.message ?? err)
            }
        })
    }

    // --- SQL console ---

    openSql() {
        this.view = 'sql'
        this.active = ''
        this.selectedId = ''
        this.editing = ''
        this.releaseRaw()
        this.highlightSql() // sync the overlay with any retained query text
        // Learn column names for autocomplete once (non-blocking).
        if (!this._sqlColumnsLoaded) {
            this._sqlColumnsLoaded = true
            this.collectSqlColumns()
        }
        this.saveRoute()
    }

    closeSql() {
        this.view = 'docs'
        this.resetSql()
        this.saveRoute()
    }

    // Leaving any Tool (SQL / Overview / Export) returns to the collections view.
    closeTool() {
        this.view = 'docs'
        this.resetSql()
        this.toolMessage = ''
        this.saveRoute()
    }

    // --- Overview tool: item counts per collection/bucket + repo totals ---

    async openOverview() {
        this.view = 'overview'
        this.active = ''
        this.selectedId = ''
        this.editing = ''
        this.releaseRaw()
        this.error = ''
        this.saveRoute()
        await this.buildOverview()
    }

    async buildOverview() {
        return await this.track(async () => {
            // Historical write cadence per collection/bucket, from .fylo-vcs.
            const activity = await readWriteActivity(this._fs).catch(() => ({
                names: {},
                buckets: 24,
                from: 0,
                to: 0
            }))
            const act = (name) => activity.names?.[name] ?? { count: 0, series: [] }
            const rows = []
            let items = 0
            for (const name of this.collections) {
                const count = await this.countDocs(name).catch(() => 0)
                const a = act(name)
                rows.push({ name, kind: 'documents', count, writes: a.count, spark: a.series })
                items += count
            }
            for (const name of this.buckets) {
                const count = await this.countFiles(`/.buckets/${name}`).catch(() => 0)
                const a = act(name)
                rows.push({ name, kind: 'files', count, writes: a.count, spark: a.series })
                items += count
            }
            const commits = (await this._fs.list('/.fylo-vcs/commits').catch(() => [])).filter(
                (n) => !n.startsWith('.')
            ).length
            this.overviewRows = rows
            this.overviewTotals = {
                collections: this.collections.length,
                buckets: this.buckets.length,
                items,
                commits
            }
            // Aggregate write-activity timeline (all collections/buckets summed)
            // for the graph at the top of the Overview.
            const span = activity.buckets ?? 24
            const total = new Array(span).fill(0)
            for (const a of Object.values(activity.names ?? {})) {
                a.series?.forEach((v, i) => (total[i] += v))
            }
            this.overviewChart = {
                series: total,
                from: activity.from ?? 0,
                to: activity.to ?? 0,
                buckets: span
            }
        })
    }

    async countDocs(name) {
        if (!this._rebuilt.has(name)) {
            await this._db.collection(name).rebuild()
            this._rebuilt.add(name)
        }
        const cursor = this._db.collection(name).find({ $onlyIds: true })
        let n = 0
        for await (const page of cursor.collect()) {
            if (typeof page === 'string') n += 1
            else if (Array.isArray(page)) n += page.length
            else n += Object.keys(page).length
        }
        return n
    }

    async countFiles(dir) {
        const entries = await this._fs.list(dir).catch(() => [])
        let n = 0
        for (const entry of entries) {
            if (entry.startsWith('.')) continue
            const path = `${dir}/${entry}`
            if (await this._fs.isDirectory(path)) n += await this.countFiles(path)
            else n += 1
        }
        return n
    }

    // --- Export / Import tool ---

    openExport() {
        this.view = 'export'
        this.active = ''
        this.selectedId = ''
        this.editing = ''
        this.releaseRaw()
        this.error = ''
        this.toolMessage = ''
        this.saveRoute()
    }

    // Dump a document collection as one JSON object per line (NDJSON), then
    // hand the browser a download. The `_id` field carries the TTID so a later
    // import round-trips to the same document.
    async doExport(name) {
        return await this.track(async () => {
            this.toolBusy = true
            this.toolMessage = ''
            this.error = ''
            try {
                if (!this._rebuilt.has(name)) {
                    await this._db.collection(name).rebuild()
                    this._rebuilt.add(name)
                }
                const cursor = this._db.collection(name).find({
                    $onlyIds: true,
                    $limit: EXPLORER_LIMITS.exportRecords + 1
                })
                const ids = []
                for await (const page of cursor.collect()) {
                    if (typeof page === 'string') ids.push(page)
                    else if (Array.isArray(page)) ids.push(...page)
                    else ids.push(...Object.keys(page))
                    if (ids.length > EXPLORER_LIMITS.exportRecords) {
                        throw new Error(
                            `Export is limited to ${EXPLORER_LIMITS.exportRecords.toLocaleString()} records. Use the FYLO CLI for larger collections.`
                        )
                    }
                }
                const chunks = []
                let bytes = 0
                for (const id of ids) {
                    const path = await this.recordPath(name, 'docs', id, '.json')
                    const storedBytes = await this._fs.size(path)
                    if (bytes + storedBytes > EXPLORER_LIMITS.exportBytes) {
                        throw new Error(
                            limitError('Export', bytes + storedBytes, EXPLORER_LIMITS.exportBytes)
                        )
                    }
                    const manifest = await this._db.collection(name).get(id).once()
                    const record = manifest?.[id]
                    if (record === undefined) continue
                    const line = `${JSON.stringify({ _id: id, ...record })}\n`
                    bytes += new TextEncoder().encode(line).byteLength
                    if (bytes > EXPLORER_LIMITS.exportBytes) {
                        throw new Error(limitError('Export', bytes, EXPLORER_LIMITS.exportBytes))
                    }
                    chunks.push(line)
                }
                this.download(`${name}.ndjson`, chunks, 'application/x-ndjson')
                this.toolMessage = `Exported ${chunks.length} document(s) from “${name}”.`
            } catch (err) {
                this.error = String(err?.message ?? err)
            } finally {
                this.toolBusy = false
            }
        })
    }

    // Load NDJSON (or a JSON array) into a collection, creating it if new. Each
    // record's `_id` (if present) preserves the original TTID; otherwise the
    // engine assigns one.
    async doImport({ collection, file }) {
        return await this.track(async () => {
            this.toolBusy = true
            this.toolMessage = ''
            this.error = ''
            try {
                if (!this.writable) {
                    this.error = 'Enable writes before importing.'
                    return
                }
                if (!collection) {
                    this.error = 'Choose a target collection to import into.'
                    return
                }
                if (file.size > EXPLORER_LIMITS.importBytes) {
                    throw new Error(limitError('Import', file.size, EXPLORER_LIMITS.importBytes))
                }
                const records = this.parseImport(await file.text())
                await this._db.createCollection(collection).catch(() => {})
                let n = 0
                for (const record of records) {
                    const { _id, ...data } = record
                    if (_id) await this._db.collection(collection).put(_id, data)
                    else await this._db.collection(collection).put(data)
                    n += 1
                }
                this._rebuilt.delete(collection)
                if (!this.collections.includes(collection)) {
                    this.collections = [...this.collections, collection].sort()
                    this.kinds = { ...this.kinds, [collection]: 'document' }
                }
                this.toolMessage = `Imported ${n} document(s) into “${collection}”.`
            } catch (err) {
                this.error = String(err?.message ?? err)
            } finally {
                this.toolBusy = false
            }
        })
    }

    // Accept either a JSON array or newline-delimited JSON objects.
    parseImport(text) {
        const trimmed = text.trim()
        if (!trimmed) return []
        const records =
            trimmed[0] === '['
                ? JSON.parse(trimmed)
                : trimmed
                      .split('\n')
                      .map((line) => line.trim())
                      .filter(Boolean)
                      .map((line) => JSON.parse(line))
        if (!Array.isArray(records)) throw new Error('Import JSON must be an array or NDJSON')
        if (records.length > EXPLORER_LIMITS.importRecords) {
            throw new Error(
                `Import is limited to ${EXPLORER_LIMITS.importRecords.toLocaleString()} records. Split the input or use the FYLO CLI.`
            )
        }
        return records.map((record, index) => {
            if (typeof record !== 'object' || record === null || Array.isArray(record)) {
                throw new Error(`Import record ${index + 1} must be a JSON object`)
            }
            return copySafeJson(record)
        })
    }

    download(filename, parts, type) {
        const url = URL.createObjectURL(new Blob(Array.isArray(parts) ? parts : [parts], { type }))
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = filename
        document.body.appendChild(anchor)
        anchor.click()
        anchor.remove()
        setTimeout(() => URL.revokeObjectURL(url), 1000)
    }

    resetSql() {
        this.sqlData = null
        this.sqlRows = []
        this.sqlResult = ''
        this.sqlEmpty = false
        this.selectedId = ''
        this.selectedJson = ''
        this.sqlSuggest = []
    }

    sqlInput(event) {
        this.sqlText = event.target.value
        this.highlightSql()
        this.updateSuggest(event.target)
    }

    // --- SQL autocomplete (keywords, collections/buckets, sampled columns) ---

    // Collect dot-path column names from a record, descending into plain nested
    // objects up to `depth` levels (FYLO's SQL parser turns address.city into the
    // address/city path). Arrays aren't descended; a size cap avoids blowups.
    flattenKeys(obj, prefix, depth, out) {
        for (const key of Object.keys(obj)) {
            if (out.size >= 200) return
            const path = prefix ? `${prefix}.${key}` : key
            out.add(path)
            const value = obj[key]
            if (depth > 1 && value && typeof value === 'object' && !Array.isArray(value)) {
                this.flattenKeys(value, path, depth - 1, out)
            }
        }
    }

    // The identifier being typed: the run of word/dot characters ending at the
    // caret. Dots are included so nested paths (address.city) are completable.
    currentSqlToken(value, caret) {
        let start = caret
        while (start > 0 && /[A-Za-z0-9_.]/.test(value[start - 1])) start -= 1
        return { start, end: caret, value: value.slice(start, caret) }
    }

    updateSuggest(textarea) {
        const token = this.currentSqlToken(textarea.value, textarea.selectionStart)
        this._sqlToken = token
        if (token.value.length < 1) {
            this.sqlSuggest = []
            return
        }
        const lower = token.value.toLowerCase()
        const pools = [
            [SQL_KEYWORDS, 'kw'],
            [this.collections, 'table'],
            [this.buckets, 'table'],
            [this._sqlColumns ?? [], 'col']
        ]
        const seen = new Set()
        const out = []
        outer: for (const [list, kind] of pools) {
            for (const cand of list) {
                const cl = cand.toLowerCase()
                if (cl.startsWith(lower) && cl !== lower && !seen.has(cl)) {
                    seen.add(cl)
                    out.push({ text: cand, kind })
                    if (out.length >= 8) break outer
                }
            }
        }
        if (out.length) this.sqlSuggestPos = this.caretXY(textarea, token.start)
        this.sqlSuggest = out
    }

    // Pixel position of character offset `index` inside the (monospace) editor,
    // used to anchor the suggestion dropdown just under the token being typed.
    caretXY(textarea, index) {
        const before = textarea.value.slice(0, index)
        const line = before.length - before.replace(/\n/g, '').length
        const col = before.length - (before.lastIndexOf('\n') + 1)
        const cs = getComputedStyle(textarea)
        const lineHeight = parseFloat(cs.lineHeight) || 20
        const charW = this.sqlCharWidth(cs)
        const left = parseFloat(cs.paddingLeft) + col * charW - textarea.scrollLeft
        const top = parseFloat(cs.paddingTop) + (line + 1) * lineHeight - textarea.scrollTop
        return { left: Math.max(2, Math.round(left)), top: Math.round(top) + 2 }
    }

    // Monospace advance width, measured once via canvas and cached.
    sqlCharWidth(cs) {
        if (this._sqlCharW) return this._sqlCharW
        const canvas = (this._measureCanvas ||= document.createElement('canvas'))
        const ctx = canvas.getContext('2d')
        ctx.font = `${cs.fontSize} ${cs.fontFamily}`
        this._sqlCharW = ctx.measureText('M').width || 8
        return this._sqlCharW
    }

    // Replace the token under the caret with the chosen suggestion, then refocus.
    applySuggest(word) {
        const ta = document.querySelector('.explorer-sql-input')
        if (!ta) return
        const { start, end } = this.wordSpan(ta.value, ta.selectionStart, /[A-Za-z0-9_.]/)
        const next = ta.value.slice(0, start) + word + ta.value.slice(end)
        this.sqlSuggest = []
        this.setEditorCaret('.explorer-sql-input', ta, next, start + word.length, (v) => {
            this.sqlText = v
            this.highlightSql()
        })
    }

    // Tab accepts the top suggestion; Escape dismisses the list.
    sqlKey(event) {
        if (event.key === 'Escape' && this.sqlSuggest.length) {
            event.preventDefault()
            this.sqlSuggest = []
        } else if (event.key === 'Tab' && this.sqlSuggest.length) {
            event.preventDefault()
            this.applySuggest(this.sqlSuggest[0].text)
        }
    }

    // Sample a few documents per collection to learn column names for
    // autocomplete. Bounded (5 docs/collection) and run once per session.
    // ponytail: sampled, not exhaustive — misses keys absent from the first rows.
    async collectSqlColumns() {
        const keys = new Set()
        for (const name of this.collections) {
            try {
                if (!this._rebuilt.has(name)) {
                    await this._db.collection(name).rebuild()
                    this._rebuilt.add(name)
                }
                const cursor = this._db.collection(name).find({ $onlyIds: true })
                const ids = []
                for await (const page of cursor.collect()) {
                    if (typeof page === 'string') ids.push(page)
                    else if (Array.isArray(page)) ids.push(...page)
                    else ids.push(...Object.keys(page))
                    if (ids.length >= 5) break
                }
                for (const id of ids.slice(0, 5)) {
                    const manifest = await this._db.collection(name).get(id).once()
                    const record = manifest?.[id]
                    if (record && typeof record === 'object') this.flattenKeys(record, '', 3, keys)
                }
            } catch {
                // skip a collection that won't sample; suggestions degrade gracefully
            }
        }
        this._sqlColumns = [...keys].sort()
        // Columns arrive after the console opens; refresh suggestions if the
        // user is already mid-token.
        const ta = document.querySelector('.explorer-sql-input')
        if (this.view === 'sql' && ta) this.updateSuggest(ta)
    }

    // Live syntax highlighting for the SQL editor: a highlighted <pre> sits
    // behind a transparent <textarea> (the caret comes from the textarea, the
    // colors from the pre).
    highlightSql() {
        this.sqlHtml = highlightToHtml(this.sqlText, 'sql')
    }

    // Keep the highlight layer and line-number gutter aligned as the editor
    // scrolls (gutter tracks vertical scroll only).
    sqlScroll(event) {
        const code = event.target.parentElement
        const pre = code?.querySelector('.explorer-sql-hl')
        if (pre) {
            pre.scrollTop = event.target.scrollTop
            pre.scrollLeft = event.target.scrollLeft
        }
        const gutter = code?.parentElement?.querySelector('.explorer-sql-gutter')
        if (gutter) gutter.scrollTop = event.target.scrollTop
    }

    async runSql() {
        return await this.track(async () => {
            this.error = ''
            this.resetSql()
            const statement = this.sqlText.trim()
            if (!statement) return
            if (!this.writable && !/^SELECT\b/i.test(statement)) {
                this.error = 'Read-only mode: only SELECT statements — enable writes for DML/DDL'
                return
            }
            try {
                // Indexes are accelerators: rebuild each document collection
                // into the in-memory overlay once, so a SELECT works on a
                // freshly-opened root whose index the browser hasn't touched.
                for (const name of this.collections) {
                    if (!this._rebuilt.has(name)) {
                        await this._db.collection(name).rebuild()
                        this._rebuilt.add(name)
                    }
                }
                const result = await this._db._sql(statement)
                // A row-shaped result (id → row object) becomes a selectable
                // TTID list, like a collection; anything else shows raw JSON.
                if (this.isRowShaped(result)) {
                    this.sqlData = result
                    this.sqlRows = Object.keys(result)
                } else if (this.isEmptySqlResult(result)) {
                    this.sqlEmpty = true
                } else {
                    this.sqlResult = JSON.stringify(result ?? null, null, 2)
                }
            } catch (err) {
                this.error = String(err?.message ?? err)
            }
        })
    }

    // Row-shaped = a plain object whose every value is itself an object, i.e.
    // the `{ <ttid>: { ...row } }` shape FYLO returns for SELECT * queries.
    isRowShaped(result) {
        if (!result || typeof result !== 'object' || Array.isArray(result)) return false
        const values = Object.values(result)
        return values.length > 0 && values.every((v) => v && typeof v === 'object')
    }

    // The SQL engine represents an empty SELECT result as an empty object.
    // Surface it as a result state, rather than rendering the implementation
    // detail (`{}`) as if it were useful query output.
    isEmptySqlResult(result) {
        return (
            !!result &&
            typeof result === 'object' &&
            !Array.isArray(result) &&
            !Object.keys(result).length
        )
    }

    selectSqlRow(id) {
        this.selectedId = id
        this.selectedJson = JSON.stringify(this.sqlData?.[id] ?? null, null, 2)
    }

    // --- Raw-file upload (write mode, buckets) ---
    //
    // Bytes land under docs/<bucket>/<ttid>.<ext>, and the object key is
    // recorded straight into the bucket's own prefix index (a `key/eq` WAL
    // entry — the same line the folder tree reads back). ponytail: only the
    // key entry is written, and the object-key/checksum xattrs can't be set
    // from a browser — a desktop `rebuild`/`verify` re-derives the full index
    // and re-stamps the checksum.

    async uploadFile(event) {
        return await this.track(async () => {
            const file = event.target.files?.[0]
            event.target.value = ''
            if (!file) return
            this.error = ''
            try {
                if (file.size > EXPLORER_LIMITS.uploadBytes) {
                    throw new Error(limitError('Upload', file.size, EXPLORER_LIMITS.uploadBytes))
                }
                const { TTID } = await this.lib()
                const id = TTID.generate()
                const dot = file.name.lastIndexOf('.')
                const ext = dot > 0 ? file.name.slice(dot) : ''
                const key = `${this.folderPath}${file.name}`
                const root = `/${this.baseDir(this.active)}/${this.active}`
                await this._fs.writeBytes(
                    `${this.writeRecordDirectory(this.active, 'docs', id)}/${id}${ext}`,
                    new Uint8Array(await file.arrayBuffer())
                )
                // key/eq entry, double-encoded to match the index format.
                const encoded = encodeURIComponent(encodeURIComponent(key))
                await this._fs.appendText(`${root}/index/keys.wal`, `+\tkey/eq/${encoded}/${id}\n`)
                await this.loadKeyMap(this.active)
                this.openFolder(this.folderPath)
                this.docIds = await this.listDocIds(this.active)
                this.flash(id, 'added')
            } catch (err) {
                this.error = String(err?.message ?? err)
            }
        })
    }

    // --- JSON field model (in-place value editing + regex schema) ---

    /** The regex for a field: the collection's saved schema, else a type default. */
    regexFor(key, type) {
        return this.schema && Object.hasOwn(this.schema, key)
            ? this.schema[key]
            : defaultRegex(type)
    }

    /** Pretty `{ field: regex }` JSON for the read-only Schema pane. */
    schemaJson() {
        let obj
        try {
            obj = JSON.parse(this.selectedJson)
        } catch {
            return '{}'
        }
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return '{}'
        /** @type {Record<string, string>} */
        const out = safeRecord()
        for (const [key, v] of Object.entries(obj)) out[key] = this.regexFor(key, valueType(v))
        return JSON.stringify(out, null, 2)
    }

    /** Per-collection regex schema, read from `<collection>/schema.json`. */
    async loadSchema(collection) {
        const path = `/${this.baseDir(collection)}/${collection}/schema.json`
        try {
            const obj = JSON.parse(await this._fs.readText(path))
            this.schema =
                obj && typeof obj === 'object' && !Array.isArray(obj)
                    ? copySafeJson(obj)
                    : safeRecord()
        } catch {
            this.schema = safeRecord()
        }
    }

    /**
     * The edit model rendered as JSON: comma/quote/literal flags let the
     * template lay each field out on its own line with only the value editable.
     */
    editView() {
        const last = this.editFields.length - 1
        return this.editFields.map((f, i) => ({
            ...f,
            comma: i < last,
            quoted: f.type === 'string',
            literal: f.type === 'null'
        }))
    }

    startNew() {
        this.editing = 'new'
        this.draft = '' // blank + placeholder; a fresh <textarea> can't show a value attr
    }

    // Edit from a TTID row's pencil icon: select it first (loads its JSON) then
    // switch into edit mode.
    async editDoc(id) {
        if (this.selectedId !== id || !this.selectedJson) await this.select(id)
        if (this.selectedJson) this.startEdit()
    }

    startEdit() {
        let obj
        try {
            obj = JSON.parse(this.selectedJson)
        } catch {
            obj = {}
        }
        this.editFields = Object.entries(obj).map(([key, v]) => {
            const type = valueType(v)
            return { key, type, value: fieldValue(v), regex: this.regexFor(key, type) }
        })
        this.editing = 'edit'
    }

    cancelEdit() {
        this.editing = ''
        this.editFields = []
    }

    draftInput(event) {
        this.draft = event.target.value
    }

    // Document pane: a field's value changed (its key and type stay fixed).
    fieldValueInput(key, event) {
        const value = event.target.value
        this.editFields = this.editFields.map((f) => (f.key === key ? { ...f, value } : f))
    }

    // Schema pane: a field's validation regex changed.
    regexInput(key, event) {
        const regex = event.target.value
        this.editFields = this.editFields.map((f) => (f.key === key ? { ...f, regex } : f))
    }

    async saveDraft() {
        return await this.track(async () => {
            this.error = ''
            /** @type {Record<string, any>} */
            let data
            if (this.editing === 'edit') {
                try {
                    data = safeRecord()
                    for (const f of this.editFields) data[f.key] = parseField(f)
                } catch (err) {
                    this.error = String(err?.message ?? err)
                    return
                }
            } else {
                try {
                    data = JSON.parse(this.draft)
                } catch (_) {
                    this.error = 'Draft is not valid JSON'
                    return
                }
            }
            try {
                const col = this._db.collection(this.active)
                const wasEdit = this.editing === 'edit'
                const id = wasEdit ? this.selectedId : ''
                const saved = id ? await col.patch(id, data) : await col.put(data)
                if (wasEdit) await this.saveSchema() // persist edited regexes
                this.editing = ''
                this.editFields = []
                this.docIds = await this.listDocIds(this.active)
                this.filtered = null
                const finalId = typeof saved === 'string' ? saved : id
                await this.select(finalId)
                this.flash(finalId, wasEdit ? 'updated' : 'added')
            } catch (err) {
                this.error = String(err?.message ?? err)
            }
        })
    }

    // Merge the edited field regexes into the collection's schema.json (a flat
    // CHEX regex schema `{ field: pattern }`). Same browser-write caveat as the
    // rest of write mode — the desktop engine reads schemas from FYLO_SCHEMA.
    async saveSchema() {
        /** @type {Record<string, string>} */
        const merged = copySafeJson(this.schema)
        for (const f of this.editFields) merged[f.key] = f.regex
        this.schema = merged
        const path = `/${this.baseDir(this.active)}/${this.active}/schema.json`
        await this._fs.writeBytes(path, new TextEncoder().encode(JSON.stringify(merged, null, 2)))
    }

    // The trash icon asks first — deleting is destructive (soft-delete, but
    // still). The confirmation dialog is driven by `confirmId`.
    askDelete(id) {
        this.confirmId = id
    }

    cancelDelete() {
        this.confirmId = ''
    }

    confirmDelete() {
        const id = this.confirmId
        this.confirmId = ''
        if (id) this.removeDoc(id)
    }

    // Delete a specific document (confirmed from the trash icon). Firestore-
    // style: the row flashes red first. Tac morphs when this handler returns, so
    // the actual deletion runs on a timer — timer callbacks rerender normally.
    removeDoc(id) {
        this.error = ''
        this.flash(id, 'deleted')
        setTimeout(() => {
            this.track(async () => {
                try {
                    await this._db.collection(this.active).delete(id)
                    if (this.selectedId === id) {
                        this.selectedId = ''
                        this.selectedJson = ''
                        this.docMeta = null
                    }
                    this.docIds = await this.listDocIds(this.active)
                    this.filtered = null
                    if (this.showDeleted) await this.refreshDeleted()
                } catch (err) {
                    this.error = String(err?.message ?? err)
                }
            })
        }, 420)
    }

    async toggleDeleted() {
        this.showDeleted = !this.showDeleted
        if (this.showDeleted) await this.refreshDeleted()
    }

    async refreshDeleted() {
        const deleted = `/${this.baseDir(this.active)}/${this.active}/.deleted`
        const buckets = await this._fs.list(deleted).catch(() => [])
        /** @type {string[]} */
        const ids = []
        for (const bucket of buckets) {
            for (const file of await this._fs.list(`${deleted}/${bucket}`).catch(() => [])) {
                ids.push(file.endsWith('.json') ? file.slice(0, -5) : file)
            }
        }
        this.deletedIds = ids.sort()
    }

    async restoreDoc(id) {
        return await this.track(async () => {
            this.error = ''
            try {
                await this._db.collection(this.active).restore(id)
                await this.refreshDeleted()
                this.docIds = await this.listDocIds(this.active)
                this.filtered = null
                this.flash(id, 'added')
            } catch (err) {
                this.error = String(err?.message ?? err)
            }
        })
    }
}
