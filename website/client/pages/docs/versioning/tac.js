const TITLE = 'Version control — FYLO'
document.title = TITLE

export default class extends Tac {
  constructor(props = {}, tac = undefined) {
    super(props, tac)
    if (this.isBrowser) document.title = TITLE
  }

  cliCode = `fylo checkout -b feature/docs --root /mnt/fylo
fylo commit -m "snapshot feature docs" --root /mnt/fylo
fylo branch --root /mnt/fylo
fylo log    --root /mnt/fylo
fylo status --root /mnt/fylo
fylo diff   --root /mnt/fylo
fylo restore-commit 4UUB32VGUDW --root /mnt/fylo --force
fylo merge feature/docs -m "merge feature docs" --root /mnt/fylo
fylo checkout main --root /mnt/fylo`

  layoutCode = `<root>/.fylo-vcs/
  HEAD                      # active branch ref
  refs/heads/<branch>.json  # branch metadata and latest commit id
  branches/<branch>/        # hidden working tree for non-main branches
    .collections/...
  commits/<commit-id>/      # commit metadata and root tree hash
  objects/<hh>/<hash>       # verified content-addressed blobs and tree nodes
  staging/<transaction>/    # durable restore/merge recovery transactions`

  offCode = `const db = new Fylo('/mnt/fylo', {
    versioning: { autoCommit: false }
})`

  unversionedCode = `await db.media.create({ kind: 'file', versioned: false })`

  machineCode = `{
    "op": "putData",
    "root": "/mnt/fylo",
    "collection": "posts",
    "versioning": { "autoCommit": false },
    "data": { "title": "manual commit later" }
}`
}
