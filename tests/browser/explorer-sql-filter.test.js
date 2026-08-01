import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { createBrowserClient } from '../../src/browser/client.js'

// Tachyon injects lifecycle decorators while compiling components. This test
// imports the uncompiled controller for its pure methods, so provide the same
// harmless decorator binding without registering a browser mount callback.
globalThis.onMount = () => {}
const {
    default: WebsiteExplorer,
    EXPLORER_LIMITS,
    browserLabel,
    clampPopupPosition,
    engineAssetUrl,
    findFileNameMatches,
    historicalShardCandidates,
    legacyShardOf,
    menuIndexForKey,
    resizeValueForKey,
    shardCandidates,
    shardOf
} = await import('../../explorer/client/components/explorer/app/tac.js')
delete globalThis.onMount

describe('SQL WHERE execution', () => {
    test('requires every AND condition to match', async () => {
        const db = createBrowserClient({ worker: false })
        await db.users.create()
        const admin = await db.users.put({ role: 'admin', age: 30 })
        await db.users.put({ role: 'member', age: 40 })

        expect(await db._sql("SELECT _id FROM users WHERE role = 'admin' AND age >= 30")).toEqual([
            admin
        ])

        await db.close()
    })
})

describe('hosted Explorer', () => {
    test('uses Tachyon canonical lifecycle, identity, render, and event behavior', () => {
        const component = readFileSync(
            new URL('../../explorer/client/components/explorer/app/tac.js', import.meta.url),
            'utf8'
        )
        const template = readFileSync(
            new URL('../../explorer/client/components/explorer/app/tac.html', import.meta.url),
            'utf8'
        )

        expect(component).toContain('@onMount\n    async boot()')
        expect(component).not.toContain('ensureBooted')
        expect(component).not.toContain('menuNonce')
        expect(component).not.toContain("event.type !== 'contextmenu'")
        expect(component).not.toContain("event.type === 'contextmenu'")
        expect(component).toContain("type: 'fsa'")
        expect(component).toContain('worker: true')
        expect(component).toContain('wasm: true')
        expect(component).not.toContain('id.slice(0, 2)')
        expect(component).not.toContain('newId.slice(0, 2)')

        for (const id of [
            'explorer-sql-input',
            'explorer-raw-editor',
            'explorer-document-filter',
            'explorer-new-document'
        ]) {
            expect(template).toContain(`id="${id}"`)
        }
        expect(template).toContain('on:click="pickFolder(column, folder)"')
        expect(template).toContain('on:click="pickFile(column, file)"')
        expect(template).toContain('on:click="select(id)"')
        expect(template).not.toContain('data-menu-nonce')

        // Tachyon #111 remains deferred, so conditional overlays still need one root.
        expect(template.match(/<div class="explorer-overlay">/g)).toHaveLength(4)
    })

    test('resizes separators with arrows and bounded Home/End keyboard controls', () => {
        expect(resizeValueForKey(200, 'ArrowLeft')).toBe(190)
        expect(resizeValueForKey(200, 'ArrowRight')).toBe(210)
        expect(resizeValueForKey(200, 'ArrowUp', true)).toBe(250)
        expect(resizeValueForKey(200, 'ArrowDown', true)).toBe(150)
        expect(resizeValueForKey(200, 'Home')).toBe(120)
        expect(resizeValueForKey(200, 'End')).toBe(1200)
        expect(resizeValueForKey(120, 'ArrowLeft')).toBe(120)
        expect(resizeValueForKey(1200, 'ArrowRight')).toBe(1200)
        expect(resizeValueForKey(200, 'Enter')).toBeNull()
    })

    test('uses trailing creation-TTID shards and keeps leading shards read-only compatible', () => {
        const id = '4VRNF52JPCO-4VRNF52JPCP-4VRNF52JPCQ'
        expect(shardOf(id)).toBe('CO')
        expect(shardOf(id, 3)).toBe('PCO')
        expect(legacyShardOf(id)).toBe('4V')
        expect(shardCandidates(id, { width: 3, previousWidths: [1, 2] })).toEqual([
            'PCO',
            'O',
            'CO',
            '4V'
        ])
        expect(historicalShardCandidates(id, { width: 2, previousWidths: [] })).toEqual([
            'CO',
            '4V',
            '',
            'O',
            'PCO',
            'JPCO'
        ])
    })

    test('opens row actions from keyboard and provides bounded menu navigation', () => {
        const explorer = new WebsiteExplorer()
        explorer.writable = true
        explorer.activateMenu = () => {}
        let prevented = false
        let stopped = false
        const opener = {
            getBoundingClientRect: () => ({ left: 940, bottom: 740 })
        }
        explorer.menuDocKey(
            {
                key: 'F10',
                shiftKey: true,
                currentTarget: opener,
                preventDefault: () => (prevented = true),
                stopPropagation: () => (stopped = true)
            },
            'doc-1'
        )

        expect(prevented).toBe(true)
        expect(stopped).toBe(true)
        expect(explorer.rowMenu.target).toEqual({ kind: 'doc', id: 'doc-1' })
        expect(menuIndexForKey(0, 4, 'ArrowDown')).toBe(1)
        expect(menuIndexForKey(3, 4, 'ArrowDown')).toBe(0)
        expect(menuIndexForKey(0, 4, 'ArrowUp')).toBe(3)
        expect(menuIndexForKey(2, 4, 'Home')).toBe(0)
        expect(menuIndexForKey(2, 4, 'End')).toBe(3)
        expect(menuIndexForKey(2, 4, 'Escape')).toBeNull()
        expect(clampPopupPosition(940, 740, 180, 220, 1024, 768)).toEqual({ x: 836, y: 540 })
    })

    test('declares menu and modal keyboard contracts in the rendered template', () => {
        const template = readFileSync(
            new URL('../../explorer/client/components/explorer/app/tac.html', import.meta.url),
            'utf8'
        )

        for (const handler of ['menuFolderKey', 'menuFileKey', 'menuDocKey']) {
            expect(template).toContain(`on:keydown="${handler}(`)
        }
        expect(template).toContain('role="menu"')
        expect(template).toContain('role="menuitem"')
        expect(template).toContain('on:keydown="menuKey(event)"')
        expect(template.match(/role="dialog"/g)).toHaveLength(3)
        expect(template.match(/aria-modal="true"/g)).toHaveLength(3)
        expect(template.match(/on:keydown="dialogKey\(event,/g)).toHaveLength(3)
        expect(template).toContain('aria-labelledby="explorer-rename-title"')
        expect(template).toContain('aria-labelledby="explorer-picker-title"')
        expect(template).toContain('aria-labelledby="explorer-delete-title"')
    })

    test('traps dialog focus, isolates the background, closes on Escape, and restores focus', async () => {
        const explorer = new WebsiteExplorer()
        let focused = ''
        const attributes = new Set()
        const background = {
            classList: { contains: () => false },
            setAttribute: (name) => attributes.add(name),
            removeAttribute: (name) => attributes.delete(name)
        }
        const overlay = { classList: { contains: (name) => name === 'explorer-overlay' } }
        const first = { focus: () => (focused = 'first') }
        const last = { focus: () => (focused = 'last') }
        const dialog = {
            focus: () => (focused = 'dialog'),
            querySelector: () => first,
            querySelectorAll: () => [first, last]
        }
        const rootElement = {
            children: [background, overlay],
            querySelectorAll: () => (attributes.has('data-explorer-inerted') ? [background] : [])
        }
        const originalDocument = globalThis.document
        const originalObserver = globalThis.MutationObserver
        globalThis.document = {
            activeElement: last,
            querySelector: (selector) =>
                selector === '.explorer'
                    ? rootElement
                    : selector.includes('data-explorer-dialog')
                      ? dialog
                      : null
        }
        globalThis.MutationObserver = class {
            observe() {}
            disconnect() {}
        }
        let openerFocused = false
        explorer._actionOpener = { isConnected: true, focus: () => (openerFocused = true) }
        try {
            explorer.activateDialog('rename')
            await Promise.resolve()
            expect(focused).toBe('first')
            expect(attributes.has('inert')).toBe(true)
            expect(attributes.has('data-explorer-inerted')).toBe(true)

            let trapped = false
            explorer.dialogKey(
                {
                    key: 'Tab',
                    shiftKey: false,
                    currentTarget: dialog,
                    preventDefault: () => (trapped = true)
                },
                'rename'
            )
            expect(trapped).toBe(true)
            expect(focused).toBe('first')

            explorer.renameFor = { target: {}, value: '' }
            let escaped = false
            explorer.dialogKey(
                {
                    key: 'Escape',
                    preventDefault: () => (escaped = true),
                    stopPropagation() {}
                },
                'rename'
            )
            await Promise.resolve()
            expect(escaped).toBe(true)
            expect(explorer.renameFor).toBeNull()
            expect(attributes.has('inert')).toBe(false)
            expect(openerFocused).toBe(true)
        } finally {
            if (originalDocument === undefined) delete globalThis.document
            else globalThis.document = originalDocument
            if (originalObserver === undefined) delete globalThis.MutationObserver
            else globalThis.MutationObserver = originalObserver
        }
    })

    test('names the current unsupported browser for compatibility guidance', () => {
        expect(browserLabel('Mozilla/5.0 Firefox/140.0')).toBe('Firefox')
        expect(browserLabel('Mozilla/5.0 Version/18.5 Safari/605.1.15')).toBe('Safari')
        expect(browserLabel('unknown')).toBe('This browser')
    })

    test('constructs only the allowlisted same-origin engine asset URL', () => {
        expect(engineAssetUrl('26.28.07', 'https://fylo.example')).toBe(
            'https://fylo.example/shared/assets/fylo-web.mjs?v=26.28.07'
        )
        expect(() => engineAssetUrl('../evil', 'https://fylo.example')).toThrow(
            'Invalid FYLO Explorer build token'
        )
        expect(() => engineAssetUrl('ok', 'data:text/html,evil')).toThrow(
            'Invalid FYLO Explorer asset origin'
        )
    })

    test('finds bucket files by filename without matching their folder path', () => {
        const result = findFileNameMatches(
            new Map([
                ['one', 'reports/Q1-summary.pdf'],
                ['two', 'archive/summary-notes.txt'],
                ['three', 'summary-folder/diagram.png']
            ]),
            'summary',
            1
        )

        expect(result.total).toBe(2)
        expect(result.matches).toEqual([
            { id: 'one', key: 'reports/Q1-summary.pdf', name: 'Q1-summary.pdf', path: 'reports/' }
        ])
    })

    test('rejects oversized raw previews before reading bytes', async () => {
        const explorer = new WebsiteExplorer()
        explorer.active = 'assets'
        explorer.kinds = { assets: 'file' }
        explorer.selectedId = 'doc-1'
        let read = false
        explorer._fs = {
            async list() {
                return ['doc-1.bin']
            },
            async size() {
                return EXPLORER_LIMITS.rawPreviewBytes + 1
            },
            async readBytes() {
                read = true
                return new Uint8Array()
            }
        }

        await explorer.loadRaw('doc-1')

        expect(read).toBe(false)
        expect(explorer.error).toContain('Raw preview is limited to 32 MiB')
    })

    test('treats filesystem not-found errors as absent file bytes', async () => {
        const explorer = new WebsiteExplorer()
        explorer.kinds = { assets: 'file' }

        for (const error of [
            Object.assign(new Error('missing'), { code: 'ENOENT' }),
            Object.assign(new Error('missing'), { name: 'NotFoundError' })
        ]) {
            explorer._fs = {
                async list() {
                    throw error
                }
            }
            expect(await explorer.fileBytesPath('assets', 'gone')).toBeNull()
        }
    })

    test('removes only successfully trashed files from the key index on partial delete', async () => {
        const explorer = new WebsiteExplorer()
        explorer.active = 'assets'
        explorer.kinds = { assets: 'file' }
        explorer._keyMap = new Map([
            ['one', 'reports/one.txt'],
            ['two', 'reports/two.txt'],
            ['gone', 'reports/gone.txt']
        ])
        const moved = []
        const committed = []
        explorer._fs = {
            async list(base) {
                if (base.endsWith('/on')) return ['one.txt']
                if (base.endsWith('/tw')) return ['two.txt']
                return []
            },
            async mkdir() {},
            async move(source) {
                moved.push(source)
                if (source.endsWith('/two.txt')) throw new Error('disk write failed')
            }
        }
        explorer.commitKeyWal = async (_collection, lines) => committed.push(...lines)

        await expect(explorer.deleteEntry({ kind: 'folder', prefix: 'reports/' })).rejects.toThrow(
            'two.txt'
        )

        expect(moved).toHaveLength(2)
        expect(committed).toEqual([
            `-\tkey/eq/${explorer.encodeKeyEntry('reports/one.txt')}/one\n`,
            `-\tkey/eq/${explorer.encodeKeyEntry('reports/gone.txt')}/gone\n`
        ])
    })

    test('continues deleting entries when a file path lookup fails', async () => {
        const explorer = new WebsiteExplorer()
        explorer.active = 'assets'
        explorer.kinds = { assets: 'file' }
        explorer._keyMap = new Map([
            ['one', 'reports/one.txt'],
            ['two', 'reports/two.txt'],
            ['gone', 'reports/gone.txt']
        ])
        const lookups = []
        const moved = []
        const committed = []
        explorer._fs = {
            async list(path) {
                lookups.push(path)
                if (path.endsWith('/tw')) throw new Error('directory read failed')
                if (path.endsWith('/on')) return ['one.txt']
                return []
            },
            async mkdir() {},
            async move(source) {
                moved.push(source)
            }
        }
        explorer.commitKeyWal = async (_collection, lines) => committed.push(...lines)

        await expect(explorer.deleteEntry({ kind: 'folder', prefix: 'reports/' })).rejects.toThrow(
            'reports/two.txt: directory read failed'
        )

        expect(lookups).toEqual([
            '/.buckets/assets/docs/ne',
            '/.buckets/assets/docs/on',
            '/.buckets/assets/docs/wo',
            '/.buckets/assets/docs/tw',
            '/.buckets/assets/docs/ne',
            '/.buckets/assets/docs/go'
        ])
        expect(moved).toEqual(['/.buckets/assets/docs/on/one.txt'])
        expect(committed).toEqual([
            `-\tkey/eq/${explorer.encodeKeyEntry('reports/one.txt')}/one\n`,
            `-\tkey/eq/${explorer.encodeKeyEntry('reports/gone.txt')}/gone\n`
        ])
    })

    test('rejects oversized imports before reading the File', async () => {
        const explorer = new WebsiteExplorer()
        explorer.writable = true
        let read = false
        await explorer.doImport({
            collection: 'users',
            file: {
                size: EXPLORER_LIMITS.importBytes + 1,
                async text() {
                    read = true
                    return '[]'
                }
            }
        })

        expect(read).toBe(false)
        expect(explorer.error).toContain('Import is limited to 16 MiB')
    })

    test('rejects oversized exports before reading document contents', async () => {
        const explorer = new WebsiteExplorer()
        explorer._rebuilt = new Set(['users'])
        let read = false
        explorer._fs = {
            async exists() {
                return true
            },
            async size() {
                return EXPLORER_LIMITS.exportBytes + 1
            }
        }
        explorer._db = {
            collection() {
                return {
                    find() {
                        return {
                            async *collect() {
                                yield ['4VNQ8ZROGVW']
                            }
                        }
                    },
                    get() {
                        read = true
                        return {
                            async once() {
                                return {}
                            }
                        }
                    }
                }
            }
        }

        await explorer.doExport('users')

        expect(read).toBe(false)
        expect(explorer.error).toContain('Export is limited to 64 MiB')
    })

    test('bounds imported record count and preserves reserved keys as own data', () => {
        const explorer = new WebsiteExplorer()
        const record = explorer.parseImport(
            '[{"__proto__":"proto","constructor":"ctor","prototype":"prototype"}]'
        )[0]
        expect(Object.getPrototypeOf(record)).toBeNull()
        expect(record.__proto__).toBe('proto')
        expect(record.constructor).toBe('ctor')
        expect(() =>
            explorer.parseImport(
                Array.from({ length: EXPLORER_LIMITS.importRecords + 1 }, () => '{}').join('\n')
            )
        ).toThrow('Import is limited to 10,000 records')
    })

    test('filters a collection with a SQL WHERE expression', async () => {
        const explorer = new WebsiteExplorer()
        const statements = []
        const rebuilt = []
        explorer.active = 'users'
        explorer.filter = "role = 'admin' AND age >= 30"
        explorer._rebuilt = new Set()
        explorer._db = {
            collection(name) {
                return {
                    async rebuild() {
                        rebuilt.push(name)
                    }
                }
            },
            async _sql(statement) {
                statements.push(statement)
                return ['4VNQ8ZROGVW', '4VNQ8ZRHXKA']
            }
        }

        await explorer.applyFilter()

        expect(rebuilt).toEqual(['users'])
        expect(statements).toEqual(["SELECT _id FROM users WHERE role = 'admin' AND age >= 30"])
        expect(explorer.filtered).toEqual(['4VNQ8ZRHXKA', '4VNQ8ZROGVW'])
    })

    test('accepts an optional WHERE prefix', async () => {
        const explorer = new WebsiteExplorer()
        const statements = []
        explorer.active = 'users'
        explorer.filter = 'WHERE active = true'
        explorer._rebuilt = new Set(['users'])
        explorer._db = {
            collection() {
                throw new Error('an already rebuilt collection must not rebuild')
            },
            async _sql(statement) {
                statements.push(statement)
                return []
            }
        }

        await explorer.applyFilter()

        expect(statements).toEqual(['SELECT _id FROM users WHERE active = true'])
        expect(explorer.filtered).toEqual([])
    })

    test('suggests active collection fields and SQL WHERE keywords', () => {
        const explorer = new WebsiteExplorer()
        explorer.filterColumns = ['age', 'role']

        explorer.filterInput({ target: { value: 'ro', selectionStart: 2 } })
        expect(explorer.filterSuggest).toEqual([{ text: 'role', kind: 'col' }])

        explorer.filterInput({ target: { value: 'an', selectionStart: 2 } })
        expect(explorer.filterSuggest).toEqual([{ text: 'AND', kind: 'kw' }])
    })

    test('reports an empty SQL result without rendering an empty object', async () => {
        const explorer = new WebsiteExplorer()
        explorer.view = 'sql'
        explorer.sqlText = "SELECT * FROM users WHERE role = 'missing'"
        explorer.collections = []
        explorer._db = {
            async _sql() {
                return {}
            }
        }

        await explorer.runSql()

        expect(explorer.sqlEmpty).toBe(true)
        expect(explorer.sqlResult).toBe('')
        expect(explorer.sqlRows).toEqual([])
        expect(explorer.hasDoc()).toBe(true)
    })
})
