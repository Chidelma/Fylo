export class CipherMock {
    static _configured = false
    static collections = new Map()
    static isConfigured() {
        return CipherMock._configured
    }
    static hasEncryptedFields(collection) {
        const fields = CipherMock.collections.get(collection)
        return !!fields && fields.size > 0
    }
    static isEncryptedField(collection, field) {
        const fields = CipherMock.collections.get(collection)
        if (!fields || fields.size === 0) return false
        for (const pattern of fields) {
            if (field === pattern) return true
            if (field.startsWith(`${pattern}/`)) return true
        }
        return false
    }
    static registerFields(collection, fields) {
        if (fields.length > 0) {
            CipherMock.collections.set(collection, new Set(fields))
        }
    }
    static async configure(_secret) {
        CipherMock._configured = true
    }
    static reset() {
        CipherMock._configured = false
        CipherMock.collections = new Map()
    }
    static async encrypt(value) {
        return btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    }
    static async blindIndex(value) {
        return `idx.${btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`
    }
    static isCiphertext(stored) {
        // The mock's wire format is bare base64url, so anything decodable
        // counts as ciphertext.
        return /^[A-Za-z0-9\-_]+$/.test(stored)
    }
    static async decrypt(encoded) {
        const b64 = encoded.replace(/-/g, '+').replace(/_/g, '/')
        const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
        return atob(padded)
    }
}
