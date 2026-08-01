const TITLE = 'Recovery & rebuild — FYLO'
document.title = TITLE

export default class extends Tac {
  constructor(props = {}, tac = undefined) {
    super(props, tac)
    if (this.isBrowser) document.title = TITLE
  }


  rebuildCliCode = `fylo rebuild posts --root /mnt/fylo --json`

  statusCode = `const status = await fylo.recoveryStatus('posts')
// {
//   collection: 'posts',
//   generation: 7,
//   state: 'stable',            // or 'writing' / 'corrupt'
//   activity: { status: 'idle', lastAction: 'recovery', ... }
// }`

  journalCode = `<root>/.fylo-transactions/<namespace>/<collection>/
  state.json               # stable/writing generation marker
  <transaction-id>/
    transaction.json       # operation, commit phase, before-image manifest
    before/                # linked or copied files needed for rollback`
}
