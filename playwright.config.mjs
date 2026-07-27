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
        command: 'python3 -m http.server 4173 --bind 127.0.0.1',
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
