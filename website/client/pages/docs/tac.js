const TITLE = 'Docs — FYLO'
document.title = TITLE

export default class extends Tac {
  constructor(props = {}, tac = undefined) {
    super(props, tac)
    if (this.isBrowser) document.title = TITLE
  }

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
  .fylo-transactions/          # crash-recovery journal (never backed up)
  .fylo-vcs/                   # commits, branches, content-addressed objects`
}
