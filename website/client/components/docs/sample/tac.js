// Multi-language code samples for the documentation pages.
//
// The renderer below is copied from components/docs/content — Tachyon
// components cannot import shared modules, so the duplication is deliberate.
// Keep the two in sync when a client's method naming changes.
// Languages with a shipped client shim. `dir` is the folder under clients/,
// `cmt` the line-comment token used when we annotate a snippet.
const LANGS = [
    { key: 'python', label: 'Python', dir: 'python', cmt: '#' },
    { key: 'ruby', label: 'Ruby', dir: 'ruby', cmt: '#' },
    { key: 'node', label: 'Node.js', dir: 'node', cmt: '//' },
    { key: 'php', label: 'PHP', dir: 'php', cmt: '//' },
    { key: 'go', label: 'Go', dir: 'go', cmt: '//' },
    { key: 'rust', label: 'Rust', dir: 'rust', cmt: '//' },
    { key: 'csharp', label: 'C#', dir: 'csharp', cmt: '//' },
    { key: 'java', label: 'Java', dir: 'java', cmt: '//' },
    { key: 'swift', label: 'Swift (iOS)', dir: 'swift', cmt: '//', mobile: true },
    { key: 'kotlin', label: 'Kotlin (Android)', dir: 'kotlin', cmt: '//', mobile: true },
    { key: 'dart', label: 'Dart', dir: 'dart', cmt: '//' },
    { key: 'flutter', label: 'Flutter', dir: 'flutter', cmt: '//', mobile: true },
    { key: 'web', label: 'JS (Browser)', dir: 'web', cmt: '//' }
]

const FYLO_BROWSER_LOADER = 'https://d31ma.github.io/FYLO/version/26.32.07/fylo.js'

// Swift (iOS), Kotlin (Android), and Flutter are local-first mobile clients — they
// embed the engine in a WebView, on-device only, like the browser client.
const isMobile = (lang) => lang === 'swift' || lang === 'kotlin' || lang === 'flutter'

// Native object/array literal renderers, one per language. Object arguments are
// built with each language's native container — no JSON strings.
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
    if (typeof v === 'string') return `'${v}'` // single quotes so $keys aren't interpolated
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
    // Swift uses \(…) for interpolation, so a literal `$` in a string needs no escaping.
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

// Positional argument order for each op's dedicated method.
const METHODS = {
    createCollection: ['collection', 'kind'],
    putData: ['collection', 'data'],
    getDoc: ['collection', 'id'],
    getLatest: ['collection', 'id'],
    patchDoc: ['collection', 'id', 'newDoc'],
    delDoc: ['collection', 'id'],
    restoreDoc: ['collection', 'id'],
    findDocs: ['collection', 'query'],
    executeSQL: ['sql']
}

// The op name cased to each language's method convention.
function methodName(lang, op) {
    if (lang === 'go' || lang === 'csharp') return op.charAt(0).toUpperCase() + op.slice(1)
    if (lang === 'python' || lang === 'ruby' || lang === 'rust') {
        return op.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase()
    }
    return op // node / php / java keep the camelCase op name
}

// Render one argument in the target language. Rust scalars are &str; its object
// args use the Json builder.
function argLit(lang, v) {
    // A `__ref` value is an existing variable in the snippet, not a literal.
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof v.__ref === 'string') {
        return v.__ref
    }
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
            return invocation // python / ruby / go / kotlin
    }
}

// Open/close boilerplate per language. Bodies are indented for languages that
// scope the connection in a block (Python `with`, Ruby block, Java try).
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

