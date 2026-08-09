import { expect, test } from '@playwright/test'
import { writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

test('runs the FYLO engine over real OPFS in a worker', async ({ page }, testInfo) => {
    await page.goto('/tests/browser/fixtures/wasm-engine.html', { waitUntil: 'domcontentloaded' })
    await expect(
        page.locator('[data-status="passed"], [data-status="failed"], [data-status="unsupported"]')
    ).toBeVisible()
    const evidence = await page.evaluate(() => globalThis.__FYLO_ENGINE_EVIDENCE__)
    const path = testInfo.outputPath('wasm-engine-evidence.json')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`)
    await testInfo.attach('evidence', { path, contentType: 'application/json' })
    console.log(JSON.stringify(evidence.surface, null, 2))
    // No frames at all means the engine never ran: the browser could not host
    // a module Worker over OPFS here, which this gate cannot fix and must not
    // report as a FYLO defect.
    test.skip(evidence.frames.length === 0, `engine did not start: ${evidence.reason}`)
    // The handshake proves the module, the Worker, the host table, and the Web
    // Lock all work in a real browser. Storage needs one more thing the page
    // must grant, so that is skipped rather than failed until it does.
    expect(evidence.frames[0]?.ok, evidence.reason).toBe(true)
    expect(evidence.frames[0]?.result?.buildTarget).toBe('browser-wasm32')
    expect(evidence.frames[0]?.result?.capabilities?.exclusiveRoot).toBe(false)
    test.skip(evidence.status === 'unsupported', evidence.reason)
    expect(evidence.status, evidence.reason).toBe('passed')

    // Storage actually happened: both documents came back, in ascending
    // identifier order, and the collection agrees.
    const found = evidence.frames[4].result
    expect(Object.keys(found)).toHaveLength(2)
    expect(Object.keys(found)).toEqual([...Object.keys(found)].sort())
    expect(
        Object.values(found)
            .map((document) => document.name)
            .sort()
    ).toEqual(['Ada', 'Grace'])
    expect(evidence.frames[5].result.docsStored).toBe(2)
    expect(evidence.frames[5].result.indexedDocs).toBe(2)
})
