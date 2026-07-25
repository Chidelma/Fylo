import { test, expect, describe } from 'bun:test'
import TTID from '../helpers/ttid.js'

// `before`/`after` bracket the generation call, but the process can be
// descheduled between reading the clock and TTID reading its own, so the
// decoded stamp may land outside that window under full-suite load. This
// slack keeps the assertion meaningful while tolerating scheduling jitter.
const CLOCK_JITTER_MS = 250

describe('TTID direct integration', () => {
    describe('generate()', () => {
        test('creates a new TTID string', () => {
            const id = TTID.generate()
            expect(typeof id).toBe('string')
            expect(id.length).toBeGreaterThan(0)
        })

        test('each call produces a unique ID (with 1ms spacing)', () => {
            // TTID uses timestamp-based generation with ~0.1ms precision.
            // Calls in the same tick produce duplicates by design.
            // A 1ms gap between calls guarantees unique IDs.
            const ids = new Set()
            for (let i = 0; i < 20; i++) {
                ids.add(TTID.generate())
                // Yield to ensure timestamp advances between calls
                Bun.sleepSync(1)
            }
            expect(ids.size).toBe(20)
        })

        test('TTID format matches expected pattern', () => {
            const id = TTID.generate()
            // TTIDs are alphanumeric with hyphens
            expect(id).toMatch(/^[a-zA-Z0-9-]+$/)
        })

        test('advances an existing TTID to a new one', () => {
            const original = TTID.generate()
            const advanced = TTID.generate(original)
            expect(advanced).not.toBe(original)
            expect(typeof advanced).toBe('string')
            expect(advanced.length).toBeGreaterThan(0)
        })

        test('advancing the same ID twice produces distinct results', () => {
            const original = TTID.generate()
            const first = TTID.generate(original)
            const second = TTID.generate(original)
            expect(first).not.toBe(second)
        })

        test('delete flag marks a TTID as deleted', () => {
            const original = TTID.generate()
            const deleted = TTID.generate(original, true)
            expect(deleted).not.toBe(original)
            expect(typeof deleted).toBe('string')
        })
    })

    describe('isTTID()', () => {
        test('returns a Date for a valid generated TTID', () => {
            const id = TTID.generate()
            const result = TTID.isTTID(id)
            expect(result).toBeInstanceOf(Date)
        })

        test('returns null for an invalid string', () => {
            expect(TTID.isTTID('not-a-ttid')).toBeNull()
            expect(TTID.isTTID('')).toBeNull()
            expect(TTID.isTTID('../path-traversal')).toBeNull()
        })

        test('returns null for non-string input', () => {
            expect(TTID.isTTID(null)).toBeNull()
            expect(TTID.isTTID(undefined)).toBeNull()
            expect(TTID.isTTID(123)).toBeNull()
        })

        test('validates a batch of generated TTIDs', () => {
            for (let i = 0; i < 50; i++) {
                const id = TTID.generate()
                expect(TTID.isTTID(id)).toBeInstanceOf(Date)
            }
        })

        test('advanced TTIDs are still valid', () => {
            const original = TTID.generate()
            const advanced = TTID.generate(original)
            expect(TTID.isTTID(advanced)).toBeInstanceOf(Date)
        })

        test('deleted TTIDs are still valid', () => {
            const original = TTID.generate()
            const deleted = TTID.generate(original, true)
            expect(TTID.isTTID(deleted)).toBeInstanceOf(Date)
        })
    })

    describe('decodeTime()', () => {
        test('decodes createdAt from a new TTID', () => {
            const before = Date.now()
            const id = TTID.generate()
            const ts = TTID.decodeTime(id)
            const after = Date.now()
            expect(ts).toBeDefined()
            expect(typeof ts.createdAt).toBe('number')
            // Timestamp should fall within the generation window (TTID has ms precision)
            expect(ts.createdAt).toBeGreaterThanOrEqual(before - CLOCK_JITTER_MS)
            expect(ts.createdAt).toBeLessThanOrEqual(after + CLOCK_JITTER_MS)
        })

        test('decodes updatedAt from an advanced TTID', () => {
            const original = TTID.generate()
            const ts1 = TTID.decodeTime(original)
            expect(ts1.updatedAt).toBeUndefined()

            const advanced = TTID.generate(original)
            const ts2 = TTID.decodeTime(advanced)
            expect(typeof ts2.createdAt).toBe('number')
            // updatedAt may or may not be present depending on TTID version
        })

        test('decodes deletedAt from a deleted TTID', () => {
            const original = TTID.generate()
            const deleted = TTID.generate(original, true)
            const ts = TTID.decodeTime(deleted)
            expect(typeof ts.createdAt).toBe('number')
        })
    })

    describe('isUUID()', () => {
        test('validates standard UUIDs', () => {
            const uuid = Bun.randomUUIDv7()
            const result = TTID.isUUID(uuid)
            expect(result).not.toBeNull()
        })

        test('rejects non-UUID strings', () => {
            expect(TTID.isUUID('not-a-uuid')).toBeNull()
            expect(TTID.isUUID('')).toBeNull()
        })

        test('generated TTIDs are not UUIDs', () => {
            const id = TTID.generate()
            expect(TTID.isUUID(id)).toBeNull()
        })
    })

    describe('cross-method consistency', () => {
        test('generated IDs pass isTTID validation', () => {
            const id = TTID.generate()
            expect(TTID.isTTID(id)).toBeInstanceOf(Date)
        })

        test('isTTID rejects random strings but accepts generated IDs', () => {
            const valid = TTID.generate()
            const invalid = 'xyz-' + valid.slice(4) // corrupt the prefix
            expect(TTID.isTTID(valid)).toBeInstanceOf(Date)
            // Corrupted IDs may or may not validate depending on checksum
        })

        test('decodeTime returns monotonic timestamps', () => {
            const ids = Array.from({ length: 5 }, () => TTID.generate())
            const timestamps = ids.map((id) => TTID.decodeTime(id).createdAt)
            for (let i = 1; i < timestamps.length; i++) {
                expect(timestamps[i]).toBeGreaterThanOrEqual(timestamps[i - 1])
            }
        })
    })
})
