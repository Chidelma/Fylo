const TITLE = 'CLI reference — FYLO'
document.title = TITLE

export default class {
    queryCode = `fylo "SELECT * FROM posts WHERE published = true"
fylo sql "SELECT * FROM posts" --page-size 25
fylo sql "EXPLAIN SELECT * FROM posts WHERE published = true" --root /mnt/fylo`

    adminCode = `fylo inspect posts   --root /mnt/fylo --json
fylo rebuild posts   --root /mnt/fylo
fylo verify  assets  --root /mnt/fylo --json   # integrity audit; exits 1 on corruption
fylo get     posts 4UUB32VGUDW --root /mnt/fylo --json
fylo deleted posts   --root /mnt/fylo --json
fylo restore posts 4UUB32VGUDW --root /mnt/fylo --json`

    vcsCode = `fylo checkout -b feature/docs --root /mnt/fylo
fylo commit -m "snapshot feature docs" --root /mnt/fylo
fylo branch --root /mnt/fylo
fylo log    --root /mnt/fylo
fylo status --root /mnt/fylo
fylo diff   --root /mnt/fylo
fylo restore-commit 4UUB32VGUDW --root /mnt/fylo --force
fylo merge feature/docs -m "merge feature docs" --root /mnt/fylo
fylo checkout main --root /mnt/fylo`

    schemaCode = `fylo schema inspect  article --schema-dir ./schemas --json
fylo schema doctor   article --schema-dir ./schemas
fylo schema validate article @article.json --schema-dir ./schemas --json`

    recoveryCode = `# Stop the writer or take an atomic filesystem snapshot first.
# Use the metadata-preserving copy profile qualified for this host.
cp -a /mnt/fylo /snapshots/fylo-$(date +%Y%m%d%H%M%S)

# Restore into a new path, then verify every collection before cutover.
fylo verify posts  --root /mnt/fylo-restored --json
fylo verify assets --root /mnt/fylo-restored --json`

    execCode = `# one request
echo '{"op":"inspectCollection","root":"/mnt/fylo","collection":"posts"}' | fylo exec --request -
fylo exec --request @request.json

# persistent loop
fylo exec --loop --root /mnt/fylo \\
  --max-request-bytes 1048576 \\
  --max-response-bytes 8388608 \\
  --exclusive-root`

    versionCode = `fylo --version
fylo version --output json`
}
