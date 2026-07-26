//! Portable, deterministic FYLO prefix-index query primitives.
//!
//! This crate has no filesystem, process, network, clock, random, or browser
//! dependencies. Native and WebAssembly hosts provide bounded snapshot bytes
//! and receive encoded document identifiers.

use std::collections::HashSet;
use std::fmt;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

mod sql;

pub use sql::{AccessPath, SqlOperation, SqlPlan, prepare_sql};

/// Current portable query contract.
pub const QUERY_FORMAT_V1: &str = "fylo.query.v1";

/// Default maximum immutable index snapshot size.
pub const DEFAULT_MAX_SNAPSHOT_BYTES: usize = 256 * 1024 * 1024;
/// Default maximum encoded key length.
pub const DEFAULT_MAX_KEY_BYTES: usize = 8 * 1024;
/// Default maximum query constraints in one intersection.
pub const DEFAULT_MAX_QUERIES: usize = 64;
/// Default maximum prefix or range-bound length.
pub const DEFAULT_MAX_TERM_BYTES: usize = 8 * 1024;
/// Default maximum encoded query input.
pub const DEFAULT_MAX_INPUT_BYTES: usize = 1024 * 1024;
/// Default maximum unique matches emitted by a scan.
pub const DEFAULT_MAX_MATCHES: usize = 1_000_000;
/// Default maximum encoded scan output.
pub const DEFAULT_MAX_OUTPUT_BYTES: usize = 64 * 1024 * 1024;

/// Resource limits enforced before or during portable index scans.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct QueryLimits {
    /// Maximum snapshot bytes accepted by the parser.
    pub max_snapshot_bytes: usize,
    /// Maximum bytes in one newline-delimited key.
    pub max_key_bytes: usize,
    /// Maximum constraints in an intersection.
    pub max_queries: usize,
    /// Maximum bytes in a prefix or range value.
    pub max_term_bytes: usize,
    /// Maximum bytes in an encoded query frame.
    pub max_input_bytes: usize,
    /// Maximum unique document identifiers returned.
    pub max_matches: usize,
    /// Maximum bytes in the newline-delimited result.
    pub max_output_bytes: usize,
}

impl Default for QueryLimits {
    fn default() -> Self {
        Self {
            max_snapshot_bytes: DEFAULT_MAX_SNAPSHOT_BYTES,
            max_key_bytes: DEFAULT_MAX_KEY_BYTES,
            max_queries: DEFAULT_MAX_QUERIES,
            max_term_bytes: DEFAULT_MAX_TERM_BYTES,
            max_input_bytes: DEFAULT_MAX_INPUT_BYTES,
            max_matches: DEFAULT_MAX_MATCHES,
            max_output_bytes: DEFAULT_MAX_OUTPUT_BYTES,
        }
    }
}

/// One prefix-index scan constraint.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ScanQuery {
    /// Full encoded key prefix.
    pub prefix: String,
    /// Optional range comparison over the value segment before the document ID.
    #[serde(default)]
    pub range: Option<ScanRange>,
}

/// One encoded index range bound.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ScanRange {
    /// Comparison operation.
    pub op: RangeOperator,
    /// Encoded sortable value.
    pub value: String,
}

/// Supported prefix-index range comparisons.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum RangeOperator {
    /// Strictly greater than.
    #[serde(rename = "$gt")]
    GreaterThan,
    /// Greater than or equal.
    #[serde(rename = "$gte")]
    GreaterThanOrEqual,
    /// Strictly less than, using a reverse-sortable index.
    #[serde(rename = "$lt")]
    LessThan,
    /// Less than or equal, using a reverse-sortable index.
    #[serde(rename = "$lte")]
    LessThanOrEqual,
}

/// Validated, immutable, newline-delimited prefix-index bytes.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct IndexSnapshot {
    bytes: Vec<u8>,
}

