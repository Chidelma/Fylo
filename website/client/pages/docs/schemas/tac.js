const TITLE = 'Schemas & migrations — FYLO'
document.title = TITLE

export default class {
    layoutCode = `<FYLO_SCHEMA>/
  <collection>/
    manifest.json          # { current, versions: [{ v, sha256?, addedAt? }] }
    history/
      v1.schema.json       # chex regex schema
      v2.schema.json       # head is whichever manifest.current points at
    upgraders/
      v1-to-v2.js          # export default async (doc) => upgradedDoc`

    manifestCode = `{
    "current": "v2",
    "versions": [
        { "v": "v1", "addedAt": "2026-04-01T00:00:00Z" },
        { "v": "v2", "addedAt": "2026-04-27T00:00:00Z" }
    ]
}`

    schemaCode = `{
    "id": "^[0-9]+$",
    "title": "^.+$",
    "body": "^.+$",
    "slug": "^[a-z0-9-]+$"
}`

    upgraderCode = `export default function upgrade(doc) {
    return {
        ...doc,
        slug:
            String(doc.title ?? '')
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-+|-+$/g, '') || 'untitled'
    }
}`

    cliCode = `fylo schema inspect article --schema-dir ./schemas --json
fylo schema doctor  article --schema-dir ./schemas
fylo schema validate article @article.json --schema-dir ./schemas --json`
}
