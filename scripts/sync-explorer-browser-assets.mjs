import { chmod, copyFile, mkdir, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const source = new URL('../dist-web/', import.meta.url)
const destination = new URL('../explorer/client/shared/assets/', import.meta.url)

await mkdir(destination, { recursive: true })
for (const [from, to = from] of [
    ['fylo.mjs', 'fylo-web.mjs'],
    ['shared.js'],
    ['dedicated.js'],
    ['fylo-index.wasm']
]) {
    const output = new URL(to, destination)
    // Replace instead of copying over the prior artifact. File Provider roots
    // may evict generated binaries; copyfile() otherwise tries to inspect the
    // dataless destination and can time out before publishing the new build.
    await rm(output, { force: true })
    await copyFile(new URL(from, source), output)
    await chmod(output, 0o644)
}

console.log(`Synced browser engine assets into ${root}explorer/client/shared/assets`)
