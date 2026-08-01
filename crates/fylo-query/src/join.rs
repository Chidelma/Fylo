//! Validated FYLO join specifications.
//!
//! A join is a query shape rather than a protocol shape, so it is parsed and
//! bounded here and executed by the engine.

use serde_json::{Map, Value};

use crate::{QueryError, QueryErrorCode, QueryLimits};

/// How a matched pair is combined into one row.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JoinMode {
    /// Both sides, right winning on a shared name.
    Inner,
    /// The left row alone.
    Left,
    /// The right row alone.
    Right,
    /// Both sides, right winning on a shared name.
    Outer,
}

/// One comparison between a left field and a right field.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JoinComparator {
    /// Strict equality.
    Eq,
    /// Strict inequality.
    Ne,
    /// Numeric greater-than.
    Gt,
    /// Numeric less-than.
    Lt,
    /// Numeric greater-or-equal.
    Gte,
    /// Numeric less-or-equal.
    Lte,
}

impl JoinComparator {
    fn parse(name: &str) -> Option<Self> {
        match name {
            "$eq" => Some(Self::Eq),
            "$ne" => Some(Self::Ne),
            "$gt" => Some(Self::Gt),
            "$lt" => Some(Self::Lt),
            "$gte" => Some(Self::Gte),
            "$lte" => Some(Self::Lte),
            _ => None,
        }
    }

    /// Whether one left/right value pair satisfies this comparison.
    ///
    /// Equality is structural, matching JavaScript's `===` for the JSON values
    /// a document can hold. The ordering comparators coerce through `Number`,
    /// so a non-numeric operand yields `NaN` and every ordering answers false —
    /// the JavaScript behaviour this mirrors.
    #[must_use]
    pub fn matches(self, left: Option<&Value>, right: Option<&Value>) -> bool {
        match self {
            Self::Eq => strict_equals(left, right),
            Self::Ne => !strict_equals(left, right),
            Self::Gt | Self::Lt | Self::Gte | Self::Lte => {
                let (Some(left), Some(right)) = (coerce_number(left), coerce_number(right)) else {
                    return false;
                };
                match self {
                    Self::Gt => left > right,
                    Self::Lt => left < right,
                    Self::Gte => left >= right,
                    Self::Lte => left <= right,
                    Self::Eq | Self::Ne => unreachable!(),
                }
            }
        }
    }
}

/// The shaping half of a join: what to keep, how to name it, and how much.
struct Projection {
    select: Vec<String>,
    rename: Map<String, Value>,
    limit: Option<usize>,
    only_ids: bool,
    group_by: Option<String>,
}

impl Projection {
    fn from_object(object: &Map<String, Value>) -> Result<Self, QueryError> {
        let select = match object.get("$select") {
            None | Some(Value::Null) => Vec::new(),
            Some(Value::Array(fields)) => fields
                .iter()
                .map(|field| {
                    field
                        .as_str()
                        .map(ToOwned::to_owned)
                        .ok_or_else(|| invalid("join \"$select\" entries must be strings"))
                })
                .collect::<Result<Vec<_>, _>>()?,
            Some(_) => return Err(invalid("join \"$select\" must be an array")),
        };
        let rename = match object.get("$rename") {
            None | Some(Value::Null) => Map::new(),
            Some(Value::Object(map)) => {
                if map.values().any(|value| !value.is_string()) {
                    return Err(invalid("join \"$rename\" values must be strings"));
                }
                map.clone()
            }
            Some(_) => return Err(invalid("join \"$rename\" must be an object")),
        };
        let limit = match object.get("$limit") {
            None | Some(Value::Null) => None,
            Some(value) => {
                let limit = value
                    .as_u64()
                    .and_then(|limit| usize::try_from(limit).ok())
                    .ok_or_else(|| invalid("join \"$limit\" must be a non-negative integer"))?;
                (limit > 0).then_some(limit)
            }
        };
        let only_ids = match object.get("$onlyIds") {
            None | Some(Value::Null) => false,
            Some(Value::Bool(flag)) => *flag,
            Some(_) => return Err(invalid("join \"$onlyIds\" must be a boolean")),
        };
        let group_by = match object.get("$groupby") {
            None | Some(Value::Null) => None,
            Some(Value::String(field)) => Some(field.clone()),
            Some(_) => return Err(invalid("join \"$groupby\" must be a string")),
        };
        Ok(Self {
            select,
            rename,
            limit,
            only_ids,
            group_by,
        })
    }
}

/// A validated join between two document collections.
#[derive(Clone, Debug)]
pub struct JoinSpec {
    left_collection: String,
    right_collection: String,
    mode: JoinMode,
    /// Left field path, comparator, right field path.
    on: Vec<(String, JoinComparator, String)>,
    select: Vec<String>,
    rename: Map<String, Value>,
    limit: Option<usize>,
    only_ids: bool,
    group_by: Option<String>,
}

