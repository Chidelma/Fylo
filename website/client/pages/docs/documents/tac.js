const TITLE = 'Documents & metadata — FYLO'
document.title = TITLE

export default class extends Tac {
  constructor(props = {}, tac = undefined) {
    super(props, tac)
    if (this.isBrowser) document.title = TITLE
  }


  restoreCode = `const deleted = {}
for await (const doc of db.users.find
    .deleted({ $deleted: { $gte: Date.parse('2026-05-01T00:00:00Z') } })
    .collect()) {
    Object.assign(deleted, doc)
}

await db.users.restore(id)`

  metaCode = `const id = await Fylo.uniqueTTID()

// write bytes and metadata together
await db.assets
    .put(id, file, { key: '/pics/beach.jpg' })
    .metadata({ camera: 'A7 IV', rating: 5, starred: true })

// bulk-edit an existing record; null removes an entry
await db.assets.put(id).metadata({ rating: 4, starred: null })

await db.assets.get(id).metadata()
// { id, name, key, extension, contentType, contentLength, etag, checksumSHA256,
//   lastModified, mtime, updatedAt, createdAt, camera: 'A7 IV', rating: 4 }`

  metaMachineCode = `{"op":"getMeta","collection":"users","id":"4UUB32VGUDW"}
{"op":"setMeta","collection":"users","id":"4UUB32VGUDW","meta":{"reviewed":true}}`

  rejectCode = `{ "tags": ["draft", "review"], "author": { "name": "Ada" } }   // accepted
{ "items": [{ "sku": "a" }] }                                  // EARRAYOFOBJECTS`

  batchCode = `// Each of these records ONE commit covering every document it touches.
await db.users.put.batch(records)
await db.users.patch.many(query, changes)
await db.users.delete.many(query)
await db.users.import(source)`
}
