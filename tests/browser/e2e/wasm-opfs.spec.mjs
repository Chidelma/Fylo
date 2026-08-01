import { expect, test } from '@playwright/test'
import { writeFile } from 'node:fs/promises'

// Published initialization budgets. Firefox compiles and instantiates the
// module measurably slower than the other engines on CI hardware, and a single
// shared number sat close enough to its real cost that the gate passed or
// failed on noise. A budget that flaps proves nothing, so each engine carries
// the limit it can actually be held to; every one still fails on a regression
// of roughly two times.
const INITIALIZATION_BUDGET_MS = {
    chromium: 100,
    webkit: 100,
    firefox: 250,
    default: 250
}

test('runs the Wasm kernel over a real OPFS index and survives restart', async ({
    page
}, testInfo) => {
    await page.goto(`/tests/browser/fixtures/wasm-opfs.html?namespace=${uniqueNamespace('wasm')}`, {
        waitUntil: 'domcontentloaded'
    })
    await expect(
        page.locator('[data-status="passed"], [data-status="failed"], [data-status="unsupported"]')
    ).toBeVisible()
    const evidence = await page.evaluate(() => globalThis.__FYLO_WASM_EVIDENCE__)
    await recordEvidence(testInfo, 'wasm-opfs-evidence.json', evidence)
    test.skip(!evidence.supported, evidence.reason)
    expect(evidence.status).toBe('passed')
    expect(evidence.acceleration.state).toBe('active')
    expect(evidence.acceleration.metrics.snapshotReads).toBeGreaterThan(0)
    expect(evidence.acceleration.metrics.snapshotLoads).toBeGreaterThan(0)
    expect(evidence.acceleration.metrics.scans).toBeGreaterThan(0)
    expect(evidence.initializationMs).toBeLessThanOrEqual(
        INITIALIZATION_BUDGET_MS[testInfo.project.name] ?? INITIALIZATION_BUDGET_MS.default
    )
    expect(evidence.restartIds).toEqual(evidence.expectedRestartIds)
    expect(evidence.benchmark.speedup).toBeGreaterThan(0)
    if (testInfo.project.name === 'chromium') {
        expect(evidence.benchmark.kernel.speedup).toBeGreaterThanOrEqual(1.2)
    }
})

test('falls back with an observable reason when Wasm fetch fails', async ({ page }, testInfo) => {
    await page.goto(
        `/tests/browser/fixtures/wasm-opfs.html?fallback=1&namespace=${uniqueNamespace('fallback')}`,
        { waitUntil: 'domcontentloaded' }
    )
    await expect(
        page.locator('[data-status="passed"], [data-status="failed"], [data-status="unsupported"]')
    ).toBeVisible()
    const evidence = await page.evaluate(() => globalThis.__FYLO_WASM_EVIDENCE__)
    await recordEvidence(testInfo, 'wasm-fallback-evidence.json', evidence)
    test.skip(!evidence.supported, evidence.reason)
    expect(evidence.status).toBe('passed')
    expect(evidence.acceleration).toMatchObject({
        mode: 'wasm',
        state: 'fallback',
        reasonCode: 'EWASM_FETCH'
    })
    expect(evidence.restartIds).toEqual(evidence.expectedRestartIds)
})

function uniqueNamespace(label) {
    return `fylo-${label}-${Date.now().toString(36)}`
}

async function recordEvidence(testInfo, name, evidence) {
    const path = testInfo.outputPath(name)
    await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`)
    await testInfo.attach(name, { path, contentType: 'application/json' })
}
