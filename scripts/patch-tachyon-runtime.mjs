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
