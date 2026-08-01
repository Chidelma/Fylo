// Languages with a shipped client shim.
const LANGS = [
    { key: 'python', label: 'Python', cmt: '#' },
    { key: 'ruby', label: 'Ruby', cmt: '#' },
    { key: 'node', label: 'Node.js', cmt: '//' },
    { key: 'php', label: 'PHP', cmt: '//' },
    { key: 'go', label: 'Go', cmt: '//' },
    { key: 'rust', label: 'Rust', cmt: '//' },
    { key: 'csharp', label: 'C#', cmt: '//' },
    { key: 'java', label: 'Java', cmt: '//' },
    { key: 'swift', label: 'Swift (iOS)', cmt: '//' },
    { key: 'kotlin', label: 'Kotlin (Android)', cmt: '//' },
    { key: 'dart', label: 'Dart', cmt: '//' },
    { key: 'flutter', label: 'Flutter', cmt: '//' },
    { key: 'web', label: 'JS (Browser)', cmt: '//' }
]

const FYLO_BROWSER_LOADER = 'https://d31ma.github.io/FYLO/version/26.31.06/fylo.js'

// Native object/array literal renderers, one per language.
function pyLit(v) {
    if (typeof v === 'number') return String(v)
    if (typeof v === 'string') return `"${v}"`
    if (Array.isArray(v)) return `[${v.map(pyLit).join(', ')}]`
    return `{${Object.entries(v)
        .map(([k, val]) => `"${k}": ${pyLit(val)}`)
        .join(', ')}}`
}
function rubyLit(v) {
    if (typeof v === 'number') return String(v)
    if (typeof v === 'string') return `"${v}"`
    if (Array.isArray(v)) return `[${v.map(rubyLit).join(', ')}]`
    return `{ ${Object.entries(v)
        .map(([k, val]) => `"${k}" => ${rubyLit(val)}`)
        .join(', ')} }`
}
function jsLit(v) {
    if (typeof v === 'number') return String(v)
    if (typeof v === 'string') return `'${v}'`
    if (Array.isArray(v)) return `[${v.map(jsLit).join(', ')}]`
    return `{ ${Object.entries(v)
        .map(([k, val]) => `${k}: ${jsLit(val)}`)
        .join(', ')} }`
}
function phpLit(v) {
    if (typeof v === 'number') return String(v)
    if (typeof v === 'string') return `'${v}'`
    if (Array.isArray(v)) return `[${v.map(phpLit).join(', ')}]`
    return `[${Object.entries(v)
        .map(([k, val]) => `'${k}' => ${phpLit(val)}`)
        .join(', ')}]`
}
function goLit(v) {
    if (typeof v === 'number') return String(v)
    if (typeof v === 'string') return `"${v}"`
    if (Array.isArray(v)) return `[]any{${v.map(goLit).join(', ')}}`
    return `map[string]any{${Object.entries(v)
        .map(([k, val]) => `"${k}": ${goLit(val)}`)
        .join(', ')}}`
}
function javaLit(v) {
    if (typeof v === 'number') return String(v)
    if (typeof v === 'string') return `"${v}"`
    if (Array.isArray(v)) return `List.of(${v.map(javaLit).join(', ')})`
    return `Map.of(${Object.entries(v)
        .flatMap(([k, val]) => [`"${k}"`, javaLit(val)])
        .join(', ')})`
}
function csharpLit(v) {
    if (typeof v === 'number') return String(v)
    if (typeof v === 'string') return `"${v}"`
    if (Array.isArray(v)) return `new object[] { ${v.map(csharpLit).join(', ')} }`
    return `new Dictionary<string, object> { ${Object.entries(v)
        .map(([k, val]) => `["${k}"] = ${csharpLit(val)}`)
        .join(', ')} }`
}
function rustJson(v) {
    if (typeof v === 'number') return `${v}.into()`
    if (typeof v === 'string') return `"${v}".into()`
    if (Array.isArray(v)) return `Json::arr(vec![${v.map(rustJson).join(', ')}])`
    return `Json::obj(vec![${Object.entries(v)
        .map(([k, val]) => `("${k}", ${rustJson(val)})`)
        .join(', ')}])`
}
function swiftLit(v) {
    if (typeof v === 'number') return String(v)
    if (typeof v === 'string') return `"${v}"`
    if (Array.isArray(v)) return `[${v.map(swiftLit).join(', ')}]`
    return `[${Object.entries(v)
        .map(([k, val]) => `"${k}": ${swiftLit(val)}`)
        .join(', ')}]`
}
function kotlinLit(v) {
    const esc = (s) => s.replace(/\$/g, '\\$') // $ starts interpolation in Kotlin strings
    if (typeof v === 'number') return String(v)
    if (typeof v === 'string') return `"${esc(v)}"`
    if (Array.isArray(v)) return `listOf(${v.map(kotlinLit).join(', ')})`
    return `mapOf(${Object.entries(v)
        .map(([k, val]) => `"${esc(k)}" to ${kotlinLit(val)}`)
        .join(', ')})`
}
function dartLit(v) {
    const esc = (s) => s.replace(/\$/g, '\\$') // $ starts interpolation in Dart strings
    if (typeof v === 'number') return String(v)
    if (typeof v === 'string') return `'${esc(v)}'`
    if (Array.isArray(v)) return `[${v.map(dartLit).join(', ')}]`
    return `{${Object.entries(v)
        .map(([k, val]) => `'${esc(k)}': ${dartLit(val)}`)
        .join(', ')}}`
}

