import { describe, expect, test } from 'bun:test'
import path from 'node:path'

const root = path.resolve(import.meta.dir, '../..')

describe('website language selector', () => {
    test('is a swipeable horizontal strip on narrow screens', async () => {
        const css = await Bun.file(
            path.join(root, 'website/client/components/code/showcase/tac.css')
        ).text()

        expect(css).toMatch(
            /@media \(max-width: 599\.98px\)[\s\S]*\.showcase-langs\s*\{[\s\S]*?flex-wrap:\s*nowrap;[\s\S]*?overflow-x:\s*auto;/
        )
        expect(css).toContain('.showcase-langs::-webkit-scrollbar')
        expect(css).toContain('-webkit-overflow-scrolling: touch')
    })
})

describe('website POSIX access guidance', () => {
    test('explains UID, GID, mode-only writes, and trusted group resolution', async () => {
        const [features, faq, docs] = await Promise.all([
            Bun.file(path.join(root, 'website/client/components/features/grid/tac.js')).text(),
            Bun.file(path.join(root, 'website/client/components/faq/panels/tac.js')).text(),
            Bun.file(path.join(root, 'website/client/components/docs/content/tac.js')).text()
        ])

        expect(features).toContain('POSIX UID/GID/mode enforcement')
        expect(faq).toContain('gid: editorsGid, mode: 0o660')
        expect(faq).toContain('Group write permission')
        expect(faq).toContain('request-scoped virtual groups')
        expect(docs).toContain('groups: [editorsGid]')
        expect(docs).toContain('.as({ uid: 1001, gid: editorsGid, mode: 0o660 })')
        expect(docs).toContain('.as({ mode: 0o600 })')
    })
})

describe('website Explorer release download', () => {
    test('links the versioned self-hosting ZIP from the download table', async () => {
        const version = (await Bun.file('package.json').json()).version
        const [download, header, footer] = await Promise.all([
            Bun.file(path.join(root, 'website/client/components/download/content/tac.js')).text(),
            Bun.file(path.join(root, 'website/client/components/site/header/tac.html')).text(),
            Bun.file(path.join(root, 'website/client/components/site/footer/tac.js')).text()
        ])

        expect(download).toContain(`fylo-explorer-${version}.zip`)
        expect(download).toContain('Web (self-hosted Explorer)')
        expect(header).not.toContain('https://fx.del.ma')
        expect(header).not.toContain('>Explorer</a>')
        expect(footer).toContain("{ label: 'Explorer', href: '/docs/browser', external: false }")
        expect(footer).not.toContain("href: '/explorer'")
    })
})

describe('website mobile touch targets', () => {
    test('keeps navigation and swipeable tabs at least 44px high', async () => {
        const [header, footer, showcase, site] = await Promise.all([
            Bun.file(path.join(root, 'website/client/components/site/header/tac.css')).text(),
            Bun.file(path.join(root, 'website/client/components/site/footer/tac.css')).text(),
            Bun.file(path.join(root, 'website/client/components/code/showcase/tac.css')).text(),
            Bun.file(path.join(root, 'website/client/shared/assets/site.css')).text()
        ])

        expect(header).toMatch(
            /@media \(max-width: 760px\)[\s\S]*min-width:\s*44px;[\s\S]*min-height:\s*44px/
        )
        expect(footer).toMatch(
            /@media \(max-width: 760px\)[\s\S]*min-width:\s*44px;[\s\S]*min-height:\s*44px/
        )
        expect(showcase).toMatch(
            /@media \(max-width: 599\.98px\)[\s\S]*\.showcase-langs \.w-btn[\s\S]*min-width:\s*44px;[\s\S]*min-height:\s*44px/
        )
        expect(site).toMatch(
            /@media \(max-width: 599\.98px\)[\s\S]*\.doc-sample-langs \.w-btn[\s\S]*min-width:\s*44px;[\s\S]*min-height:\s*44px/
        )
    })
})
