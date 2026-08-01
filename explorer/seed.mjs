// Seeds explorer/db with demo data for the FYLO Explorer.
// Run: bun run seed   (then open the Explorer and pick explorer/db as the root)
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Fylo } from '../clients/node/fylo.mjs'

const root = path.join(import.meta.dir, 'db')
await rm(root, { recursive: true, force: true })

const binary = path.resolve(
    import.meta.dir,
    '..',
    'target',
    'debug',
    process.platform === 'win32' ? 'fylo-rust.exe' : 'fylo-rust'
)
const staging = await mkdtemp(path.join(os.tmpdir(), 'fylo-explorer-seed-'))
const db = new Fylo(root, { binary, exclusiveRoot: true })
await db.ready

// --- users: a document collection with varied fields for filter/SQL demos ---
await db.createCollection('users')
const USERS = [
    { name: 'Ada Lovelace', role: 'admin', age: 36, team: 'engines' },
    { name: 'Grace Hopper', role: 'admin', age: 85, team: 'compilers' },
    { name: 'Alan Turing', role: 'owner', age: 41, team: 'engines' },
    { name: 'Katherine Johnson', role: 'analyst', age: 101, team: 'trajectories' },
    { name: 'Margaret Hamilton', role: 'owner', age: 88, team: 'guidance' },
    { name: 'Edsger Dijkstra', role: 'viewer', age: 72, team: 'algorithms' },
    { name: 'Barbara Liskov', role: 'admin', age: 84, team: 'abstractions' },
    { name: 'Donald Knuth', role: 'viewer', age: 87, team: 'algorithms' },
    { name: 'Radia Perlman', role: 'analyst', age: 73, team: 'networks' },
    { name: 'Linus Torvalds', role: 'owner', age: 55, team: 'kernels' }
]
/** @type {string[]} */
const userIds = []
for (const user of USERS) userIds.push(await db.putData('users', user))

// --- posts: cross-references users, arrays for $contains demos ---
await db.createCollection('posts')
const POSTS = [
    { title: 'Notes on the Analytical Engine', tags: ['history', 'engines'], published: true },
    { title: 'Compiling the future', tags: ['compilers'], published: true },
    { title: 'On computable numbers', tags: ['theory', 'history'], published: true },
    { title: 'Orbital mechanics by hand', tags: ['math'], published: false },
    { title: 'Software engineering, named', tags: ['guidance', 'history'], published: true },
    { title: 'Goto considered harmful', tags: ['essays'], published: true },
    { title: 'Substitutability', tags: ['theory'], published: false },
    { title: 'Literate programming', tags: ['essays', 'books'], published: true }
]
for (let i = 0; i < POSTS.length; i++) {
    await db.putData('posts', {
        ...POSTS[i],
        authorId: userIds[i % userIds.length],
        likes: i * 7
    })
}

// --- assets: a bucket with every previewable file type at random depths ---
await db.createCollection('assets', 'file')

const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#f89b4b"/><path d="M20 10h18l12 12v28a4 4 0 0 1-4 4H20a4 4 0 0 1-4-4V14a4 4 0 0 1 4-4Z" fill="#171007"/><circle cx="26" cy="30" r="3.4" fill="#f89b4b"/><circle cx="26" cy="45" r="3.4" fill="#f89b4b"/><circle cx="39" cy="34" r="3.4" fill="#f89b4b"/><path d="M26 33.4v8.2M39 37.4a10.5 10.5 0 0 1-9.2 7.3" fill="none" stroke="#f89b4b" stroke-width="2.5" stroke-linecap="round"/></svg>`

const MEDIA_NAMES = [
    'photo.png',
    'pixel.gif',
    'sample.jpg',
    'bitmap.bmp',
    'icon.webp',
    'modern.avif',
    'favicon.ico',
    'tone.wav',
    'song.mp3',
    'audio.ogg',
    'track.m4a',
    'lossless.flac',
    'sound.aac',
    'clip.mp4',
    'movie.webm',
    'video.mov',
    'anim.ogv'
]
const mediaDir = path.join(import.meta.dir, 'fixtures', 'media')
const MEDIA_ASSETS = await Promise.all(
    MEDIA_NAMES.map(async (name) => ({
        name,
        data: new Uint8Array(await readFile(path.join(mediaDir, name)))
    }))
)

