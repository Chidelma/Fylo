use fylo_query::{IndexSnapshot, QUERY_FORMAT_V1, QueryLimits, ScanQuery};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fixture {
    schema_version: u32,
    query_format: String,
    snapshot: String,
    cases: Vec<QueryCase>,
}

#[derive(Deserialize)]
struct QueryCase {
    name: String,
    queries: Vec<ScanQuery>,
    expected: Vec<String>,
}

#[test]
fn javascript_v1_query_fixture_matches_rust_kernel() {
    let fixture: Fixture =
        serde_json::from_str(include_str!("../../../tests/fixtures/rust-query-v1.json")).unwrap();
    assert_eq!(fixture.schema_version, 1);
    assert_eq!(fixture.query_format, QUERY_FORMAT_V1);
    let snapshot =
        IndexSnapshot::from_bytes(fixture.snapshot.as_bytes(), QueryLimits::default()).unwrap();
    for test_case in fixture.cases {
        let actual: Vec<String> = snapshot
            .scan(&test_case.queries, QueryLimits::default())
            .unwrap()
            .into_iter()
            .map(|id| String::from_utf8(id).unwrap())
            .collect();
        assert_eq!(actual, test_case.expected, "{}", test_case.name);
    }
}
