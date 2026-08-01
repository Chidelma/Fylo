use fylo_query::{QueryLimits, QueryRow, StructuredQuery};
use serde::Deserialize;
use serde_json::{Map, Value};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fixture {
    schema_version: u32,
    query_format: String,
    cases: Vec<PredicateCase>,
    result_cases: Vec<ResultCase>,
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResultCase {
    name: String,
    query: Value,
    rows: Vec<ResultRow>,
    expected_ids: Vec<String>,
}

#[derive(Deserialize)]
struct ResultRow {
    id: String,
    document: Map<String, Value>,
    timestamps: Timestamps,
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
    for test_case in fixture.result_cases {
        let query = StructuredQuery::from_value(&test_case.query, QueryLimits::default()).unwrap();
        let rows: Vec<QueryRow<'_>> = test_case
            .rows
            .iter()
            .map(|row| QueryRow {
                id: &row.id,
                document: &row.document,
                created_at: row.timestamps.created_at,
                updated_at: row.timestamps.updated_at,
            })
            .collect();
        let actual: Vec<&str> = query.filter(rows).into_iter().map(|row| row.id).collect();
        assert_eq!(actual, test_case.expected_ids, "{}", test_case.name);
    }
}