impl IndexSnapshot {
    /// Validate and own a snapshot.
    ///
    /// Empty snapshots and a final line without a newline are accepted for
    /// compatibility with the JavaScript engine. Keys must be non-empty,
    /// strictly sorted, unique, and free of NUL and carriage-return bytes.
    ///
    /// # Errors
    ///
    /// Returns a stable [`QueryError`] when resource or format bounds fail.
    pub fn from_bytes(bytes: &[u8], limits: QueryLimits) -> Result<Self, QueryError> {
        if bytes.len() > limits.max_snapshot_bytes {
            return Err(QueryError::new(
                QueryErrorCode::SnapshotTooLarge,
                format!(
                    "snapshot contains {} bytes; limit is {}",
                    bytes.len(),
                    limits.max_snapshot_bytes
                ),
            ));
        }

        let mut previous: Option<&[u8]> = None;
        for key in bytes.split(|byte| *byte == b'\n') {
            if key.is_empty() {
                continue;
            }
            if key.len() > limits.max_key_bytes {
                return Err(QueryError::new(
                    QueryErrorCode::KeyTooLarge,
                    format!(
                        "index key contains {} bytes; limit is {}",
                        key.len(),
                        limits.max_key_bytes
                    ),
                ));
            }
            if key.contains(&0) || key.contains(&b'\r') {
                return Err(QueryError::new(
                    QueryErrorCode::InvalidSnapshot,
                    "index key contains a forbidden byte",
                ));
            }
            if previous.is_some_and(|prior| prior >= key) {
                return Err(QueryError::new(
                    QueryErrorCode::UnsortedSnapshot,
                    "index snapshot keys must be strictly sorted and unique",
                ));
            }
            previous = Some(key);
        }
        Ok(Self {
            bytes: bytes.to_vec(),
        })
    }

    /// Borrow the validated snapshot bytes.
    #[must_use]
    pub fn as_bytes(&self) -> &[u8] {
        &self.bytes
    }

    /// Execute a bounded prefix/range intersection.
    ///
    /// The first constraint establishes stable result order. Later constraints
    /// filter that order, matching JavaScript `Set` intersection semantics.
    ///
    /// # Errors
    ///
    /// Returns a stable [`QueryError`] for invalid inputs or exceeded bounds.
    pub fn scan(
        &self,
        queries: &[ScanQuery],
        limits: QueryLimits,
    ) -> Result<Vec<Vec<u8>>, QueryError> {
        validate_queries(queries, limits)?;
        let mut candidates: Option<Vec<Vec<u8>>> = None;
        for query in queries {
            let next = self.scan_one(query, limits)?;
            candidates = Some(match candidates {
                None => next,
                Some(current) => {
                    let allowed: HashSet<Vec<u8>> = next.into_iter().collect();
                    current
                        .into_iter()
                        .filter(|id| allowed.contains(id))
                        .collect()
                }
            });
        }
        Ok(candidates.unwrap_or_default())
    }

    /// Execute a scan and encode document identifiers one per line.
    ///
    /// # Errors
    ///
    /// Returns a stable [`QueryError`] for invalid inputs or exceeded bounds.
    pub fn scan_encoded(
        &self,
        queries: &[ScanQuery],
        limits: QueryLimits,
    ) -> Result<Vec<u8>, QueryError> {
        let matches = self.scan(queries, limits)?;
        let required = matches.iter().try_fold(0_usize, |total, id| {
            total
                .checked_add(id.len())
                .and_then(|size| size.checked_add(1))
                .ok_or_else(|| {
                    QueryError::new(QueryErrorCode::OutputTooLarge, "scan output size overflow")
                })
        })?;
        if required > limits.max_output_bytes {
            return Err(QueryError::new(
                QueryErrorCode::OutputTooLarge,
                format!(
                    "scan output requires {required} bytes; limit is {}",
                    limits.max_output_bytes
                ),
            ));
        }
        let mut output = Vec::with_capacity(required);
        for id in matches {
            output.extend_from_slice(&id);
            output.push(b'\n');
        }
        Ok(output)
    }

    fn scan_one(&self, query: &ScanQuery, limits: QueryLimits) -> Result<Vec<Vec<u8>>, QueryError> {
        let prefix = query.prefix.as_bytes();
        let mut cursor = find_first_key_at_or_after(&self.bytes, prefix);
        let mut matches = Vec::new();
        let mut seen = HashSet::new();
        while cursor < self.bytes.len() {
            let relative_end = self.bytes[cursor..]
                .iter()
                .position(|byte| *byte == b'\n')
                .unwrap_or(self.bytes.len() - cursor);
            let end = cursor + relative_end;
            let key = &self.bytes[cursor..end];
            if !key.starts_with(prefix) {
                break;
            }
            if include_key_in_range(key, query.range.as_ref())
                && let Some(separator) = key.iter().rposition(|byte| *byte == b'/')
            {
                let id = key[separator + 1..].to_vec();
                if !id.is_empty() && seen.insert(id.clone()) {
                    if matches.len() >= limits.max_matches {
                        return Err(QueryError::new(
                            QueryErrorCode::TooManyMatches,
                            format!("scan match count exceeds limit of {}", limits.max_matches),
                        ));
                    }
                    matches.push(id);
                }
            }
            cursor = end.saturating_add(1);
        }
        Ok(matches)
    }
}

