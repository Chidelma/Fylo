//! Versioned, bounded parsing and metadata rules shared by FYLO engines.
//!
//! This crate deliberately contains no filesystem, process, network, or
//! browser APIs. It is suitable for both native and WebAssembly targets.

use std::fmt;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// Current document body format.
pub const DOCUMENT_FORMAT_V1: &str = "fylo.document.json.v1";

/// Default maximum encoded document size accepted by the portable parser.
pub const DEFAULT_MAX_DOCUMENT_BYTES: usize = 16 * 1024 * 1024;

/// Default maximum nesting depth for a FYLO document.
pub const DEFAULT_MAX_DOCUMENT_DEPTH: usize = 64;

/// Default maximum number of values visited while validating a document.
pub const DEFAULT_MAX_DOCUMENT_NODES: usize = 1_000_000;

const TTID_PRECISION: u64 = 10_000;
const TTID_MIN_TIMESTAMP_MS: u64 = 1_577_836_800_000;
const TTID_MAX_TIMESTAMP_MS: u64 = 7_258_118_400_000;

/// Limits applied before a document can enter query or storage code.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DocumentLimits {
    /// Maximum encoded JSON bytes.
    pub max_bytes: usize,
    /// Maximum nested object/array depth.
    pub max_depth: usize,
    /// Maximum total values visited.
    pub max_nodes: usize,
}

impl Default for DocumentLimits {
    fn default() -> Self {
        Self {
            max_bytes: DEFAULT_MAX_DOCUMENT_BYTES,
            max_depth: DEFAULT_MAX_DOCUMENT_DEPTH,
            max_nodes: DEFAULT_MAX_DOCUMENT_NODES,
        }
    }
}

/// A validated FYLO document body.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Document(Map<String, Value>);

impl Document {
    /// Parse and validate an encoded document using the supplied resource
    /// limits.
    ///
    /// # Errors
    ///
    /// Returns a stable [`FormatError`] when the input is oversized, malformed,
    /// not a JSON object, too deeply nested, too large as a value graph, or
    /// contains an array of objects.
    pub fn parse(bytes: &[u8], limits: DocumentLimits) -> Result<Self, FormatError> {
        if bytes.len() > limits.max_bytes {
            return Err(FormatError::new(
                FormatErrorCode::DocumentTooLarge,
                format!(
                    "document contains {} bytes; limit is {}",
                    bytes.len(),
                    limits.max_bytes
                ),
            ));
        }

        let value: Value = serde_json::from_slice(bytes)
            .map_err(|error| FormatError::new(FormatErrorCode::InvalidJson, error.to_string()))?;
        Self::try_from_value(value, limits)
    }

    /// Validate an already decoded JSON value.
    ///
    /// # Errors
    ///
    /// Returns a stable [`FormatError`] when the value violates the FYLO
    /// document shape or resource limits.
    pub fn try_from_value(value: Value, limits: DocumentLimits) -> Result<Self, FormatError> {
        let Value::Object(map) = value else {
            return Err(FormatError::new(
                FormatErrorCode::DocumentRoot,
                "FYLO document root must be a JSON object",
            ));
        };

        let mut visited = 1;
        validate_object(&map, 1, &mut visited, limits, None)?;
        Ok(Self(map))
    }

    /// Encode this document as compact JSON while preserving insertion order.
    ///
    /// # Errors
    ///
    /// Returns a stable [`FormatError`] if serialization fails.
    pub fn encode(&self) -> Result<Vec<u8>, FormatError> {
        serde_json::to_vec(&self.0)
            .map_err(|error| FormatError::new(FormatErrorCode::Encode, error.to_string()))
    }

    /// Borrow the underlying ordered JSON object.
    #[must_use]
    pub const fn fields(&self) -> &Map<String, Value> {
        &self.0
    }

    /// Consume the document and return its ordered JSON object.
    #[must_use]
    pub fn into_fields(self) -> Map<String, Value> {
        self.0
    }
}

