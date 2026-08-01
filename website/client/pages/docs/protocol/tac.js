const TITLE = 'Machine protocol — FYLO'
document.title = TITLE

export default class extends Tac {
  constructor(props = {}, tac = undefined) {
    super(props, tac)
    if (this.isBrowser) document.title = TITLE
  }

  ops = [
    { group: 'Session', items: 'handshake' },
    { group: 'Collections', items: 'createCollection, dropCollection, inspectCollection, rebuildCollection, verifyCollection' },
    { group: 'Documents', items: 'getDoc, getLatest, putData, batchPutData, patchDoc, patchDocs, delDoc, delDocs, restoreDoc, importBulkData' },
    { group: 'Metadata', items: 'getMeta, setMeta' },
    { group: 'Queries', items: 'findDocs, findDeletedDocs, joinDocs, executeSQL' },
    { group: 'Version control', items: 'checkout, branch, commit, log, status, diff, restoreCommit, merge' },
    { group: 'Schemas', items: 'schemaInspect, schemaCurrent, schemaHistory, schemaDoctor, schemaValidate, schemaMaterialize' }
  ]

  requestCode = `echo '{"op":"inspectCollection","root":"/mnt/fylo","collection":"posts"}' | fylo exec --request -`

  responseCode = `{
    "protocolVersion": 1,
    "ok": true,
    "op": "inspectCollection",
    "durationMs": 4,
    "result": { "collection": "posts", "exists": true }
}`

  handshakeCode = `printf '%s\\n' '{"op":"handshake"}' | fylo exec --loop --root /mnt/fylo`

  framesCode = `fylo exec --loop --root /mnt/fylo \\
  --max-request-bytes 1048576 \\
  --max-response-bytes 8388608`

  pageCode = `{"op":"findDocs","collection":"posts","query":{"$ops":[]},"page":{"limit":256}}
{"op":"findDocs","collection":"posts","query":{"$ops":[]},"page":{"limit":256,"cursor":"<opaque>"}}`

  leaseCode = `fylo exec --loop --root /mnt/fylo --exclusive-root`

  accessCode = `{
    "op": "patchDoc",
    "collection": "messages",
    "id": "4UUB32VGUDW",
    "data": { "title": "reviewed" },
    "access": { "uid": 1002, "groups": [4001] }
}`
}