/// Parse the WebAssembly/FFI JSON query representation with bounded terms.
///
/// # Errors
///
/// Returns a stable [`QueryError`] for malformed JSON or invalid constraints.
pub fn parse_queries(bytes: &[u8], limits: QueryLimits) -> Result<Vec<ScanQuery>, QueryError> {
    if bytes.len() > limits.max_input_bytes {
        return Err(QueryError::new(
            QueryErrorCode::InputTooLarge,
            format!(
                "query input contains {} bytes; limit is {}",
                bytes.len(),
                limits.max_input_bytes
            ),
        ));
    }
    let queries: Vec<ScanQuery> = serde_json::from_slice(bytes)
        .map_err(|error| QueryError::new(QueryErrorCode::InvalidQuery, error.to_string()))?;
    validate_queries(&queries, limits)?;
    Ok(queries)
}

/// A validated FYLO structured document query.
#[derive(Clone, Debug, PartialEq)]
pub struct StructuredQuery {
    operations: Vec<Map<String, Value>>,
    created: Option<TimestampRange>,
    updated: Option<TimestampRange>,
    limit: Option<usize>,
}

impl StructuredQuery {
    /// Parse a bounded structured query from JSON.
    ///
    /// # Errors
    ///
    /// Returns a stable [`QueryError`] when the frame or supported query fields
    /// are malformed.
    pub fn parse(bytes: &[u8], limits: QueryLimits) -> Result<Self, QueryError> {
        if bytes.len() > limits.max_input_bytes {
            return Err(QueryError::new(
                QueryErrorCode::InputTooLarge,
                format!(
                    "query input contains {} bytes; limit is {}",
                    bytes.len(),
                    limits.max_input_bytes
                ),
            ));
        }
        let value: Value = serde_json::from_slice(bytes)
            .map_err(|error| QueryError::new(QueryErrorCode::InvalidQuery, error.to_string()))?;
        Self::from_value(&value, limits)
    }

    /// Validate an already decoded structured query.
    ///
    /// # Errors
    ///
    /// Returns a stable [`QueryError`] when a supported field is malformed.
    pub fn from_value(value: &Value, limits: QueryLimits) -> Result<Self, QueryError> {
        let object = value.as_object().ok_or_else(|| {
            QueryError::new(
                QueryErrorCode::InvalidQuery,
                "structured query must be a JSON object",
            )
        })?;
        let operations = match object.get("$ops") {
            None => Vec::new(),
            Some(Value::Array(operations)) => {
                if operations.len() > limits.max_queries {
                    return Err(QueryError::new(
                        QueryErrorCode::TooManyQueries,
                        format!(
                            "query contains {} operations; limit is {}",
                            operations.len(),
                            limits.max_queries
                        ),
                    ));
                }
                operations
                    .iter()
                    .map(|operation| {
                        operation.as_object().cloned().ok_or_else(|| {
                            QueryError::new(
                                QueryErrorCode::InvalidQuery,
                                "each $ops entry must be an object",
                            )
                        })
                    })
                    .collect::<Result<Vec<_>, _>>()?
            }
            Some(_) => {
                return Err(QueryError::new(
                    QueryErrorCode::InvalidQuery,
                    "$ops must be an array",
                ));
            }
        };
        for operation in &operations {
            for (field, operand) in operation {
                if field.len() > limits.max_term_bytes {
                    return Err(QueryError::new(
                        QueryErrorCode::TermTooLarge,
                        "query field path exceeds the configured byte limit",
                    ));
                }
                if let Value::Object(operators) = operand {
                    for (operator, expected) in operators {
                        if operator.len() > limits.max_term_bytes
                            || serde_json::to_vec(expected)
                                .is_ok_and(|encoded| encoded.len() > limits.max_term_bytes)
                        {
                            return Err(QueryError::new(
                                QueryErrorCode::TermTooLarge,
                                "query operand exceeds the configured byte limit",
                            ));
                        }
                    }
                }
            }
        }
        let created = parse_timestamp_range(object.get("$created"))?;
        let updated = parse_timestamp_range(object.get("$updated"))?;
        let limit = match object.get("$limit") {
            None => None,
            Some(Value::Number(number)) => number
                .as_u64()
                .map(usize::try_from)
                .transpose()
                .map_err(|_| {
                    QueryError::new(
                        QueryErrorCode::InvalidQuery,
                        "$limit exceeds this platform's address space",
                    )
                })?,
            Some(_) => {
                return Err(QueryError::new(
                    QueryErrorCode::InvalidQuery,
                    "$limit must be a non-negative integer",
                ));
            }
        };
        if object.contains_key("$limit") && limit.is_none() {
            return Err(QueryError::new(
                QueryErrorCode::InvalidQuery,
                "$limit must be a non-negative integer",
            ));
        }
        Ok(Self {
            operations,
            created,
            updated,
            limit,
        })
    }

