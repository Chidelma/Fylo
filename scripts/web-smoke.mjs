#!/usr/bin/env bun

import { readFile } from 'node:fs/promises'

const REQUEST_TIMEOUT_MS = 15_000

export async function smokeSite(site, fetcher = fetch) {
    const results = []
    for (const probe of site.probes) {
        const url = new URL(probe.path, site.origin).href
        const response = await fetcher(url, {
            redirect: 'follow',
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            headers: { 'cache-control': 'no-cache', 'user-agent': 'fylo-release-smoke/1' }
        })
        if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`)

        for (const [name, expected] of Object.entries({
            ...site.requiredHeaders,
            ...probe.requiredHeaders
        })) {
            const actual = response.headers.get(name)
            if (actual !== expected) {
                throw new Error(
                    `${url} returned unexpected ${name} header ${JSON.stringify(actual)}; expected ${JSON.stringify(expected)}`
                )
            }
        }

        const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim() ?? ''
        if (probe.contentTypes?.length && !probe.contentTypes.includes(contentType)) {
            throw new Error(
                `${url} returned unexpected content type ${JSON.stringify(contentType)}; expected ${probe.contentTypes.join(' or ')}`
            )
        }

        const bytes = new Uint8Array(await response.arrayBuffer())
        if (probe.contains && !new TextDecoder().decode(bytes).includes(probe.contains)) {
            throw new Error(
                `${url} did not contain expected marker ${JSON.stringify(probe.contains)}`
            )
        }
        if (probe.startsWithHex) {
            if (!/^(?:[a-f\d]{2})+$/i.test(probe.startsWithHex)) {
                throw new Error(`${url} has an invalid configured binary marker`)
            }
            const expected = Uint8Array.from(
                probe.startsWithHex.match(/.{2}/g).map((byte) => Number.parseInt(byte, 16))
            )
            if (
                expected.length === 0 ||
                bytes.length < expected.length ||
                expected.some((byte, index) => bytes[index] !== byte)
            ) {
                throw new Error(
                    `${url} did not start with expected binary marker ${probe.startsWithHex}`
                )
            }
        }
        results.push({ url, status: response.status })
    }
    return results
}

async function main() {
    const [siteName, configPath = 'ops/web-release.json'] = process.argv.slice(2)
    const config = JSON.parse(await readFile(configPath, 'utf8'))
    const site = config.sites?.[siteName]
    if (!site) throw new Error(`Unknown site ${JSON.stringify(siteName)}`)
    console.log(JSON.stringify(await smokeSite(site)))
}

if (import.meta.main)
    main().catch((error) => {
        console.error(error.message)
        process.exitCode = 1
    })
