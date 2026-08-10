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

#[derive(Clone, Copy, Debug)]
pub struct QueueConsumerOptions {
    pub max_messages: usize,
    pub visibility_timeout_ms: u64,
    pub max_attempts: u32,
    pub retry_delay_ms: u64,
}

impl Default for QueueConsumerOptions {
    fn default() -> Self {
        Self {
            max_messages: 1,
            visibility_timeout_ms: 30_000,
            max_attempts: 3,
            retry_delay_ms: 0,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct QueueProcessResult {
    pub claimed: usize,
    pub acknowledged: usize,
    pub retried: usize,
    pub dead_lettered: usize,
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

    // --- Durable serverless queue ---
    pub fn queue_publish(
        &mut self,
        topic: &str,
        payload: Json,
        delay_ms: u64,
        idempotency_key: Option<&str>,
    ) -> std::io::Result<String> {
        let idempotency = idempotency_key.map_or(String::new(), |key| {
            format!(",\"idempotencyKey\":\"{}\"", esc(key))
        });
        self.checked(format!(
            r#"{{"op":"queuePublish","topic":"{}","payload":{},"delayMs":{}{}}}"#,
            esc(topic),
            payload.encode(),
            delay_ms,
            idempotency
        ))
    }
    pub fn queue_claim(
        &mut self,
        topic: &str,
        group: &str,
        max_messages: usize,
        visibility_timeout_ms: u64,
        max_attempts: u32,
    ) -> std::io::Result<String> {
        self.checked(format!(
            r#"{{"op":"queueClaim","topic":"{}","group":"{}","maxMessages":{},"visibilityTimeoutMs":{},"maxAttempts":{}}}"#,
            esc(topic), esc(group), max_messages, visibility_timeout_ms, max_attempts
        ))
    }
    pub fn queue_ack(
        &mut self,
        topic: &str,
        group: &str,
        id: &str,
        receipt: &str,
    ) -> std::io::Result<String> {
        self.checked(format!(
            r#"{{"op":"queueAck","topic":"{}","group":"{}","id":"{}","receipt":"{}"}}"#,
            esc(topic),
            esc(group),
            esc(id),
            esc(receipt)
        ))
    }
    pub fn queue_nack(
        &mut self,
        topic: &str,
        group: &str,
        id: &str,
        receipt: &str,
        delay_ms: u64,
        reason: &str,
    ) -> std::io::Result<String> {
        self.checked(format!(
            r#"{{"op":"queueNack","topic":"{}","group":"{}","id":"{}","receipt":"{}","delayMs":{},"reason":"{}"}}"#,
            esc(topic), esc(group), esc(id), esc(receipt), delay_ms, esc(reason)
        ))
    }
    pub fn queue_extend(
        &mut self,
        topic: &str,
        group: &str,
        id: &str,
        receipt: &str,
        visibility_timeout_ms: u64,
    ) -> std::io::Result<String> {
        self.checked(format!(
            r#"{{"op":"queueExtend","topic":"{}","group":"{}","id":"{}","receipt":"{}","visibilityTimeoutMs":{}}}"#,
            esc(topic), esc(group), esc(id), esc(receipt), visibility_timeout_ms
        ))
    }
    pub fn queue_stats(&mut self, topic: &str, group: &str) -> std::io::Result<String> {
        self.checked(format!(
            r#"{{"op":"queueStats","topic":"{}","group":"{}"}}"#,
            esc(topic),
            esc(group)
        ))
    }
    pub fn queue_dead_letters(
        &mut self,
        topic: &str,
        group: &str,
        limit: usize,
    ) -> std::io::Result<String> {
        self.checked(format!(
            r#"{{"op":"queueDeadLetters","topic":"{}","group":"{}","limit":{}}}"#,
            esc(topic),
            esc(group),
            limit
        ))
    }

    /// Process and settle one bounded batch. The dependency-free handler sees
    /// each delivery as a validated raw JSON object.
    pub fn queue_process<F>(
        &mut self,
        topic: &str,
        group: &str,
        options: QueueConsumerOptions,
        mut handler: F,
    ) -> std::io::Result<QueueProcessResult>
    where
        F: FnMut(&str) -> Result<(), String>,
    {
        let response = self.queue_claim(
            topic,
            group,
            options.max_messages,
            options.visibility_timeout_ms,
            options.max_attempts,
        )?;
        let result_json = json_object_field(response.trim(), "result")?;
        let deliveries: Vec<String> = json_array_values(result_json)?
            .into_iter()
            .map(str::to_string)
            .collect();
        let mut result = QueueProcessResult {
            claimed: deliveries.len(),
            ..QueueProcessResult::default()
        };
        for delivery in deliveries {
            let id = json_string_field(&delivery, "id")?;
            let receipt = json_string_field(&delivery, "receipt")?;
            match handler(&delivery) {
                Ok(()) => {
                    self.queue_ack(topic, group, &id, &receipt)?;
                    result.acknowledged += 1;
                }
                Err(_) => {
                    let response = self.queue_nack(
                        topic,
                        group,
                        &id,
                        &receipt,
                        options.retry_delay_ms,
                        "queue handler failed",
                    )?;
                    let nack = json_object_field(response.trim(), "result")?;
                    if json_object_field(nack, "deadLettered")? == "true" {
                        result.dead_lettered += 1;
                    } else {
                        result.retried += 1;
                    }
                }
            }
        }
        Ok(result)
    }

    /// Return Rust's attribute-free decorator equivalent: a callable that
    /// processes one bounded batch whenever it is invoked.
    pub fn queue_consumer<'a, F>(
        &'a mut self,
        topic: &str,
        group: &str,
        options: QueueConsumerOptions,
        mut handler: F,
    ) -> impl FnMut() -> std::io::Result<QueueProcessResult> + 'a
    where
        F: FnMut(&str) -> Result<(), String> + 'a,
    {
        let topic = topic.to_string();
        let group = group.to_string();
        move || self.queue_process(&topic, &group, options, &mut handler)
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

fn invalid_json(message: &str) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::InvalidData, message)
}

fn skip_json_space(bytes: &[u8], mut index: usize) -> usize {
    while index < bytes.len() && bytes[index].is_ascii_whitespace() {
        index += 1;
    }
    index
}

fn json_string_end(bytes: &[u8], start: usize) -> std::io::Result<usize> {
    if bytes.get(start) != Some(&b'"') {
        return Err(invalid_json("expected a JSON string"));
    }
    let mut index = start + 1;
    while index < bytes.len() {
        match bytes[index] {
            b'"' => return Ok(index + 1),
            b'\\' => index += 2,
            0x00..=0x1f => return Err(invalid_json("invalid JSON string control byte")),
            _ => index += 1,
        }
    }
    Err(invalid_json("unterminated JSON string"))
}

fn json_value_end(bytes: &[u8], start: usize) -> std::io::Result<usize> {
    let start = skip_json_space(bytes, start);
    match bytes.get(start) {
        Some(b'"') => json_string_end(bytes, start),
        Some(b'{') | Some(b'[') => {
            let mut stack = vec![if bytes[start] == b'{' { b'}' } else { b']' }];
            let mut index = start + 1;
            while index < bytes.len() {
                match bytes[index] {
                    b'"' => index = json_string_end(bytes, index)?,
                    b'{' => {
                        stack.push(b'}');
                        index += 1;
                    }
                    b'[' => {
                        stack.push(b']');
                        index += 1;
                    }
                    b'}' | b']' => {
                        if stack.pop() != Some(bytes[index]) {
                            return Err(invalid_json("mismatched JSON container"));
                        }
                        index += 1;
                        if stack.is_empty() {
                            return Ok(index);
                        }
                    }
                    _ => index += 1,
                }
            }
            Err(invalid_json("unterminated JSON container"))
        }
        Some(_) => {
            let mut index = start;
            while index < bytes.len()
                && !matches!(bytes[index], b',' | b']' | b'}')
                && !bytes[index].is_ascii_whitespace()
            {
                index += 1;
            }
            if index == start {
                Err(invalid_json("missing JSON value"))
            } else {
                Ok(index)
            }
        }
        None => Err(invalid_json("missing JSON value")),
    }
}

fn json_object_field<'a>(object: &'a str, wanted: &str) -> std::io::Result<&'a str> {
    let bytes = object.as_bytes();
    let mut index = skip_json_space(bytes, 0);
    if bytes.get(index) != Some(&b'{') {
        return Err(invalid_json("expected a JSON object"));
    }
    index += 1;
    loop {
        index = skip_json_space(bytes, index);
        if bytes.get(index) == Some(&b'}') {
            break;
        }
        let key_end = json_string_end(bytes, index)?;
        let key = decode_json_string(&object[index..key_end])?;
        index = skip_json_space(bytes, key_end);
        if bytes.get(index) != Some(&b':') {
            return Err(invalid_json("JSON object field lacks a colon"));
        }
        let value_start = skip_json_space(bytes, index + 1);
        let value_end = json_value_end(bytes, value_start)?;
        if key == wanted {
            return Ok(&object[value_start..value_end]);
        }
        index = skip_json_space(bytes, value_end);
        match bytes.get(index) {
            Some(b',') => index += 1,
            Some(b'}') => break,
            _ => return Err(invalid_json("invalid JSON object separator")),
        }
    }
    Err(invalid_json("FYLO response lacks an expected JSON field"))
}

