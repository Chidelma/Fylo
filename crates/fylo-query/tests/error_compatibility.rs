use fylo_query::{
    IndexSnapshot, QueryError, QueryLimits, StructuredQuery, parse_queries, prepare_sql,
};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fixture {
    schema_version: u32,
    query_format: String,
    producer: String,
    cases: Vec<ErrorCase>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ErrorCase {
    name: String,
    operation: String,
    #[serde(default)]
    snapshot: String,
    #[serde(default)]
    input: String,
    #[serde(default)]
    limits: LimitOverrides,
    error_code: String,
}

#[derive(Default, Deserialize)]
struct LimitOverrides {
    #[serde(rename = "maxSnapshotBytes")]
    snapshot_bytes: Option<usize>,
    #[serde(rename = "maxKeyBytes")]
    key_bytes: Option<usize>,
    #[serde(rename = "maxQueries")]
    queries: Option<usize>,
    #[serde(rename = "maxTermBytes")]
    term_bytes: Option<usize>,
    #[serde(rename = "maxInputBytes")]
    input_bytes: Option<usize>,
    #[serde(rename = "maxMatches")]
    matches: Option<usize>,
    #[serde(rename = "maxOutputBytes")]
    output_bytes: Option<usize>,
}

impl LimitOverrides {
    fn apply(&self) -> QueryLimits {
        let defaults = QueryLimits::default();
        QueryLimits {
            max_snapshot_bytes: self.snapshot_bytes.unwrap_or(defaults.max_snapshot_bytes),
            max_key_bytes: self.key_bytes.unwrap_or(defaults.max_key_bytes),
            max_queries: self.queries.unwrap_or(defaults.max_queries),
            max_term_bytes: self.term_bytes.unwrap_or(defaults.max_term_bytes),
            max_input_bytes: self.input_bytes.unwrap_or(defaults.max_input_bytes),
            max_matches: self.matches.unwrap_or(defaults.max_matches),
            max_output_bytes: self.output_bytes.unwrap_or(defaults.max_output_bytes),
        }
    }
}

#[test]
fn versioned_query_failures_keep_stable_codes() {
    let fixture: Fixture = serde_json::from_str(include_str!(
        "../../../tests/fixtures/rust-query-errors-v1.json"
    ))
    .unwrap();
    assert_eq!(fixture.schema_version, 1);
    assert_eq!(fixture.query_format, "fylo.query.errors.v1");
    assert_eq!(fixture.producer, "fylo-rust-contract");

    for case in fixture.cases {
        let limits = case.limits.apply();
        let result: Result<(), QueryError> = match case.operation.as_str() {
            "snapshot" => IndexSnapshot::from_bytes(case.snapshot.as_bytes(), limits).map(drop),
            "parse" => parse_queries(case.input.as_bytes(), limits).map(drop),
            "structured" => StructuredQuery::parse(case.input.as_bytes(), limits).map(drop),
            "sql" => prepare_sql(&case.input, limits).map(drop),
            "scan" | "scanEncoded" => {
                let snapshot = IndexSnapshot::from_bytes(case.snapshot.as_bytes(), limits)
                    .unwrap_or_else(|error| panic!("{} setup failed: {error}", case.name));
                let queries = parse_queries(case.input.as_bytes(), limits)
                    .unwrap_or_else(|error| panic!("{} setup failed: {error}", case.name));
                if case.operation == "scan" {
                    snapshot.scan(&queries, limits).map(drop)
                } else {
                    snapshot.scan_encoded(&queries, limits).map(drop)
                }
            }
            operation => panic!("unknown fixture operation {operation}"),
        };
        let error = result.unwrap_err();
        assert_eq!(error.code().as_str(), case.error_code, "{}", case.name);
    }
}
