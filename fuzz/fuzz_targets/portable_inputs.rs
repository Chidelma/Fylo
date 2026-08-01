#![no_main]

use fylo_format::{Document, DocumentLimits};
use fylo_query::{QueryLimits, StructuredQuery, parse_queries, prepare_sql};
use libfuzzer_sys::fuzz_target;

fuzz_target!(|input: &[u8]| {
    let document_limits = DocumentLimits {
        max_bytes: 1024 * 1024,
        max_depth: 64,
        max_nodes: 100_000,
    };
    let query_limits = QueryLimits {
        max_snapshot_bytes: 1024 * 1024,
        max_key_bytes: 8 * 1024,
        max_queries: 64,
        max_term_bytes: 8 * 1024,
        max_input_bytes: 1024 * 1024,
        max_matches: 10_000,
        max_output_bytes: 1024 * 1024,
    };

    if let Ok(document) = Document::parse(input, document_limits) {
        let encoded = document
            .encode()
            .expect("validated JSON documents must remain serializable");
        let reparsed = Document::parse(&encoded, document_limits)
            .expect("canonical document bytes must remain parseable");
        assert_eq!(document, reparsed);
    }
    let _ = parse_queries(input, query_limits);
    let _ = StructuredQuery::parse(input, query_limits);
    if let Ok(sql) = std::str::from_utf8(input) {
        let _ = prepare_sql(sql, query_limits);
    }
});