    /// Test one document and its canonical timestamps.
    #[must_use]
    pub fn matches(&self, document: &Map<String, Value>, created_at: u64, updated_at: u64) -> bool {
        if self
            .created
            .as_ref()
            .is_some_and(|range| !range.matches(created_at))
            || self
                .updated
                .as_ref()
                .is_some_and(|range| !range.matches(updated_at))
        {
            return false;
        }
        if self.operations.is_empty() {
            return true;
        }
        self.operations.iter().any(|operation| {
            operation.iter().all(|(field, operand)| {
                let Some(operators) = operand.as_object() else {
                    return false;
                };
                matches_operand(value_at_path(document, field), operators)
            })
        })
    }

    /// Filter rows without changing their input order.
    ///
    /// A zero limit retains the JavaScript engine's historical “no limit”
    /// behavior because JavaScript checks the option for truthiness.
    #[must_use]
    pub fn filter<'a>(&self, rows: impl IntoIterator<Item = QueryRow<'a>>) -> Vec<QueryRow<'a>> {
        let mut output = Vec::new();
        for row in rows {
            if !self.matches(row.document, row.created_at, row.updated_at) {
                continue;
            }
            output.push(row);
            if self
                .limit
                .is_some_and(|limit| limit > 0 && output.len() >= limit)
            {
                break;
            }
        }
        output
    }

    /// Configured result limit.
    ///
    /// Zero retains the JavaScript engine's historical “unlimited” behavior.
    #[must_use]
    pub const fn limit(&self) -> Option<usize> {
        self.limit
    }
}

/// Borrowed document row used by the portable predicate executor.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct QueryRow<'a> {
    /// Opaque document ID.
    pub id: &'a str,
    /// Document object.
    pub document: &'a Map<String, Value>,
    /// Canonical creation time.
    pub created_at: u64,
    /// Canonical update time.
    pub updated_at: u64,
}

#[derive(Clone, Debug, PartialEq)]
struct TimestampRange {
    greater_than: Option<u64>,
    greater_than_or_equal: Option<u64>,
    less_than: Option<u64>,
    less_than_or_equal: Option<u64>,
}

impl TimestampRange {
    fn matches(&self, value: u64) -> bool {
        self.greater_than.is_none_or(|expected| value > expected)
            && self
                .greater_than_or_equal
                .is_none_or(|expected| value >= expected)
            && self.less_than.is_none_or(|expected| value < expected)
            && self
                .less_than_or_equal
                .is_none_or(|expected| value <= expected)
    }
}

fn parse_timestamp_range(value: Option<&Value>) -> Result<Option<TimestampRange>, QueryError> {
    let Some(value) = value else {
        return Ok(None);
    };
    let object = value.as_object().ok_or_else(|| {
        QueryError::new(
            QueryErrorCode::InvalidQuery,
            "timestamp query must be an object",
        )
    })?;
    let number = |name: &str| -> Result<Option<u64>, QueryError> {
        match object.get(name) {
            None => Ok(None),
            Some(Value::Number(value)) => value.as_u64().map(Some).ok_or_else(|| {
                QueryError::new(
                    QueryErrorCode::InvalidQuery,
                    "timestamp bounds must be non-negative integers",
                )
            }),
            Some(_) => Err(QueryError::new(
                QueryErrorCode::InvalidQuery,
                "timestamp bounds must be non-negative integers",
            )),
        }
    };
    Ok(Some(TimestampRange {
        greater_than: number("$gt")?,
        greater_than_or_equal: number("$gte")?,
        less_than: number("$lt")?,
        less_than_or_equal: number("$lte")?,
    }))
}

