use std::fs::{self, File};
use std::io::{Read, Take};
use std::path::{Component, Path, PathBuf};

use aes_gcm::{
    Aes256Gcm,
    aead::{Aead, KeyInit},
};
use hmac::{Hmac, Mac};
use pbkdf2::pbkdf2_hmac_array;
use serde::Deserialize;
use serde_json::{Map, Value};
use sha2::Sha256;
use zeroize::Zeroizing;

const MAX_SCHEMA_MANIFEST_BYTES: u64 = 1024 * 1024;
const MAX_SCHEMA_BYTES: u64 = 16 * 1024 * 1024;
const PBKDF2_ITERATIONS: u32 = 100_000;
type SecretKey = Zeroizing<[u8; 32]>;

#[derive(Clone)]
pub(crate) struct EncryptionReader {
    schema_root: PathBuf,
    key: Option<SecretKey>,
    hmac_key: Option<SecretKey>,
}

pub(crate) fn reject_undeclared_ciphertext(
    collection: &str,
    fields: &Map<String, Value>,
) -> Result<(), String> {
    if contains_ciphertext(&Value::Object(fields.clone())) {
        Err(format!(
            "cannot decrypt collection {collection}: ciphertext exists but no schema root was configured"
        ))
    } else {
        Ok(())
    }
}

impl EncryptionReader {
    pub(crate) fn open(
        schema_root: impl AsRef<Path>,
        credentials: Option<(&str, &str)>,
    ) -> Result<Self, String> {
        let schema_root = fs::canonicalize(schema_root.as_ref())
            .map_err(|error| format!("cannot open FYLO schema root: {error}"))?;
        if !fs::metadata(&schema_root)
            .map_err(|error| format!("cannot inspect FYLO schema root: {error}"))?
            .is_dir()
        {
            return Err("FYLO schema root is not a directory".into());
        }
        let keys = credentials
            .map(|(secret, salt)| derive_keys(secret, salt))
            .transpose()?;
        let (key, hmac_key) =
            keys.map_or((None, None), |(key, hmac_key)| (Some(key), Some(hmac_key)));
        Ok(Self {
            schema_root,
            key,
            hmac_key,
        })
    }

    pub(crate) fn decode_document(
        &self,
        collection: &str,
        mut fields: Map<String, Value>,
    ) -> Result<Map<String, Value>, String> {
        let encrypted = self.encrypted_fields(collection)?;
        if encrypted.is_empty() {
            if fields.values().any(contains_ciphertext) {
                return Err(format!(
                    "cannot decrypt collection {collection}: ciphertext exists but its schema does not declare encrypted fields"
                ));
            }
            return Ok(fields);
        }
        let key = self.key.as_ref().ok_or_else(|| {
            format!(
                "cannot decrypt collection {collection}: FYLO_ENCRYPTION_KEY and FYLO_CIPHER_SALT are required"
            )
        })?;
        for (field, value) in &mut fields {
            decode_value(value, field, &encrypted, key).map_err(|reason| {
                format!("cannot decrypt encrypted field in collection {collection}: {reason}")
            })?;
        }
        Ok(fields)
    }

    pub(crate) fn encrypted_fields(&self, collection: &str) -> Result<Vec<String>, String> {
        let manifest_path = PathBuf::from(collection).join("manifest.json");
        if !self.path_exists(&manifest_path)? {
            return Ok(Vec::new());
        }
        let manifest: SchemaManifest =
            serde_json::from_slice(&self.read_file(&manifest_path, MAX_SCHEMA_MANIFEST_BYTES)?)
                .map_err(|error| format!("schema manifest is corrupt: {error}"))?;
        validate_version(&manifest.current)?;
        let schema_path = PathBuf::from(collection)
            .join("history")
            .join(format!("{}.schema.json", manifest.current));
        let schema: Value =
            serde_json::from_slice(&self.read_file(&schema_path, MAX_SCHEMA_BYTES)?)
                .map_err(|error| format!("head schema is corrupt: {error}"))?;
        let Some(encrypted) = schema.get("$encrypted") else {
            return Ok(Vec::new());
        };
        let encrypted = encrypted.as_array().ok_or_else(|| {
            format!("schema $encrypted for {collection} must be an array of field names")
        })?;
        encrypted
            .iter()
            .map(|field| {
                let field = field.as_str().ok_or_else(|| {
                    format!("schema $encrypted for {collection} must contain only strings")
                })?;
                validate_field_path(field)?;
                Ok(field.to_owned())
            })
            .collect()
    }