/// Canonical document metadata supplied by the storage adapter.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanonicalMetadata {
    /// Opaque document identifier.
    pub id: String,
    /// TTID-derived creation time in Unix milliseconds.
    pub created_at: u64,
    /// Last document or metadata update in Unix milliseconds.
    pub updated_at: f64,
    /// Native file modification time in Unix milliseconds.
    pub mtime: f64,
}

/// Timestamps encoded in a FYLO TTID.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TtidTimestamps {
    /// Initial creation timestamp.
    pub created_at: u64,
    /// Optional latest update timestamp encoded in the identifier.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<u64>,
    /// Optional deletion timestamp encoded in the identifier.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deleted_at: Option<u64>,
}

/// Validate and decode a FYLO time-ordered identifier.
///
/// # Errors
///
/// Returns [`FormatErrorCode::InvalidDocumentId`] when the syntax, lifecycle
/// placeholders, arithmetic, or timestamp range is invalid.
pub fn decode_ttid(identifier: &str) -> Result<TtidTimestamps, FormatError> {
    if identifier.is_empty() || identifier.len() > 36 {
        return Err(invalid_ttid("identifier length is outside FYLO bounds"));
    }
    let segments: Vec<&str> = identifier.split('-').collect();
    if segments.is_empty() || segments.len() > 3 {
        return Err(invalid_ttid("identifier has an invalid lifecycle shape"));
    }
    for segment in &segments {
        if segment.is_empty()
            || segment.len() > 11
            || !segment.bytes().all(|byte| byte.is_ascii_alphanumeric())
        {
            return Err(invalid_ttid("identifier contains an invalid segment"));
        }
    }
    if segments[0].eq_ignore_ascii_case("x") {
        return Err(invalid_ttid("creation timestamp cannot be a placeholder"));
    }
    let created_at = decode_ttid_segment(segments[0])?;
    let updated_at = match segments.get(1) {
        Some(segment) if segment.eq_ignore_ascii_case("x") => None,
        Some(segment) => Some(decode_ttid_segment(segment)?),
        None => None,
    };
    let deleted_at = match segments.get(2) {
        Some(segment) if segment.eq_ignore_ascii_case("x") => {
            return Err(invalid_ttid("deletion timestamp cannot be a placeholder"));
        }
        Some(segment) => Some(decode_ttid_segment(segment)?),
        None => None,
    };
    Ok(TtidTimestamps {
        created_at,
        updated_at,
        deleted_at,
    })
}

fn decode_ttid_segment(segment: &str) -> Result<u64, FormatError> {
    let encoded = u64::from_str_radix(segment, 36)
        .map_err(|_| invalid_ttid("identifier timestamp is not valid base-36"))?;
    let milliseconds = encoded
        .checked_add(TTID_PRECISION / 2)
        .ok_or_else(|| invalid_ttid("identifier timestamp overflows"))?
        / TTID_PRECISION;
    if !(TTID_MIN_TIMESTAMP_MS..=TTID_MAX_TIMESTAMP_MS).contains(&milliseconds) {
        return Err(invalid_ttid(
            "identifier timestamp is outside the supported range",
        ));
    }
    Ok(milliseconds)
}

fn invalid_ttid(message: &str) -> FormatError {
    FormatError::new(FormatErrorCode::InvalidDocumentId, message)
}

impl CanonicalMetadata {
    /// Merge custom metadata with canonical storage metadata.
    ///
    /// Canonical fields always win, so a custom xattr cannot spoof document
    /// identity or native timestamps.
    #[must_use]
    pub fn merge_with_custom(&self, custom: &Map<String, Value>) -> Map<String, Value> {
        let mut merged = custom.clone();
        merged.insert("id".into(), Value::String(self.id.clone()));
        merged.insert("createdAt".into(), Value::from(self.created_at));
        merged.insert("updatedAt".into(), javascript_number(self.updated_at));
        merged.insert("mtime".into(), javascript_number(self.mtime));
        merged
    }
}

fn javascript_number(value: f64) -> Value {
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_precision_loss,
        clippy::cast_sign_loss
    )]
    if value.fract() == 0.0 && value >= 0.0 && value <= u64::MAX as f64 {
        Value::from(value as u64)
    } else {
        Value::from(value)
    }
}