#[derive(Clone, Copy)]
enum FieldValue<'a> {
    Missing,
    Present(&'a Value),
}

fn value_at_path<'a>(document: &'a Map<String, Value>, path: &str) -> FieldValue<'a> {
    let mut current: Option<&'a Value> = None;
    for (index, segment) in path
        .split(['.', '/'])
        .filter(|segment| !segment.is_empty())
        .enumerate()
    {
        let object = if index == 0 {
            document
        } else {
            let Some(Value::Object(object)) = current else {
                return FieldValue::Missing;
            };
            object
        };
        current = object.get(segment);
        if current.is_none() {
            return FieldValue::Missing;
        }
    }
    current.map_or(FieldValue::Missing, FieldValue::Present)
}

fn matches_operand(value: FieldValue<'_>, operators: &Map<String, Value>) -> bool {
    for (operator, expected) in operators {
        let matches = match operator.as_str() {
            "$eq" => loose_equal(value, expected),
            "$ne" => !loose_equal(value, expected),
            "$gt" => numeric_compare(value, expected, |left, right| left > right),
            "$gte" => numeric_compare(value, expected, |left, right| left >= right),
            "$lt" => numeric_compare(value, expected, |left, right| left < right),
            "$lte" => numeric_compare(value, expected, |left, right| left <= right),
            "$like" => match (value, expected) {
                (FieldValue::Present(Value::String(actual)), Value::String(pattern)) => {
                    matches_like(actual, pattern)
                }
                _ => false,
            },
            "$contains" => match value {
                FieldValue::Present(Value::Array(items)) => items
                    .iter()
                    .any(|item| loose_equal(FieldValue::Present(item), expected)),
                _ => false,
            },
            _ => true,
        };
        if !matches {
            return false;
        }
    }
    true
}

fn loose_equal(actual: FieldValue<'_>, expected: &Value) -> bool {
    match actual {
        FieldValue::Missing | FieldValue::Present(Value::Null) => expected.is_null(),
        FieldValue::Present(Value::String(left)) => match expected {
            Value::String(right) => left == right,
            Value::Number(_) | Value::Bool(_) => {
                numeric_value(actual) == numeric_value(FieldValue::Present(expected))
            }
            _ => false,
        },
        FieldValue::Present(Value::Number(left)) => match expected {
            Value::Number(right) => left.as_f64() == right.as_f64(),
            Value::String(_) | Value::Bool(_) => {
                numeric_value(actual) == numeric_value(FieldValue::Present(expected))
            }
            _ => false,
        },
        FieldValue::Present(Value::Bool(left)) => match expected {
            Value::Bool(right) => left == right,
            Value::String(_) | Value::Number(_) => {
                numeric_value(actual) == numeric_value(FieldValue::Present(expected))
            }
            _ => false,
        },
        FieldValue::Present(Value::Array(_) | Value::Object(_)) => false,
    }
}

fn numeric_compare(
    actual: FieldValue<'_>,
    expected: &Value,
    compare: impl FnOnce(f64, f64) -> bool,
) -> bool {
    let Some(left) = numeric_value(actual) else {
        return false;
    };
    let Some(right) = numeric_value(FieldValue::Present(expected)) else {
        return false;
    };
    compare(left, right)
}

fn numeric_value(value: FieldValue<'_>) -> Option<f64> {
    match value {
        FieldValue::Present(Value::Null) => Some(0.0),
        FieldValue::Present(Value::Bool(value)) => Some(u8::from(*value).into()),
        FieldValue::Present(Value::Number(value)) => value.as_f64(),
        FieldValue::Present(Value::String(value)) => {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                Some(0.0)
            } else {
                trimmed.parse().ok()
            }
        }
        FieldValue::Present(Value::Array(values)) if values.is_empty() => Some(0.0),
        FieldValue::Present(Value::Array(values)) if values.len() == 1 => {
            numeric_value(FieldValue::Present(&values[0]))
        }
        FieldValue::Missing | FieldValue::Present(Value::Array(_) | Value::Object(_)) => None,
    }
}

