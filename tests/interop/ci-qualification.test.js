import { describe, expect, test } from 'bun:test'

describe('Rust CI qualification contract', () => {
    test('the main workflow is reusable and preserves FYLO-specific safety gates', async () => {
        const workflow = await Bun.file('.github/workflows/ci.yml').text()

        expect(workflow).toContain('workflow_call:')
        expect(workflow).toContain('cancel-in-progress: true')
        expect(workflow).toContain('portable-artifacts:')
        expect(workflow).toContain('native:')
        expect(workflow).toContain('browser:')
        expect(workflow).toContain('binary-interop:')
        expect(workflow).toContain('miri:')
        expect(workflow).toContain('rust:crash:matrix')
        expect(workflow).toContain('run-rust-soak.mjs --iterations 100')
        expect(workflow).toContain('browser: [chromium, firefox, webkit]')
        expect(workflow).toContain('windows-2022')
        expect(workflow).toContain('windows-2025')
    })

    test('quality uses the locked whole workspace and rejects documentation warnings', async () => {
        const [manifest, workflow] = await Promise.all([
            Bun.file('package.json').json(),
            Bun.file('.github/workflows/ci.yml').text()
        ])

        expect(manifest.scripts['rust:check']).toContain(
            'cargo check --workspace --all-targets --all-features --locked'
        )
        expect(manifest.scripts['rust:clippy']).toContain(
            'cargo clippy --workspace --all-targets --all-features --locked'
        )
        expect(manifest.scripts['rust:test']).toContain(
            'cargo test --workspace --all-targets --all-features --locked'
        )
        expect(manifest.scripts['rust:doc']).toContain(
            'cargo doc --workspace --all-features --no-deps --locked'
        )
        expect(workflow).toContain('bun run rust:check')
        expect(workflow).toContain('bun run rust:doc')
        expect(workflow).toContain('RUSTDOCFLAGS: -D warnings')
    })

    test('supply-chain, coverage, and provenance tools are exact and retained', async () => {
        const [manifest, workflow] = await Promise.all([
            Bun.file('package.json').json(),
            Bun.file('.github/workflows/ci.yml').text()
        ])

        expect(workflow).toContain('supply-chain:')
        expect(workflow).toContain('cargo-deny --version 0.19.7 --locked')
        expect(workflow).toContain('coverage:')
        expect(workflow).toContain('cargo-llvm-cov --version 0.8.6 --locked')
        expect(workflow).toContain('target/coverage.lcov')
        expect(manifest.scripts['rust:coverage']).toContain('--fail-under-lines 50')
        expect(manifest.scripts['rust:coverage']).toContain('--fail-under-functions 43')
        expect(manifest.scripts['rust:coverage']).toContain('--fail-under-regions 48')
        expect(workflow).toContain('provenance:')
        expect(workflow).toContain('cargo-cyclonedx --version 0.5.7 --locked')
        expect(workflow).toContain('cargo-auditable --version 0.7.0 --locked')
        expect(workflow).toContain('cargo cyclonedx --all --format json')
        expect(workflow).toContain('cargo auditable build')
    })

    test('scheduled qualification exercises memory and concurrency sanitizers', async () => {
        const workflow = await Bun.file('.github/workflows/rust-nightly.yml').text()

        expect(workflow).toContain('nightly-2026-07-20')
        expect(workflow).toContain('-Zsanitizer=address')
        expect(workflow).toContain('-Zsanitizer=leak')
        expect(workflow).toContain('-Zsanitizer=thread')
        expect(workflow).toContain('-p fylo-storage-native')
    })
})