const METHODS = {
    createCollection: ['collection', 'kind'],
    putData: ['collection', 'data'],
    getLatest: ['collection', 'id'],
    findDocs: ['collection', 'query'],
    executeSQL: ['sql']
}

function methodName(lang, op) {
    if (lang === 'go' || lang === 'csharp') return op.charAt(0).toUpperCase() + op.slice(1)
    if (lang === 'python' || lang === 'ruby' || lang === 'rust') {
        return op.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase()
    }
    return op
}

function argLit(lang, v) {
    switch (lang) {
        case 'python':
            return pyLit(v)
        case 'ruby':
            return rubyLit(v)
        case 'node':
        case 'web':
            return jsLit(v)
        case 'php':
            return phpLit(v)
        case 'go':
            return goLit(v)
        case 'java':
            return javaLit(v)
        case 'csharp':
            return csharpLit(v)
        case 'swift':
            return swiftLit(v)
        case 'kotlin':
            return kotlinLit(v)
        case 'dart':
        case 'flutter':
            return dartLit(v)
        case 'rust':
            return typeof v === 'string' ? `"${v}"` : rustJson(v)
        default:
            return pyLit(v)
    }
}

// Short method name per op for the collection facade.
const SHORT = {
    createCollection: 'create',
    dropCollection: 'drop',
    inspectCollection: 'inspect',
    rebuildCollection: 'rebuild',
    putData: 'put',
    getDoc: 'get',
    getLatest: 'latest',
    patchDoc: 'patch',
    delDoc: 'delete',
    restoreDoc: 'restore',
    findDocs: 'find'
}
// Languages whose clients expose `db.<collection>` dynamic sugar.
const DYNAMIC = new Set(['node', 'web', 'python', 'ruby', 'php'])

// One collection-scoped facade call: `db.users.put(...)` in dynamic languages,
// `db.collection("users").put(...)` in the rest.
function call(lang, op) {
    let method = SHORT[op.op] || op.op
    if (lang === 'go' || lang === 'csharp')
        method = method.charAt(0).toUpperCase() + method.slice(1)
    const rest = (METHODS[op.op] || [])
        .filter((k) => k !== 'collection' && op[k] !== undefined)
        .map((k) => argLit(lang, op[k]))
        .join(', ')
    const accessor = lang === 'go' || lang === 'csharp' ? 'Collection' : 'collection'
    const receiver = DYNAMIC.has(lang)
        ? `${lang === 'php' ? '$db->' : 'db.'}${op.collection}`
        : `db.${accessor}(${argLit(lang, op.collection)})`
    const sep = lang === 'php' ? '->' : '.' // PHP method access
    const invocation = `${receiver}${sep}${method}(${rest})`
    switch (lang) {
        case 'node':
            return `await ${invocation}`
        case 'dart':
        case 'flutter':
            return `await ${invocation};`
        case 'swift':
            return `try await ${invocation}` // async local-first mobile client
        case 'rust':
            return `${invocation}?;`
        case 'csharp':
        case 'java':
        case 'php':
            return `${invocation};`
        default:
            return invocation
    }
}

