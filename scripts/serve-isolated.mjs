// Static server that makes the page cross-origin isolated.
//
// `SharedArrayBuffer` — and therefore the `Atomics.wait` bridge OPFS needs — is
// unavailable unless the document is cross-origin isolated, which requires both
// headers below. Python's `http.server` sends neither, so the browser gate
// cannot use it.

import { createReadStream, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize, resolve } from 'node:path'

const root = resolve(process.argv[3] ?? '.')
const port = Number(process.argv[2] ?? 4173)

const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.wasm': 'application/wasm'
}

createServer((request, response) => {
    // Containment: a joined path that escapes the root is refused rather than
    // served, so the gate cannot read the machine it runs on.
    const requested = decodeURIComponent((request.url ?? '/').split('?')[0])
    const path = join(root, normalize(requested).replace(/^(\.\.[/\\])+/, ''))
    if (!path.startsWith(root)) {
        response.writeHead(403).end('forbidden')
        return
    }
    let stats
    try {
        stats = statSync(path)
    } catch {
        response.writeHead(404).end('not found')
        return
    }
    if (stats.isDirectory()) {
        response.writeHead(404).end('not found')
        return
    }
    response.writeHead(200, {
        'Content-Type': TYPES[extname(path)] ?? 'application/octet-stream',
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'Cross-Origin-Resource-Policy': 'same-origin',
        'Cache-Control': 'no-store'
    })
    createReadStream(path).pipe(response)
}).listen(port, '127.0.0.1', () => {
    console.log(`serving ${root} cross-origin isolated on http://127.0.0.1:${port}`)
})
