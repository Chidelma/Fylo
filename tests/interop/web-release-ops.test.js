import { describe, expect, test } from 'bun:test'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { createWebArtifact } from '../../scripts/web-artifact.mjs'
import { verifyPagesRelease } from '../../scripts/pages-smoke.mjs'
import { smokeSite } from '../../scripts/web-smoke.mjs'

const execFileAsync = promisify(execFile)

describe('web release operations', () => {
    test('creates checksum-addressed deterministic artifacts', async () => {
        const temporary = await mkdtemp(path.join(os.tmpdir(), 'fylo-artifact-test-'))
        try {
            const source = path.join(temporary, 'web')
            await mkdir(path.join(source, 'assets'), { recursive: true })
            await writeFile(path.join(source, 'index.html'), '<h1>Fylo</h1>')
            await writeFile(path.join(source, 'assets', 'app.js'), 'export default 1')
            const first = await createWebArtifact(source, path.join(temporary, 'one'))
            await writeFile(path.join(source, 'index.html'), '<h1>Fylo</h1>')
            const second = await createWebArtifact(source, path.join(temporary, 'two'))
            expect(first.checksum).toBe(second.checksum)
            expect(path.basename(first.output)).toBe(`${first.checksum}.zip`)
            expect(first.files).toBe(2)
        } finally {
            await rm(temporary, { recursive: true, force: true })
        }
    })

    test('refuses symlinks in deployment artifacts', async () => {
        const temporary = await mkdtemp(path.join(os.tmpdir(), 'fylo-artifact-link-test-'))
        try {
            await writeFile(path.join(temporary, 'index.html'), 'Fylo')
            await symlink(path.join(temporary, 'index.html'), path.join(temporary, 'alias.html'))
            await expect(createWebArtifact(temporary, path.join(temporary, 'out'))).rejects.toThrow(
                'Refusing symlink'
            )
        } finally {
            await rm(temporary, { recursive: true, force: true })
        }
    })

    test('web artifacts place the hostable site at the ZIP root', async () => {
        const temporary = await mkdtemp(path.join(os.tmpdir(), 'fylo-artifact-root-test-'))
        try {
            const source = path.join(temporary, 'web')
            await mkdir(path.join(source, 'shared', 'assets'), { recursive: true })
            await writeFile(path.join(source, 'index.html'), '<title>FX | Fylo Explorer</title>')
            await writeFile(path.join(source, 'shared', 'assets', 'app.js'), 'export default 1')
            const artifact = await createWebArtifact(source, path.join(temporary, 'release'))
            const { stdout } = await execFileAsync('unzip', ['-Z1', artifact.output])
            const files = stdout.trim().split('\n')

            expect(files).toContain('index.html')
            expect(files).toContain('shared/assets/app.js')
            expect(files).not.toContain('web/index.html')
        } finally {
            await rm(temporary, { recursive: true, force: true })
        }
    })

    test('verifies immutable and latest Pages assets, checksums, and equality', async () => {
        const files = new Map([
            ['fylo.js', 'loader'],
            ['fylo-web.mjs', 'engine'],
            ['shared.js', 'shared-worker'],
            ['dedicated.js', 'dedicated-worker'],
            ['fylo-index.wasm', 'wasm-scanner']
        ])
        const hashes = await Promise.all(
            [...files].map(async ([name, body]) => [
                name,
                new Bun.CryptoHasher('sha256').update(body).digest('hex')
            ])
        )
        const manifest = hashes.map(([name, hash]) => `${hash}  ${name}`).join('\n')
        const fetcher = async (input) => {
            const name = new URL(input).pathname.split('/').at(-1)
            const body = name === 'SHA256SUMS' ? manifest : files.get(name)
            return new Response(body, { status: body === undefined ? 404 : 200 })
        }
        await expect(
            verifyPagesRelease('https://pages.example/Fylo/', '26.29.03', fetcher)
        ).resolves.toEqual({
            version: '26.29.03',
            files: ['fylo.js', 'fylo-web.mjs', 'shared.js', 'dedicated.js', 'fylo-index.wasm']
        })
    })

    test('rejects stale latest Pages assets even when both manifests are internally valid', async () => {
        const immutable = new Map([
            ['fylo.js', 'loader'],
            ['fylo-web.mjs', 'engine'],
            ['shared.js', 'shared-worker'],
            ['dedicated.js', 'dedicated-worker'],
            ['fylo-index.wasm', 'wasm-scanner']
        ])
        const latest = new Map(immutable)
        latest.set('fylo-web.mjs', 'stale-engine')
        const manifestFor = (files) =>
            [...files]
                .map(
                    ([name, body]) =>
                        `${new Bun.CryptoHasher('sha256').update(body).digest('hex')}  ${name}`
                )
                .join('\n')
        const fetcher = async (input) => {
            const pathname = new URL(input).pathname
            const files = pathname.includes('/version/latest/') ? latest : immutable
            const name = pathname.split('/').at(-1)
            return new Response(name === 'SHA256SUMS' ? manifestFor(files) : files.get(name))
        }

        await expect(
            verifyPagesRelease('https://pages.example/Fylo/', '26.29.03', fetcher)
        ).rejects.toThrow('latest fylo-web.mjs differs from immutable 26.29.03')
    })

    test('rejects a missing latest Pages asset', async () => {
        const files = new Map([
            ['fylo.js', 'loader'],
            ['fylo-web.mjs', 'engine'],
            ['shared.js', 'shared-worker'],
            ['dedicated.js', 'dedicated-worker'],
            ['fylo-index.wasm', 'wasm-scanner']
        ])
        const manifest = [...files]
            .map(
                ([name, body]) =>
                    `${new Bun.CryptoHasher('sha256').update(body).digest('hex')}  ${name}`
            )
            .join('\n')
        const fetcher = async (input) => {
            const pathname = new URL(input).pathname
            const name = pathname.split('/').at(-1)
            if (pathname.includes('/version/latest/') && name === 'fylo-web.mjs') {
                return new Response('missing', { status: 404 })
            }
            return new Response(name === 'SHA256SUMS' ? manifest : files.get(name))
        }

        await expect(
            verifyPagesRelease('https://pages.example/Fylo/', '26.29.03', fetcher)
        ).rejects.toThrow('latest fylo-web.mjs returned HTTP 404')
    })

    test('fails a site smoke check when the marker is absent', async () => {
        const site = { origin: 'https://fylo.example', probes: [{ path: '/', contains: 'FYLO' }] }
        await expect(smokeSite(site, async () => new Response('wrong'))).rejects.toThrow(
            'expected marker'
        )
    })

    test('verifies configured CSS, JavaScript, component, worker, and Wasm assets', async () => {
        const site = {
            origin: 'https://fx.example',
            probes: [
                { path: '/', contains: 'Explorer', contentTypes: ['text/html'] },
                {
                    path: '/shared/assets/explorer.css',
                    contains: '.explorer',
                    contentTypes: ['text/css']
                },
                {
                    path: '/imports.js',
                    contains: 'shared/assets/fylo-web.mjs',
                    contentTypes: ['application/javascript']
                },
                {
                    path: '/components/explorer/app/tac.js',
                    contains: 'class Explorer',
                    contentTypes: ['application/javascript']
                },
                {
                    path: '/shared/assets/shared.js',
                    contains: 'src/browser/worker/shared.js',
                    contentTypes: ['application/javascript']
                },
                {
                    path: '/shared/assets/fylo-index.wasm',
                    startsWithHex: '0061736d',
                    contentTypes: ['application/wasm']
                }
            ]
        }
        const assets = new Map([
            ['/', ['<title>Explorer</title>', 'text/html; charset=utf-8']],
            ['/shared/assets/explorer.css', ['.explorer {}', 'text/css']],
            ['/imports.js', ["import('/shared/assets/fylo-web.mjs')", 'application/javascript']],
            [
                '/components/explorer/app/tac.js',
                ['export class Explorer {}', 'application/javascript']
            ],
            [
                '/shared/assets/shared.js',
                ['// src/browser/worker/shared.js', 'application/javascript']
            ],
            [
                '/shared/assets/fylo-index.wasm',
                [Uint8Array.from([0x00, 0x61, 0x73, 0x6d, 0x01]), 'application/wasm']
            ]
        ])
        const fetcher = async (input) => {
            const asset = assets.get(new URL(input).pathname)
            return asset
                ? new Response(asset[0], { headers: { 'content-type': asset[1] } })
                : new Response('missing', { status: 404 })
        }

        await expect(smokeSite(site, fetcher)).resolves.toHaveLength(site.probes.length)
    })

    test('rejects stripped assets before deployment can be marked current', async () => {
        const site = {
            origin: 'https://fx.example',
            probes: [
                {
                    path: '/shared/assets/explorer.css',
                    contains: '.explorer',
                    contentTypes: ['text/css']
                }
            ]
        }

        await expect(
            smokeSite(
                site,
                async () =>
                    new Response('<!doctype html><title>SPA fallback</title>', {
                        headers: { 'content-type': 'text/html' }
                    })
            )
        ).rejects.toThrow('unexpected content type')
    })

    test('production probe manifests accept complete FYLO and FXP bundles', async () => {
        const config = await Bun.file('ops/web-release.json').json()
        const root = path.resolve(import.meta.dir, '../..')
        await execFileAsync('bun', ['run', 'bundle'], { cwd: path.join(root, 'website') })
        await execFileAsync('bun', ['run', 'bundle'], { cwd: path.join(root, 'explorer') })

        const homepage = await Bun.file(path.join(root, 'website/dist/web/index.html')).text()
        const mime = new Map([
            ['.css', 'text/css'],
            ['.html', 'text/html'],
            ['.js', 'application/javascript'],
            ['.mjs', 'application/javascript'],
            ['.wasm', 'application/wasm']
        ])
        const staticFetcher = (directory) => async (input) => {
            let relative = new URL(input).pathname.slice(1)
            if (!relative || !path.extname(relative)) relative = path.join(relative, 'index.html')
            const file = Bun.file(path.join(directory, relative))
            if (!(await file.exists())) return new Response('missing', { status: 404 })
            return new Response(await file.arrayBuffer(), {
                headers: { 'content-type': mime.get(path.extname(relative)) ?? 'text/plain' }
            })
        }
        const websiteFetcher = staticFetcher(path.join(root, 'website/dist/web'))
        const explorerFetcher = staticFetcher(path.join(root, 'explorer/dist/web'))

        await expect(smokeSite(config.sites.fylo, websiteFetcher)).resolves.toHaveLength(
            config.sites.fylo.probes.length
        )
        await expect(
            smokeSite(config.sites.fxp, async (input) => {
                if (new URL(input).pathname === '/') {
                    return new Response(homepage, { headers: { 'content-type': 'text/html' } })
                }
                return explorerFetcher(input)
            })
        ).rejects.toThrow('expected marker')
        await expect(smokeSite(config.sites.fxp, explorerFetcher)).resolves.toHaveLength(
            config.sites.fxp.probes.length
        )
    })

    test('keeps operational runbooks available to a clean checkout', async () => {
        const runbooks = ['docs/operations/web-release.md']
        for (const runbook of runbooks) {
            await expect(Bun.file(runbook).exists()).resolves.toBe(true)
            await expect(
                execFileAsync('git', ['check-ignore', '--no-index', '--quiet', runbook], {
                    cwd: path.resolve(import.meta.dir, '../..')
                })
            ).rejects.toMatchObject({ code: 1 })
        }
    })

    test('wires Pages post-deploy verification and documents rollback', async () => {
        const workflow = await Bun.file('.github/workflows/pages.yml').text()
        const runbook = await Bun.file('docs/operations/web-release.md').text()
        expect(workflow).toContain('bun scripts/pages-smoke.mjs')
        expect(runbook).toContain('git revert <bad-gh-pages-commit>')
        expect(runbook).toContain('bun scripts/amplify-release.mjs rollback fylo')
        expect(runbook).toContain('bun scripts/amplify-release.mjs rollback fxp')
    })

    test('installs every web workspace before compiled interop bundles run', async () => {
        for (const path of ['.github/workflows/ci.yml', '.github/workflows/publish.yml']) {
            const workflow = await Bun.file(path).text()
            const index = workflow.indexOf('    binary-interop:')
            expect(index).toBeGreaterThan(-1)
            const binaryInterop = workflow.slice(index)

            expect(binaryInterop).toContain('(cd website && bun install --frozen-lockfile)')
            expect(binaryInterop).toContain('(cd explorer && bun install --frozen-lockfile)')
            expect(
                binaryInterop.indexOf('(cd website && bun install --frozen-lockfile)')
            ).toBeLessThan(binaryInterop.indexOf('bun run test:interop'))
            expect(
                binaryInterop.indexOf('(cd explorer && bun install --frozen-lockfile)')
            ).toBeLessThan(binaryInterop.indexOf('bun run test:interop'))
        }
    })

    test('uses one pinned Bun and Rust toolchain for every browser release path', async () => {
        const bunVersion = (await Bun.file('.bun-version').text()).trim()
        const rustToolchain = await Bun.file('rust-toolchain.toml').text()
        const build = await Bun.file('scripts/build-browser.mjs').text()
        const rootPackage = await Bun.file('package.json').json()
        const websitePackage = await Bun.file('website/package.json').json()
        const explorerPackage = await Bun.file('explorer/package.json').json()

        expect(bunVersion).toBe('1.3.11')
        expect(rustToolchain).toContain('channel = "1.97.1"')
        expect(rustToolchain).toContain('targets = ["wasm32-unknown-unknown"]')
        expect(build).toContain("readFile(new URL('../.bun-version'")
        expect(build).toContain("readFile(new URL('../rust-toolchain.toml'")
        expect(build).toContain("'--locked'")
        for (const packageJson of [rootPackage, websitePackage, explorerPackage]) {
            expect(packageJson.packageManager).toBe(`bun@${bunVersion}`)
        }
        for (const workflowPath of ['.github/workflows/ci.yml', '.github/workflows/publish.yml']) {
            const workflow = await Bun.file(workflowPath).text()
            expect(workflow).not.toContain('bun-version: latest')
            expect(workflow).toContain('bun-version-file: .bun-version')
        }
    })

    test('pins both Amplify targets and preserves checksum-verified rollback artifacts', async () => {
        const config = await Bun.file('ops/web-release.json').json()
        const release = await Bun.file('scripts/amplify-release.mjs').text()
        expect(config.sites.fylo).toMatchObject({
            appId: 'dhq9jgfyq7uv2',
            origin: 'https://fylo.del.ma'
        })
        expect(config.sites.fxp).toMatchObject({
            appId: 'dnjtojrhwtus2',
            origin: 'https://fx.del.ma'
        })
        expect(release).toContain("'create-deployment'")
        expect(release).toContain("'start-deployment'")
        expect(release).toContain("'get-job'")
        expect(release).toContain('Archived artifact checksum mismatch')
        expect(release).toContain('Deployment failed; restoring')
        expect(release).toContain('rollback verification also failed')
        expect(release).toContain('previousChecksum')
        expect(release).toContain('verifiedProbeCount')
    })
})
