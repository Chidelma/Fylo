//! Schema administration and validation over the same CHEX binary the
//! JavaScript engine drives.
//!
//! FYLO consumes CHEX as a compiled binary spoken to over NDJSON, not as a
//! library. The native engine therefore reuses that exact process rather than
//! embedding a second JSON Schema implementation, which would validate the
//! same documents differently and silently split the contract in two.

use std::cell::RefCell;
use std::fmt::Write as _;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

use serde::Deserialize;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

/// Bytes read for one schema manifest or version file.
const MAX_SCHEMA_BYTES: u64 = 16 * 1024 * 1024;
/// Bytes accepted for one CHEX response frame.
const MAX_RESPONSE_BYTES: u64 = 16 * 1024 * 1024;
/// Field the JavaScript engine stamps with the head schema version.
const VERSION_FIELD: &str = "_v";

#[derive(Clone, Deserialize)]
struct SchemaManifest {
    current: String,
    #[serde(default)]
    versions: Vec<SchemaVersionEntry>,
}

#[derive(Clone, Deserialize)]
struct SchemaVersionEntry {
    v: String,
    #[serde(rename = "addedAt", default)]
    added_at: Option<Value>,
    #[serde(default)]
    sha256: Option<String>,
}

/// Schema directory tooling bound to one resolved schema root.
pub(crate) struct SchemaTools {
    schema_dir: PathBuf,
    chex: RefCell<Option<Chex>>,
}

impl SchemaTools {
    pub(crate) fn new(schema_dir: impl Into<PathBuf>) -> Self {
        Self {
            schema_dir: schema_dir.into(),
            chex: RefCell::new(None),
        }
    }

    pub(crate) fn schema_dir(&self) -> &Path {
        &self.schema_dir
    }

    fn collection_dir(&self, collection: &str) -> PathBuf {
        self.schema_dir.join(collection)
    }

    fn manifest_path(&self, collection: &str) -> PathBuf {
        self.collection_dir(collection).join("manifest.json")
    }

    fn version_path(&self, collection: &str, version: &str) -> PathBuf {
        self.collection_dir(collection)
            .join("history")
            .join(format!("{version}.schema.json"))
    }

    fn upgrader_path(&self, collection: &str, from: &str, to: &str) -> PathBuf {
        self.collection_dir(collection)
            .join("upgraders")
            .join(format!("{from}-to-{to}.js"))
    }

