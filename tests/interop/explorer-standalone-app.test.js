import { describe, expect, test } from 'bun:test'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const root = path.resolve(import.meta.dir, '../..')
const explorer = path.join(root, 'explorer')
const website = path.join(root, 'website')

async function exists(target) {
    try {
        await stat(target)
        return true
    } catch {
        return false
    }
}

async function run(command, cwd) {
    const process = Bun.spawn(command, {
        cwd,
        env: { ...globalThis.process.env },
        stdout: 'pipe',
        stderr: 'pipe'
    })
    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
        process.exited
    ])
    expect(exitCode, `${stderr}\n${stdout}`).toBe(0)
}

describe('standalone Explorer app', () => {
    test('owns its root page, components, assets, and build commands', async () => {
        const packageJson = await Bun.file(path.join(explorer, 'package.json')).json()
        const page = await Bun.file(path.join(explorer, 'client/pages/tac.html')).text()
        const imports = await Bun.file(
            path.join(explorer, 'client/shared/scripts/imports.js')
        ).text()

        expect(packageJson.scripts.serve).toContain('@d31ma/tachyon/src/cli/index.js serve')
        expect(packageJson.scripts.bundle).toContain('@d31ma/tachyon/src/cli/index.js bundle')
        expect(packageJson.scripts['browser:sync']).toContain('build-browser.mjs --wasm')
        expect(packageJson.scripts['browser:sync']).toContain('sync-explorer-browser-assets.mjs')
        expect(page).toContain('<explorer-app />')
        expect(page).not.toContain('<link')
        expect(page).not.toContain('<script')
        for (const asset of [
            '/shared/assets/duvay/duvay.min.css',
            '/shared/assets/theme.css',
            '/shared/assets/highlight-theme.css',
            '/shared/assets/explorer.css',
            '/shared/assets/fylo-web.mjs',
            '/shared/assets/highlight.min.js',
            '/shared/assets/duvay/duvay-wc.min.js'
        ]) {
            expect(imports).toContain(asset)
        }
        expect(await exists(path.join(explorer, 'client/components/explorer/app/tac.js'))).toBe(
            true
        )
    })

    test('leaves the marketing website free of Explorer source and build gates', async () => {
        const packageJson = await Bun.file(path.join(website, 'package.json')).json()

        expect(await exists(path.join(website, 'client/pages/explorer'))).toBe(false)
        expect(await exists(path.join(website, 'client/components/explorer'))).toBe(false)
        expect(await exists(path.join(website, 'scripts/gate-explorer.mjs'))).toBe(false)
        expect(packageJson.scripts['gate:explorer']).toBeUndefined()
        expect(packageJson.scripts.bundle).not.toContain('gate:explorer')
    })

    test('presents recent roots as one row with a contextual remove action', async () => {
        const app = await Bun.file(
            path.join(explorer, 'client/components/explorer/app/tac.html')
        ).text()
        const styles = await Bun.file(
            path.join(explorer, 'client/shared/assets/explorer.css')
        ).text()

        expect(app).toContain('class="explorer-recent-root"')
        expect(app).toContain('explorer-recent-remove')
        expect(app).toContain("'Remove ' + recent.name + ' from recent roots'")
        expect(app).toContain('does not delete files')
        expect(styles).toContain('.explorer-recent-root:hover .explorer-recent-remove')
        expect(styles).toContain('.explorer-recent-root:focus-within .explorer-recent-remove')
        expect(styles).toContain('@media (hover: none)')
    })

    test('links the standalone Explorer topbar back to Fylo resources', async () => {
        const app = await Bun.file(
            path.join(explorer, 'client/components/explorer/app/tac.html')
        ).text()

        expect(app).toContain('class="explorer-nav"')
        expect(app).toContain('href="https://fylo.del.ma/docs"')
        expect(app).toContain('href="https://fylo.del.ma/download"')
        expect(app).toContain('href="https://github.com/d31ma/Fylo"')
    })

    test('ships real media fixtures for every Explorer preview format', async () => {
        const seed = await Bun.file(path.join(explorer, 'seed.mjs')).text()
        const { rawInfo } = await import(
            pathToFileURL(path.join(explorer, 'client/components/explorer/app/raw-preview.js')).href
        )
        const media = [
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

        expect(seed).not.toContain('demo placeholder')
        expect(rawInfo('video.mov').mime).toBe('video/mp4')
        for (const name of media) {
            const fixture = path.join(explorer, 'fixtures/media', name)
            expect(await exists(fixture), `${name} should exist`).toBe(true)
            expect(
                (await stat(fixture)).size,
                `${name} should contain media bytes`
            ).toBeGreaterThan(1024)
        }
    })

    test('bundles Explorer directly at the app root', async () => {
        await run(['bun', 'run', 'bundle'], explorer)

        const output = path.join(explorer, 'dist/web')
        const index = await Bun.file(path.join(output, 'index.html')).text()
        const imports = await Bun.file(path.join(output, 'imports.js')).text()
        const renderer = await Bun.file(path.join(output, 'spa-renderer.js')).text()

        expect(index).toContain('FX | Fylo Explorer')
        expect(index).not.toContain('/shared/assets/explorer.css')
        expect(imports).toContain('/shared/assets/explorer.css')
        expect(await exists(path.join(output, 'components/explorer/app/tac.js'))).toBe(true)
        expect(await exists(path.join(output, 'explorer/index.html'))).toBe(false)
        expect(renderer).not.toContain('"/explorer"')
    }, 300_000)

    test('pins Tachyon and the generated browser engine for reproducible builds', async () => {
        await run(['bun', 'run', 'build:web'], root)
        const packageJson = await Bun.file(path.join(explorer, 'package.json')).json()
        const lock = await Bun.file(path.join(explorer, 'bun.lock')).text()
        const websitePackage = await Bun.file(path.join(website, 'package.json')).json()
        const websiteLock = await Bun.file(path.join(website, 'bun.lock')).text()
        const browserBundle = await Bun.file(path.join(root, 'dist-web/fylo.mjs')).text()
        const vendoredBundle = await Bun.file(
            path.join(explorer, 'client/shared/assets/fylo-web.mjs')
        ).text()
        const imports = await Bun.file(
            path.join(explorer, 'client/shared/scripts/imports.js')
        ).text()

        const tachyonCommit = '47775135e456cd8db3c80f4dfde0afaf1273296b'
        const pinnedTachyon = `github:d31ma/Tachyon#${tachyonCommit}`
        expect(packageJson.devDependencies['@d31ma/tachyon']).toBe(pinnedTachyon)
        expect(lock).toContain(tachyonCommit.slice(0, 7))
        expect(websitePackage.devDependencies['@d31ma/tachyon']).toBe(pinnedTachyon)
        expect(websiteLock).toContain(tachyonCommit.slice(0, 7))
        expect(vendoredBundle).toBe(browserBundle)
        for (const asset of ['shared.js', 'dedicated.js', 'fylo-index.wasm']) {
            expect(await exists(path.join(explorer, 'client/shared/assets', asset))).toBe(true)
        }
        expect(imports).not.toContain('Date.now()')
        expect(imports).toContain('__FYLO_ASSET_VERSION__')
    })
})
