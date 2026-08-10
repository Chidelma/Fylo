const TITLE = 'Docs — FYLO'
document.title = TITLE

export default class {
    installCode = `# macOS / Linux
curl -fsSL https://fylo.del.ma/install.sh | sh

# Windows (PowerShell)
irm https://fylo.del.ma/install.ps1 | iex

fylo --version`

    layoutCode = `<root>/
  .collections/users/          # documents — one JSON file each
    docs/4U/4UUB32VGUDW.json
    .deleted/                  # soft-deleted payloads
    index/                     # derived: mmap'd sorted keys + WAL
    events/users.ndjson        # append-only event journal
    locks/                     # advisory file locks
  .buckets/assets/             # raw files — identical layout
  .fylo-catalog/               # collection descriptors
  .fylo-transactions/          # crash-recovery journal; include in full-root snapshots
  .fylo-queue/v1/              # durable brokerless messages and consumer state
  .fylo-vcs/                   # commits, branches, content-addressed objects`
}
