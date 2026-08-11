import path from 'node:path'

const project = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd()
const web = path.join(project, 'dist', 'web')
const runtime = path.join(web, '.tachyon', 'islands.js')
const source = await Bun.file(runtime).text()

const loop = `  for (const marker of root.querySelectorAll('tachyon-expr[data-tachyon-expression]')) {
`
const scopedLoop = `${loop}    if (marker.closest('tachyon-island') !== root) continue
`

if (source.includes(scopedLoop)) {
    console.log('Tachyon nested-island expression ownership is already patched')
} else if (!source.includes(loop)) {
    throw new Error(
        'Tachyon islands runtime changed; refusing to apply the 26.33.01 nested-island patch'
    )
} else {
    await Bun.write(runtime, source.replace(loop, scopedLoop))
    console.log('Patched Tachyon 26.33.01 nested-island expression ownership')
}

const browserEntry = '<script type="module" src="/shared/scripts/imports.js"></script>'
let documents = 0
for await (const relative of new Bun.Glob('**/*.html').scan({ cwd: web })) {
    const file = path.join(web, relative)
    const html = await Bun.file(file).text()
    if (html.includes(browserEntry)) continue
    if (!html.includes('</body>')) throw new Error(`Generated HTML has no </body>: ${relative}`)
    await Bun.write(file, html.replace('</body>', `${browserEntry}</body>`))
    documents++
}
console.log(`Added the shared browser entry to ${documents} generated routes`)

const serviceWorkerFile = path.join(web, 'tachyon-sw.js')
const serviceWorker = await Bun.file(serviceWorkerFile).text()
const staticAssetPattern =
    'const STATIC = /\\.(?:avif|css|gif|ico|jpe?g|js|json|mjs|mp3|mp4|ogg|otf|png|svg|ttf|wasm|webm|webp|woff2?)$/i\n\n'
const cacheFirstFetch = `  // A navigation stays network-first so a deployment is picked up at once,
  // with the cache as the offline fallback. A versioned static asset cannot
  // change under its own URL, so it is served cache-first.
  const cacheFirst = STATIC.test(url.pathname) && request.mode !== 'navigate'
  event.respondWith(cacheFirst ? fromCache(request) : fromNetwork(request))
})

async function fromCache(request) {
  const cache = await caches.open(CACHE)
  return (await cache.match(request)) || fromNetwork(request)
}
`
const networkFirstFetch = `  // Generated asset paths are stable across releases. Always check the network
  // first so a controlling worker cannot combine new HTML with stale runtime
  // JavaScript. The versioned cache remains an offline-only fallback.
  event.respondWith(fromNetwork(request))
})
`

if (
    serviceWorker.includes(networkFirstFetch) &&
    !serviceWorker.includes(staticAssetPattern) &&
    !serviceWorker.includes('async function fromCache(request)')
) {
    console.log('Tachyon service worker is already patched for network-first assets')
} else if (
    !serviceWorker.includes(staticAssetPattern) ||
    !serviceWorker.includes(cacheFirstFetch) ||
    !serviceWorker.includes("if (url.pathname.startsWith('/.tachyon/live-reload')) return") ||
    !serviceWorker.includes(
        'if (name.startsWith(PREFIX) && name !== CACHE) await caches.delete(name)'
    )
) {
    throw new Error(
        'Tachyon service worker changed; refusing to apply the 26.33.01 network-first patch'
    )
} else {
    await Bun.write(
        serviceWorkerFile,
        serviceWorker.replace(staticAssetPattern, '').replace(cacheFirstFetch, networkFirstFetch)
    )
    console.log('Patched Tachyon 26.33.01 service worker for network-first assets')
}
