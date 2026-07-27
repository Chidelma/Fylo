//! Experimental native NDJSON machine server used by protocol conformance
//! gates. It serves the read operations the native engine implements and
//! reports `EUNSUPPORTEDOP` for the rest of the registry.

use std::env;
use std::io::{self, BufReader};
use std::path::PathBuf;
use std::process::ExitCode;

use fylo_machine::{FrameLimits, serve};

fn main() -> ExitCode {
    let arguments: Vec<String> = env::args().skip(1).collect();
    let root = option(&arguments, "--root").map(PathBuf::from);
    let limits = FrameLimits {
        max_request_bytes: usize_option(&arguments, "--max-request-bytes")
            .unwrap_or(fylo_machine::DEFAULT_MAX_REQUEST_BYTES),
        max_response_bytes: usize_option(&arguments, "--max-response-bytes")
            .unwrap_or(fylo_machine::DEFAULT_MAX_RESPONSE_BYTES),
    };
    let mut input = BufReader::new(io::stdin().lock());
    let mut output = io::stdout().lock();
    match serve(&mut input, &mut output, root, limits) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
}

fn option<'a>(arguments: &'a [String], name: &str) -> Option<&'a str> {
    arguments
        .iter()
        .position(|argument| argument == name)
        .and_then(|index| arguments.get(index + 1))
        .map(String::as_str)
}

fn usize_option(arguments: &[String], name: &str) -> Option<usize> {
    option(arguments, name).and_then(|value| value.parse().ok())
}
