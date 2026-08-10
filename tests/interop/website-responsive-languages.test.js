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

describe('website serverless queue guidance', () => {
    test('documents bounded decorator invocations without implying a hidden poll loop', async () => {
        const [protocolHtml, protocolJs, queueHtml, queueJs, nav, imports, features] =
            await Promise.all([
                Bun.file(path.join(root, 'website/client/pages/docs/protocol/tac.html')).text(),
                Bun.file(path.join(root, 'website/client/pages/docs/protocol/tac.js')).text(),
                Bun.file(path.join(root, 'website/client/pages/docs/queue/tac.html')).text(),
                Bun.file(path.join(root, 'website/client/pages/docs/queue/tac.js')).text(),
                Bun.file(path.join(root, 'website/client/components/docs/nav/tac.html')).text(),
                Bun.file(path.join(root, 'website/client/shared/scripts/imports.js')).text(),
                Bun.file(path.join(root, 'website/client/components/features/grid/tac.js')).text()
            ])

        expect(protocolHtml).toContain('consumer decorator, annotation, or callable')
        expect(protocolHtml).toContain('one bounded batch')
        expect(protocolJs).toContain("db.queue.consumer('email.welcome', 'email-service'")
        expect(queueHtml).toContain('Serverless does not mean distributed multi-writer storage')
        expect(queueHtml).toContain('Seven machine operations')
        expect(queueHtml).toContain('One-batch consumer decorators')
        expect(queueHtml).toContain('Browser and')
        expect(queueHtml).toContain('do not advertise the')
        expect(queueHtml).toMatch(/1,000 most recently acknowledged\s+ID\/receipt\s+pairs/)
        expect(queueHtml).toMatch(/64 MiB of aggregate\s+message-file scan\s+work/)
        expect(queueJs).toContain('@db.queue_consumer(')
        expect(queueJs).toContain('One bounded serverless invocation')
        expect(nav).toContain('<a href="/docs/queue">Serverless queue</a>')
        expect(imports).toContain("'/docs/queue': 'Serverless queue — FYLO'")
        expect(features).toContain('Serverless without a broker')
    })

    test('canonical queue examples never persist raw exception text', async () => {
        const readme = await Bun.file(path.join(root, 'README.md')).text()
        const queueGuide = readme.match(/## Serverless Queue([\s\S]*?)### Machine Interface/)?.[1]

        expect(queueGuide).toBeDefined()
        expect(queueGuide?.match(/receipt-key\.json/g)).toHaveLength(1)
        expect(queueGuide).toMatch(
            /reason:\s*(?:['"]queue handler failed['"]|(?:sanitize|safe)\w*Reason\(error\))/i
        )
        expect(queueGuide).not.toMatch(
            /reason:\s*(?:String\(error\)|error(?:\.message|\.toString\(\))?|`[^`]*\$\{error(?:\.message)?\}[^`]*`)/
        )
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