fn json_array_values(array: &str) -> std::io::Result<Vec<&str>> {
    let bytes = array.as_bytes();
    let mut index = skip_json_space(bytes, 0);
    if bytes.get(index) != Some(&b'[') {
        return Err(invalid_json("expected a JSON array"));
    }
    index += 1;
    let mut values = Vec::new();
    loop {
        index = skip_json_space(bytes, index);
        if bytes.get(index) == Some(&b']') {
            return Ok(values);
        }
        let end = json_value_end(bytes, index)?;
        values.push(&array[index..end]);
        index = skip_json_space(bytes, end);
        match bytes.get(index) {
            Some(b',') => index += 1,
            Some(b']') => return Ok(values),
            _ => return Err(invalid_json("invalid JSON array separator")),
        }
    }
}

fn json_string_field(object: &str, key: &str) -> std::io::Result<String> {
    decode_json_string(json_object_field(object, key)?)
}

fn decode_json_string(value: &str) -> std::io::Result<String> {
    if value.len() < 2 || !value.starts_with('"') || !value.ends_with('"') {
        return Err(invalid_json("expected a JSON string field"));
    }
    let mut chars = value[1..value.len() - 1].chars();
    let mut decoded = String::new();
    while let Some(character) = chars.next() {
        if character != '\\' {
            decoded.push(character);
            continue;
        }
        match chars
            .next()
            .ok_or_else(|| invalid_json("incomplete JSON escape"))?
        {
            '"' => decoded.push('"'),
            '\\' => decoded.push('\\'),
            '/' => decoded.push('/'),
            'b' => decoded.push('\u{08}'),
            'f' => decoded.push('\u{0c}'),
            'n' => decoded.push('\n'),
            'r' => decoded.push('\r'),
            't' => decoded.push('\t'),
            'u' => {
                let mut code = 0_u32;
                for _ in 0..4 {
                    code = code * 16
                        + chars
                            .next()
                            .and_then(|digit| digit.to_digit(16))
                            .ok_or_else(|| invalid_json("invalid JSON unicode escape"))?;
                }
                if (0xd800..=0xdbff).contains(&code) {
                    if chars.next() != Some('\\') || chars.next() != Some('u') {
                        return Err(invalid_json("missing JSON low surrogate"));
                    }
                    let mut low = 0_u32;
                    for _ in 0..4 {
                        low = low * 16
                            + chars
                                .next()
                                .and_then(|digit| digit.to_digit(16))
                                .ok_or_else(|| invalid_json("invalid JSON low surrogate"))?;
                    }
                    if !(0xdc00..=0xdfff).contains(&low) {
                        return Err(invalid_json("invalid JSON low surrogate"));
                    }
                    code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
                } else if (0xdc00..=0xdfff).contains(&code) {
                    return Err(invalid_json("unexpected JSON low surrogate"));
                }
                decoded.push(
                    char::from_u32(code)
                        .ok_or_else(|| invalid_json("invalid JSON unicode scalar"))?,
                );
            }
            _ => return Err(invalid_json("unknown JSON escape")),
        }
    }
    Ok(decoded)
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
