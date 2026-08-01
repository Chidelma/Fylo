const TITLE = 'Backup & sync — FYLO'
document.title = TITLE

export default class extends Tac {
  constructor(props = {}, tac = undefined) {
    super(props, tac)
    if (this.isBrowser) document.title = TITLE
  }

  hooksCode = `const fylo = new Fylo('/mnt/fylo', {
    syncMode: 'fire-and-forget',
    sync: {
        async onWrite(event) {
            await replicationQueue.push({
                operation: event.operation,
                collection: event.collection,
                id: event.docId,
                path: event.path
            })
        },
        async onDelete(event) {
            await replicationQueue.push({
                operation: 'delete',
                collection: event.collection,
                id: event.docId,
                path: event.path,
                previousPath: event.previousPath
            })
        }
    }
})`

  snapshotCode = `# Example only: choose the snapshot/copy tool qualified for your filesystem.
# Stop the FYLO writer first when the source is not an atomic snapshot.

# macOS / POSIX metadata-preserving copy
cp -a /mnt/fylo /backups/fylo-$(date +%Y%m%d%H%M%S)

# Restore into a new directory, then verify each collection
fylo verify users --root /mnt/fylo-restored
fylo verify files --root /mnt/fylo-restored`
}