    fn manifest(&self, collection: &str) -> Result<Option<SchemaManifest>, String> {
        let path = self.manifest_path(collection);
        if !path.is_file() {
            return Ok(None);
        }
        let bytes = read_bounded(&path, MAX_SCHEMA_BYTES)?;
        serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|error| format!("schema manifest is corrupt: {error}"))
    }

    /// `schemaInspect`: manifest identity plus per-version file and upgrader
    /// state, including SHA-256 agreement with the manifest.
    pub(crate) fn inspect(&self, collection: &str) -> Result<Value, String> {
        let manifest = self.manifest(collection)?;
        let mut versions = Vec::new();
        if let Some(manifest) = manifest.as_ref() {
            for (index, entry) in manifest.versions.iter().enumerate() {
                let path = self.version_path(collection, &entry.v);
                let exists = path.is_file();
                let actual = if exists {
                    file_sha256(&path).ok()
                } else {
                    None
                };
                let next = manifest.versions.get(index + 1).map(|next| next.v.clone());
                let upgrader = next
                    .as_ref()
                    .map(|next| self.upgrader_path(collection, &entry.v, next));
                versions.push(json!({
                    "version": entry.v,
                    "current": entry.v == manifest.current,
                    "addedAt": entry.added_at,
                    "sha256": entry.sha256,
                    "path": path,
                    "exists": exists,
                    "actualSha256": actual,
                    "sha256Ok": entry
                        .sha256
                        .as_ref()
                        .map(|expected| Some(expected) == actual.as_ref()),
                    "nextVersion": next,
                    "upgraderPath": upgrader,
                    "upgraderExists": upgrader.as_ref().map(|path| path.is_file()),
                }));
            }
        }
        Ok(json!({
            "collection": collection,
            "schemaDir": self.schema_dir,
            "versioned": manifest.is_some(),
            "current": manifest.as_ref().map(|manifest| manifest.current.clone()),
            "manifestPath": self.manifest_path(collection),
            "manifest": manifest.as_ref().map(|manifest| json!({
                "current": manifest.current,
                "versions": manifest.versions.iter().map(|entry| json!({
                    "v": entry.v,
                    "addedAt": entry.added_at,
                    "sha256": entry.sha256,
                })).collect::<Vec<_>>(),
            })),
            "versions": versions,
        }))
    }

    /// `schemaDoctor`: every inspect finding the JavaScript admin reports as a
    /// blocking issue.
    pub(crate) fn doctor(&self, collection: &str) -> Value {
        let mut issues = Vec::new();
        let inspect = match self.inspect(collection) {
            Ok(inspect) => Some(inspect),
            Err(error) => {
                issues.push(error);
                None
            }
        };
        if let Some(inspect) = inspect.as_ref() {
            if inspect["versioned"] != Value::Bool(true) {
                issues.push(format!("Missing manifest: {}", inspect["manifestPath"]));
            }
            let mut seen: Vec<String> = Vec::new();
            let current = inspect["current"].as_str().unwrap_or_default().to_owned();
            for version in inspect["versions"].as_array().unwrap_or(&Vec::new()) {
                let label = version["version"].as_str().unwrap_or_default().to_owned();
                if seen.contains(&label) {
                    issues.push(format!("Duplicate version label: {label}"));
                }
                seen.push(label.clone());
                if version["exists"] != Value::Bool(true) {
                    issues.push(format!("Missing schema version file: {}", version["path"]));
                }
                if version["sha256Ok"] == Value::Bool(false) {
                    issues.push(format!("SHA-256 mismatch for {label}: {}", version["path"]));
                }
                if version["nextVersion"].is_string()
                    && version["upgraderExists"] != Value::Bool(true)
                {
                    issues.push(format!(
                        "Missing upgrader {label}->{}: {}",
                        version["nextVersion"], version["upgraderPath"]
                    ));
                }
            }
            if !current.is_empty() && !seen.contains(&current) {
                issues.push(format!(
                    "Current version is not declared in manifest.versions: {current}"
                ));
            }
        }
        json!({
            "collection": collection,
            "schemaDir": self.schema_dir,
            "ok": issues.is_empty(),
            "issues": issues,
            "warnings": Vec::<String>::new(),
            "inspect": inspect,
        })
    }

    pub(crate) fn current_version(&self, collection: &str) -> Result<Option<String>, String> {
        Ok(self.manifest(collection)?.map(|manifest| manifest.current))
    }

    /// Validate against the head schema and stamp `_v`, matching
    /// `validateAgainstHead`.
    ///
    /// Returns `None` when the collection has neither a versioned manifest nor
    /// a flat `<collection>.schema.json`, because the JavaScript engine stores
    /// such a collection without validating it.
    pub(crate) fn validate_against_head(
        &self,
        collection: &str,
        document: &Map<String, Value>,
    ) -> Result<Option<Map<String, Value>>, String> {
        let mut body = document.clone();
        body.remove(VERSION_FIELD);
        let Some(manifest) = self.manifest(collection)? else {
            let flat = self.schema_dir.join(format!("{collection}.schema.json"));
            if !flat.is_file() {
                return Ok(None);
            }
            let validated = self.validate(collection, &body, Some(&self.schema_dir))?;
            return Ok(Some(validated));
        };
        let head = self.version_path(collection, &manifest.current);
        if !head.is_file() {
            return Err(format!(
                "head schema is missing: {}",
                head.to_string_lossy()
            ));
        }
        let mut validated = self.validate(&head.to_string_lossy(), &body, None)?;
        validated.insert(
            VERSION_FIELD.into(),
            Value::String(manifest.current.clone()),
        );
        Ok(Some(validated))
    }

    /// Send one `validate` operation to the warm CHEX process.
    fn validate(
        &self,
        schema: &str,
        data: &Map<String, Value>,
        schema_dir: Option<&Path>,
    ) -> Result<Map<String, Value>, String> {
        let mut request = json!({
            "op": "validate",
            "schema": schema,
            "data": data,
        });
        if let Some(directory) = schema_dir {
            request["schemaDir"] = Value::String(directory.to_string_lossy().into_owned());
        }
        let response = self.request(&request)?;
        if response.get("ok") != Some(&Value::Bool(true)) {
            let message = response
                .get("error")
                .and_then(|error| error.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("document does not match its schema");
            return Err(message.to_owned());
        }
        response
            .get("result")
            .and_then(Value::as_object)
            .cloned()
            .ok_or_else(|| "CHEX returned a non-object validation result".to_owned())
    }

    fn request(&self, request: &Value) -> Result<Value, String> {
        let mut slot = self.chex.borrow_mut();
        if slot.is_none() {
            *slot = Some(Chex::spawn()?);
        }
        let outcome = slot
            .as_mut()
            .ok_or_else(|| "CHEX process is unavailable".to_owned())?
            .request(request);
        if outcome.is_err() {
            // A dead loop cannot be reused; the next call respawns it.
            *slot = None;
        }
        outcome
    }
}