    pub(crate) fn blind_index(&self, value: &str) -> Result<String, String> {
        let key = self.hmac_key.as_ref().ok_or_else(|| {
            "FYLO_ENCRYPTION_KEY and FYLO_CIPHER_SALT are required for blind indexes".to_owned()
        })?;
        let mut hmac = <Hmac<Sha256> as hmac::KeyInit>::new_from_slice(key.as_slice())
            .map_err(|_| "invalid HMAC-SHA256 key".to_owned())?;
        hmac.update(value.as_bytes());
        Ok(format!(
            "idx1.{}",
            encode_base64_url(&hmac.finalize().into_bytes())
        ))
    }

    fn path_exists(&self, relative: &Path) -> Result<bool, String> {
        let path = self.schema_root.join(relative);
        match fs::symlink_metadata(path) {
            Ok(_) => Ok(true),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(format!("cannot inspect schema path: {error}")),
        }
    }

    fn read_file(&self, relative: &Path, max_bytes: u64) -> Result<Vec<u8>, String> {
        let mut current = self.schema_root.clone();
        for component in relative.components() {
            let Component::Normal(segment) = component else {
                return Err("schema path contains an unsafe component".into());
            };
            current.push(segment);
            let metadata = fs::symlink_metadata(&current)
                .map_err(|error| format!("cannot inspect schema path: {error}"))?;
            if metadata.file_type().is_symlink() {
                return Err("schema path contains a symbolic link or reparse point".into());
            }
        }
        let canonical = fs::canonicalize(&current)
            .map_err(|error| format!("cannot canonicalize schema path: {error}"))?;
        if !canonical.starts_with(&self.schema_root) {
            return Err("schema path escapes the canonical schema root".into());
        }
        let file =
            File::open(&canonical).map_err(|error| format!("cannot open schema file: {error}"))?;
        let metadata = file
            .metadata()
            .map_err(|error| format!("cannot inspect schema file: {error}"))?;
        if !metadata.is_file() {
            return Err("schema path is not a regular file".into());
        }
        if metadata.len() > max_bytes {
            return Err(format!("schema file exceeds {max_bytes} bytes"));
        }
        read_bounded(file.take(max_bytes.saturating_add(1)), max_bytes)
    }
}

#[derive(Deserialize)]
struct SchemaManifest {
    current: String,
}

fn derive_keys(secret: &str, salt: &str) -> Result<(SecretKey, SecretKey), String> {
    if secret.len() < 32 {
        return Err("FYLO_ENCRYPTION_KEY must be at least 32 characters long".into());
    }
    if salt.is_empty() {
        return Err("FYLO_CIPHER_SALT must not be empty".into());
    }
    let material = Zeroizing::new(pbkdf2_hmac_array::<Sha256, 64>(
        secret.as_bytes(),
        salt.as_bytes(),
        PBKDF2_ITERATIONS,
    ));
    let mut key = Zeroizing::new([0_u8; 32]);
    key.copy_from_slice(&material[..32]);
    let mut hmac_key = Zeroizing::new([0_u8; 32]);
    hmac_key.copy_from_slice(&material[32..]);
    Ok((key, hmac_key))
}

fn decode_value(
    value: &mut Value,
    field: &str,
    encrypted: &[String],
    key: &[u8; 32],
) -> Result<(), String> {
    match value {
        Value::Object(fields) => {
            for (child, value) in fields {
                decode_value(value, &format!("{field}/{child}"), encrypted, key)?;
            }
        }
        Value::Array(values) => {
            for value in values {
                decode_value(value, field, encrypted, key)?;
            }
        }
        Value::String(ciphertext) if is_encrypted_field(field, encrypted) => {
            *value = decode_stored_value(&decrypt(ciphertext, key)?);
        }
        _ => {}
    }
    Ok(())
}

pub(crate) fn is_encrypted_field(field: &str, encrypted: &[String]) -> bool {
    encrypted
        .iter()
        .any(|pattern| field == pattern || field.starts_with(&format!("{pattern}/")))
}

fn encode_base64_url(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut output = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let first = chunk[0];
        let second = chunk.get(1).copied().unwrap_or(0);
        let third = chunk.get(2).copied().unwrap_or(0);
        output.push(char::from(ALPHABET[usize::from(first >> 2)]));
        output.push(char::from(
            ALPHABET[usize::from(((first & 0x03) << 4) | (second >> 4))],
        ));
        if chunk.len() > 1 {
            output.push(char::from(
                ALPHABET[usize::from(((second & 0x0f) << 2) | (third >> 6))],
            ));
        }
        if chunk.len() > 2 {
            output.push(char::from(ALPHABET[usize::from(third & 0x3f)]));
        }
    }
    output
}

