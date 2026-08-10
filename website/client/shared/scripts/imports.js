// Browser entry — owns the theme lifecycle and injects favicon + SEO metadata
// into the generated shell. The site is authored entirely with DuVay's CSS
// classes (no web components), so only duvay.min.css is needed.
const THEME_KEY = 'w-theme'
const THEME_ICON = { dark: '☾', light: '☀' }

function applyTheme(theme) {
    document.documentElement.setAttribute('w-theme', theme)
    try {
        localStorage.setItem(THEME_KEY, theme)
    } catch (_) {}
    for (const el of document.querySelectorAll('[w-theme-icon]')) {
        el.textContent = THEME_ICON[theme] || THEME_ICON.dark
    }
}

function currentTheme() {
    try {
        return localStorage.getItem(THEME_KEY) || 'dark'
    } catch (_) {
        return 'dark'
    }
}

if (typeof document !== 'undefined') {
    // Apply the persisted theme before first paint; FYLO defaults to dark.
    applyTheme(currentTheme())

    // Delegated toggles — survive any Tac rerender since nothing is bound to nodes.
    const closeMenu = () => {
        const header = document.querySelector('.site-header')
        if (!header || !header.classList.contains('menu-open')) return
        header.classList.remove('menu-open')
        header.querySelector('[w-menu-toggle]')?.setAttribute('aria-expanded', 'false')
    }
    document.addEventListener('click', (event) => {
        if (event.target.closest('[w-theme-toggle]')) {
            applyTheme(currentTheme() === 'dark' ? 'light' : 'dark')
            return
        }
        const burger = event.target.closest('[w-menu-toggle]')
        if (burger) {
            const header = burger.closest('.site-header')
            const open = header.classList.toggle('menu-open')
            burger.setAttribute('aria-expanded', String(open))
            return
        }
        // Any other click (including a menu link) closes the open mobile menu.
        closeMenu()
    })

    // Keep every multi-language sample on a docs page on the same language.
    // Each <docs-sample> owns its own $lang, so the only way to move them
    // together is to replay the click — which also keeps each component the
    // single owner of its own state. The guard stops the replay recursing.
    let syncingLang = false
    document.addEventListener('click', (event) => {
        const button = event.target.closest('.doc-sample-langs button')
        if (!button || syncingLang) return
        const label = button.textContent.trim()
        syncingLang = true
        try {
            // Re-query each round: selecting a language morphs that component's
            // DOM, which detaches nodes captured before the click.
            const count = document.querySelectorAll('.doc-sample-langs').length
            for (let i = 0; i < count; i++) {
                const strip = document.querySelectorAll('.doc-sample-langs')[i]
                if (!strip) continue
                const match = [...strip.querySelectorAll('button')].find(
                    (candidate) => candidate.textContent.trim() === label
                )
                if (match && match.getAttribute('aria-selected') !== 'true') match.click()
            }
        } finally {
            syncingLang = false
        }
    })
    // Close the mobile menu on SPA navigation.
    window.addEventListener('popstate', closeMenu)

    // Keep <title> in sync with the route. SPA navigation doesn't re-run page
    // constructors, so a page's own `document.title` only fires the first time its
    // module loads — after that the title would stick. Drive it from here instead.
    const ROUTE_TITLES = {
        '/': 'FYLO — The document store that speaks your language.',
        '/docs': 'Docs — FYLO',
        '/docs/concepts': 'Concepts — FYLO',
        '/docs/clients': 'Language clients — FYLO',
        '/docs/documents': 'Documents & metadata — FYLO',
        '/docs/buckets': 'Buckets & raw files — FYLO',
        '/docs/querying': 'Querying & SQL — FYLO',
        '/docs/queue': 'Serverless queue — FYLO',
        '/docs/schemas': 'Schemas & migrations — FYLO',
        '/docs/security': 'Encryption & access — FYLO',
        '/docs/versioning': 'Version control — FYLO',
        '/docs/recovery': 'Recovery & rebuild — FYLO',
        '/docs/operations': 'Configuration — FYLO',
        '/docs/replication': 'Backup & sync — FYLO',
        '/docs/browser': 'Browser & Explorer — FYLO',
        '/docs/cli': 'CLI reference — FYLO',
        '/docs/protocol': 'Machine protocol — FYLO',
        '/docs/errors': 'Error codes — FYLO',
        '/docs/limitations': 'Limitations — FYLO',
        '/download': 'Download — FYLO'
    }
    const currentPath = () => location.pathname.replace(/\/$/, '') || '/'
    const syncTitle = () => {
        const t = ROUTE_TITLES[currentPath()]
        if (t && document.title !== t) document.title = t
    }

    // Highlight the docs sidebar entry for the current route. Delegated from
    // here rather than bound in the component, so it survives Tac rerenders and
    // SPA navigations that never re-run a page constructor.
    const syncDocNav = () => {
        const here = currentPath()
        for (const link of document.querySelectorAll('.doc-nav-list a')) {
            const target = link.getAttribute('href').replace(/\/$/, '') || '/'
            link.classList.toggle('active', target === here)
            if (target === here) link.setAttribute('aria-current', 'page')
            else link.removeAttribute('aria-current')
        }
    }
    // On narrow screens the docs sidebar collapses to a horizontal strip, where
    // the current page can sit off-screen with nothing to suggest it exists.
    const revealActive = () => {
        for (const selector of [
            '.doc-nav-list a.active',
            '.doc-sample-langs [aria-selected="true"]'
        ]) {
            const active = document.querySelector(selector)
            const scroller = active?.closest('.doc-nav-inner, .doc-sample-langs')
            if (!active || !scroller || scroller.scrollWidth <= scroller.clientWidth) continue
            const offset = active.offsetLeft - (scroller.clientWidth - active.offsetWidth) / 2
            scroller.scrollTo({ left: Math.max(0, offset) })
        }
    }
    const syncRoute = () => {
        syncTitle()
        syncDocNav()
        revealActive()
    }
    window.addEventListener('tachyon:navigate', syncRoute)
    window.addEventListener('popstate', syncRoute)
    syncRoute()

    // Tac rerenders can rebuild the header (and its [w-theme-icon] span) — keep it in sync.
    new MutationObserver(() => {
        const theme = currentTheme()
        for (const el of document.querySelectorAll('[w-theme-icon]')) {
            if (el.textContent !== (THEME_ICON[theme] || THEME_ICON.dark)) {
                el.textContent = THEME_ICON[theme] || THEME_ICON.dark
            }
        }
        // A morph can also rebuild the docs sidebar and drop `active`.
        syncDocNav()
    }).observe(document.documentElement, { childList: true, subtree: true })

    // Favicon — the FYLO mark: a document whose contents are a branch history.
    const faviconSVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#f89b4b"/><path d="M20 10h18l12 12v28a4 4 0 0 1-4 4H20a4 4 0 0 1-4-4V14a4 4 0 0 1 4-4Z" fill="#171007"/><path d="M38 10v9a3 3 0 0 0 3 3h9" fill="none" stroke="#f89b4b" stroke-width="2.5" stroke-linejoin="round"/><circle cx="26" cy="30" r="3.4" fill="#f89b4b"/><circle cx="26" cy="45" r="3.4" fill="#f89b4b"/><circle cx="39" cy="34" r="3.4" fill="#f89b4b"/><path d="M26 33.4v8.2M39 37.4a10.5 10.5 0 0 1-9.2 7.3" fill="none" stroke="#f89b4b" stroke-width="2.5" stroke-linecap="round"/></svg>`
    const favicon = document.createElement('link')
    favicon.rel = 'icon'
    favicon.type = 'image/svg+xml'
    favicon.href = 'data:image/svg+xml,' + encodeURIComponent(faviconSVG)
    document.head.appendChild(favicon)

    const seoMeta = [
        {
            name: 'description',
            content:
                'FYLO is a document store that ships as a single self-contained binary with language shims for Python, Ruby, Node, Go, Rust, C#, Java, PHP, and Dart, plus local-only browser, mobile, and Flutter clients. One canonical JSON file per document, zero-payload prefix indexes, git-like version control, and SQL — no server, no network protocol.'
        },
        {
            name: 'keywords',
            content:
                'fylo, document store, nosql, filesystem, prefix index, sql, binary, cli, python, go, rust, java, csharp, database'
        },
        { name: 'author', content: 'FYLO contributors' },
        { name: 'robots', content: 'index, follow' },
        { property: 'og:type', content: 'website' },
        { property: 'og:title', content: 'FYLO — The document store that speaks your language.' },
        {
            property: 'og:description',
            content:
                'One canonical file per document. Zero-payload prefix indexes. No monolithic caches.'
        },
        { property: 'og:url', content: 'https://fylo.del.ma' },
        { property: 'og:site_name', content: 'FYLO' },
        { name: 'twitter:card', content: 'summary' },
        { name: 'twitter:title', content: 'FYLO — The document store that speaks your language.' },
        {
            name: 'twitter:description',
            content:
                'One canonical file per document. Zero-payload prefix indexes. No monolithic caches.'
        }
    ]
    for (const attrs of seoMeta) {
        const meta = document.createElement('meta')
        for (const [k, v] of Object.entries(attrs)) meta.setAttribute(k, v)
        document.head.appendChild(meta)
    }
}
