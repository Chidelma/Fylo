export default class {
    constructor(props = {}) {
        Object.assign(this, props)
    }

    hydrate(root) {
        this.root = root
    }
    /** @type {string} */
    openKey = 'rebuild'

    toggle(_event, key) {
        this.openKey = this.openKey === key ? '' : key
        for (const panel of this.root?.querySelectorAll('[data-faq]') ?? []) {
            const open = panel.dataset.faq === this.openKey
            panel.classList.toggle('open', open)
            panel.querySelector('button')?.setAttribute('aria-expanded', String(open))
        }
    }

    faqs = [
        {
            key: 'rebuild',
            q: 'What happens if an index gets corrupted?',
            a: 'Nothing is lost. Documents are the source of truth and indexes are derived accelerators — the rebuild operation reconstructs every index entry by scanning the canonical document files.'
        },
        {
            key: 'languages',
            q: 'Which languages can I use FYLO from?',
            a: "Any language that can spawn a process. FYLO ships as a single binary that speaks a JSON machine protocol over stdin/stdout; drop-in shims are provided for Python, Ruby, Node/TypeScript, PHP, Go, Rust, C#, Java, and Dart, and the protocol is tested in CI against even more. For platforms that can't spawn the binary there are local-only clients that embed the engine on-device — the browser bundle, native iOS (Swift) and Android (Kotlin) clients, and a Flutter client."
        },
        {
            key: 'explorer',
            q: 'Can I browse a FYLO database visually?',
            a: "Yes — Fylo Explorer is a browser UI over a real FYLO root on your disk, opened through the File System Access API. Pick the folder once and browse collections, inspect documents, and filter with SQL WHERE expressions (role = 'admin' AND age >= 30). It is read-only by default — the engine rebuilds indexes into a copy-on-write overlay, never touching the folder — with opt-in writes that go through the engine. Document queries run in a worker with Wasm acceleration and automatic JavaScript fallback. Chromium-only, since Firefox and Safari do not implement real-folder access."
        },
        {
            key: 'replication',
            q: 'How do I back up or replicate a root?',
            a: 'FYLO is filesystem-only. Quiesce the writer, take a byte- and metadata-preserving snapshot of the complete root, and verify a restore into a new empty path. You can copy that snapshot with the storage or synchronization tool of your choice, but remote transport is deliberately outside the FYLO engine.'
        },
        {
            key: 'transactions',
            q: 'Are there transactions?',
            a: 'Writes are serialized per collection with advisory file locks. There are no cross-collection atomic commits — declare related objects as their own collections and join them at query time with joinDocs.'
        },
        {
            key: 'encryption',
            q: 'Is my data encrypted at rest?',
            a: 'Fields listed in a schema’s $encrypted array are stored with AES-GCM. Equality lookups use HMAC blind indexes, so queries work without decrypting — with the documented trade-off that value repetition counts are observable.'
        },
        {
            key: 'groups',
            q: 'Can multiple users share a document or file?',
            a: 'Yes. Write it with .as({ gid: editorsGid, mode: 0o660 }), then authenticated group members read, update, or delete with .as({ uid: memberUid }). FYLO resolves membership from the host POSIX group database. Binary-backed applications can also supply request-scoped virtual groups from authenticated server state; never accept those claims from an end-user payload. Group write permission is required — 0o600 remains owner-only.'
        }
    ]
}
