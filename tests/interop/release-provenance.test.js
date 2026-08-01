import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve(import.meta.dir, '../..')

describe('release recovery and supply-chain gates', () => {
    test('keeps release assets independent of object-storage credentials', async () => {
        const publish = await readFile(path.join(root, '.github/workflows/publish.yml'), 'utf8')
        expect(publish).toContain('needs.macos-storage.result ==')
        expect(publish).not.toContain('s3-live.yml')
        expect(publish).not.toContain('needs.live-s3')
    })

    test('generates, attests, and verifies an SPDX SBOM before assets are uploaded', async () => {
        const workflow = await readFile(path.join(root, '.github/workflows/publish.yml'), 'utf8')
        const sbom = workflow.indexOf(
            'anchore/sbom-action@e22c389904149dbc22b58101806040fa8d37a610'
        )
        const provenance = workflow.indexOf(
            'actions/attest@f7c74d28b9d84cb8768d0b8ca14a4bac6ef463e6'
        )
        const verify = workflow.indexOf('gh attestation verify')
        const upload = workflow.indexOf('name: Upload verified release assets')

        expect(workflow).toContain('id-token: write')
        expect(workflow).toContain('attestations: write')
        expect(workflow).toContain('artifact-metadata: write')
        expect(workflow).toContain('syft-version: v1.49.0')
        expect(workflow).toContain('fylo-${VERSION}.spdx.json')
        expect(workflow).toContain('Native Rust Linux release (${{ matrix.target }})')
        expect(workflow).toContain('Download native-tested Linux arm64 release executable')
        expect(workflow).toContain('native-release-root-lease.test.js')
        expect(workflow).toContain('macos-15-intel')
        expect(workflow).toContain('FYLO_BUILD_KIND: release')
        expect(workflow).toContain(
            'Verify release candidate matches all released machine semantics'
        )
        expect(workflow).toContain('verify-rust-release-machine-parity.mjs')
        expect(workflow).toContain('gh release download v26.30.06')
        expect(workflow).toContain(
            'ae39a2b66ea9771766f3f3d6b3d0d1b01e1b3842a45aa0389535109b91bdee50'
        )
        expect(sbom).toBeGreaterThan(0)
        expect(provenance).toBeGreaterThan(sbom)
        expect(verify).toBeGreaterThan(provenance)
        expect(upload).toBeGreaterThan(verify)
    })

    test('keeps the Windows filesystem capability behind native NTFS tests', async () => {
        for (const name of ['ci.yml', 'publish.yml']) {
            const workflow = await readFile(path.join(root, '.github/workflows', name), 'utf8')
            expect(workflow).toContain('tests/interop/windows-native-binary.test.js')
            expect(workflow).not.toContain('tests/integration/s3-')
        }
    })

    test('prebuilds compiled interop once and installs required macOS client tools', async () => {
        const workflow = await readFile(path.join(root, '.github/workflows/publish.yml'), 'utf8')
        const macos = workflow.slice(
            workflow.indexOf('    macos-storage:'),
            workflow.indexOf('    linux-storage:')
        )
        const interop = workflow.slice(
            workflow.indexOf('    binary-interop:'),
            workflow.indexOf('    version:')
        )

        expect(macos).toContain('shivammathur/setup-php@')
        expect(macos).toContain('actions/setup-go@')
        expect(interop).toContain('name: Build exact Rust release executable')
        expect(interop).toContain("FYLO_SKIP_BINARY_BUILD: '1'")
    })

    test('limits cross-version handshake normalization to release identity and known capabilities', async () => {
        const parity = await readFile(
            path.join(root, 'scripts/verify-rust-release-machine-parity.mjs'),
            'utf8'
        )
        const normalizeHandshake = parity.slice(
            parity.indexOf('function normalizeHandshake'),
            parity.indexOf('function normalizeKnownReleaseDeltas')
        )

        expect(normalizeHandshake).toContain('delete normalized.runtimeVersion')
        expect(normalizeHandshake).toContain('delete normalized.capabilities?.documentBuckets')
        expect(normalizeHandshake).toContain('delete normalized.capabilities?.machineAccess')
        expect(normalizeHandshake.match(/delete normalized\.capabilities\?\./g)).toHaveLength(3)
        expect(normalizeHandshake).not.toContain('delete normalized.protocolVersion')
        expect(normalizeHandshake).not.toContain('delete normalized.capabilities\n')
    })
})