// A minimal valid single-page PDF with correct xref offsets.
function makePdf(text) {
    const content = `BT /F1 22 Tf 24 90 Td (${text}) Tj ET`
    const objs = [
        '<</Type/Catalog/Pages 2 0 R>>',
        '<</Type/Pages/Kids[3 0 R]/Count 1>>',
        '<</Type/Page/Parent 2 0 R/Resources<</Font<</F1 5 0 R>>>>/MediaBox[0 0 320 130]/Contents 4 0 R>>',
        `<</Length ${content.length}>>\nstream\n${content}\nendstream`,
        '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>'
    ]
    let pdf = '%PDF-1.4\n'
    const offsets = []
    objs.forEach((body, i) => {
        offsets.push(pdf.length)
        pdf += `${i + 1} 0 obj\n${body}\nendobj\n`
    })
    const xref = pdf.length
    pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
    for (const o of offsets) pdf += `${String(o).padStart(10, '0')} 00000 n \n`
    pdf += `trailer\n<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF`
    return new TextEncoder().encode(pdf)
}

// Extension → bytes. Media fixtures contain real, decodable image, audio, and
// video content so every supported Explorer preview can be exercised.
const HTML = '<!doctype html><h1>Report</h1><p>An HTML file rendered in the preview.</p>'
const CODE = {
    txt: 'A plain text file.\nSecond line.\n',
    md: '# Readme\n\n- bullet one\n- bullet two\n\n`inline code`\n',
    csv: 'name,role,age\nAda,admin,36\nGrace,admin,85\n',
    json: JSON.stringify({ name: 'FYLO', kind: 'demo', nested: { ok: true } }, null, 2),
    xml: '<?xml version="1.0"?>\n<root>\n  <item id="1">hello</item>\n</root>\n',
    yaml: 'name: fylo\nfeatures:\n  - buckets\n  - explorer\n',
    log: '[00:00:01] boot\n[00:00:02] ready\n[00:00:03] serving\n',
    js: 'export const add = (a, b) => a + b\nconsole.log(add(2, 3))\n',
    mjs: "import { add } from './add.js'\nexport default add\n",
    ts: 'export function greet(name: string): string {\n  return `hi ${name}`\n}\n',
    jsx: 'export const App = () => <main>hello</main>\n',
    css: '.explorer { display: flex }\n.explorer-row { padding: 0.5rem }\n',
    sh: '#!/bin/sh\nset -e\necho "seeding fylo"\n',
    py: 'def greet(name):\n    return f"hi {name}"\n\nprint(greet("fylo"))\n',
    go: 'package main\n\nimport "fmt"\n\nfunc main() { fmt.Println("fylo") }\n',
    rs: 'fn main() {\n    println!("fylo");\n}\n',
    rb: 'def greet(name)\n  "hi #{name}"\nend\nputs greet("fylo")\n',
    java: 'public class App {\n  public static void main(String[] a) { System.out.println("fylo"); }\n}\n',
    c: '#include <stdio.h>\nint main(){ printf("fylo\\n"); return 0; }\n',
    h: '#ifndef FYLO_H\n#define FYLO_H\nint answer(void);\n#endif\n'
}

/** @type {{ name: string, data: Uint8Array | string }[]} */
const ASSETS = [
    ...MEDIA_ASSETS,
    { name: 'logo.svg', data: LOGO_SVG },
    { name: 'report.pdf', data: makePdf('FYLO demo PDF') },
    { name: 'page.html', data: HTML },
    ...Object.entries(CODE).map(([ext, body]) => ({ name: `file.${ext}`, data: body }))
]

// Scatter every asset across random folder depths.
const FOLDERS = [
    '/',
    '/images/',
    '/images/icons/',
    '/docs/',
    '/docs/2026/',
    '/docs/archive/',
    '/media/',
    '/media/clips/',
    '/code/',
    '/code/src/',
    '/misc/deep/nested/'
]
for (const asset of ASSETS) {
    const folder = FOLDERS[Math.floor(Math.random() * FOLDERS.length)]
    const source = path.join(staging, asset.name)
    await writeFile(source, asset.data)
    await db.putFile('assets', { path: source, key: `${folder}${asset.name}` })
}

const users = await db.inspectCollection('users')
const posts = await db.inspectCollection('posts')
const assets = await db.inspectCollection('assets')
await db.close()
await rm(staging, { recursive: true, force: true })
console.log(`Seeded ${root}`)
console.log(`  users:  ${users.docsStored} documents`)
console.log(`  posts:  ${posts.docsStored} documents`)
console.log(`  assets: ${assets.docsStored} files`)
