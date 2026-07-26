use fylo_query::{QueryLimits, StructuredQuery};
use serde::Deserialize;
use serde_json::{Map, Value};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fixture {
    schema_version: u32,
    query_format: String,
    cases: Vec<PredicateCase>,
}

#[derive(Deserialize)]
struct PredicateCase {
    name: String,
    document: Map<String, Value>,
    query: Value,
    timestamps: Timestamps,
    expected: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Timestamps {
    created_at: u64,
    updated_at: u64,
}

#[test]
fn javascript_predicate_fixture_matches_rust_kernel() {
    let fixture: Fixture = serde_json::from_str(include_str!(
        "../../../tests/fixtures/rust-predicate-v1.json"
    ))
    .unwrap();
    assert_eq!(fixture.schema_version, 1);
    assert_eq!(fixture.query_format, "fylo.structured-query.v1");
    for test_case in fixture.cases {
        let query = StructuredQuery::from_value(&test_case.query, QueryLimits::default()).unwrap();
        assert_eq!(
            query.matches(
                &test_case.document,
                test_case.timestamps.created_at,
                test_case.timestamps.updated_at
            ),
            test_case.expected,
            "{}",
            test_case.name
        );
    }
}
