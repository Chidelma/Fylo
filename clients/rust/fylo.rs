//! Fylo client — drives the `fylo` binary's persistent NDJSON loop.
//!
//! No crates (std only), so it works as a single-file module or dropped into a
//! crate. Requires the `fylo` binary on PATH (brew/scoop) or an explicit path.
//! One long-lived child process keeps the engine warm across calls.
//!
//! ```no_run
//! use fylo::{Fylo, Json};
//! let mut db = Fylo::open("/path/to/db", "fylo").unwrap();
//! db.create_collection("users", "document").unwrap();
//! db.put_data("users", Json::obj(vec![("name", "Ada".into()), ("role", "admin".into())])).unwrap();
//! // responses are raw JSON lines: {"ok":true,"result":"<id>",...}
//! let admins = db.find_docs("users",
//!     Json::obj(vec![("$ops", Json::arr(vec![
//!         Json::obj(vec![("role", Json::obj(vec![("$eq", "admin".into())]))])]))])).unwrap();
//! ```
//!
//! Operation methods build the request for you and error on `"ok":false`; they
//! return the raw JSON response line (bring serde if you want typed structs).
//! Object arguments are built with the dependency-free `Json` value type (which
//! has `From` impls for &str/String/i64/f64/bool). Method names follow Rust's
//! snake_case; `request` is the raw escape hatch for ops without a method.

use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};

const MAX_REQUEST_BYTES: usize = 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;

pub struct Fylo {
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: BufReader<std::process::ChildStdout>,
}

