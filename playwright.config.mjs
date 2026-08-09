import { defineConfig } from '@playwright/test'

export default defineConfig({
    testDir: './tests/browser/e2e',
    timeout: 120_000,
    expect: { timeout: 120_000 },
    fullyParallel: false,
    workers: 1,
    preserveOutput: 'always',
    reporter: [['line']],
    use: {
        baseURL: 'http://127.0.0.1:4173',
        trace: 'retain-on-failure'
    },
    webServer: {
        // Cross-origin isolation, without which SharedArrayBuffer — and the
        // Atomics bridge OPFS needs — does not exist.
        command: 'node scripts/serve-isolated.mjs 4173 .',
        url: 'http://127.0.0.1:4173/tests/browser/fixtures/wasm-opfs.html',
        reuseExistingServer: true,
        timeout: 30_000
    },
    projects: [
        { name: 'chromium', use: { browserName: 'chromium' } },
        { name: 'firefox', use: { browserName: 'firefox' } },
        { name: 'webkit', use: { browserName: 'webkit' } }
    ]
})
