/**
 * AES-256-GCM encryption adapter for field-level value encryption.
 *
 * Two modes are supported via the `deterministic` flag on `encrypt()`:
 *
 * - **Random IV (default)**: A cryptographically random IV is generated per
 *   encryption operation. Identical plaintexts produce different ciphertexts.
 *   Use this for fields that do not need exact-match ($eq/$ne) queries.
 *
 * Exact-match queries use a separate keyed HMAC blind index. This leaks equality
 * and frequency for indexed values, but stored document bodies use random nonces.
 *
 * Encrypted fields are declared per-collection in JSON schema files via the
 * `$encrypted` array. The encryption key is sourced from `FYLO_ENCRYPTION_KEY`.
 * Set `FYLO_CIPHER_SALT` to a unique random value to prevent cross-deployment attacks.
 */
export class Cipher {
    /** @type {CryptoKey | null} */
    static key = null
    /** @type {CryptoKey | null} */
    static hmacKey = null
    /** Per-collection encrypted field sets, loaded from schema `$encrypted` arrays. */
    /** @type {Map<string, Set<string>>} */
    static collections = new Map()

    /** @returns {boolean} */
    static isConfigured() {
        return Cipher.key !== null
    }

    /**
     * @param {string} collection
     * @returns {boolean}
     */
    static hasEncryptedFields(collection) {
        const fields = Cipher.collections.get(collection)
        return !!fields && fields.size > 0
    }

    /**
     * @param {string} collection
     * @param {string} field
     * @returns {boolean}
     */
    static isEncryptedField(collection, field) {
        const fields = Cipher.collections.get(collection)
        if (!fields || fields.size === 0) return false
        for (const pattern of fields) {
            if (field === pattern) return true
            // Support nested: encrypting "address" encrypts "address/city" etc.
            if (field.startsWith(`${pattern}/`)) return true
        }
        return false
    }
    /**
     * Registers encrypted fields for a collection (from schema `$encrypted` array).
     * @param {string} collection
     * @param {string[]} fields
     */
    static registerFields(collection, fields) {
        if (fields.length > 0) {
            Cipher.collections.set(collection, new Set(fields))
        }
    }
    /**
     * Derives AES + HMAC keys from a secret string. Called once at startup.
     * @param {string} secret
     */
    static async configure(secret) {
        const encoder = new TextEncoder()
        const keyMaterial = await crypto.subtle.importKey(
            'raw',
            encoder.encode(secret),
            'PBKDF2',
            false,
            ['deriveBits']
        )
        const cipherSalt = process.env.FYLO_CIPHER_SALT
        if (!cipherSalt) {
            throw new Error(
                'FYLO_CIPHER_SALT env var is not set. Generate one with: export FYLO_CIPHER_SALT=$(openssl rand -hex 32)'
            )
        }
        // Derive 64 bytes: 32 for AES-GCM key + 32 for HMAC blind indexes.
        const bits = await crypto.subtle.deriveBits(
            {
                name: 'PBKDF2',
                salt: encoder.encode(cipherSalt),
                iterations: 100000,
                hash: 'SHA-256'
            },
            keyMaterial,
            512
        )
        const derived = new Uint8Array(bits)
        const key = await crypto.subtle.importKey(
            'raw',
            derived.slice(0, 32),
            { name: 'AES-GCM' },
            false,
            ['encrypt', 'decrypt']
        )
        const hmacKey = await crypto.subtle.importKey(
            'raw',
            derived.slice(32, 64),
            { name: 'HMAC', hash: 'SHA-256' },
            false,
            ['sign']
        )
        Cipher.key = key
        Cipher.hmacKey = hmacKey
    }

    /** Reset keys and collection field registrations for tests or reconfiguration. */
    static reset() {
        Cipher.key = null
        Cipher.hmacKey = null
        Cipher.collections = new Map()
    }
    /**
     * Deterministic nonce from HMAC-SHA256 of plaintext, truncated to 12 bytes.
     * @param {string} plaintext
     * @returns {Promise<Uint8Array>}
     */
    static async deriveNonce(plaintext) {
        const hmacKey = Cipher.hmacKey
        if (!hmacKey) throw new Error('Cipher not configured — set FYLO_ENCRYPTION_KEY env var')
        const encoder = new TextEncoder()
        const sig = await crypto.subtle.sign('HMAC', hmacKey, encoder.encode(plaintext))
        return new Uint8Array(sig).slice(0, 12)
    }

    /**
     * @param {Uint8Array} bytes
     * @returns {string}
     */
    static base64Url(bytes) {
        let binary = ''
        for (let i = 0; i < bytes.length; i += 0x8000) {
            binary += String.fromCharCode(...bytes.slice(i, i + 0x8000))
        }
        return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    }

    /**
     * @param {string} encoded
     * @returns {Uint8Array}
     */
    static fromBase64Url(encoded) {
        const b64 = encoded.replace(/-/g, '+').replace(/_/g, '/')
        const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
        return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0))
    }
    /**
     * Produces a keyed lookup token for encrypted exact-match indexes.
     * @param {string} value
     * @returns {Promise<string>}
     */
    static async blindIndex(value) {
        const hmacKey = Cipher.hmacKey
        if (!hmacKey) throw new Error('Cipher not configured — set FYLO_ENCRYPTION_KEY env var')
        const sig = await crypto.subtle.sign('HMAC', hmacKey, new TextEncoder().encode(value))
        return `idx1.${Cipher.base64Url(new Uint8Array(sig))}`
    }
    /**
     * Encrypts a value. Returns a URL-safe base64 string (no slashes).
     *
     * @param {string} value - The plaintext to encrypt.
     * @param {boolean=} deterministic - Compatibility mode for legacy deterministic callers.
     *   Prefer `blindIndex()` for query indexes and random nonces for stored data.
     * @returns {Promise<string>}
     */
    static async encrypt(value, deterministic = false) {
        const key = Cipher.key
        if (!key) throw new Error('Cipher not configured — set FYLO_ENCRYPTION_KEY env var')
        const nonce = deterministic
            ? await Cipher.deriveNonce(value)
            : crypto.getRandomValues(new Uint8Array(12))
        const encoder = new TextEncoder()
        const encrypted = await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv: /** @type {BufferSource} */ (nonce) },
            key,
            encoder.encode(value)
        )
        const combined = new Uint8Array(nonce.length + encrypted.byteLength)
        combined.set(nonce)
        combined.set(new Uint8Array(encrypted), nonce.length)
        return `v2.${Cipher.base64Url(combined)}`
    }
    /**
     * Whether a stored value carries this cipher's wire format. Callers use it
     * to distinguish legacy plaintext from a wrong key without quoting stored
     * content into an error.
     * @param {string} stored
     * @returns {boolean}
     */
    static isCiphertext(stored) {
        return stored.startsWith('v2.')
    }
    /**
     * Decrypts a URL-safe base64 encoded value back to plaintext.
     * @param {string} encoded
     * @returns {Promise<string>}
     */
    static async decrypt(encoded) {
        const key = Cipher.key
        if (!key) throw new Error('Cipher not configured — set FYLO_ENCRYPTION_KEY env var')
        if (!encoded.startsWith('v2.')) {
            throw new Error(
                `Unsupported ciphertext format. Expected v2.* (AES-GCM); received ${encoded.slice(0, 8)}…`
            )
        }
        const combined = Cipher.fromBase64Url(encoded.slice(3))
        const nonce = combined.slice(0, 12)
        const ciphertext = combined.slice(12)
        const decrypted = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: nonce },
            key,
            ciphertext
        )
        return new TextDecoder().decode(decrypted)
    }
}