impl Fylo {
    /// Start a warm fylo process rooted at `root`. `binary` is usually "fylo".
    pub fn open(root: &str, binary: &str) -> std::io::Result<Fylo> {
        let mut cmd = Command::new(binary);
        cmd.args(["exec", "--loop", "--root", root]);
        cmd.arg("--max-request-bytes")
            .arg(MAX_REQUEST_BYTES.to_string())
            .arg("--max-response-bytes")
            .arg(MAX_RESPONSE_BYTES.to_string());
        let mut child = cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).spawn()?;
        let stdin = child.stdin.take().expect("stdin piped");
        let stdout = BufReader::new(child.stdout.take().expect("stdout piped"));
        Ok(Fylo {
            child,
            stdin: Some(stdin),
            stdout,
        })
    }

    /// Send one machine-protocol operation (a JSON object string) and return the
    /// response line (also JSON). ponytail: one call in flight; not thread-safe.
    pub fn request(&mut self, op_json: &str) -> std::io::Result<String> {
        let payload = op_json.trim_end();
        if payload.as_bytes().len() > MAX_REQUEST_BYTES {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                format!("FYLO request exceeds {MAX_REQUEST_BYTES} bytes"),
            ));
        }
        let stdin = self
            .stdin
            .as_mut()
            .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::BrokenPipe, "fylo closed"))?;
        stdin.write_all(payload.as_bytes())?;
        stdin.write_all(b"\n")?;
        stdin.flush()?;
        let mut line = String::new();
        let read = (&mut self.stdout)
            .take((MAX_RESPONSE_BYTES + 2) as u64)
            .read_line(&mut line);
        let n = match read {
            Ok(n) => n,
            Err(error) => {
                let _ = self.child.kill();
                return Err(error);
            }
        };
        if n == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "fylo closed the stream",
            ));
        }
        if !line.ends_with('\n') || line.as_bytes().len() - 1 > MAX_RESPONSE_BYTES {
            let _ = self.child.kill();
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("FYLO response exceeds {MAX_RESPONSE_BYTES} bytes"),
            ));
        }
        Ok(line)
    }

    // Send a fully-formed op JSON and error on a failure response.
    // ponytail: checks for the always-present "ok":true field by substring.
    fn checked(&mut self, json: String) -> std::io::Result<String> {
        let resp = self.request(&json)?;
        if !resp.contains("\"ok\":true") {
            return Err(std::io::Error::new(
                std::io::ErrorKind::Other,
                resp.trim().to_string(),
            ));
        }
        Ok(resp)
    }

    // --- Collections ---
    pub fn create_collection(&mut self, collection: &str, kind: &str) -> std::io::Result<String> {
        let kind = if kind.is_empty() { "document" } else { kind };
        self.checked(format!(
            r#"{{"op":"createCollection","collection":"{}","kind":"{}"}}"#,
            esc(collection),
            esc(kind)
        ))
    }
    pub fn drop_collection(&mut self, collection: &str) -> std::io::Result<String> {
        self.checked(format!(
            r#"{{"op":"dropCollection","collection":"{}"}}"#,
            esc(collection)
        ))
    }
    pub fn inspect_collection(&mut self, collection: &str) -> std::io::Result<String> {
        self.checked(format!(
            r#"{{"op":"inspectCollection","collection":"{}"}}"#,
            esc(collection)
        ))
    }
    pub fn rebuild_collection(&mut self, collection: &str) -> std::io::Result<String> {
        self.checked(format!(
            r#"{{"op":"rebuildCollection","collection":"{}"}}"#,
            esc(collection)
        ))
    }

    // --- Documents (object args are built with Json) ---
    pub fn put_data(&mut self, collection: &str, data: Json) -> std::io::Result<String> {
        self.checked(format!(
            r#"{{"op":"putData","collection":"{}","data":{}}}"#,
            esc(collection),
            data.encode()
        ))
    }
    pub fn get_doc(&mut self, collection: &str, id: &str) -> std::io::Result<String> {
        self.checked(format!(
            r#"{{"op":"getDoc","collection":"{}","id":"{}"}}"#,
            esc(collection),
            esc(id)
        ))
    }
    pub fn get_meta(&mut self, collection: &str, id: &str) -> std::io::Result<String> {
        self.checked(format!(
            r#"{{"op":"getMeta","collection":"{}","id":"{}"}}"#,
            esc(collection),
            esc(id)
        ))
    }
    pub fn set_meta(&mut self, collection: &str, id: &str, meta: Json) -> std::io::Result<String> {
        self.checked(format!(
            r#"{{"op":"setMeta","collection":"{}","id":"{}","meta":{}}}"#,
            esc(collection),
            esc(id),
            meta.encode()
        ))
    }
    pub fn get_latest(&mut self, collection: &str, id: &str) -> std::io::Result<String> {
        self.checked(format!(
            r#"{{"op":"getLatest","collection":"{}","id":"{}"}}"#,
            esc(collection),
            esc(id)
        ))
    }
    pub fn patch_doc(
        &mut self,
        collection: &str,
        id: &str,
        new_doc: Json,
    ) -> std::io::Result<String> {
        self.checked(format!(
            r#"{{"op":"patchDoc","collection":"{}","id":"{}","newDoc":{}}}"#,
            esc(collection),
            esc(id),
            new_doc.encode()
        ))
    }
    pub fn del_doc(&mut self, collection: &str, id: &str) -> std::io::Result<String> {
        self.checked(format!(
            r#"{{"op":"delDoc","collection":"{}","id":"{}"}}"#,
            esc(collection),
            esc(id)
        ))
    }
    pub fn restore_doc(&mut self, collection: &str, id: &str) -> std::io::Result<String> {
        self.checked(format!(
            r#"{{"op":"restoreDoc","collection":"{}","id":"{}"}}"#,
            esc(collection),
            esc(id)
        ))
    }

    // --- Query ---
    pub fn find_docs(&mut self, collection: &str, query: Json) -> std::io::Result<String> {
        self.checked(format!(
            r#"{{"op":"findDocs","collection":"{}","query":{}}}"#,
            esc(collection),
            query.encode()
        ))
    }
    pub fn find_docs_page(
        &mut self,
        collection: &str,
        query: Json,
        page: Json,
    ) -> std::io::Result<String> {
        self.checked(format!(
            r#"{{"op":"findDocs","collection":"{}","query":{},"page":{}}}"#,
            esc(collection),
            query.encode(),
            page.encode()
        ))
    }
    pub fn find_deleted_docs_page(
        &mut self,
        collection: &str,
        query: Json,
        page: Json,
    ) -> std::io::Result<String> {
        self.checked(format!(
            r#"{{"op":"findDeletedDocs","collection":"{}","query":{},"page":{}}}"#,
            esc(collection),
            query.encode(),
            page.encode()
        ))
    }
    pub fn execute_sql(&mut self, sql: &str) -> std::io::Result<String> {
        self.checked(format!(r#"{{"op":"executeSQL","sql":"{}"}}"#, esc(sql)))
    }
    pub fn execute_sql_as(
        &mut self,
        sql: &str,
        uid: u32,
        mode: Option<u32>,
    ) -> std::io::Result<String> {
        self.execute_sql_access(sql, Some(uid), None, mode)
    }
    pub fn execute_sql_access(
        &mut self,
        sql: &str,
        uid: Option<u32>,
        gid: Option<u32>,
        mode: Option<u32>,
    ) -> std::io::Result<String> {
        let mut fields = Vec::new();
        if let Some(value) = uid {
            fields.push(format!(r#""uid":{}"#, value));
        }
        if let Some(value) = gid {
            fields.push(format!(r#""gid":{}"#, value));
        }
        if let Some(value) = mode {
            fields.push(format!(r#""mode":{}"#, value));
        }
        self.checked(format!(
            r#"{{"op":"executeSQL","sql":"{}","access":{{{}}}}}"#,
            esc(sql),
            fields.join(",")
        ))
    }

    /// Run raw SQL, built with `format!`. Values are inlined verbatim —
    /// escape/validate untrusted input yourself.
    pub fn sql(&mut self, query: &str) -> std::io::Result<String> {
        self.execute_sql(query)
    }
    pub fn sql_as(&mut self, query: &str, uid: u32, mode: Option<u32>) -> std::io::Result<String> {
        self.execute_sql_as(query, uid, mode)
    }
    pub fn sql_access(
        &mut self,
        query: &str,
        uid: Option<u32>,
        gid: Option<u32>,
        mode: Option<u32>,
    ) -> std::io::Result<String> {
        self.execute_sql_access(query, uid, gid, mode)
    }

    /// Collection-scoped facade with short method names, so
    /// `db.collection("users").put(data)` reads like the browser client.
    pub fn collection<'a>(&'a mut self, name: &str) -> Collection<'a> {
        Collection {
            db: self,
            name: name.to_string(),
        }
    }
}

/// A collection-scoped view; methods drop the leading collection argument.
pub struct Collection<'a> {
    db: &'a mut Fylo,
    name: String,
}

impl<'a> Collection<'a> {
    pub fn create(&mut self, kind: &str) -> std::io::Result<String> {
        self.db.create_collection(&self.name, kind)
    }
    pub fn drop(&mut self) -> std::io::Result<String> {
        self.db.drop_collection(&self.name)
    }
    pub fn inspect(&mut self) -> std::io::Result<String> {
        self.db.inspect_collection(&self.name)
    }
    pub fn rebuild(&mut self) -> std::io::Result<String> {
        self.db.rebuild_collection(&self.name)
    }
    pub fn put(&mut self, data: Json) -> std::io::Result<String> {
        self.db.put_data(&self.name, data)
    }
    pub fn get(&mut self, id: &str) -> std::io::Result<String> {
        self.db.get_doc(&self.name, id)
    }
    pub fn get_meta(&mut self, id: &str) -> std::io::Result<String> {
        self.db.get_meta(&self.name, id)
    }
    pub fn set_meta(&mut self, id: &str, meta: Json) -> std::io::Result<String> {
        self.db.set_meta(&self.name, id, meta)
    }
    pub fn latest(&mut self, id: &str) -> std::io::Result<String> {
        self.db.get_latest(&self.name, id)
    }
    pub fn patch(&mut self, id: &str, new_doc: Json) -> std::io::Result<String> {
        self.db.patch_doc(&self.name, id, new_doc)
    }
    pub fn delete(&mut self, id: &str) -> std::io::Result<String> {
        self.db.del_doc(&self.name, id)
    }
    pub fn restore(&mut self, id: &str) -> std::io::Result<String> {
        self.db.restore_doc(&self.name, id)
    }
    pub fn find(&mut self, query: Json) -> std::io::Result<String> {
        self.db.find_docs(&self.name, query)
    }
    pub fn find_page(&mut self, query: Json, page: Json) -> std::io::Result<String> {
        self.db.find_docs_page(&self.name, query, page)
    }
}

// Minimal JSON string escaping for interpolated scalar values.
fn esc(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

/// A tiny dependency-free JSON value for building object arguments natively.
/// Scalars convert via `.into()` (e.g. `"admin".into()`, `18.into()`).
pub enum Json {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<Json>),
    Obj(Vec<(String, Json)>),
}

impl Json {
    pub fn arr(items: Vec<Json>) -> Json {
        Json::Arr(items)
    }
    pub fn obj(pairs: Vec<(&str, Json)>) -> Json {
        Json::Obj(pairs.into_iter().map(|(k, v)| (k.to_string(), v)).collect())
    }

    fn encode(&self) -> String {
        match self {
            Json::Null => "null".to_string(),
            Json::Bool(b) => b.to_string(),
            Json::Num(n) if n.fract() == 0.0 => format!("{}", *n as i64),
            Json::Num(n) => n.to_string(),
            Json::Str(s) => format!("\"{}\"", esc(s)),
            Json::Arr(a) => {
                let items: Vec<String> = a.iter().map(|x| x.encode()).collect();
                format!("[{}]", items.join(","))
            }
            Json::Obj(o) => {
                let pairs: Vec<String> = o
                    .iter()
                    .map(|(k, v)| format!("\"{}\":{}", esc(k), v.encode()))
                    .collect();
                format!("{{{}}}", pairs.join(","))
            }
        }
    }
}

impl From<&str> for Json {
    fn from(s: &str) -> Json {
        Json::Str(s.to_string())
    }
}
impl From<String> for Json {
    fn from(s: String) -> Json {
        Json::Str(s)
    }
}
impl From<i64> for Json {
    fn from(n: i64) -> Json {
        Json::Num(n as f64)
    }
}
impl From<f64> for Json {
    fn from(n: f64) -> Json {
        Json::Num(n)
    }
}
impl From<bool> for Json {
    fn from(b: bool) -> Json {
        Json::Bool(b)
    }
}

impl Drop for Fylo {
    fn drop(&mut self) {
        // Close stdin FIRST so the loop hits EOF and exits, then reap the child.
        self.stdin.take();
        let _ = self.child.wait();
    }
}