fn matches_like(value: &str, pattern: &str) -> bool {
    let value: Vec<u16> = value.encode_utf16().collect();
    let pattern: Vec<u16> = pattern.encode_utf16().collect();
    let percent = u16::from(b'%');
    let underscore = u16::from(b'_');
    let mut value_index = 0;
    let mut pattern_index = 0;
    let mut wildcard_index = None;
    let mut wildcard_value_index = 0;
    while value_index < value.len() {
        let token = pattern.get(pattern_index).copied();
        if token.is_some_and(|token| token == underscore || token == value[value_index]) {
            value_index += 1;
            pattern_index += 1;
        } else if token == Some(percent) {
            wildcard_index = Some(pattern_index);
            pattern_index += 1;
            wildcard_value_index = value_index;
        } else if let Some(wildcard) = wildcard_index {
            pattern_index = wildcard + 1;
            wildcard_value_index += 1;
            value_index = wildcard_value_index;
        } else {
            return false;
        }
    }
    while pattern.get(pattern_index) == Some(&percent) {
        pattern_index += 1;
    }
    pattern_index == pattern.len()
}

fn validate_queries(queries: &[ScanQuery], limits: QueryLimits) -> Result<(), QueryError> {
    if queries.is_empty() {
        return Err(QueryError::new(
            QueryErrorCode::EmptyQuery,
            "at least one scan constraint is required",
        ));
    }
    if queries.len() > limits.max_queries {
        return Err(QueryError::new(
            QueryErrorCode::TooManyQueries,
            format!(
                "query contains {} constraints; limit is {}",
                queries.len(),
                limits.max_queries
            ),
        ));
    }
    for query in queries {
        if query.prefix.len() > limits.max_term_bytes {
            return Err(QueryError::new(
                QueryErrorCode::TermTooLarge,
                "query prefix exceeds the configured byte limit",
            ));
        }
        if query
            .range
            .as_ref()
            .is_some_and(|range| range.value.len() > limits.max_term_bytes)
        {
            return Err(QueryError::new(
                QueryErrorCode::TermTooLarge,
                "query range value exceeds the configured byte limit",
            ));
        }
    }
    Ok(())
}

fn find_first_key_at_or_after(snapshot: &[u8], prefix: &[u8]) -> usize {
    if snapshot.is_empty() {
        return 0;
    }
    let mut low = 0;
    let mut high = snapshot.len();
    while low < high {
        let middle = usize::midpoint(low, high);
        let mut start = middle;
        while start > 0 && snapshot[start - 1] != b'\n' {
            start -= 1;
        }
        let mut end = middle;
        while end < snapshot.len() && snapshot[end] != b'\n' {
            end += 1;
        }
        if snapshot[start..end] < *prefix {
            low = end.saturating_add(1);
        } else {
            high = start;
        }
    }
    while low > 0 && low < snapshot.len() && snapshot[low - 1] != b'\n' {
        low -= 1;
    }
    low
}

fn include_key_in_range(key: &[u8], range: Option<&ScanRange>) -> bool {
    let Some(range) = range else {
        return true;
    };
    let Some(last) = key.iter().rposition(|byte| *byte == b'/') else {
        return false;
    };
    let Some(previous) = key[..last].iter().rposition(|byte| *byte == b'/') else {
        return false;
    };
    let value = &key[previous + 1..last];
    let threshold = range.value.as_bytes();
    match range.op {
        RangeOperator::GreaterThan | RangeOperator::LessThan => value > threshold,
        RangeOperator::GreaterThanOrEqual | RangeOperator::LessThanOrEqual => value >= threshold,
    }
}