fn decrypt(encoded: &str, key: &[u8; 32]) -> Result<String, String> {
    let payload = encoded
        .strip_prefix("v2.")
        .ok_or_else(|| "unsupported ciphertext format; expected v2".to_owned())?;
    let combined = decode_base64_url(payload)?;
    if combined.len() < 12 + 16 {
        return Err("ciphertext envelope is truncated".into());
    }
    let (nonce, ciphertext) = combined.split_at(12);
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| "invalid AES-256 key".to_owned())?;
    let nonce: &aes_gcm::aead::Nonce<Aes256Gcm> = nonce
        .try_into()
        .map_err(|_| "ciphertext nonce has an invalid length".to_owned())?;
    let plaintext = cipher
        .decrypt(nonce, ciphertext)
        .map_err(|_| "configured key could not authenticate ciphertext".to_owned())?;
    String::from_utf8(plaintext).map_err(|_| "decrypted value is not valid UTF-8".into())
}

fn decode_stored_value(plaintext: &str) -> Value {
    let unescaped = plaintext.replace("%2F", "/");
    match serde_json::from_str(&unescaped) {
        Ok(value) => value,
        Err(_) => Value::String(unescaped),
    }
}

fn contains_ciphertext(value: &Value) -> bool {
    match value {
        Value::String(value) => value.starts_with("v2."),
        Value::Array(values) => values.iter().any(contains_ciphertext),
        Value::Object(fields) => fields.values().any(contains_ciphertext),
        _ => false,
    }
}

fn decode_base64_url(encoded: &str) -> Result<Vec<u8>, String> {
    let mut source = encoded.as_bytes().to_vec();
    for byte in &mut source {
        match *byte {
            b'-' => *byte = b'+',
            b'_' => *byte = b'/',
            _ => {}
        }
    }
    let padding = (4 - source.len() % 4) % 4;
    source.extend(std::iter::repeat_n(b'=', padding));
    decode_base64(&source)
}

fn decode_base64(encoded: &[u8]) -> Result<Vec<u8>, String> {
    if !encoded.len().is_multiple_of(4) {
        return Err("ciphertext contains invalid base64url".into());
    }
    let quartets = encoded.chunks_exact(4);
    let count = quartets.len();
    let mut output = Vec::with_capacity(count * 3);
    for (index, quartet) in quartets.enumerate() {
        let last = index + 1 == count;
        if (!last && quartet.contains(&b'='))
            || quartet[0] == b'='
            || quartet[1] == b'='
            || (quartet[2] == b'=' && quartet[3] != b'=')
        {
            return Err("ciphertext contains invalid base64url padding".into());
        }
        let a = base64_value(quartet[0])?;
        let b = base64_value(quartet[1])?;
        let c = if quartet[2] == b'=' {
            0
        } else {
            base64_value(quartet[2])?
        };
        let d = if quartet[3] == b'=' {
            0
        } else {
            base64_value(quartet[3])?
        };
        output.push((a << 2) | (b >> 4));
        if quartet[2] != b'=' {
            output.push((b << 4) | (c >> 2));
        }
        if quartet[3] != b'=' {
            output.push((c << 6) | d);
        }
    }
    Ok(output)
}

fn base64_value(byte: u8) -> Result<u8, String> {
    match byte {
        b'A'..=b'Z' => Ok(byte - b'A'),
        b'a'..=b'z' => Ok(byte - b'a' + 26),
        b'0'..=b'9' => Ok(byte - b'0' + 52),
        b'+' => Ok(62),
        b'/' => Ok(63),
        _ => Err("ciphertext contains invalid base64url".into()),
    }
}

fn validate_version(version: &str) -> Result<(), String> {
    let valid = !version.is_empty()
        && version.len() <= 128
        && version
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte));
    if valid {
        Ok(())
    } else {
        Err("schema manifest current version is invalid".into())
    }
}

fn validate_field_path(field: &str) -> Result<(), String> {
    let valid = !field.is_empty()
        && field.len() <= 1024
        && field
            .split('/')
            .all(|segment| !segment.is_empty() && segment != "." && segment != "..");
    if valid {
        Ok(())
    } else {
        Err("schema contains an invalid encrypted field path".into())
    }
}

fn read_bounded<R: Read>(mut reader: Take<R>, max_bytes: u64) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    reader
        .read_to_end(&mut bytes)
        .map_err(|error| format!("cannot read schema file: {error}"))?;
    if bytes.len() as u64 > max_bytes {
        return Err(format!("schema file exceeds {max_bytes} bytes"));
    }
    Ok(bytes)
}
