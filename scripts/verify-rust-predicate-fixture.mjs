import { readFile } from 'node:fs/promises'

import { BrowserQueryEngine } from '../src/browser/core/query.js'

const fixture = JSON.parse(await readFile('tests/fixtures/rust-predicate-v1.json', 'utf8'))
const engine = new BrowserQueryEngine({ index: {} })

for (const testCase of fixture.cases) {
    const actual = engine.matchesQuery(
        'fixture-id',
        testCase.document,
        testCase.query,
        testCase.timestamps
    )
    if (actual !== testCase.expected) {
        throw new Error(
            `${testCase.name} predicate fixture drift: expected ${testCase.expected}, got ${actual}`
        )
    }
}

console.log(
    `Verified ${fixture.cases.length} structured predicates against the JavaScript query oracle`
)
process.exit(0)