/// Stable query failure codes.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum QueryErrorCode {
    /// Encoded query input exceeded its byte limit.
    #[serde(rename = "EQUERY_INPUT_SIZE")]
    InputTooLarge,
    /// Encoded query input was malformed.
    #[serde(rename = "EQUERY_INVALID")]
    InvalidQuery,
    /// No query constraints were provided.
    #[serde(rename = "EQUERY_EMPTY")]
    EmptyQuery,
    /// Too many constraints were provided.
    #[serde(rename = "EQUERY_COUNT")]
    TooManyQueries,
    /// A prefix or range term was oversized.
    #[serde(rename = "EQUERY_TERM_SIZE")]
    TermTooLarge,
    /// Snapshot bytes exceeded their configured bound.
    #[serde(rename = "EINDEX_SNAPSHOT_SIZE")]
    SnapshotTooLarge,
    /// A snapshot key exceeded its configured bound.
    #[serde(rename = "EINDEX_KEY_SIZE")]
    KeyTooLarge,
    /// Snapshot bytes were not a valid key stream.
    #[serde(rename = "EINDEX_SNAPSHOT_FORMAT")]
    InvalidSnapshot,
    /// Snapshot keys were not strictly sorted and unique.
    #[serde(rename = "EINDEX_SNAPSHOT_ORDER")]
    UnsortedSnapshot,
    /// A scan produced more unique identifiers than allowed.
    #[serde(rename = "EQUERY_MATCH_COUNT")]
    TooManyMatches,
    /// Encoded result bytes exceeded their configured bound.
    #[serde(rename = "EQUERY_OUTPUT_SIZE")]
    OutputTooLarge,
}

impl QueryErrorCode {
    /// Return the stable external representation.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::InputTooLarge => "EQUERY_INPUT_SIZE",
            Self::InvalidQuery => "EQUERY_INVALID",
            Self::EmptyQuery => "EQUERY_EMPTY",
            Self::TooManyQueries => "EQUERY_COUNT",
            Self::TermTooLarge => "EQUERY_TERM_SIZE",
            Self::SnapshotTooLarge => "EINDEX_SNAPSHOT_SIZE",
            Self::KeyTooLarge => "EINDEX_KEY_SIZE",
            Self::InvalidSnapshot => "EINDEX_SNAPSHOT_FORMAT",
            Self::UnsortedSnapshot => "EINDEX_SNAPSHOT_ORDER",
            Self::TooManyMatches => "EQUERY_MATCH_COUNT",
            Self::OutputTooLarge => "EQUERY_OUTPUT_SIZE",
        }
    }
}

/// A bounded, machine-testable portable query failure.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct QueryError {
    code: QueryErrorCode,
    message: String,
}

impl QueryError {
    pub(crate) fn new(code: QueryErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    /// Return the stable error code.
    #[must_use]
    pub const fn code(&self) -> QueryErrorCode {
        self.code
    }

    /// Return the safe diagnostic.
    #[must_use]
    pub fn message(&self) -> &str {
        &self.message
    }
}

impl fmt::Display for QueryError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.code.as_str(), self.message)
    }
}

