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
use std::rc::Rc;

use boa_engine::module::{Module, SimpleModuleLoader};
use boa_engine::object::builtins::JsPromise;
use boa_engine::{Context, JsValue, Source, js_string};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

/// Bytes read for one schema manifest or version file.
const MAX_SCHEMA_BYTES: u64 = 16 * 1024 * 1024;
/// Bytes accepted for one CHEX response frame.
const MAX_RESPONSE_BYTES: u64 = 16 * 1024 * 1024;
/// Field the JavaScript engine stamps with the head schema version.
const VERSION_FIELD: &str = "_v";
/// A schema upgrader is trusted application code, but still receives a finite
/// loop budget so an accidental infinite loop cannot wedge the machine server.
const UPGRADER_LOOP_LIMIT: u64 = 10_000_000;

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
                let mut status = Map::new();
                status.insert("version".into(), Value::String(entry.v.clone()));
                status.insert("current".into(), Value::Bool(entry.v == manifest.current));
                if let Some(added_at) = entry.added_at.as_ref() {
                    status.insert("addedAt".into(), added_at.clone());
                }
                if let Some(sha256) = entry.sha256.as_ref() {
                    status.insert("sha256".into(), Value::String(sha256.clone()));
                }
                status.insert("path".into(), json!(path));
                status.insert("exists".into(), Value::Bool(exists));
                if let Some(actual) = actual.as_ref() {
                    status.insert("actualSha256".into(), Value::String(actual.clone()));
                }
                if let Some(expected) = entry.sha256.as_ref() {
                    status.insert(
                        "sha256Ok".into(),
                        Value::Bool(Some(expected) == actual.as_ref()),
                    );
                }
                if let Some(next) = next.as_ref() {
                    status.insert("nextVersion".into(), Value::String(next.clone()));
                }
                if let Some(upgrader) = upgrader.as_ref() {
                    status.insert("upgraderPath".into(), json!(upgrader));
                    status.insert("upgraderExists".into(), Value::Bool(upgrader.is_file()));
                }
                versions.push(Value::Object(status));
            }
        }
        Ok(json!({
            "collection": collection,
            "schemaDir": self.schema_dir,
            "versioned": manifest.is_some(),
            "current": manifest.as_ref().map(|manifest| manifest.current.clone()),
            "manifestPath": self.manifest_path(collection),
            "manifest": manifest.as_ref().map(manifest_value),
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

    /// Upgrade one document through the manifest's ordered JavaScript modules.
    ///
    /// Boa is embedded solely for this compatibility boundary. Modules execute
    /// without Node/Bun host APIs; relative ECMAScript imports remain confined
    /// to the configured schema root by `SimpleModuleLoader`.
    pub(crate) fn materialize(
        &self,
        collection: &str,
        document: &Map<String, Value>,
    ) -> Result<Map<String, Value>, String> {
        let Some(manifest) = self.manifest(collection)? else {
            return Ok(document.clone());
        };
        if manifest.versions.is_empty() {
            return Err(format!(
                "Invalid manifest for '{collection}': 'versions' must be a non-empty array"
            ));
        }
        let from = document
            .get(VERSION_FIELD)
            .and_then(Value::as_str)
            .unwrap_or(&manifest.versions[0].v);
        let from_index = manifest
            .versions
            .iter()
            .position(|entry| entry.v == from)
            .ok_or_else(|| {
                format!(
                    "Doc in '{collection}' is at unknown version '{from}' (not in manifest.versions)"
                )
            })?;
        let head_index = manifest
            .versions
            .iter()
            .position(|entry| entry.v == manifest.current)
            .ok_or_else(|| {
                format!(
                    "Manifest for '{collection}': 'current' ({}) is not present in 'versions'",
                    manifest.current
                )
            })?;
        if from_index > head_index {
            return Err(format!(
                "Doc in '{collection}' is at {from}, ahead of target {}: schema rolled back?",
                manifest.current
            ));
        }
        if from_index == head_index {
            return Ok(document.clone());
        }

        let mut next = document.clone();
        next.remove(VERSION_FIELD);
        for index in from_index..head_index {
            let from = &manifest.versions[index].v;
            let to = &manifest.versions[index + 1].v;
            next = self.run_upgrader(collection, from, to, &next)?;
        }
        next.insert(VERSION_FIELD.into(), Value::String(manifest.current));
        Ok(next)
    }

    fn run_upgrader(
        &self,
        collection: &str,
        from: &str,
        to: &str,
        document: &Map<String, Value>,
    ) -> Result<Map<String, Value>, String> {
        let path = self.upgrader_path(collection, from, to);
        let bytes = read_bounded(&path, MAX_SCHEMA_BYTES).map_err(|_| {
            format!(
                "Missing upgrader {from}->{to} for collection '{collection}' at {}",
                path.display()
            )
        })?;
        let source_text = String::from_utf8(bytes)
            .map_err(|_| format!("upgrader {} is not valid UTF-8", path.display()))?;
        let source_text = normalize_default_export(&source_text);
        let loader = Rc::new(
            SimpleModuleLoader::new(&self.schema_dir)
                .map_err(|error| format!("cannot initialize schema module loader: {error}"))?,
        );
        let mut context = Context::builder()
            .module_loader(loader.clone())
            .build()
            .map_err(|error| format!("cannot initialize schema upgrader runtime: {error}"))?;
        context
            .runtime_limits_mut()
            .set_loop_iteration_limit(UPGRADER_LOOP_LIMIT);
        let source = Source::from_reader(source_text.as_bytes(), Some(&path));
        let module = Module::parse(source, None, &mut context)
            .map_err(|error| format!("cannot parse upgrader {}: {error}", path.display()))?;
        loader.insert(path.clone(), module.clone());
        module
            .load_link_evaluate(&mut context)
            .await_blocking(&mut context)
            .map_err(|error| format!("cannot evaluate upgrader {}: {error}", path.display()))?;
        let callable = module
            .get_value(js_string!("default"), &mut context)
            .map_err(|error| format!("cannot load upgrader default export: {error}"))?;
        let function = callable.as_function().ok_or_else(|| {
            format!(
                "Upgrader at {} must default-export an async (doc) => doc function",
                path.display()
            )
        })?;
        let argument = JsValue::from_json(&Value::Object(document.clone()), &mut context)
            .map_err(|error| format!("cannot encode upgrader document: {error}"))?;
        let returned = function
            .call(&JsValue::undefined(), &[argument], &mut context)
            .map_err(|error| format!("upgrader {from}->{to} failed: {error}"))?;
        let returned = if let Some(object) = returned.as_object() {
            match JsPromise::from_object(object.clone()) {
                Ok(promise) => promise
                    .await_blocking(&mut context)
                    .map_err(|error| format!("upgrader {from}->{to} failed: {error}"))?,
                Err(_) => returned,
            }
        } else {
            returned
        };
        returned
            .to_json(&mut context)
            .map_err(|error| format!("upgrader {from}->{to} returned invalid JSON: {error}"))?
            .and_then(|value| value.as_object().cloned())
            .ok_or_else(|| {
                format!("Upgrader {from}->{to} for '{collection}' must return an object")
            })
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

fn manifest_value(manifest: &SchemaManifest) -> Value {
    let versions = manifest
        .versions
        .iter()
        .map(|entry| {
            let mut value = Map::new();
            value.insert("v".into(), Value::String(entry.v.clone()));
            if let Some(added_at) = entry.added_at.as_ref() {
                value.insert("addedAt".into(), added_at.clone());
            }
            if let Some(sha256) = entry.sha256.as_ref() {
                value.insert("sha256".into(), Value::String(sha256.clone()));
            }
            Value::Object(value)
        })
        .collect::<Vec<_>>();
    json!({
        "current": manifest.current,
        "versions": versions,
    })
}

/// Boa 0.21 parses default function/class declarations correctly but currently
/// rejects a default-exported arrow expression. FYLO has documented arrow
/// upgraders since the JavaScript release, so normalize only that module syntax
/// while leaving the executable expression unchanged.
fn normalize_default_export(source: &str) -> String {
    const EXPORT: &str = "export default ";
    let Some(offset) = source.find(EXPORT) else {
        return source.to_owned();
    };
    let expression = &source[offset + EXPORT.len()..];
    if expression.starts_with("function") || expression.starts_with("class") {
        return source.to_owned();
    }
    let mut normalized = String::with_capacity(source.len() + 64);
    normalized.push_str(&source[..offset]);
    normalized.push_str("const __fylo_default_upgrader__ = ");
    normalized.push_str(expression);
    normalized.push_str("\nexport { __fylo_default_upgrader__ as default };\n");
    normalized
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
