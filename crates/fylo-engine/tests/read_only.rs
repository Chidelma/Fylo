use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use fylo_engine::{EngineErrorCode, ReadOnlyEngine};
use fylo_query::ScanQuery;

struct TestRoot(PathBuf);

static NEXT_TEST_ROOT: AtomicU64 = AtomicU64::new(0);

impl TestRoot {
    fn create() -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "fylo-engine-read-only-{}-{nonce}-{}",
            std::process::id(),
            NEXT_TEST_ROOT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(path.join(".collections/users/docs/4V")).unwrap();
        fs::create_dir_all(path.join(".collections/users/.deleted/4V")).unwrap();
        fs::create_dir_all(path.join(".collections/users/index")).unwrap();
        fs::write(
            path.join(".collections/users/docs/4V/4VRNF52JPCO.json"),
            br#"{"name":"Ada","score":42}"#,
        )
        .unwrap();
        fs::write(
            path.join(".collections/users/.deleted/4V/4VRNF52JPCO.json"),
            br#"{"name":"Ada","score":41}"#,
        )
        .unwrap();
        fs::write(
            path.join(".collections/users/index/keys.snapshot"),
            b"name/eq/Ada/4VRNF52JPCO\n",
        )
        .unwrap();
        Self(path)
    }
}

impl Drop for TestRoot {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn gets_inspects_and_scans_without_mutating_the_root() {
    let fixture = TestRoot::create();
    let before = snapshot_tree(&fixture.0);
    let engine = ReadOnlyEngine::open(&fixture.0).unwrap();
    let record = engine.get("users", "4VRNF52JPCO").unwrap();
    assert_eq!(record.metadata.id, "4VRNF52JPCO");
    assert_eq!(
        engine
            .scan_index(
                "users",
                &[ScanQuery {
                    prefix: "name/eq/Ada/".into(),
                    range: None,
                }],
            )
            .unwrap(),
        ["4VRNF52JPCO"]
    );
    let inspection = engine.inspect("users").unwrap();
    assert_eq!(inspection.document_count, 1);
    assert_eq!(inspection.deleted_count, 1);
    let deleted = engine.get_deleted("users", "4VRNF52JPCO").unwrap();
    assert_eq!(deleted.document.fields()["score"], 41);
    assert_eq!(deleted.id, "4VRNF52JPCO");
    assert_eq!(snapshot_tree(&fixture.0), before);
}

#[test]
fn refuses_to_read_an_in_progress_generation() {
    let fixture = TestRoot::create();
    let state = fixture
        .0
        .join(".fylo-transactions/.collections/users/state.json");
    fs::create_dir_all(state.parent().unwrap()).unwrap();
    fs::write(
        state,
        br#"{"format":"fylo.collection-generation.v1","generation":1,"state":"writing","transactionId":"tx"}"#,
    )
    .unwrap();
    let error = ReadOnlyEngine::open(&fixture.0)
        .unwrap()
        .get("users", "4VRNF52JPCO")
        .unwrap_err();
    assert_eq!(error.code(), EngineErrorCode::ConcurrentWrite);
}

#[test]
fn fails_closed_on_ciphertext_without_a_schema_root() {
    let fixture = TestRoot::create();
    fs::write(
        fixture
            .0
            .join(".collections/users/docs/4V/4VRNF52JPCO.json"),
        br#"{"secret":"v2.ciphertext-must-not-escape"}"#,
    )
    .unwrap();
    let error = ReadOnlyEngine::open(&fixture.0)
        .unwrap()
        .get("users", "4VRNF52JPCO")
        .unwrap_err();
    assert_eq!(error.code(), EngineErrorCode::Encryption);
    assert!(!error.to_string().contains("v2."));
}

fn snapshot_tree(root: &std::path::Path) -> Vec<(PathBuf, u64)> {
    fn walk(root: &std::path::Path, current: &std::path::Path, output: &mut Vec<(PathBuf, u64)>) {
        let mut entries: Vec<_> = fs::read_dir(current).unwrap().map(Result::unwrap).collect();
        entries.sort_by_key(fs::DirEntry::file_name);
        for entry in entries {
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path).unwrap();
            output.push((path.strip_prefix(root).unwrap().to_owned(), metadata.len()));
            if metadata.is_dir() {
                walk(root, &path, output);
            }
        }
    }
    let mut output = Vec::new();
    walk(root, root, &mut output);
    output
}
