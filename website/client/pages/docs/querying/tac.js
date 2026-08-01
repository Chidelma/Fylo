const TITLE = 'Querying & SQL — FYLO'
document.title = TITLE

export default class extends Tac {
  constructor(props = {}, tac = undefined) {
    super(props, tac)
    if (this.isBrowser) document.title = TITLE
  }


  explainCode = `const plan = await db.executeSQL(
    "EXPLAIN SELECT * FROM posts WHERE title = 'Hello'"
)
// { operation: 'SELECT', collection: 'posts', access: [...], executed: false }`

  cliSqlCode = `fylo sql "EXPLAIN SELECT * FROM posts WHERE published = true" --root /mnt/fylo`

  pageCode = `{"op":"findDocs","collection":"posts","query":{"$ops":[]},"page":{"limit":256}}
{"op":"findDocs","collection":"posts","query":{"$ops":[]},"page":{"limit":256,"cursor":"<opaque>"}}`

  postgrestCode = `role=eq.admin&age=gte.30    // translated by queryFromSearch() into a findDocs query`
}