// A recipe is an ordered list of steps. A step is either a comment line or one
// machine operation, which `call()` renders into the selected language.
const RECIPES = {
    'first-write': [
        { op: 'createCollection', collection: 'users' },
        { blank: true },
        { assign: 'id', op: 'putData', collection: 'users', data: { name: 'Ada', role: 'admin' } },
        { assign: 'doc', op: 'getLatest', collection: 'users', id: '<id>' }
    ],
    query: [
        { comment: 'Every field was indexed on write — nothing to declare first.' },
        {
            assign: 'admins',
            op: 'findDocs',
            collection: 'users',
            query: { $ops: [{ role: { $eq: 'admin' } }] }
        },
        { blank: true },
        { comment: 'The same question in SQL, against the same engine and indexes.' },
        { assign: 'rows', op: 'executeSQL', sql: "SELECT * FROM users WHERE role = 'admin'" }
    ],
    crud: [
        { op: 'createCollection', collection: 'users' },
        { blank: true },
        {
            assign: 'id',
            op: 'putData',
            collection: 'users',
            data: { name: 'Jane Doe', age: 29, team: 'platform' }
        },
        { assign: 'doc', op: 'getDoc', collection: 'users', id: '<id>' },
        { blank: true },
        { comment: 'patch preserves the document TTID — an update, not a replace.' },
        {
            op: 'patchDoc',
            collection: 'users',
            id: '<id>',
            newDoc: { team: 'core-platform' }
        },
        { op: 'delDoc', collection: 'users', id: '<id>' }
    ],
    restore: [
        { comment: 'A soft-deleted document keeps its TTID and can be brought back.' },
        { op: 'restoreDoc', collection: 'users', id: '<id>' }
    ],
    'find-ops': [
        { comment: 'Exact match' },
        {
            assign: 'exact',
            op: 'findDocs',
            collection: 'users',
            query: { $ops: [{ name: { $eq: 'Alice' } }] }
        },
        { blank: true },
        { comment: 'Range — numeric fields' },
        {
            assign: 'adults',
            op: 'findDocs',
            collection: 'users',
            query: { $ops: [{ age: { $gte: 18 } }] }
        },
        { blank: true },
        { comment: 'Array membership' },
        {
            assign: 'engineers',
            op: 'findDocs',
            collection: 'users',
            query: { $ops: [{ tags: { $contains: 'engineering' } }] }
        },
        { blank: true },
        { comment: 'OR — every entry in $ops is a separate branch' },
        {
            assign: 'privileged',
            op: 'findDocs',
            collection: 'users',
            query: { $ops: [{ role: { $eq: 'admin' } }, { role: { $eq: 'owner' } }] }
        }
    ],
    sql: [
        { assign: 'created', op: 'executeSQL', sql: 'CREATE TABLE posts' },
        {
            assign: 'inserted',
            op: 'executeSQL',
            sql: "INSERT INTO posts (title, published) VALUES ('Hello', true)"
        },
        { assign: 'posts', op: 'executeSQL', sql: 'SELECT * FROM posts WHERE published = true' },
        { blank: true },
        { comment: 'EXPLAIN reports the access path without executing the statement.' },
        {
            assign: 'plan',
            op: 'executeSQL',
            sql: "EXPLAIN SELECT * FROM posts WHERE title = 'Hello'"
        }
    ],
    rebuild: [
        { comment: 'Documents are truth; the index is derived and can always be rebuilt.' },
        { assign: 'result', op: 'rebuildCollection', collection: 'posts' },
        { assign: 'info', op: 'inspectCollection', collection: 'posts' }
    ],
    bucket: [
        { comment: 'A bucket is a collection whose values are bytes rather than records.' },
        { op: 'createCollection', collection: 'assets', kind: 'file' },
        { blank: true },
        { comment: 'Derived file metadata is indexed, so keys are queryable.' },
        {
            assign: 'reports',
            op: 'findDocs',
            collection: 'assets',
            query: { $ops: [{ key: { $like: '/reports/%' } }] }
        }
    ]
}

// Assignment syntax per language for a step that binds its result to a name.
function bind(lang, name) {
    switch (lang) {
        case 'python':
        case 'ruby':
            return `${name} = `
        case 'node':
        case 'web':
            return `const ${name} = `
        case 'php':
            return `$${name} = `
        case 'go':
            return `${name}, _ := `
        case 'rust':
            return `let ${name} = `
        case 'csharp':
            return `var ${name} = `
        case 'java':
            return `var ${name} = `
        case 'swift':
            return `let ${name} = `
        case 'kotlin':
            return `val ${name} = `
        case 'dart':
        case 'flutter':
            return `final ${name} = `
        default:
            return `${name} = `
    }
}

// `<id>` in a recipe means "the identifier the previous step produced", rendered
// as that language's variable reference rather than a string literal.
function idRef(lang) {
    return lang === 'php' ? '$id' : 'id'
}

// Statement terminator / await form, matching `call()`'s tail.
function finish(lang, invocation) {
    switch (lang) {
        case 'node':
        case 'web':
            return `await ${invocation}`
        case 'dart':
        case 'flutter':
            return `await ${invocation};`
        case 'swift':
            return `try await ${invocation}`
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

// SQL statements quote with ' internally, so they are always emitted as a
// double-quoted literal — the single-quote languages would otherwise terminate
// the string early. `$` is escaped where the language interpolates it.
function sqlLit(lang, sql) {
    const interpolatesDollar =
        lang === 'php' || lang === 'kotlin' || lang === 'dart' || lang === 'flutter'
    let escaped = sql.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    if (interpolatesDollar) escaped = escaped.replace(/\$/g, '\\$')
    return `"${escaped}"`
}

// SQL is not collection-scoped — it is a top-level method on the client.
function sqlCall(lang, sql) {
    const receiver = lang === 'php' ? '$db->' : 'db.'
    return finish(lang, `${receiver}${methodName(lang, 'executeSQL')}(${sqlLit(lang, sql)})`)
}

// `const x = await db…()` — the binding goes in front of the whole expression,
// await included.
function applyBind(lang, name, line) {
    return bind(lang, name) + line
}

function renderStep(lang, step) {
    if (step.blank) return ''
    if (step.comment) {
        const cmt = LANGS.find((l) => l.key === lang)?.cmt || '//'
        return `${cmt} ${step.comment}`
    }
    if (step.op === 'executeSQL') {
        const line = sqlCall(lang, step.sql)
        return step.assign ? applyBind(lang, step.assign, line) : line
    }
    const resolved = { ...step }
    if (resolved.id === '<id>') resolved.id = { __ref: idRef(lang) }
    const line = call(lang, resolved)
    return step.assign ? applyBind(lang, step.assign, line) : line
}

export default class extends Tac {
    /** @type {string} */
    topic = 'crud'

    /** @type {string} */
    $lang = 'python' // sessionStorage-persisted, shared by every sample on the page

    langs = LANGS

    showLang(key) {
        this.$lang = key
    }

    activeLabel() {
        return (LANGS.find((l) => l.key === this.$lang) || LANGS[0]).label
    }

    code() {
        const lang = LANGS.find((l) => l.key === this.$lang) ? this.$lang : 'python'
        const steps = RECIPES[this.topic] || RECIPES.crud
        return scaffold(
            lang,
            steps.map((step) => renderStep(lang, step))
        )
    }
}
