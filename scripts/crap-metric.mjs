#!/usr/bin/env bun
// CRAP (Change Risk Anti-Patterns) per function:
//
//   CRAP(f) = CC(f)^2 * (1 - coverage(f))^3 + CC(f)
//
// At full coverage CRAP collapses to CC, so a ceiling of N also caps
// cyclomatic complexity at N. Coverage comes from the lcov report Bun writes;
// complexity comes from the TypeScript AST, which the repo already depends on
// for `tsc --noEmit`.
//
// Usage: bun scripts/crap-metric.mjs [--threshold 5] [--lcov coverage/lcov.info] [--json]

import { readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

function parseArgs(argv) {
    const options = { threshold: 5, lcov: 'coverage/lcov.info', json: false, top: 25 }
    for (let index = 0; index < argv.length; index++) {
        const flag = argv[index]
        if (flag === '--json') options.json = true
        else if (flag === '--threshold') options.threshold = Number(argv[++index])
        else if (flag === '--lcov') options.lcov = argv[++index]
        else if (flag === '--top') options.top = Number(argv[++index])
        else throw new Error(`Unknown argument: ${flag}`)
    }
    return options
}

/**
 * Line hit counts per source file, keyed by repo-relative path.
 * @param {string} lcovPath
 * @returns {Map<string, Map<number, number>>}
 */
function readLcov(lcovPath) {
    const files = new Map()
    let current = null
    for (const line of readFileSync(lcovPath, 'utf8').split('\n')) {
        if (line.startsWith('SF:')) {
            const file = path.relative(process.cwd(), path.resolve(line.slice(3).trim()))
            current = files.get(file) ?? new Map()
            files.set(file, current)
        } else if (line.startsWith('DA:') && current) {
            const [lineNumber, hits] = line.slice(3).split(',')
            // A line may appear once per test file; keep the highest hit count.
            const previous = current.get(Number(lineNumber)) ?? 0
            current.set(Number(lineNumber), Math.max(previous, Number(hits)))
        }
    }
    return files
}

// Each construct below introduces one independent path through a function.
const DECISION_KINDS = new Set([
    ts.SyntaxKind.IfStatement,
    ts.SyntaxKind.ConditionalExpression,
    ts.SyntaxKind.CaseClause,
    ts.SyntaxKind.CatchClause,
    ts.SyntaxKind.ForStatement,
    ts.SyntaxKind.ForInStatement,
    ts.SyntaxKind.ForOfStatement,
    ts.SyntaxKind.WhileStatement,
    ts.SyntaxKind.DoStatement
])

const BINARY_DECISION_TOKENS = new Set([
    ts.SyntaxKind.AmpersandAmpersandToken,
    ts.SyntaxKind.BarBarToken,
    ts.SyntaxKind.QuestionQuestionToken
])

function isFunctionNode(node) {
    return (
        ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isConstructorDeclaration(node) ||
        ts.isGetAccessor(node) ||
        ts.isSetAccessor(node)
    )
}

/**
 * Cyclomatic complexity of one function, excluding nested functions so each
 * function is scored on its own branching rather than its children's.
 */
function cyclomaticComplexity(fn) {
    let complexity = 1
    const visit = (node) => {
        if (node !== fn && isFunctionNode(node)) return
        if (DECISION_KINDS.has(node.kind)) complexity++
        else if (ts.isBinaryExpression(node) && BINARY_DECISION_TOKENS.has(node.operatorToken.kind))
            complexity++
        ts.forEachChild(node, visit)
    }
    ts.forEachChild(fn, visit)
    return complexity
}

function functionName(node, source) {
    if (ts.isConstructorDeclaration(node)) {
        const owner =
            node.parent && node.parent.name ? node.parent.name.getText(source) : 'anonymous'
        return `${owner}.constructor`
    }
    const own = node.name?.getText(source)
    const ownerName =
        node.parent && ts.isClassLike(node.parent) && node.parent.name
            ? `${node.parent.name.getText(source)}.`
            : ''
    if (own) return `${ownerName}${own}`
    // Arrow/function expressions assigned to a name: `const x = () => {}`
    const parent = node.parent
    if (parent && ts.isVariableDeclaration(parent) && parent.name)
        return parent.name.getText(source)
    if (parent && ts.isPropertyAssignment(parent) && parent.name) return parent.name.getText(source)
    if (parent && ts.isPropertyDeclaration(parent) && parent.name)
        return `${ownerName}${parent.name.getText(source)}`
    return '<anonymous>'
}

/**
 * Statement-line coverage restricted to a function's line span. Lines with no
 * lcov record are non-executable and excluded from the ratio.
 */
function functionCoverage(lines, startLine, endLine) {
    let total = 0
    let covered = 0
    for (let line = startLine; line <= endLine; line++) {
        const hits = lines?.get(line)
        if (hits === undefined) continue
        total++
        if (hits > 0) covered++
    }
    // A function with no executable lines recorded is treated as uncovered.
    return { ratio: total === 0 ? 0 : covered / total, executableLines: total }
}

function crap(complexity, coverageRatio) {
    const uncovered = 1 - coverageRatio
    return complexity ** 2 * uncovered ** 3 + complexity
}

const options = parseArgs(process.argv.slice(2))
const coverage = readLcov(options.lcov)

const sourceFiles = [...new Bun.Glob('src/**/*.js').scanSync('.')].sort()
const results = []

for (const file of sourceFiles) {
    const text = readFileSync(file, 'utf8')
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
    const lines = coverage.get(file)
    const visit = (node) => {
        if (isFunctionNode(node) && node.body) {
            const startLine = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
            const endLine = source.getLineAndCharacterOfPosition(node.getEnd()).line + 1
            const complexity = cyclomaticComplexity(node)
            const { ratio, executableLines } = functionCoverage(lines, startLine, endLine)
            results.push({
                file,
                name: functionName(node, source),
                line: startLine,
                complexity,
                coverage: ratio,
                executableLines,
                crap: crap(complexity, ratio)
            })
        }
        ts.forEachChild(node, visit)
    }
    ts.forEachChild(source, visit)
}

results.sort((left, right) => right.crap - left.crap)
const offenders = results.filter((entry) => entry.crap > options.threshold)

if (options.json) {
    console.log(JSON.stringify({ threshold: options.threshold, results }, null, 2))
} else {
    const measured = results.length
    const worst = results[0]
    console.log(`CRAP report — ${measured} functions across ${sourceFiles.length} source files`)
    console.log(`threshold: ${options.threshold}`)
    console.log(
        `over threshold: ${offenders.length} (${((offenders.length / measured) * 100).toFixed(1)}%)`
    )
    console.log(`worst: ${worst.crap.toFixed(1)} — ${worst.file}:${worst.line} ${worst.name}`)
    const capped = results.filter((entry) => entry.complexity > options.threshold).length
    console.log(
        `functions whose complexity alone exceeds the threshold (unfixable by tests): ${capped}`
    )
    console.log('')
    console.log('worst offenders:')
    console.log('   CRAP    CC   cov%  location')
    for (const entry of offenders.slice(0, options.top)) {
        console.log(
            `${entry.crap.toFixed(1).padStart(7)} ${String(entry.complexity).padStart(5)} ` +
                `${(entry.coverage * 100).toFixed(0).padStart(5)}  ${entry.file}:${entry.line} ${entry.name}`
        )
    }
}

process.exitCode = offenders.length === 0 ? 0 : 1
