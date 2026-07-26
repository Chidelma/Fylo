//! Repository-specific FYLO development and qualification tasks.

use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("xtask: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), String> {
    let mut arguments = env::args().skip(1);
    match arguments.next().as_deref() {
        Some("verify-workspace") => verify_workspace(&workspace_root()?),
        Some("print-version") => {
            println!("{}", read_version(&workspace_root()?)?);
            Ok(())
        }
        Some(command) => Err(format!("unknown command: {command}")),
        None => Err("expected `verify-workspace` or `print-version`".into()),
    }
}

fn workspace_root() -> Result<PathBuf, String> {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "xtask manifest has no workspace parent".into())
}

fn verify_workspace(root: &Path) -> Result<(), String> {
    let version = read_version(root)?;
    let package = fs::read_to_string(root.join("package.json"))
        .map_err(|error| format!("cannot read package.json: {error}"))?;
    let expected = format!("\"version\": \"{version}\"");
    if !package.contains(&expected) {
        return Err(format!(
            "VERSION contains {version}, but package.json does not contain {expected}"
        ));
    }

    for required in [
        "Cargo.lock",
        "Cargo.toml",
        "deny.toml",
        "rust-toolchain.toml",
        "rustfmt.toml",
        "docs/RUST_ENGINE_PROJECT_PLAN.md",
        "docs/releases/support-tiers.md",
    ] {
        if !root.join(required).is_file() {
            return Err(format!("required workspace file is missing: {required}"));
        }
    }

    println!("FYLO workspace {version} is internally consistent");
    Ok(())
}

fn read_version(root: &Path) -> Result<String, String> {
    let version = fs::read_to_string(root.join("VERSION"))
        .map_err(|error| format!("cannot read VERSION: {error}"))?;
    let version = version.trim();
    if version.is_empty() {
        return Err("VERSION is empty".into());
    }
    Ok(version.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn committed_workspace_is_consistent() {
        verify_workspace(&workspace_root().unwrap()).unwrap();
    }
}