const SCAFFOLD = {
    python: {
        open: ['from fylo import Fylo', '', 'with Fylo("/mnt/fylo") as db:'],
        indent: '    ',
        close: []
    },
    ruby: {
        open: ['require_relative "fylo"', '', 'Fylo.open("/mnt/fylo") do |db|'],
        indent: '  ',
        close: ['end']
    },
    node: {
        open: ["import { Fylo } from './fylo.mjs'", '', "const db = new Fylo('/mnt/fylo')"],
        indent: '',
        close: []
    },
    php: {
        open: ["require 'fylo.php';", '', '$db = new Fylo("/mnt/fylo");'],
        indent: '',
        close: []
    },
    go: {
        open: [
            'import fylo "yourapp/fylo"',
            '',
            'db, _ := fylo.Open("/mnt/fylo", "fylo")',
            'defer db.Close()'
        ],
        indent: '',
        close: []
    },
    rust: {
        open: ['use fylo::{Fylo, Json};', '', 'let mut db = Fylo::open("/mnt/fylo", "fylo")?;'],
        indent: '',
        close: []
    },
    csharp: {
        open: [
            'using System.Collections.Generic;',
            '',
            'using var db = new Fylo.Fylo("/mnt/fylo");'
        ],
        indent: '',
        close: []
    },
    java: {
        open: [
            'import java.util.Map;',
            'import java.util.List;',
            '',
            'try (Fylo db = new Fylo("/mnt/fylo")) {'
        ],
        indent: '    ',
        close: ['}']
    },
    swift: {
        open: ['import Fylo', '', 'let db = try await Fylo()'],
        indent: '',
        close: []
    },
    kotlin: {
        open: [
            '// inside a coroutine (e.g. lifecycleScope.launch { … })',
            '',
            'val db = Fylo.open(context)'
        ],
        indent: '',
        close: []
    },
    dart: {
        open: [
            "import 'fylo.dart';",
            '',
            'Future<void> main() async {',
            "  final db = await Fylo.open('/mnt/fylo');"
        ],
        indent: '  ',
        close: ['}']
    },
    flutter: {
        open: [
            "import 'fylo.dart';",
            '',
            '// in an async context (e.g. initState / an async method)',
            'final db = await Fylo.open();'
        ],
        indent: '',
        close: []
    }
}

function scaffold(lang, bodyLines) {
    const s = SCAFFOLD[lang]
    const body = bodyLines.map((l) => (l ? s.indent + l : l))
    return [...s.open, '', ...body, ...s.close].join('\n')
}

export default class extends Tac {
    /** @type {string} */
    heading = 'From install to query in one minute' // populated from props.heading

    /** @type {string} */
    $tab = 'start' // sessionStorage-persisted active tab

    /** @type {string} */
    $lang = 'python' // sessionStorage-persisted active language

    /** @type {string} */
    collection = 'users'

    copied = false

    langs = LANGS

    tabs = [
        { key: 'start', label: 'Quick start', code: true },
        { key: 'query', label: 'Query', code: true },
        { key: 'sql', label: 'SQL', code: true }
    ]

    show(key) {
        this.$tab = key
    }

    showLang(key) {
        this.$lang = key
    }

    isCodeTab() {
        const tab = this.tabs.find((t) => t.key === this.$tab)
        return tab ? tab.code : false
    }

    safeCollection() {
        const cleaned = String(this.collection ?? '')
            .toLowerCase()
            .replace(/[^a-z0-9_-]/g, '')
        return cleaned || 'users'
    }

    // JS (Browser): local OPFS/FSA storage, not a binary shim.
    webScaffold(body) {
        return [
            `// Add once to <head>: <script src="${FYLO_BROWSER_LOADER}"></script>`,
            '',
            'const db = await Fylo.open({ wasm: true })',
            '',
            ...body
        ].join('\n')
    }

    quickstartCode() {
        const c = this.safeCollection()
        const lang = this.$lang
        if (lang === 'web') {
            return this.webScaffold([
                `await db['${c}'].put({ name: 'Ada', role: 'admin' })`,
                `await db['${c}'].latest('<id>')`
            ])
        }
        return scaffold(lang, [
            call(lang, { op: 'createCollection', collection: c, kind: 'document' }),
            call(lang, { op: 'putData', collection: c, data: { name: 'Ada', role: 'admin' } }),
            call(lang, { op: 'getLatest', collection: c, id: '<id>' })
        ])
    }

