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

for (const testCase of fixture.resultCases) {
    const actual = []
    for (const row of testCase.rows) {
        if (!engine.matchesQuery(row.id, row.document, testCase.query, row.timestamps)) continue
        actual.push(row.id)
        if (testCase.query.$limit && actual.length >= testCase.query.$limit) break
    }
    if (JSON.stringify(actual) !== JSON.stringify(testCase.expectedIds)) {
        throw new Error(
            `${testCase.name} result fixture drift: expected ${JSON.stringify(testCase.expectedIds)}, got ${JSON.stringify(actual)}`
        )
    }
}

console.log(
    `Verified ${fixture.cases.length} structured predicates and ${fixture.resultCases.length} ordered result cases against the JavaScript query oracle`
)
process.exit(0)