/// One warm `chex exec --loop` subprocess.
struct Chex {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
}

impl Chex {
    fn spawn() -> Result<Self, String> {
        let binary = std::env::var("FYLO_CHEX_BINARY").unwrap_or_else(|_| "chex".into());
        let mut child = Command::new(&binary)
            .args(["exec", "--loop"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|error| format!("cannot start the CHEX validator ({binary}): {error}"))?;
        let input = child
            .stdin
            .take()
            .ok_or_else(|| "CHEX stdin is unavailable".to_owned())?;
        let output = child
            .stdout
            .take()
            .ok_or_else(|| "CHEX stdout is unavailable".to_owned())?;
        Ok(Self {
            child,
            input,
            output: BufReader::new(output),
        })
    }

    fn request(&mut self, request: &Value) -> Result<Value, String> {
        let encoded =
            serde_json::to_string(request).map_err(|error| format!("invalid request: {error}"))?;
        writeln!(self.input, "{encoded}")
            .and_then(|()| self.input.flush())
            .map_err(|error| format!("cannot write to the CHEX validator: {error}"))?;
        let mut line = Vec::new();
        let read = std::io::Read::take(&mut self.output, MAX_RESPONSE_BYTES)
            .read_until(b'\n', &mut line)
            .map_err(|error| format!("cannot read from the CHEX validator: {error}"))?;
        if read == 0 {
            return Err("the CHEX validator exited".into());
        }
        let line =
            String::from_utf8(line).map_err(|_| "CHEX response is not valid UTF-8".to_owned())?;
        serde_json::from_str(line.trim())
            .map_err(|error| format!("CHEX response is not valid JSON: {error}"))
    }
}

impl Drop for Chex {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn read_bounded(path: &Path, max_bytes: u64) -> Result<Vec<u8>, String> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|error| format!("cannot inspect schema file: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("schema path is not a regular file".into());
    }
    if metadata.len() > max_bytes {
        return Err(format!("schema file exceeds {max_bytes} bytes"));
    }
    std::fs::read(path).map_err(|error| format!("cannot read schema file: {error}"))
}

fn file_sha256(path: &Path) -> Result<String, String> {
    let bytes = read_bounded(path, MAX_SCHEMA_BYTES)?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    let mut encoded = String::with_capacity(64);
    for byte in hasher.finalize() {
        let _ = write!(encoded, "{byte:02x}");
    }
    Ok(encoded)
}