impl JoinSpec {
    /// Parse a bounded join specification from JSON.
    ///
    /// # Errors
    ///
    /// Returns a stable [`QueryError`] when the shape is malformed or exceeds
    /// the configured limits.
    pub fn from_value(value: &Value, limits: QueryLimits) -> Result<Self, QueryError> {
        let object = value
            .as_object()
            .ok_or_else(|| invalid("join must be a JSON object"))?;
        let left_collection = require_name(object, "$leftCollection")?;
        let right_collection = require_name(object, "$rightCollection")?;
        let mode = match object.get("$mode").and_then(Value::as_str) {
            Some("inner") => JoinMode::Inner,
            Some("left") => JoinMode::Left,
            Some("right") => JoinMode::Right,
            Some("outer") => JoinMode::Outer,
            _ => {
                return Err(invalid(
                    "join \"$mode\" must be \"inner\", \"left\", \"right\", or \"outer\"",
                ));
            }
        };

        let on_object = object
            .get("$on")
            .and_then(Value::as_object)
            .ok_or_else(|| invalid("join \"$on\" must be an object"))?;
        let mut on = Vec::new();
        for (field, operand) in on_object {
            let Some(operand) = operand.as_object() else {
                return Err(invalid(format!(
                    "join \"$on\" entry \"{field}\" must be an object"
                )));
            };
            for (name, right_field) in operand {
                let Some(comparator) = JoinComparator::parse(name) else {
                    return Err(invalid(format!(
                        "join comparator \"{name}\" is unsupported"
                    )));
                };
                let Some(right_field) = right_field.as_str() else {
                    return Err(invalid(format!(
                        "join comparator \"{name}\" must name a right-hand field"
                    )));
                };
                on.push((field.clone(), comparator, right_field.to_owned()));
            }
        }
        if on.is_empty() {
            // A join with nothing to compare would pair every left row with
            // every right row, which is a full cross product rather than the
            // join the caller asked for.
            return Err(invalid("join \"$on\" must contain at least one comparison"));
        }
        if on.len() > limits.max_queries {
            return Err(invalid(format!(
                "join declares {} comparisons; limit is {}",
                on.len(),
                limits.max_queries
            )));
        }

        let Projection {
            select,
            rename,
            limit,
            only_ids,
            group_by,
        } = Projection::from_object(object)?;

        Ok(Self {
            left_collection,
            right_collection,
            mode,
            on,
            select,
            rename,
            limit,
            only_ids,
            group_by,
        })
    }

    /// Left-hand collection name.
    #[must_use]
    pub fn left_collection(&self) -> &str {
        &self.left_collection
    }

    /// Right-hand collection name.
    #[must_use]
    pub fn right_collection(&self) -> &str {
        &self.right_collection
    }

    /// Maximum number of joined rows, when one was requested.
    #[must_use]
    pub const fn limit(&self) -> Option<usize> {
        self.limit
    }

    /// Whether only the joined identifiers were requested.
    #[must_use]
    pub const fn only_ids(&self) -> bool {
        self.only_ids
    }

    /// Field the joined rows are bucketed by, when one was requested.
    #[must_use]
    pub fn group_by(&self) -> Option<&str> {
        self.group_by.as_deref()
    }

    /// Whether one left/right pair satisfies the join.
    ///
    /// A pair matches when **any** comparison holds, matching the JavaScript
    /// engine: `$on` is a set of alternatives, not a conjunction.
    #[must_use]
    pub fn matches(&self, left: &Map<String, Value>, right: &Map<String, Value>) -> bool {
        self.on.iter().any(|(left_field, comparator, right_field)| {
            comparator.matches(
                value_by_path(left, left_field),
                value_by_path(right, right_field),
            )
        })
    }

    /// Combine and project one matched pair.
    #[must_use]
    pub fn project(
        &self,
        left: &Map<String, Value>,
        right: &Map<String, Value>,
    ) -> Map<String, Value> {
        let mut row = match self.mode {
            JoinMode::Left => left.clone(),
            JoinMode::Right => right.clone(),
            JoinMode::Inner | JoinMode::Outer => {
                let mut combined = left.clone();
                for (name, value) in right {
                    combined.insert(name.clone(), value.clone());
                }
                combined
            }
        };
        if !self.select.is_empty() {
            row.retain(|name, _| self.select.iter().any(|field| field == name));
        }
        if !self.rename.is_empty() {
            let mut renamed = Map::new();
            for (name, value) in row {
                match self.rename.get(&name).and_then(Value::as_str) {
                    Some(replacement) => renamed.insert(replacement.to_owned(), value),
                    None => renamed.insert(name, value),
                };
            }
            row = renamed;
        }
        row
    }
}

/// Read a dotted or slashed field path out of a document.
#[must_use]
pub fn value_by_path<'a>(document: &'a Map<String, Value>, path: &str) -> Option<&'a Value> {
    let mut segments = path.split(['.', '/']);
    let first = segments.next()?;
    let mut current = document.get(first)?;
    for segment in segments {
        current = match current {
            Value::Object(map) => map.get(segment)?,
            _ => return None,
        };
    }
    Some(current)
}

