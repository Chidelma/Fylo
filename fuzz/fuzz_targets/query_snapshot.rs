#![no_main]

use fylo_query::{parse_queries, IndexSnapshot, QueryLimits};
use libfuzzer_sys::fuzz_target;

fuzz_target!(|input: &[u8]| {
    let split = input
        .iter()
        .position(|byte| *byte == 0)
        .unwrap_or(input.len());
    let snapshot_bytes = &input[..split];
    let query_bytes = input.get(split.saturating_add(1)..).unwrap_or_default();
    let limits = QueryLimits {
        max_snapshot_bytes: 1024 * 1024,
        max_key_bytes: 8 * 1024,
        max_queries: 64,
        max_term_bytes: 8 * 1024,
        max_input_bytes: 1024 * 1024,
        max_matches: 10_000,
        max_output_bytes: 1024 * 1024,
    };
    if let (Ok(snapshot), Ok(queries)) = (
        IndexSnapshot::from_bytes(snapshot_bytes, limits),
        parse_queries(query_bytes, limits),
    ) {
        let _ = snapshot.scan_encoded(&queries, limits);
    }
});
