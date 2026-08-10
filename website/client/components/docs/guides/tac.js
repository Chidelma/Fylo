export default class {
    hydrate() {}
    guides = [
        {
            href: '/docs/concepts',
            title: 'Concepts',
            text: 'Root, collection, bucket, document, TTID, index key, generation, commit — the words that mean something specific here.'
        },
        {
            href: '/docs/documents',
            title: 'Documents & metadata',
            text: 'Create, read, patch, delete, restore. Developer metadata that rides along with the bytes as extended attributes.'
        },
        {
            href: '/docs/buckets',
            title: 'Buckets & raw files',
            text: 'Store bytes instead of records. Slash-delimited logical keys, folder browsing, checksums, and the integrity audit.'
        },
        {
            href: '/docs/querying',
            title: 'Querying & SQL',
            text: 'Operators, which index each one uses, pagination cursors, joins, and the SQL surface.'
        },
        {
            href: '/docs/queue',
            title: 'Serverless queue',
            text: 'Brokerless topics, consumer groups, visibility leases, retry fencing, dead letters, and one-batch SDK decorators.'
        },
        {
            href: '/docs/schemas',
            title: 'Schemas & migrations',
            text: 'Versioned chex schemas, upgraders that run on read, strict writes, and why arrays of objects are rejected.'
        },
        {
            href: '/docs/security',
            title: 'Encryption & access',
            text: 'AES-GCM field encryption with blind indexes and POSTIX per-record UID/GID/mode.'
        },
        {
            href: '/docs/versioning',
            title: 'Version control',
            text: 'Auto-commit, branches, diff, three-way merge, and content-addressed snapshots that share unchanged bytes.'
        },
        {
            href: '/docs/replication',
            title: 'Backup & sync',
            text: 'Post-write hooks plus safe filesystem snapshots, restore, and verification.'
        },
        {
            href: '/docs/recovery',
            title: 'Recovery & rebuild',
            text: 'What happens when a process dies mid-write, how to read recovery status, and when to rebuild an index.'
        },
        {
            href: '/docs/browser',
            title: 'Browser & Explorer',
            text: 'The local-only OPFS engine, direct folder access in Chromium, and the Explorer UI over a real root.'
        },
        {
            href: '/docs/protocol',
            title: 'Machine protocol',
            text: 'Every operation, the bounded NDJSON framing contract, pagination cursors, and the exclusive root lease.'
        },
        {
            href: '/docs/errors',
            title: 'Error codes',
            text: 'Every stable code FYLO can return, what it means, and whether retrying is the right response.'
        }
    ]
}
