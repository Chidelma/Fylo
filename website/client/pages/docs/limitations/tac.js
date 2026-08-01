const TITLE = 'Limitations — FYLO'
document.title = TITLE

export default class extends Tac {
  constructor(props = {}, tac = undefined) {
    super(props, tac)
    if (this.isBrowser) document.title = TITLE
  }

  limits = [
    {
      title: 'Filesystem-first engine',
      detail: 'One engine writes to a local path. Remote object storage is not a query, transaction, or built-in backup backend.'
    },
    {
      title: 'Local-filesystem locking',
      detail: 'PID-aware lock files plus kernel-owned takeover claims; live owners are never evicted by TTL. Use local POSIX filesystems or NTFS, not network or sync filesystems lacking equivalent atomic semantics.'
    },
    {
      title: 'Indexes are derived',
      detail: 'External writes to data files will not update indexes. Run rebuild() afterwards.'
    },
    {
      title: 'Frequency leaks on encryption',
      detail: 'HMAC blind indexes for equality reveal value repetition even without decryption.'
    },
    {
      title: 'Process-global cipher',
      detail: 'One key per process for all $encrypted fields. No per-collection key rotation is built in.'
    },
    {
      title: 'No cross-collection transactions',
      detail: 'SQL mutations and ordinary writes are atomic within one collection; there is no atomic multi-collection commit.'
    },
    {
      title: 'Timestamp metadata',
      detail: 'createdAt comes from the TTID; updatedAt comes from file modification metadata.'
    },
    {
      title: 'Bulk import for trusted sources',
      detail: 'The SSRF guard blocks private addresses and caps at 50 MiB. It is not safe for user-provided URLs.'
    },
    {
      title: 'No arrays of objects',
      detail: 'A document may hold scalars, nested objects, and arrays of scalars — never an array of objects, at any depth.'
    }
  ]
}
