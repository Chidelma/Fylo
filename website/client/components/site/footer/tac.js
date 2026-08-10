export default class {
    hydrate() {}
    /** @type {string} */
    siteUrl

    // `external` drives target/rel — without it every internal link opened a new tab.
    linkGroups = [
        {
            title: 'Learn',
            links: [
                { label: 'Documentation', href: '/docs', external: false },
                { label: 'Concepts', href: '/docs/concepts', external: false },
                { label: 'Querying & SQL', href: '/docs/querying', external: false },
                { label: 'Language clients', href: '/docs/clients', external: false }
            ]
        },
        {
            title: 'Reference',
            links: [
                { label: 'CLI', href: '/docs/cli', external: false },
                { label: 'Machine protocol', href: '/docs/protocol', external: false },
                { label: 'Error codes', href: '/docs/errors', external: false },
                { label: 'Limitations', href: '/docs/limitations', external: false }
            ]
        },
        {
            title: 'Project',
            links: [
                { label: 'Download', href: '/download', external: false },
                { label: 'Explorer', href: '/docs/browser', external: false },
                { label: 'Source code', href: 'https://github.com/d31ma/Fylo', external: true },
                {
                    label: 'Releases',
                    href: 'https://github.com/d31ma/Fylo/releases',
                    external: true
                }
            ]
        },
        {
            title: 'Ecosystem',
            links: [
                { label: 'Tachyon', href: 'https://github.com/d31ma/Tachyon', external: true },
                { label: 'TTID', href: 'https://github.com/d31ma/ttid', external: true },
                { label: 'CHEX', href: 'https://github.com/d31ma/chex', external: true },
                {
                    label: 'MIT License',
                    href: 'https://github.com/d31ma/Fylo/blob/main/LICENSE',
                    external: true
                }
            ]
        }
    ]
}