impl std::error::Error for QueryError {}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn query(prefix: &str) -> ScanQuery {
        ScanQuery {
            prefix: prefix.into(),
            range: None,
        }
    }

    #[test]
    fn scans_prefixes_ranges_and_stable_intersections() {
        let snapshot = IndexSnapshot::from_bytes(
            b"score/n/400fffffffffffff/doc-a\nscore/n/bff0000000000000/doc-b\nstatus/eq/active/doc-a\nstatus/eq/active/doc-b\ntitle/f/prefix%20a/doc-a\ntitle/f/prefix%20b/doc-b\n",
            QueryLimits::default(),
        )
        .unwrap();
        assert_eq!(
            snapshot
                .scan(&[query("title/f/prefix%20")], QueryLimits::default())
                .unwrap(),
            [b"doc-a".to_vec(), b"doc-b".to_vec()]
        );
        assert_eq!(
            snapshot
                .scan(
                    &[
                        query("status/eq/active/"),
                        ScanQuery {
                            prefix: "score/n/".into(),
                            range: Some(ScanRange {
                                op: RangeOperator::GreaterThanOrEqual,
                                value: "8000000000000000".into(),
                            }),
                        },
                    ],
                    QueryLimits::default(),
                )
                .unwrap(),
            [b"doc-b".to_vec()]
        );
    }

    #[test]
    fn rejects_malformed_or_unbounded_inputs() {
        let error = IndexSnapshot::from_bytes(b"b/1\na/2\n", QueryLimits::default()).unwrap_err();
        assert_eq!(error.code(), QueryErrorCode::UnsortedSnapshot);

        let snapshot = IndexSnapshot::from_bytes(b"a/1\n", QueryLimits::default()).unwrap();
        let error = snapshot.scan(&[], QueryLimits::default()).unwrap_err();
        assert_eq!(error.code(), QueryErrorCode::EmptyQuery);

        let error = parse_queries(b"not json", QueryLimits::default()).unwrap_err();
        assert_eq!(error.code(), QueryErrorCode::InvalidQuery);
    }

    #[test]
    fn binary_scan_matches_a_linear_reference_across_generated_snapshots() {
        for document_count in 1..=16 {
            let mut keys = Vec::new();
            for document in 0..document_count {
                keys.push(format!("group/eq/{}/doc-{document:03}", document % 7));
                keys.push(format!("name/f/user-{document:03}/doc-{document:03}"));
            }
            keys.sort();
            let encoded = format!("{}\n", keys.join("\n"));
            let snapshot =
                IndexSnapshot::from_bytes(encoded.as_bytes(), QueryLimits::default()).unwrap();
            for prefix in [
                "group/eq/",
                "group/eq/0/",
                "group/eq/6/",
                "name/f/user-0",
                "name/f/user-063/",
                "z/",
            ] {
                let actual = snapshot
                    .scan(&[query(prefix)], QueryLimits::default())
                    .unwrap();
                let mut expected = Vec::new();
                let mut seen = HashSet::new();
                for key in &keys {
                    if !key.as_bytes().starts_with(prefix.as_bytes()) {
                        continue;
                    }
                    let id = key.rsplit('/').next().unwrap().as_bytes().to_vec();
                    if seen.insert(id.clone()) {
                        expected.push(id);
                    }
                }
                assert_eq!(actual, expected, "count={document_count}, prefix={prefix}");
            }
        }
    }

    #[test]
    fn structured_predicates_match_javascript_coercion_and_like_semantics() {
        let document = json!({
            "name": "Ada Lovelace",
            "score": "42",
            "active": true,
            "tags": ["math", 7],
            "profile": { "city": "London" }
        })
        .as_object()
        .unwrap()
        .clone();
        let query = StructuredQuery::from_value(
            &json!({
                "$ops": [{
                    "score": { "$gte": 40, "$lt": 50 },
                    "active": { "$eq": 1 },
                    "name": { "$like": "Ada%" },
                    "tags": { "$contains": "math" },
                    "profile.city": { "$eq": "London" }
                }],
                "$created": { "$lte": 10 },
                "$updated": { "$gt": 10 }
            }),
            QueryLimits::default(),
        )
        .unwrap();
        assert!(query.matches(&document, 10, 20));
        assert!(!query.matches(&document, 11, 20));
    }

    #[test]
    fn structured_operations_are_or_of_and_and_keep_stable_limit_order() {
        let ada = json!({"name":"Ada","role":"admin"})
            .as_object()
            .unwrap()
            .clone();
        let grace = json!({"name":"Grace","role":"editor"})
            .as_object()
            .unwrap()
            .clone();
        let linus = json!({"name":"Linus","role":"reader"})
            .as_object()
            .unwrap()
            .clone();
        let query = StructuredQuery::from_value(
            &json!({
                "$ops": [
                    {"role":{"$eq":"admin"}},
                    {"role":{"$eq":"editor"}}
                ],
                "$limit": 1
            }),
            QueryLimits::default(),
        )
        .unwrap();
        let rows = [
            QueryRow {
                id: "ada",
                document: &ada,
                created_at: 1,
                updated_at: 1,
            },
            QueryRow {
                id: "grace",
                document: &grace,
                created_at: 1,
                updated_at: 1,
            },
            QueryRow {
                id: "linus",
                document: &linus,
                created_at: 1,
                updated_at: 1,
            },
        ];
        assert_eq!(
            query
                .filter(rows)
                .into_iter()
                .map(|row| row.id)
                .collect::<Vec<_>>(),
            ["ada"]
        );
    }

    #[test]
    fn missing_fields_are_loosely_equal_to_null_like_javascript_undefined() {
        let document = Map::new();
        let query = StructuredQuery::from_value(
            &json!({"$ops":[{"missing":{"$eq":null}}]}),
            QueryLimits::default(),
        )
        .unwrap();
        assert!(query.matches(&document, 0, 0));
    }
}
