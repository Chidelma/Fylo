import { describe, expect, test } from 'bun:test'

const workflows = ['.github/workflows/ci.yml', '.github/workflows/publish.yml']

describe('native Windows release gate', () => {
    for (const workflowPath of workflows) {
        test(`${workflowPath} requires the native Rust Windows x64 contract`, async () => {
            const workflow = await Bun.file(workflowPath).text()

            expect(workflow).toContain('windows-2022')
            expect(workflow).toContain('windows-2025')
            expect(workflow).toContain('bun-version-file: .bun-version')
            expect(workflow).toContain('cargo test --locked')
            expect(workflow).toContain('-p fylo-storage-native')
            expect(workflow).toContain('-p fylo-machine')
            expect(workflow).toContain('rust:crash:matrix')
            expect(workflow).not.toContain('tests/integration/')
            expect(workflow).toContain('bun ./scripts/build-executable.mjs --outfile')
            expect(workflow).toContain('tests/interop/native-release-root-lease.test.js')
        })
    }

    test('Release publishes the exact native-tested Windows executable', async () => {
        const workflow = await Bun.file('.github/workflows/publish.yml').text()

        expect(workflow).toContain(
            'bun ./scripts/build-executable.mjs --outfile ./dist-bin/fylo-windows-x64.exe'
        )
        expect(workflow).toContain('FYLO_WINDOWS_BINARY: dist-bin/fylo-windows-x64.exe')
        expect(workflow).toContain("if: matrix.os == 'windows-2022'")
        expect(workflow).toContain('name: windows-release-${{ github.sha }}')
        expect(workflow).toContain('path: dist-bin/fylo-windows-x64.exe')
        expect(workflow).toContain('Download native-tested Windows release executable')
        expect(workflow).toContain('Native Rust Linux release (${{ matrix.target }})')
        expect(workflow).toContain('os: ubuntu-24.04-arm')
        expect(workflow).toContain('name: linux-release-linux-arm64-${{ github.sha }}')
        expect(workflow).toContain('Download native-tested Linux arm64 release executable')
        expect(workflow).not.toContain('bun ./scripts/build-executable.mjs --target')
        expect(workflow).not.toContain('build bun-windows-x64')
    })

    test('the public executable builder and package expose only the Rust native engine', async () => {
        const [manifest, builder, publicEntry] = await Promise.all([
            Bun.file('package.json').json(),
            Bun.file('scripts/build-executable.mjs').text(),
            Bun.file('src/index.js').text()
        ])

        expect(manifest.scripts['build:exe']).toBe('bun ./scripts/build-executable.mjs')
        expect(manifest.scripts['build:exe:javascript']).toBeUndefined()
        expect(manifest.bin).toBeUndefined()
        expect(builder).toContain("'cargo',")
        expect(builder).toContain("'fylo-rust'")
        expect(builder).not.toContain("'./src/cli/index.js'")
        expect(publicEntry).toContain('../clients/node/fylo.mjs')
    })

    test('Release publishes a CalVer-named self-hosted Explorer archive', async () => {
        const workflow = await Bun.file('.github/workflows/publish.yml').text()
        const explorerPackage = await Bun.file('explorer/package.json').json()

        expect(explorerPackage.scripts['bundle:release']).toContain(
            'sync-explorer-browser-assets.mjs'
        )
        expect(workflow).toContain('(cd explorer && bun install --frozen-lockfile)')
        expect(workflow).toContain('(cd explorer && bun run bundle:release)')
        expect(workflow).toContain('bun scripts/web-artifact.mjs explorer/dist/web release-assets')
        expect(workflow).toContain('fylo-explorer-${VERSION}.zip')
        expect(workflow).toContain('unzip -tq "$archive"')
        expect(workflow).toContain("grep -Fq 'FX | Fylo Explorer'")
        expect(workflow).toContain('sha256sum --check SHA256SUMS')
    })
})

describe('release supply-chain pinning', () => {
    for (const workflowPath of [
        ...workflows,
        '.github/workflows/pages.yml',
        '.github/workflows/rust-nightly.yml'
    ]) {
        test(`${workflowPath} pins every external action to a commit`, async () => {
            const workflow = await Bun.file(workflowPath).text()
            const actions = [...workflow.matchAll(/uses:\s+([^\s#]+)@([^\s#]+)/g)]

            expect(actions.length).toBeGreaterThan(0)
            for (const [, action, reference] of actions) {
                expect(reference, `${action} must use a full commit SHA`).toMatch(/^[0-9a-f]{40}$/)
            }
        })
    }

    for (const workflowPath of workflows) {
        test(`${workflowPath} uses repository-verified toolchain installers`, async () => {
            const workflow = await Bun.file(workflowPath).text()

            expect(workflow).toContain('sh ./scripts/install-vendor-bins.sh')
            expect(workflow).toContain('sh ./scripts/install-kotlin-compiler.sh')
            expect(workflow).not.toContain('releases/latest')
            expect(workflow).not.toMatch(/curl[^\n]*\|\s*(?:ba)?sh/)
        })
    }

    test('vendor installers anchor versions and digests in the repository', async () => {
        const [shell, powershell, kotlin] = await Promise.all([
            Bun.file('scripts/install-vendor-bins.sh').text(),
            Bun.file('scripts/install-vendor-bins.ps1').text(),
            Bun.file('scripts/install-kotlin-compiler.sh').text()
        ])

        for (const installer of [shell, powershell]) {
            expect(installer).toContain('v26.32.03')
            expect(installer).toContain('v26.32.02')
            expect(installer).toContain('v26.33.01')
            expect(installer).not.toContain('releases/latest')
            expect(installer).not.toContain('SHA256SUMS')
        }
        expect(shell).toContain('2ec6d27844720cdbaf7f9b4e06ab20f06cb69aa272930a22eca0edf57ef4dcf4')
        expect(powershell).toContain(
            '41c06d2305e40ceb34baefc214610a869defc772501047e39c23427e0ff8565f'
        )
        expect(shell).toContain('0ecafafd0468b8e559e98f1192e88df2cc5c53fb195e8ff8305b4d2f3b2ee584')
        expect(powershell).toContain(
            '15b624f77c4e582a41332e44aadc7451369b960f8081da7fd670e11eb76a6424'
        )
        expect(kotlin).toContain("KOTLIN_VERSION='2.1.10'")
        expect(kotlin).toContain(
            "KOTLIN_SHA256='c6e9e2636889828e19c8811d5ab890862538c89dc2a3101956dfee3c2a8ba6b1'"
        )
        expect(kotlin).not.toContain('.zip.sha256')
    })
})
