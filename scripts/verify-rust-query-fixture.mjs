import { readFile } from 'node:fs/promises'

import { BrowserPrefixIndex } from '../src/browser/core/prefix-index.js'

const fixture = JSON.parse(await readFile('tests/fixtures/rust-query-v1.json', 'utf8'))
const bytes = new TextEncoder().encode(fixture.snapshot)
const index = new BrowserPrefixIndex({}, () => '/unused')

for (const testCase of fixture.cases) {
    let candidates = null
    for (const query of testCase.queries) {
        const next = new Set()
        index.scanSnapshotWithJavaScript(bytes, query.prefix, query.rootPrefix, query.range, next)
        candidates =
            candidates === null
                ? next
                : new Set([...candidates].filter((documentId) => next.has(documentId)))
    }
    const actual = [...(candidates ?? [])]
    if (JSON.stringify(actual) !== JSON.stringify(testCase.expected)) {
        throw new Error(
            `${testCase.name} query fixture drift\n` +
                `expected: ${JSON.stringify(testCase.expected)}\n` +
                `actual: ${JSON.stringify(actual)}`
        )
    }
}

console.log(
    `Verified ${fixture.cases.length} portable query cases against the JavaScript index oracle`
)
process.exit(0)