/// JavaScript `===` for the JSON values a document can hold.
///
/// An absent field is `undefined`, which is never strictly equal to anything —
/// including another absent field.
fn strict_equals(left: Option<&Value>, right: Option<&Value>) -> bool {
    match (left, right) {
        (Some(left), Some(right)) => left == right,
        _ => false,
    }
}

/// JavaScript `Number(value)`, restricted to what a comparison can use.
///
/// Anything that would coerce to `NaN` yields `None`, so every ordering
/// against it answers false.
fn coerce_number(value: Option<&Value>) -> Option<f64> {
    match value? {
        Value::Number(number) => number.as_f64(),
        Value::Bool(flag) => Some(if *flag { 1.0 } else { 0.0 }),
        Value::Null => Some(0.0),
        Value::String(text) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                Some(0.0)
            } else {
                trimmed.parse::<f64>().ok()
            }
        }
        Value::Array(_) | Value::Object(_) => None,
    }
}

fn require_name(object: &Map<String, Value>, field: &str) -> Result<String, QueryError> {
    object
        .get(field)
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty())
        .map(ToOwned::to_owned)
        .ok_or_else(|| invalid(format!("join \"{field}\" must be a collection name")))
}

fn invalid(message: impl Into<String>) -> QueryError {
    QueryError::new(QueryErrorCode::InvalidQuery, message.into())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn spec(value: &Value) -> JoinSpec {
        JoinSpec::from_value(value, QueryLimits::default()).unwrap()
    }

    #[test]
    fn any_comparison_matching_is_enough() {
        let join = spec(&json!({
            "$leftCollection": "users",
            "$rightCollection": "orders",
            "$mode": "inner",
            "$on": { "id": { "$eq": "userId" }, "tier": { "$eq": "tier" } }
        }));
        let left = json!({ "id": 1, "tier": "gold" });
        let right = json!({ "userId": 2, "tier": "gold" });
        assert!(join.matches(left.as_object().unwrap(), right.as_object().unwrap()));
    }

    #[test]
    fn an_absent_field_never_equals_another_absent_field() {
        let join = spec(&json!({
            "$leftCollection": "users",
            "$rightCollection": "orders",
            "$mode": "inner",
            "$on": { "missing": { "$eq": "alsoMissing" } }
        }));
        assert!(!join.matches(
            json!({ "id": 1 }).as_object().unwrap(),
            json!({ "id": 2 }).as_object().unwrap()
        ));
    }

    #[test]
    fn ordering_against_a_non_numeric_operand_is_false_both_ways() {
        let join = spec(&json!({
            "$leftCollection": "users",
            "$rightCollection": "orders",
            "$mode": "inner",
            "$on": { "score": { "$gt": "label" } }
        }));
        assert!(!join.matches(
            json!({ "score": 10 }).as_object().unwrap(),
            json!({ "label": "high" }).as_object().unwrap()
        ));
    }

    #[test]
    fn right_wins_on_a_shared_name() {
        let join = spec(&json!({
            "$leftCollection": "users",
            "$rightCollection": "orders",
            "$mode": "inner",
            "$on": { "id": { "$eq": "id" } }
        }));
        let row = join.project(
            json!({ "id": 1, "name": "Ada" }).as_object().unwrap(),
            json!({ "id": 1, "name": "Grace" }).as_object().unwrap(),
        );
        assert_eq!(row["name"], json!("Grace"));
    }

    #[test]
    fn select_then_rename_projects_in_that_order() {
        let join = spec(&json!({
            "$leftCollection": "users",
            "$rightCollection": "orders",
            "$mode": "inner",
            "$on": { "id": { "$eq": "id" } },
            "$select": ["name"],
            "$rename": { "name": "who" }
        }));
        let row = join.project(
            json!({ "id": 1, "name": "Ada" }).as_object().unwrap(),
            json!({ "id": 1, "total": 9 }).as_object().unwrap(),
        );
        assert_eq!(row, json!({ "who": "Ada" }).as_object().cloned().unwrap());
    }

    #[test]
    fn a_join_without_a_comparison_is_refused() {
        let error = JoinSpec::from_value(
            &json!({
                "$leftCollection": "users",
                "$rightCollection": "orders",
                "$mode": "inner",
                "$on": {}
            }),
            QueryLimits::default(),
        )
        .unwrap_err();
        assert_eq!(error.code(), QueryErrorCode::InvalidQuery);
    }

    #[test]
    fn nested_paths_use_dots_or_slashes() {
        let document = json!({ "profile": { "city": "Lagos" } });
        let document = document.as_object().unwrap();
        assert_eq!(
            value_by_path(document, "profile.city"),
            Some(&json!("Lagos"))
        );
        assert_eq!(
            value_by_path(document, "profile/city"),
            Some(&json!("Lagos"))
        );
        assert_eq!(value_by_path(document, "profile.zip"), None);
    }
}
