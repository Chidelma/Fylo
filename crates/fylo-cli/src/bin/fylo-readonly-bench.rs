//! Controlled in-process benchmark for the native read-only preview.

use std::env;
use std::hint::black_box;
use std::process::ExitCode;
use std::time::Instant;

use fylo_engine::ReadOnlyEngine;
use fylo_query::{QueryLimits, StructuredQuery};
use serde_json::json;

const MAX_ITERATIONS: usize = 100_000;
const MAX_WARMUP: usize = 10_000;

fn main() -> ExitCode {
    let arguments: Vec<String> = env::args().skip(1).collect();
    match run(&arguments) {
        Ok(output) => {
            println!("{output}");
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
}

fn run(arguments: &[String]) -> Result<String, String> {
    let root = required_option(arguments, "--root")?;
    let collection = required_option(arguments, "--collection")?;
    let identifier = required_option(arguments, "--id")?;
    let encoded_query = required_option(arguments, "--query")?;
    let iterations = bounded_usize(arguments, "--iterations", 100, 1, MAX_ITERATIONS)?;
    let warmup = bounded_usize(arguments, "--warmup", 20, 0, MAX_WARMUP)?;
    let query = StructuredQuery::parse(encoded_query.as_bytes(), QueryLimits::default())
        .map_err(|error| error.to_string())?;
    let engine = ReadOnlyEngine::open(root).map_err(|error| error.to_string())?;

    let get = measure(iterations, warmup, || {
        engine
            .get(collection, identifier)
            .map(|record| record.metadata.id.len())
            .map_err(|error| error.to_string())
    })?;
    let find = measure(iterations, warmup, || {
        engine
            .find(collection, &query)
            .map(|records| records.len())
            .map_err(|error| error.to_string())
    })?;
    let inspect = measure(iterations, warmup, || {
        engine
            .inspect(collection)
            .map(|report| report.document_count + report.file_count)
            .map_err(|error| error.to_string())
    })?;
    let verify_index = measure(iterations, warmup, || {
        engine
            .verify_index(collection)
            .map(|report| usize::from(report.rebuild_equivalent))
            .map_err(|error| error.to_string())
    })?;

    serde_json::to_string_pretty(&json!({
        "format": "fylo.read-only-benchmark.engine.v1",
        "engine": "rust-read-only-preview",
        "unit": "nanoseconds",
        "parameters": {
            "iterations": iterations,
            "warmup": warmup
        },
        "operations": {
            "get": get.to_json(),
            "find": find.to_json(),
            "inspect": inspect.to_json(),
            "verifyIndex": verify_index.to_json()
        },
        "process": {
            "peakRssBytes": peak_rss_bytes()
        }
    }))
    .map_err(|error| error.to_string())
}

fn measure(
    iterations: usize,
    warmup: usize,
    mut operation: impl FnMut() -> Result<usize, String>,
) -> Result<SampleSummary, String> {
    for _ in 0..warmup {
        black_box(operation()?);
    }
    let mut samples = Vec::with_capacity(iterations);
    let mut last_result = 0;
    for _ in 0..iterations {
        let started = Instant::now();
        last_result = black_box(operation()?);
        let elapsed = started.elapsed().as_nanos();
        samples.push(u64::try_from(elapsed).unwrap_or(u64::MAX));
    }
    samples.sort_unstable();
    Ok(SampleSummary {
        iterations,
        minimum: samples[0],
        mean: samples.iter().sum::<u64>() / u64::try_from(iterations).unwrap_or(u64::MAX),
        p50: percentile(&samples, 50),
        p95: percentile(&samples, 95),
        p99: percentile(&samples, 99),
        maximum: samples[iterations - 1],
        last_result,
    })
}

fn percentile(samples: &[u64], percentile: usize) -> u64 {
    let rank = samples
        .len()
        .saturating_mul(percentile)
        .div_ceil(100)
        .saturating_sub(1);
    samples[rank.min(samples.len() - 1)]
}

struct SampleSummary {
    iterations: usize,
    minimum: u64,
    mean: u64,
    p50: u64,
    p95: u64,
    p99: u64,
    maximum: u64,
    last_result: usize,
}

impl SampleSummary {
    fn to_json(&self) -> serde_json::Value {
        json!({
            "iterations": self.iterations,
            "min": self.minimum,
            "mean": self.mean,
            "p50": self.p50,
            "p95": self.p95,
            "p99": self.p99,
            "max": self.maximum,
            "lastResult": self.last_result
        })
    }
}

fn bounded_usize(
    arguments: &[String],
    name: &str,
    default: usize,
    minimum: usize,
    maximum: usize,
) -> Result<usize, String> {
    if !arguments.iter().any(|argument| argument == name) {
        return Ok(default);
    }
    let value = required_option(arguments, name)?
        .parse::<usize>()
        .map_err(|error| format!("invalid {name}: {error}"))?;
    if !(minimum..=maximum).contains(&value) {
        return Err(format!("{name} must be between {minimum} and {maximum}"));
    }
    Ok(value)
}

fn required_option<'a>(arguments: &'a [String], name: &str) -> Result<&'a str, String> {
    let Some(index) = arguments.iter().position(|argument| argument == name) else {
        return Err(format!("missing required option {name}"));
    };
    arguments
        .get(index + 1)
        .map(String::as_str)
        .filter(|value| !value.is_empty() && !value.starts_with("--"))
        .ok_or_else(|| format!("missing value for {name}"))
}

#[cfg(target_os = "linux")]
fn peak_rss_bytes() -> Option<u64> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    let line = status.lines().find(|line| line.starts_with("VmHWM:"))?;
    let kibibytes = line.split_whitespace().nth(1)?.parse::<u64>().ok()?;
    kibibytes.checked_mul(1024)
}

#[cfg(target_os = "macos")]
fn peak_rss_bytes() -> Option<u64> {
    let output = std::process::Command::new("ps")
        .args(["-o", "rss=", "-p"])
        .arg(std::process::id().to_string())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let kibibytes = String::from_utf8(output.stdout)
        .ok()?
        .trim()
        .parse::<u64>()
        .ok()?;
    kibibytes.checked_mul(1024)
}

#[cfg(windows)]
fn peak_rss_bytes() -> Option<u64> {
    let command = format!(
        "(Get-Process -Id {} -ErrorAction SilentlyContinue).WorkingSet64",
        std::process::id()
    );
    let output = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", &command])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8(output.stdout)
        .ok()?
        .trim()
        .parse::<u64>()
        .ok()
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
fn peak_rss_bytes() -> Option<u64> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percentiles_use_nearest_rank() {
        let samples = [10, 20, 30, 40, 50];
        assert_eq!(percentile(&samples, 50), 30);
        assert_eq!(percentile(&samples, 95), 50);
        assert_eq!(percentile(&samples, 99), 50);
    }

    #[test]
    fn bounded_options_reject_excessive_work() {
        let arguments = ["--iterations".into(), "100001".into()];
        assert_eq!(
            bounded_usize(&arguments, "--iterations", 10, 1, MAX_ITERATIONS).unwrap_err(),
            "--iterations must be between 1 and 100000"
        );
    }
}
