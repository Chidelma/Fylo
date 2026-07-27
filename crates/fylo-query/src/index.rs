use std::collections::BTreeSet;

use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

const MAX_STRING_PREFIX_BYTES: usize = 180;
const MAX_NGRAM_SOURCE_CHARS: usize = 512;
const NGRAM_SIZE: usize = 3;
const SIGN_MASK: u64 = 1_u64 << 63;

/// Value selected for an equality lookup, plus whether string/range expansion
/// must be suppressed for an encrypted field.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct IndexLookupValue {
    /// Plain stored-value text or a keyed blind-index token.
    pub value: String,
    /// Whether the field is schema-encrypted.
    pub encrypted: bool,
}

impl IndexLookupValue {
    /// Preserve the JavaScript indexer's ordinary plaintext behavior.
    #[must_use]
    pub fn plain(value: impl Into<String>) -> Self {
        Self {
            value: value.into(),
            encrypted: false,
        }
    }

    /// Use a keyed equality token for a schema-encrypted field.
    #[must_use]
    pub fn encrypted(value: impl Into<String>) -> Self {
        Self {
            value: value.into(),
            encrypted: true,
        }
    }
}

/// Independently derive every JavaScript-compatible prefix-index key for one
/// validated document.
///
/// `lookup` may replace the ordinary stored-value string with a keyed blind
/// token for schema-encrypted fields. The portable kernel otherwise owns field
/// traversal, JavaScript number formatting/coercion, URI encoding, sortable
/// numeric keys, reverse strings, and trigrams.
///
/// # Errors
///
/// Propagates the host's blind-index/key-availability failure.
pub fn index_entries_for_document<E>(
    document_id: &str,
    fields: &Map<String, Value>,
    mut lookup: impl FnMut(&str, &str) -> Result<IndexLookupValue, E>,
) -> Result<BTreeSet<String>, E> {
    let mut entries = BTreeSet::new();
    walk_fields(document_id, fields, None, &mut lookup, &mut entries)?;
    Ok(entries)
}

fn walk_fields<E>(
    document_id: &str,
    fields: &Map<String, Value>,
    parent: Option<&str>,
    lookup: &mut impl FnMut(&str, &str) -> Result<IndexLookupValue, E>,
    entries: &mut BTreeSet<String>,
) -> Result<(), E> {
    for (field, value) in fields {
        let field_path = parent.map_or_else(|| field.clone(), |parent| format!("{parent}/{field}"));
        match value {
            Value::Object(children) => {
                walk_fields(document_id, children, Some(&field_path), lookup, entries)?;
            }
            Value::Array(values) => {
                for value in values {
                    add_value(document_id, &field_path, value, lookup, entries)?;
                }
            }
            _ => add_value(document_id, &field_path, value, lookup, entries)?,
        }
    }
    Ok(())
}

fn add_value<E>(
    document_id: &str,
    field_path: &str,
    raw: &Value,
    lookup: &mut impl FnMut(&str, &str) -> Result<IndexLookupValue, E>,
    entries: &mut BTreeSet<String>,
) -> Result<(), E> {
    let stored = stringify_stored_value(raw);
    let lookup = lookup(field_path, &stored)?;
    entries.insert(index_key(
        field_path,
        "eq",
        &lookup_token(&lookup.value),
        document_id,
    ));

    if let Some(numeric) = numeric_value(raw) {
        let sortable = sortable_float64(numeric);
        entries.insert(index_key(field_path, "n", &sortable, document_id));
        entries.insert(index_key(
            field_path,
            "nr",
            &reverse_sortable(&sortable),
            document_id,
        ));
    }

    let Value::String(_) = raw else {
        return Ok(());
    };
    if lookup.encrypted {
        return Ok(());
    }
    let encoded = encode_uri_component(&lookup.value);
    if encoded.len() > MAX_STRING_PREFIX_BYTES {
        return Ok(());
    }
    entries.insert(index_key(field_path, "f", &encoded, document_id));
    entries.insert(index_key(
        field_path,
        "r",
        &encode_uri_component(&reverse_string(&lookup.value)),
        document_id,
    ));
    for gram in trigrams(&lookup.value) {
        entries.insert(index_key(
            field_path,
            "g3",
            &encode_uri_component(&gram),
            document_id,
        ));
    }
    Ok(())
}

fn index_key(field_path: &str, kind: &str, value: &str, document_id: &str) -> String {
    format!(
        "{}/{kind}/{}/{}",
        encode_field_path(field_path),
        value,
        encode_uri_component(document_id)
    )
}

fn encode_field_path(path: &str) -> String {
    path.split('/')
        .map(encode_uri_component)
        .collect::<Vec<_>>()
        .join("/")
}

fn lookup_token(value: &str) -> String {
    let encoded = encode_uri_component(value);
    if encoded.len() <= MAX_STRING_PREFIX_BYTES {
        encoded
    } else {
        format!("h_{}", sha256_hex(value.as_bytes()))
    }
}

