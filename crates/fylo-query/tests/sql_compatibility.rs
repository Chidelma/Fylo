use fylo_query::{QueryLimits, prepare_sql};
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fixture {
    schema_version: u64,
    query_format: String,
    producer: String,
    ast_cases: Vec<Case>,
    plan_cases: Vec<Case>,
}

#[derive(Deserialize)]
struct Case {
    sql: String,
    expected: Value,
}

#[test]
fn javascript_sql_fixture_matches_rust_parser_and_planner() {
    let fixture: Fixture =
        serde_json::from_str(include_str!("../../../tests/fixtures/rust-sql-v1.json")).unwrap();
    assert_eq!(fixture.schema_version, 1);
    assert_eq!(fixture.query_format, "fylo.query.v1");
    assert_eq!(fixture.producer, "fylo-js");

    for case in fixture.ast_cases {
        let plan = prepare_sql(&case.sql, QueryLimits::default()).unwrap();
        assert_eq!(plan.ast, case.expected, "AST mismatch for {}", case.sql);
    }
    for case in fixture.plan_cases {
        let plan = prepare_sql(&case.sql, QueryLimits::default()).unwrap();
        assert_eq!(
            serde_json::to_value(plan).unwrap(),
            case.expected,
            "plan mismatch for {}",
            case.sql
        );
    }
}
