import { describe, expect, test } from 'bun:test'
import path from 'node:path'

const root = path.resolve(import.meta.dir, '../..')

describe('GitHub Pages browser client publishing', () => {
    test('publishes latest and immutable browser client paths after a release', async () => {
        const workflow = await Bun.file(path.join(root, '.github/workflows/pages.yml')).text()

        expect(workflow).toContain('workflows: [Release]')
        expect(workflow).toContain('site/version/latest')
        expect(workflow).toContain('site/version/$VERSION')
        expect(workflow).toContain('source/dist-web/fylo.mjs')
        expect(workflow).toContain('source/dist-web/shared.js')
        expect(workflow).toContain('source/dist-web/dedicated.js')
        expect(workflow).toContain('source/dist-web/fylo-index.wasm')
        expect(workflow).toContain('source/clients/browser/fylo.js')
        expect(workflow).toContain('source/website/client/shared/assets/install.sh')
        expect(workflow).toContain('source/website/client/shared/assets/install.ps1')
        expect(workflow).toContain('site/install.sh')
        expect(workflow).toContain('site/install.ps1')
        expect(workflow).toContain('Verify published release')
        expect(workflow).toContain('release_ref:')
        expect(workflow).toContain('inputs.release_ref')
        expect(workflow).toContain('SOURCE_SHA: ${{ steps.package.outputs.sha }}')
        expect(workflow).toContain('::error::Refusing Pages publish')
        expect(workflow).not.toContain('Skipping Pages publish')
        expect(workflow).toContain('version: ${{ steps.package.outputs.version }}')
        expect(workflow).toContain('ref: ${{ github.sha }}')
        expect(workflow).toContain(
            'bun scripts/pages-smoke.mjs "${{ needs.build.outputs.version }}"'
        )
        expect(workflow.match(/persist-credentials: false/g) || []).toHaveLength(2)
        expect(workflow).toContain('GH_TOKEN: ${{ github.token }}')
        expect(workflow).toContain('gh auth setup-git')
        expect(workflow).toContain('needs: [build, deploy]')
        expect(workflow).toContain('assert_managed_directory "$immutable"')
        expect(workflow).toContain('assert_managed_file "$immutable/$asset"')
        expect(workflow).toContain('Refusing managed directory symlink')
        expect(workflow).toContain('Refusing managed file symlink')
        expect(workflow).toContain(`bun -p 'require("./package.json").version'`)
        expect(workflow).not.toContain(`require(\\"./package.json\\")`)
        expect(workflow).toContain("if: needs.build.outputs.should_publish == 'true'")
        expect(workflow).toContain(
            'actions/configure-pages@983d7736d9b0ae728b81ab479565c72886d7745b'
        )
        expect(workflow).toContain(
            'actions/upload-pages-artifact@7b1f4a764d45c48632c6b24a0339c27f5614fb0b'
        )
        expect(workflow).toContain('actions/deploy-pages@d6db90164ac5ed86f2b6aed7e0febac5b3c0c03e')
        expect(workflow).not.toMatch(/uses:\s+[^\s]+@v\d+/)
        expect(workflow).toContain('bun-version-file: source/.bun-version')
        expect(workflow).toContain('bun-version-file: .bun-version')
        expect(workflow).not.toContain('bun-version: latest')
        expect(workflow).toContain('permissions: {}')
        expect(workflow).toContain('contents: write')
        expect(workflow).toContain('Refusing to overwrite immutable $immutable')
        expect(workflow).toContain('cmp -s "$candidate/$asset" "$immutable/$asset"')
    })

    test('ships a head-tag loader beside the browser engine module', async () => {
        const loader = await Bun.file(path.join(root, 'clients/browser/fylo.js')).text()

        expect(loader).toContain("new URL('./fylo-web.mjs'")
        expect(loader).toContain('module.createBrowserClient(options)')
        expect(loader).toContain('await client.ready()')
        expect(loader).toContain('global.Fylo = Object.freeze')
    })

    test('documents both pinned and latest Pages URLs', async () => {
        const clients = await Bun.file(path.join(root, 'clients/README.md')).text()

        expect(clients).toContain('https://d31ma.github.io/FYLO/version/26.32.07/fylo.js')
        expect(clients).toContain('https://d31ma.github.io/FYLO/version/latest/fylo.js')
    })

    test('keeps website browser examples aligned with the Pages loader', async () => {
        const examples = await Promise.all([
            Bun.file(path.join(root, 'website/client/components/docs/content/tac.js')).text(),
            Bun.file(path.join(root, 'website/client/components/code/showcase/tac.js')).text()
        ])

        for (const example of examples) {
            expect(example).toContain('https://d31ma.github.io/FYLO/version/26.32.07/fylo.js')
            expect(example).toContain('const db = await Fylo.open({ wasm: true })')
            expect(example).not.toContain("createBrowserClient } from './fylo-web.mjs'")
        }
    })

    test('pins every website release reference to the current version', async () => {
        // The loader-alignment test above covers two components by name. These
        // three carry the same version and were drifting unguarded: the browser
        // page shipped a 26.30.04 loader while the rest of the site said
        // 26.32.07, and the download page names the Explorer zip by version
        // under a /latest/download/ URL, so a missed bump 404s it.
        const pinned = await Promise.all(
            [
                'website/client/components/docs/sample/tac.js',
                'website/client/pages/docs/browser/tac.js',
                'website/client/components/download/content/tac.js'
            ].map((file) => Bun.file(path.join(root, file)).text())
        )

        for (const source of pinned) {
            const stale = source.match(/26\.\d+\.\d+/g)?.filter((v) => v !== '26.32.07') ?? []
            expect(stale).toEqual([])
        }
    })

    test('promotes both installers into every marketing-site build artifact', async () => {
        const buildScript = await Bun.file(path.join(root, 'scripts/fingerprint-assets.mjs')).text()

        expect(buildScript).toContain("['install.sh', 'install.ps1']")
        expect(buildScript).toContain('path.join(output, installer)')
    })
})