fn stringify_stored_value(value: &Value) -> String {
    let value = match value {
        Value::Null => "null".to_owned(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => {
            let value = value
                .as_f64()
                .expect("serde_json numbers accepted by FYLO are finite");
            ryu_js::Buffer::new().format_finite(value).to_owned()
        }
        Value::String(value) => value.clone(),
        Value::Array(_) | Value::Object(_) => {
            unreachable!("validated FYLO arrays contain scalar values only")
        }
    };
    value.replace('/', "%2F")
}

fn numeric_value(value: &Value) -> Option<f64> {
    let numeric = match value {
        Value::Null => 0.0,
        Value::Bool(value) => u8::from(*value).into(),
        Value::Number(value) => value.as_f64()?,
        Value::String(value) => javascript_number(value)?,
        Value::Array(_) | Value::Object(_) => return None,
    };
    numeric.is_finite().then_some(numeric)
}

#[allow(clippy::cast_precision_loss)] // JavaScript Number coercion intentionally targets f64.
fn javascript_number(value: &str) -> Option<f64> {
    let value = value.trim();
    if value.is_empty() {
        return Some(0.0);
    }
    let signed = matches!(value.as_bytes().first(), Some(b'-' | b'+'));
    let (sign, unsigned) = value
        .strip_prefix('-')
        .map_or((1.0, value), |value| (-1.0, value));
    let unsigned = unsigned.strip_prefix('+').unwrap_or(unsigned);
    let radix = [
        ("0x", 16),
        ("0X", 16),
        ("0b", 2),
        ("0B", 2),
        ("0o", 8),
        ("0O", 8),
    ]
    .into_iter()
    .find_map(|(prefix, radix)| unsigned.strip_prefix(prefix).map(|digits| (digits, radix)));
    if let Some((digits, radix)) = radix {
        if signed || digits.is_empty() {
            return None;
        }
        return u64::from_str_radix(digits, radix)
            .ok()
            .map(|value| sign * value as f64);
    }
    value.parse().ok()
}

fn sortable_float64(value: f64) -> String {
    let bits = value.to_bits();
    let sortable = if bits & SIGN_MASK == 0 {
        bits ^ SIGN_MASK
    } else {
        !bits
    };
    format!("{sortable:016x}")
}

fn reverse_sortable(sortable: &str) -> String {
    let value = u64::from_str_radix(sortable, 16).expect("sortable values are hexadecimal u64");
    format!("{:016x}", u64::MAX - value)
}

fn reverse_string(value: &str) -> String {
    value.chars().rev().collect()
}

fn trigrams(value: &str) -> Vec<String> {
    let characters: Vec<char> = value.chars().take(MAX_NGRAM_SOURCE_CHARS).collect();
    if characters.len() < NGRAM_SIZE {
        return Vec::new();
    }
    let mut grams = BTreeSet::new();
    for window in characters.windows(NGRAM_SIZE) {
        grams.insert(window.iter().collect());
    }
    grams.into_iter().collect()
}

fn encode_uri_component(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            )
        {
            encoded.push(char::from(byte));
        } else {
            use std::fmt::Write;
            write!(&mut encoded, "%{byte:02X}").expect("writing to a string cannot fail");
        }
    }
    encoded
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut encoded = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write;
        write!(&mut encoded, "{byte:02x}").expect("writing to a string cannot fail");
    }
    encoded
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn matches_javascript_prefix_index_expansion() {
        let fields = json!({
            "name": "Ada Lovelace",
            "score": -2.5,
            "active": true,
            "tags": ["math", "code"],
            "nested": {"path": "a/b"}
        })
        .as_object()
        .unwrap()
        .clone();
        let entries = index_entries_for_document("4VRNF52JPCO", &fields, |_, value| {
            Ok::<_, std::convert::Infallible>(IndexLookupValue::plain(value))
        })
        .unwrap();
        assert!(entries.contains("name/eq/Ada%20Lovelace/4VRNF52JPCO"));
        assert!(entries.contains("score/n/3ffbffffffffffff/4VRNF52JPCO"));
        assert!(entries.contains("active/eq/true/4VRNF52JPCO"));
        assert!(entries.contains("tags/eq/math/4VRNF52JPCO"));
        assert!(entries.contains("nested/path/eq/a%252Fb/4VRNF52JPCO"));
        assert!(entries.contains("name/g3/Ada/4VRNF52JPCO"));
    }

    #[test]
    fn suppresses_string_expansion_for_encrypted_fields() {
        let fields = json!({"secret": "value"}).as_object().unwrap().clone();
        let entries = index_entries_for_document("4VRNF52JPCO", &fields, |field, _| {
            Ok::<_, std::convert::Infallible>(if field == "secret" {
                IndexLookupValue::encrypted("idx1.token")
            } else {
                unreachable!()
            })
        })
        .unwrap();
        assert_eq!(
            entries,
            BTreeSet::from(["secret/eq/idx1.token/4VRNF52JPCO".to_owned()])
        );
    }

    #[test]
    fn uses_ecmascript_number_format_and_coercion() {
        let fields = json!({
            "large": 100_000_000_000_000_000_000.0,
            "negativeZero": -0.0,
            "hex": "0x10",
            "signedHex": "-0x10",
            "empty": ""
        })
        .as_object()
        .unwrap()
        .clone();
        let entries = index_entries_for_document("4VRNF52JPCO", &fields, |_, value| {
            Ok::<_, std::convert::Infallible>(IndexLookupValue::plain(value))
        })
        .unwrap();
        assert!(entries.contains("large/eq/100000000000000000000/4VRNF52JPCO"));
        assert!(entries.contains("negativeZero/eq/0/4VRNF52JPCO"));
        assert!(entries.contains("hex/n/c030000000000000/4VRNF52JPCO"));
        assert!(
            entries
                .iter()
                .all(|entry| !entry.starts_with("signedHex/n/"))
        );
        assert!(entries.contains("empty/n/8000000000000000/4VRNF52JPCO"));
    }
}
