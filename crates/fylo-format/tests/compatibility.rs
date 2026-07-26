use fylo_format::{CanonicalMetadata, Document, DocumentLimits, FormatErrorCode};
use serde::Deserialize;
use serde_json::{Map, Value};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fixture {
    schema_version: u32,
    producer: Producer,
    documents: Vec<DocumentCase>,
    metadata: Vec<MetadataCase>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Producer {
    document_format: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DocumentCase {
    name: String,
    input: Value,
    valid: bool,
    encoded: Option<String>,
    error_code: Option<String>,
}

#[derive(Deserialize)]
struct MetadataCase {
    name: String,
    custom: Map<String, Value>,
    canonical: CanonicalMetadata,
    expected: Map<String, Value>,
}

#[test]
fn javascript_v1_fixture_matches_rust_format_contract() {
    let fixture: Fixture =
        serde_json::from_str(include_str!("../../../tests/fixtures/rust-format-v1.json")).unwrap();
    assert_eq!(fixture.schema_version, 1);
    assert_eq!(fixture.producer.document_format, "fylo.document.json.v1");

    for test_case in fixture.documents {
        let result = Document::try_from_value(test_case.input, DocumentLimits::default());
        if test_case.valid {
            let document = result
                .unwrap_or_else(|error| panic!("{} unexpectedly failed: {error}", test_case.name));
            assert_eq!(
                String::from_utf8(document.encode().unwrap()).unwrap(),
                test_case.encoded.unwrap(),
                "{}",
                test_case.name
            );
        } else {
            let error = result.expect_err(&test_case.name);
            assert_eq!(
                error.code().as_str(),
                test_case.error_code.unwrap(),
                "{}",
                test_case.name
            );
        }
    }

    for test_case in fixture.metadata {
        assert_eq!(
            test_case.canonical.merge_with_custom(&test_case.custom),
            test_case.expected,
            "{}",
            test_case.name
        );
    }
}

#[test]
fn stable_error_code_strings_are_complete() {
    let codes = [
        FormatErrorCode::DocumentTooLarge,
        FormatErrorCode::InvalidJson,
        FormatErrorCode::DocumentRoot,
        FormatErrorCode::ArrayOfObjects,
        FormatErrorCode::DocumentTooDeep,
        FormatErrorCode::TooManyNodes,
        FormatErrorCode::Encode,
        FormatErrorCode::InvalidDocumentId,
    ];
    for code in codes {
        assert!(code.as_str().starts_with('E'));
    }
}