/// Stable format error codes exposed by compatibility fixtures and bindings.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum FormatErrorCode {
    /// Encoded document exceeded the configured byte limit.
    #[serde(rename = "EFORMAT_SIZE")]
    DocumentTooLarge,
    /// Input was not valid JSON.
    #[serde(rename = "EFORMAT_JSON")]
    InvalidJson,
    /// Document root was not an object.
    #[serde(rename = "EDOCUMENTROOT")]
    DocumentRoot,
    /// Document contained an array of objects.
    #[serde(rename = "EARRAYOFOBJECTS")]
    ArrayOfObjects,
    /// Document exceeded the configured nesting depth.
    #[serde(rename = "EFORMAT_DEPTH")]
    DocumentTooDeep,
    /// Document exceeded the configured value-node limit.
    #[serde(rename = "EFORMAT_NODES")]
    TooManyNodes,
    /// A validated value could not be encoded.
    #[serde(rename = "EFORMAT_ENCODE")]
    Encode,
    /// A FYLO document identifier was invalid.
    #[serde(rename = "EINVALIDDOCID")]
    InvalidDocumentId,
}

impl FormatErrorCode {
    /// Return the stable string representation used outside Rust.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::DocumentTooLarge => "EFORMAT_SIZE",
            Self::InvalidJson => "EFORMAT_JSON",
            Self::DocumentRoot => "EDOCUMENTROOT",
            Self::ArrayOfObjects => "EARRAYOFOBJECTS",
            Self::DocumentTooDeep => "EFORMAT_DEPTH",
            Self::TooManyNodes => "EFORMAT_NODES",
            Self::Encode => "EFORMAT_ENCODE",
            Self::InvalidDocumentId => "EINVALIDDOCID",
        }
    }
}

/// A bounded, machine-testable format failure.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FormatError {
    code: FormatErrorCode,
    message: String,
}

impl FormatError {
    fn new(code: FormatErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    /// Return the stable error code.
    #[must_use]
    pub const fn code(&self) -> FormatErrorCode {
        self.code
    }

    /// Return the safe diagnostic message.
    #[must_use]
    pub fn message(&self) -> &str {
        &self.message
    }
}

impl fmt::Display for FormatError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.code.as_str(), self.message)
    }
}

impl std::error::Error for FormatError {}

fn validate_object(
    map: &Map<String, Value>,
    depth: usize,
    visited: &mut usize,
    limits: DocumentLimits,
    parent: Option<&str>,
) -> Result<(), FormatError> {
    check_depth(depth, limits)?;
    for (field, value) in map {
        visit_node(visited, limits)?;
        let path = parent.map_or_else(|| field.clone(), |prefix| format!("{prefix}/{field}"));
        validate_value(value, depth + 1, visited, limits, &path)?;
    }
    Ok(())
}

