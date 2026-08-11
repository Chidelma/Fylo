const TITLE = 'Browser & Explorer — FYLO'
document.title = TITLE

export default class {
    loaderCode =
        `<script src="https://d31ma.github.io/FYLO/version/26.33.02/fylo.js"></` + `script>`

    useCode = `const db = await Fylo.open()

const id = await db.users.put({ name: 'Ada', role: 'admin' })
await db.users.put(id).metadata({ source: 'browser', reviewed: false })

const metadata = await db.users.get(id).metadata()
const doc = await db.users.latest(id)`

    wasmCode = `const db = createBrowserClient({ storage: 'opfs', worker: true, wasm: true })
await db.ready()`

    fsaCode = `const handle = await showDirectoryPicker({ mode: 'readwrite' })

const db = createBrowserClient({
    storage: { type: 'fsa', handle, access: 'readwrite' },
    worker: true,
    wasm: true
})
await db.ready()`

    explorerCode = `cd explorer && bun run seed     # optional: demo root at explorer/db
cd explorer && bun run serve    # http://localhost:8080
cd explorer && bun run bundle   # production bundle at explorer/dist/web`

    zipCode = `VERSION=26.33.02
curl -fLO "https://github.com/d31ma/Fylo/releases/download/v\${VERSION}/fylo-explorer-\${VERSION}.zip"
mkdir "fylo-explorer-\${VERSION}"
unzip "fylo-explorer-\${VERSION}.zip" -d "fylo-explorer-\${VERSION}"
python3 -m http.server 8080 --directory "fylo-explorer-\${VERSION}"`
}
