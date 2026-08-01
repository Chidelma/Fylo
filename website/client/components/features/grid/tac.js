import { CLIENT_COUNT } from '../../../shared/scripts/shims.js'

export default class extends Tac {
    // Exposed for template interpolation ({clientCount} in tac.html).
    clientCount = CLIENT_COUNT

    features = [
        {
            area: 'Storage',
            color: 'primary',
            title: 'Documents are truth',
            text: 'Each document is one canonical JSON file on disk, sharded by the trailing characters of its creation TTID. Easy to inspect, debug, back up, and rebuild from.'
        },
        {
            area: 'Indexing',
            color: 'primary',
            title: 'Zero-payload prefix indexes',
            text: "Path-encoded key-only index entries in an mmap'd sorted catalog. Queries narrow by binary search, then hydrate only matching documents."
        },
        {
            area: 'Query',
            color: 'success',
            title: 'SQL + NoSQL APIs',
            text: 'Query with a JSON operation protocol — put, find, patch, join — or plain SQL over the same engine. Exact, range, prefix, and trigram strategies.'
        },
        {
            area: 'Versioning',
            color: 'success',
            title: 'Git-like version control',
            text: 'Branch, commit, diff, merge, and restore your document store. Auto-commit on writes with content-addressed, deduplicated snapshots.'
        },
        {
            area: 'Distribution',
            color: 'warning',
            title: 'One self-contained binary',
            text: `Download a single executable — no runtime, no daemon, no native addons. Install once, then use drop-in clients for ${CLIENT_COUNT} languages — thin shims plus local-first browser and mobile.`
        },
        {
            area: 'Security',
            color: 'error',
            title: 'Encryption & POSIX access',
            text: 'AES-GCM field encryption with HMAC blind indexes, per-record POSIX UID/GID/mode enforcement, and trusted group membership.'
        },
        {
            area: 'Recovery',
            color: 'warning',
            title: 'Filesystem snapshots',
            text: 'Quiesce the writer, copy the complete root with native metadata intact, then verify and restore into a new path. Remote copy and synchronization remain deployment choices outside the engine.'
        },
        {
            area: 'Architecture',
            color: 'success',
            title: 'No server, no protocol',
            text: 'Every client owns its database directly — the binary on desktop, OPFS on the web, or a user-selected folder through File System Access. Browser queries can run in a worker with Wasm acceleration. Nothing listens on a port.'
        },
        {
            area: 'Interop',
            color: 'primary',
            title: 'One protocol, many languages',
            text: 'A compiled executable speaks a JSON machine protocol tested against Python, Ruby, PHP, Dart, Java, C#, C++, Swift, Kotlin, and Rust.'
        }
    ]
}
