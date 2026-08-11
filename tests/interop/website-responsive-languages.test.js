import { describe, expect, test } from 'bun:test'
import path from 'node:path'
import CodeShowcase from '../../website/client/components/code/showcase/tac.js'
import DocsSample from '../../website/client/components/docs/sample/tac.js'

const root = path.resolve(import.meta.dir, '../..')

describe('website language selector', () => {
    test('is a swipeable horizontal strip on narrow screens', async () => {
        const [css, markup] = await Promise.all([
            Bun.file(path.join(root, 'website/client/components/code/showcase/tac.css')).text(),
            Bun.file(path.join(root, 'website/client/components/code/showcase/tac.html')).text()
        ])

        expect(css).toMatch(
            /@media \(max-width: 599\.98px\)[\s\S]*\.showcase-langs\s*\{[\s\S]*?flex-wrap:\s*nowrap;[\s\S]*?overflow-x:\s*auto;/
        )
        expect(css).toContain('.showcase-langs::-webkit-scrollbar')
        expect(css).toContain('-webkit-overflow-scrolling: touch')
        expect(markup.match(/role="group"/g)).toHaveLength(2)
        expect(markup.match(/aria-pressed=/g)).toHaveLength(16)
        expect(markup).not.toContain('role="tab"')
        expect(markup).not.toContain('role="tablist"')
        expect(markup).toContain('aria-live="polite"')

        const showcase = new CodeShowcase()
        showcase.$lang = 'web'
        expect(showcase.quickstartCode()).toContain('<script type="module">')
        expect(showcase.quickstartCode()).toContain('const db = await Fylo.open({ wasm: true })')
        expect(showcase.quickstartCode()).toContain('</script>')
    })
})

describe('website template companion state', () => {
    test('keeps static feature and FAQ content out of shipped controllers', async () => {
        const features = await Bun.file('website/client/components/features/grid/tac.js').text()
        const faq = await Bun.file('website/client/components/faq/panels/tac.js').text()
        expect(features).not.toContain('features =')
        expect(faq).not.toContain('faqs =')
    })
})

describe('website POSIX access guidance', () => {
    test('explains UID, GID, mode-only writes, and trusted group resolution', async () => {
        const [features, faq, docs] = await Promise.all([
            Bun.file(path.join(root, 'website/client/components/features/grid/tac.html')).text(),
            Bun.file(path.join(root, 'website/client/components/faq/panels/tac.html')).text(),
            Bun.file(path.join(root, 'website/client/components/docs/content/tac.js')).text()
        ])

        expect(features).toMatch(/POSIX\s+UID\/GID\/mode enforcement/)
        expect(faq).toContain('gid: editorsGid, mode: 0o660')
        expect(faq).toContain('Group write permission')
        expect(faq).toContain('request-scoped virtual groups')
        expect(docs).toContain('groups: [editorsGid]')
        expect(docs).toContain('.as({ uid: 1001, gid: editorsGid, mode: 0o660 })')
        expect(docs).toContain('.as({ mode: 0o600 })')
    })
})

describe('website child-scoped FYLO configuration', () => {
    test('documents every binary shim and the nested-application isolation model', async () => {
        const [sample, sampleMarkup, clients, operations, features, faq, browserEntry] =
            await Promise.all([
                Bun.file(path.join(root, 'website/client/components/docs/sample/tac.js')).text(),
                Bun.file(path.join(root, 'website/client/components/docs/sample/tac.html')).text(),
                Bun.file(path.join(root, 'website/client/pages/docs/clients/tac.html')).text(),
                Bun.file(path.join(root, 'website/client/pages/docs/operations/tac.html')).text(),
                Bun.file(
                    path.join(root, 'website/client/components/features/grid/tac.html')
                ).text(),
                Bun.file(path.join(root, 'website/client/components/faq/panels/tac.html')).text(),
                Bun.file(path.join(root, 'website/client/shared/scripts/imports.js')).text()
            ])

        for (const marker of [
            'with Fylo(',
            'Fylo.open(',
            'new Fylo(',
            'OpenWithOptions',
            'open_with_options',
            'new Fylo.Fylo(',
            'Fylo.Options options',
            'final db = await Fylo.open('
        ]) {
            expect(sample).toContain(marker)
        }
        expect(clients).toContain('<docs-sample topic="environment" hydrate="load" />')
        expect(clients).toContain('FYLO_SHARD_WIDTH=2')
        expect(operations).toContain('<code>FYLO_SHARD_WIDTH</code>')
        expect(operations).toMatch(
            /<td><code>FYLO_SHARD_WIDTH<\/code><\/td>[\s\S]*?<td><code>1<\/code><\/td>/
        )
        expect(operations).not.toContain('<code>FYLO_LOGGING</code>')
        expect(operations).toContain('Resolution and isolation')
        expect(operations).toMatch(/without\s+changing global environment state/)
        expect(features).toContain('independently configured roots can share one application')
        expect(faq).toContain('Can one application run multiple FYLO configurations?')
        expect(faq).toContain('without mutating the host process')
        expect(features).toContain('Encryption &amp; POSTIX access')
        expect(sampleMarkup).toContain('role="group" aria-label="Language"')
        expect(sampleMarkup).not.toContain('role="tab"')
        expect(sampleMarkup).not.toContain('role="tablist"')
        expect(sampleMarkup.match(/aria-pressed=/g)).toHaveLength(13)
        expect(browserEntry).toContain('requestAnimationFrame(revealLanguageSelections)')
        expect(browserEntry).toContain('strip.querySelector(\'[aria-pressed="true"]\')')
        expect(faq.match(/aria-controls="faq-[^"]+-answer"/g)).toHaveLength(8)
        expect(faq.match(/role="region"/g)).toHaveLength(8)
        expect(clients).toContain('trusted bootstrap configuration')
        expect(clients).toContain('absolute, administrator-controlled binary path')
        expect(operations).toMatch(/Never\s+derive either from a request/)

        const restoredButtons = ['python', 'ruby'].map((lang) => ({
            dataset: { lang },
            className: '',
            pressed: '',
            setAttribute(name, value) {
                if (name === 'aria-pressed') this.pressed = value
            }
        }))
        const restoredSample = new DocsSample({ topic: 'environment' })
        restoredSample.$lang = 'ruby'
        restoredSample.hydrate({ querySelectorAll: () => restoredButtons })
        expect(restoredButtons.map(({ pressed }) => pressed)).toEqual(['false', 'true'])

        const browserCrud = new DocsSample({ topic: 'crud' })
        browserCrud.$lang = 'web'
        expect(browserCrud.code()).toContain('await db.users.create()')
        expect(browserCrud.code()).toContain('await db.users.put(')
        expect(browserCrud.code()).toContain('await db.users.get(')
        expect(browserCrud.code()).toContain('await db.users.patch(')
        expect(browserCrud.code()).toContain('await db.users.delete(')

        const browserEnvironment = new DocsSample({ topic: 'environment' })
        browserEnvironment.$lang = 'web'
        expect(browserEnvironment.code()).toContain(
            'https://d31ma.github.io/FYLO/version/26.33.02/fylo.js'
        )
        expect(browserEnvironment.code()).toContain('const db = await Fylo.open({')
        expect(browserEnvironment.code()).toContain('<script type="module">')
        expect(browserEnvironment.code()).not.toContain('createBrowserClient(')

        const dartEnvironment = new DocsSample({ topic: 'environment' })
        dartEnvironment.$lang = 'dart'
        expect(dartEnvironment.code()).toContain('Future<void> main() async {')

        const flutterEnvironment = new DocsSample({ topic: 'environment' })
        flutterEnvironment.$lang = 'flutter'
        expect(flutterEnvironment.code()).toContain('Future<void> configureFylo() async {')
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
                Bun.file(path.join(root, 'website/client/components/features/grid/tac.html')).text()
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
        for (const [css, selector] of [
            [showcase, '.showcase-langs .w-btn'],
            [site, '.doc-sample-langs .w-btn']
        ]) {
            expect(css).toContain('@media (hover: none) and (pointer: coarse)')
            expect(css).toContain(selector)
            expect(css).toMatch(/min-width:\s*44px;[\s\S]*min-height:\s*44px/)
        }
    })
})
