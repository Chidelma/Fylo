const TITLE = 'Buckets & raw files — FYLO'
document.title = TITLE

export default class {
    basicCode = `await db.assets.create({ kind: 'file' })

const id = await db.assets.put(
    new File(['hello'], 'greeting.txt', { type: 'text/plain' })
)

const metadata = await db.assets.get(id).once()
const bytes    = await db.assets.get(id).bytes()
const blob     = await db.assets.get(id).blob()
const stream   = await db.assets.get(id).stream()`

    keysCode = `const id = await db.assets.put(file, { key: '/reports/2026/summary.pdf' })

const exact = await db.assets
    .find({ $ops: [{ key: { $eq: '/reports/2026/summary.pdf' } }] })
    .collect()

const reports = await db.assets
    .find({ $ops: [{ key: { $like: '/reports/%' } }] })
    .collect()`

    folderCode = `await db.assets.rekey(id, '/reports/2027/summary.pdf')   // move one file
await db.assets.rekey.prefix('/reports/', '/archive/')   // move a whole folder

const { files, folders } = await db.assets.folder('/archive/')
// files   → { [id]: manifest } for direct children
// folders → ['2026', '2027'] — immediate subfolder names`

    verifyCode = `const report = await db.assets.verify()
// { collection, filesScanned, verified, stamped,
//   corrupt: [{ id, namespace, expected, actual }] }`

    cronCode = `# Weekly integrity audit, Sunday 03:00 — the alert fires on a non-zero exit
0 3 * * 0  fylo verify assets --root /mnt/fylo --json || notify "fylo: corruption detected"`

    metaQueryCode = `await db.assets.find({ $ops: [{ ['meta/starred']: { $eq: true } }] })
await db.assets.find({ $ops: [{ ['meta/rating']: { $gte: 4 } }] })`

    pathCode = `.buckets/assets/docs/<TTID-prefix>/<TTID>.<original-extension>`

    machineCode = `{
    "op": "putData",
    "root": "/mnt/fylo",
    "collection": "assets",
    "file": {
        "path": "/uploads/greeting.txt",
        "key": "/incoming/greeting.txt"
    }
}`
}