fn validate_value(
    value: &Value,
    depth: usize,
    visited: &mut usize,
    limits: DocumentLimits,
    path: &str,
) -> Result<(), FormatError> {
    match value {
        Value::Object(map) => validate_object(map, depth, visited, limits, Some(path)),
        Value::Array(items) => {
            check_depth(depth, limits)?;
            for item in items {
                visit_node(visited, limits)?;
                if item.is_object() || item.is_array() {
                    return Err(FormatError::new(
                        FormatErrorCode::ArrayOfObjects,
                        format!(
                            "cannot index an array of objects at \"{path}\": store objects in \
                             their own collection and reference them by key"
                        ),
                    ));
                }
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

fn check_depth(depth: usize, limits: DocumentLimits) -> Result<(), FormatError> {
    if depth > limits.max_depth {
        return Err(FormatError::new(
            FormatErrorCode::DocumentTooDeep,
            format!(
                "document nesting depth exceeds limit of {}",
                limits.max_depth
            ),
        ));
    }
    Ok(())
}

fn visit_node(visited: &mut usize, limits: DocumentLimits) -> Result<(), FormatError> {
    *visited = visited.saturating_add(1);
    if *visited > limits.max_nodes {
        return Err(FormatError::new(
            FormatErrorCode::TooManyNodes,
            format!("document value count exceeds limit of {}", limits.max_nodes),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn document_round_trips_without_reordering_fields() {
        let source = br#"{"z":1,"a":{"city":"Toronto"},"tags":["a",2,true,null]}"#;
        let document = Document::parse(source, DocumentLimits::default()).unwrap();
        assert_eq!(document.encode().unwrap(), source);
    }

    #[test]
    fn rejects_non_object_roots() {
        let error =
            Document::parse(br#"["not","a","document"]"#, DocumentLimits::default()).unwrap_err();
        assert_eq!(error.code(), FormatErrorCode::DocumentRoot);
    }

    #[test]
    fn rejects_arrays_of_objects_with_field_path() {
        let source = br#"{"profile":{"members":[{"name":"Ada"}]}}"#;
        let error = Document::parse(source, DocumentLimits::default()).unwrap_err();
        assert_eq!(error.code(), FormatErrorCode::ArrayOfObjects);
        assert!(error.message().contains("profile/members"));
    }

    #[test]
    fn rejects_nested_arrays_like_the_javascript_engine() {
        let error =
            Document::parse(br#"{"matrix":[[1,2],[3,4]]}"#, DocumentLimits::default()).unwrap_err();
        assert_eq!(error.code(), FormatErrorCode::ArrayOfObjects);
    }

    #[test]
    fn enforces_byte_depth_and_node_limits() {
        let oversized = Document::parse(
            br#"{"name":"Ada"}"#,
            DocumentLimits {
                max_bytes: 4,
                ..DocumentLimits::default()
            },
        )
        .unwrap_err();
        assert_eq!(oversized.code(), FormatErrorCode::DocumentTooLarge);

        let deep = Document::parse(
            br#"{"a":{"b":{"c":1}}}"#,
            DocumentLimits {
                max_depth: 2,
                ..DocumentLimits::default()
            },
        )
        .unwrap_err();
        assert_eq!(deep.code(), FormatErrorCode::DocumentTooDeep);

        let many = Document::parse(
            br#"{"a":1,"b":2}"#,
            DocumentLimits {
                max_nodes: 2,
                ..DocumentLimits::default()
            },
        )
        .unwrap_err();
        assert_eq!(many.code(), FormatErrorCode::TooManyNodes);
    }

    #[test]
    fn canonical_metadata_overrides_spoofed_custom_values() {
        let custom = json!({
            "owner": "editors",
            "id": "spoofed",
            "createdAt": 0,
            "updatedAt": 0,
            "mtime": 0
        })
        .as_object()
        .unwrap()
        .clone();
        let canonical = CanonicalMetadata {
            id: "01document".into(),
            created_at: 10,
            updated_at: 30.0,
            mtime: 30.0,
        };

        assert_eq!(
            canonical.merge_with_custom(&custom),
            json!({
                "owner": "editors",
                "id": "01document",
                "createdAt": 10,
                "updatedAt": 30,
                "mtime": 30
            })
            .as_object()
            .unwrap()
            .clone()
        );
    }

    #[test]
    fn decodes_ttid_lifecycle_timestamps() {
        let timestamps = decode_ttid("4VRNF52JPCO").unwrap();
        assert_eq!(timestamps.created_at, 1_785_099_771_859);
        assert_eq!(timestamps.updated_at, None);
        assert_eq!(timestamps.deleted_at, None);

        let deleted = decode_ttid("4VRNF52JPCO-X-4VRNF52JQHC").unwrap();
        assert_eq!(deleted.created_at, timestamps.created_at);
        assert_eq!(deleted.updated_at, None);
        assert!(deleted.deleted_at.is_some());
    }

    #[test]
    fn rejects_invalid_ttid_paths_and_ranges() {
        for identifier in ["", "../escape", "ABC", "4VRNF52JPCO-X-X", "4VRNF52JPCO-"] {
            assert_eq!(
                decode_ttid(identifier).unwrap_err().code(),
                FormatErrorCode::InvalidDocumentId
            );
        }
    }
}
