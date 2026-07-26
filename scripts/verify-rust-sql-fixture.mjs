import { readFile } from 'node:fs/promises'

import { Parser } from '../src/query/parser.js'
import { FyloQueryPlanner } from '../src/query/planner.js'

const fixture = JSON.parse(
    await readFile(new URL('../tests/fixtures/rust-sql-v1.json', import.meta.url), 'utf8')
)
if (
    fixture.schemaVersion !== 1 ||
    fixture.queryFormat !== 'fylo.query.v1' ||
    fixture.producer !== 'fylo-js'
) {
    throw new Error('Unsupported Rust SQL compatibility fixture')
}

const planner = new FyloQueryPlanner()
for (const testCase of fixture.astCases) {
    const actual = Parser.parse(testCase.sql)
    if (JSON.stringify(actual) !== JSON.stringify(testCase.expected)) {
        throw new Error(`SQL AST fixture drifted for: ${testCase.sql}`)
    }
}
for (const testCase of fixture.planCases) {
    const actual = planner.prepare(testCase.sql)
    if (JSON.stringify(actual) !== JSON.stringify(testCase.expected)) {
        throw new Error(`SQL plan fixture drifted for: ${testCase.sql}`)
    }
}

console.log(
    `Verified ${fixture.astCases.length} SQL ASTs and ${fixture.planCases.length} plans against JavaScript`
)