    queryCode() {
        const c = this.safeCollection()
        const lang = this.$lang
        if (lang === 'web') {
            return this.webScaffold([
                `const cursor = db['${c}'].find({ $ops: [{ role: { $eq: 'admin' } }, { age: { $gte: 30 } }] })`,
                'for await (const page of cursor.collect()) console.log(page)'
            ])
        }
        return scaffold(lang, [
            call(lang, {
                op: 'findDocs',
                collection: c,
                query: { $ops: [{ role: { $eq: 'admin' } }, { age: { $gte: 30 } }] }
            })
        ])
    }

    sqlCode() {
        const lang = this.$lang
        const { cmt } = this.langs.find((l) => l.key === lang) ?? { cmt: '//' }
        const body = this.sqlBody(lang, cmt)
        return lang === 'web' ? this.webScaffold(body) : scaffold(lang, body)
    }

    // Each language's native `sql` interpolation. Node/JS-browser (tagged template)
    // and C# (FormattableString) escape values; the rest inline verbatim.
    sqlBody(lang, cmt) {
        const c = this.safeCollection()
        switch (lang) {
            case 'node':
            case 'web':
                return [
                    `${cmt} Tagged template — interpolated values are escaped for you.`,
                    "const role = 'admin'",
                    'await db.sql`SELECT * FROM ' + c + ' WHERE role = ${role}`'
                ]
            case 'csharp':
                return [
                    `${cmt} Interpolated string ($"…") — values are escaped for you.`,
                    'var role = "admin";',
                    'db.Sql($"SELECT * FROM ' + c + ' WHERE role = {role}");'
                ]
            case 'python':
                return [
                    `${cmt} Native f-string — quote and escape untrusted values yourself.`,
                    'role = "admin"',
                    `db.sql(f"SELECT * FROM ${c} WHERE role = '{role}'")`
                ]
            case 'ruby':
                return [
                    `${cmt} Native interpolation — quote and escape untrusted values yourself.`,
                    'role = "admin"',
                    `db.sql("SELECT * FROM ${c} WHERE role = '#{role}'")`
                ]
            case 'php':
                return [
                    `${cmt} Native interpolation — quote and escape untrusted values yourself.`,
                    '$role = "admin";',
                    `$db->sql("SELECT * FROM ${c} WHERE role = '$role'");`
                ]
            case 'go':
                return [
                    `${cmt} Sprintf — quote and escape untrusted values yourself.`,
                    'role := "admin"',
                    `db.Sql(fmt.Sprintf("SELECT * FROM ${c} WHERE role = '%s'", role))`
                ]
            case 'java':
                return [
                    `${cmt} Concatenation — quote and escape untrusted values yourself.`,
                    'String role = "admin";',
                    `db.sql("SELECT * FROM ${c} WHERE role = '" + role + "'");`
                ]
            case 'rust':
                return [
                    `${cmt} format! — quote and escape untrusted values yourself.`,
                    'let role = "admin";',
                    `db.sql(&format!("SELECT * FROM ${c} WHERE role = '{role}'"))?;`
                ]
            case 'swift':
                return [
                    `${cmt} Native interpolation (\\()) — quote and escape untrusted values yourself.`,
                    'let role = "admin"',
                    `try await db.sql("SELECT * FROM ${c} WHERE role = '\\(role)'")`
                ]
            case 'kotlin':
                return [
                    `${cmt} Native interpolation ($) — quote and escape untrusted values yourself.`,
                    'val role = "admin"',
                    `db.sql("SELECT * FROM ${c} WHERE role = '\${role}'")`
                ]
            case 'dart':
            case 'flutter':
                return [
                    `${cmt} Native interpolation ($) — quote and escape untrusted values yourself.`,
                    "final role = 'admin';",
                    `await db.sql("SELECT * FROM ${c} WHERE role = '\$role'");`
                ]
            default:
                return [
                    call(lang, { op: 'executeSQL', sql: `SELECT * FROM ${c} WHERE active = true` })
                ]
        }
    }

    currentCode() {
        switch (this.$tab) {
            case 'query':
                return this.queryCode()
            case 'sql':
                return this.sqlCode()
            default:
                return this.quickstartCode()
        }
    }

    @publish('snippet-copied')
    async copyCurrent() {
        try {
            await navigator.clipboard.writeText(this.currentCode())
            this.copied = true
            setTimeout(() => {
                this.copied = false
            }, 2000)
        } catch (_) {
            /* clipboard unavailable */
        }
        return this.$tab
    }
}
