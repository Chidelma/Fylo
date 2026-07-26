//! FYLO engine orchestration.
//!
//! The current vertical slice is deliberately read-only. It combines native
//! storage discovery with the portable format and query kernels and verifies a
//! stable collection generation around every logical read.

use std::fmt;
use std::path::Path;

use fylo_format::{CanonicalMetadata, Document, DocumentLimits, FormatError, decode_ttid};
use fylo_query::{QueryError, QueryLimits, ScanQuery};
use fylo_storage_native::{
    CollectionKind, GenerationStatus, NativeCollection, NativeRoot, NativeStorageError,
};
use serde::Serialize;

const MAX_STABLE_READ_ATTEMPTS: usize = 3;

/// Read-only native FYLO engine.
#[derive(Clone, Debug)]
pub struct ReadOnlyEngine {
    root: NativeRoot,
}

impl ReadOnlyEngine {
    /// Open an existing FYLO root without modifying it.
    ///
    /// # Errors
    ///
    /// Returns an error when the root cannot be opened safely.
    pub fn open(path: impl AsRef<Path>) -> Result<Self, EngineError> {
        Ok(Self {
            root: NativeRoot::open(path).map_err(EngineError::storage)?,
        })
    }

    /// Canonical root identity.
    #[must_use]
    pub fn root_path(&self) -> &Path {
        self.root.path()
    }

    /// Read and validate one JSON document with canonical metadata.
    ///
    /// # Errors
    ///
    /// Returns a stable error for unsafe storage, corrupt documents, invalid
    /// identifiers, or concurrent write generations.
    pub fn get(&self, collection: &str, identifier: &str) -> Result<ReadDocument, EngineError> {
        let collection = self
            .root
            .collection(collection)
            .map_err(EngineError::storage)?;
        Self::read_stable(&collection, || {
            let stored = collection
                .read_document(identifier)
                .map_err(EngineError::storage)?;
            let document = Document::parse(&stored.bytes, DocumentLimits::default())
                .map_err(EngineError::format)?;
            let timestamps = decode_ttid(identifier).map_err(EngineError::format)?;
            Ok(ReadDocument {
                metadata: CanonicalMetadata {
                    id: identifier.to_owned(),
                    created_at: timestamps.created_at,
                    updated_at: stored.modified_millis,
                    mtime: stored.modified_millis,
                },
                document,
            })
        })
    }

    /// Execute one portable prefix-index scan under a stable generation.
    ///
    /// # Errors
    ///
    /// Returns a stable error for unsafe/corrupt storage, invalid queries, or a
    /// concurrent write generation.
    pub fn scan_index(
        &self,
        collection: &str,
        queries: &[ScanQuery],
    ) -> Result<Vec<String>, EngineError> {
        let collection = self
            .root
            .collection(collection)
            .map_err(EngineError::storage)?;
        Self::read_stable(&collection, || {
            collection
                .index_snapshot()
                .map_err(EngineError::storage)?
                .scan(queries, QueryLimits::default())
                .map_err(EngineError::query)?
                .into_iter()
                .map(|identifier| {
                    String::from_utf8(identifier).map_err(|error| {
                        EngineError::new(
                            EngineErrorCode::CorruptData,
                            format!("index document identifier is not UTF-8: {error}"),
                        )
                    })
                })
                .collect()
        })
    }

    /// Inspect one collection without changing any files.
    ///
    /// # Errors
    ///
    /// Returns a stable error for unsafe, corrupt, missing, or concurrently
    /// mutating storage.
    pub fn inspect(&self, collection: &str) -> Result<CollectionInspection, EngineError> {
        let collection = self
            .root
            .collection(collection)
            .map_err(EngineError::storage)?;
        Self::read_stable(&collection, || {
            let generation = collection.generation().map_err(EngineError::storage)?;
            let document_count = if collection.kind() == CollectionKind::Document {
                collection
                    .document_ids()
                    .map_err(EngineError::storage)?
                    .len()
            } else {
                0
            };
            let index_bytes = collection
                .index_snapshot()
                .map_err(EngineError::storage)?
                .as_bytes()
                .len();
            Ok(CollectionInspection {
                collection: collection.name().to_owned(),
                kind: collection.kind(),
                generation: generation.generation,
                state: generation.state,
                document_count,
                index_bytes,
                read_only: true,
            })
        })
    }

    fn read_stable<T>(
        collection: &NativeCollection,
        read: impl Fn() -> Result<T, EngineError>,
    ) -> Result<T, EngineError> {
        for _ in 0..MAX_STABLE_READ_ATTEMPTS {
            let before = collection.generation().map_err(EngineError::storage)?;
            if before.state == GenerationStatus::Writing {
                continue;
            }
            let value = read()?;
            let after = collection.generation().map_err(EngineError::storage)?;
            if after.state == GenerationStatus::Stable && after.generation == before.generation {
                return Ok(value);
            }
        }
        Err(EngineError::new(
            EngineErrorCode::ConcurrentWrite,
            "collection changed during a read-only operation",
        ))
    }
}

/// Validated document plus canonical storage metadata.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadDocument {
    /// Canonical metadata.
    pub metadata: CanonicalMetadata,
    /// Stored JSON document.
    pub document: Document,
}

/// Read-only collection inspection result.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionInspection {
    /// Collection name.
    pub collection: String,
    /// Document or file collection.
    pub kind: CollectionKind,
    /// Stable transaction generation.
    pub generation: u64,
    /// Stable/writing state observed by the reader.
    pub state: GenerationStatus,
    /// Validated live JSON document count.
    pub document_count: usize,
    /// Immutable index snapshot bytes, or zero when absent.
    pub index_bytes: usize,
    /// Always true for this preview engine.
    pub read_only: bool,
}

/// Stable read-only engine error codes.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EngineErrorCode {
    /// Native storage rejected the operation.
    Storage,
    /// Portable format validation failed.
    Format,
    /// Portable query validation/execution failed.
    Query,
    /// Index or identifier data was corrupt.
    CorruptData,
    /// A writer prevented a stable generation read.
    ConcurrentWrite,
}

impl EngineErrorCode {
    /// Stable external string.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Storage => "EENGINE_STORAGE",
            Self::Format => "EENGINE_FORMAT",
            Self::Query => "EENGINE_QUERY",
            Self::CorruptData => "EENGINE_CORRUPT",
            Self::ConcurrentWrite => "EENGINE_CONCURRENT_WRITE",
        }
    }
}

/// Read-only engine error.
#[derive(Debug)]
pub struct EngineError {
    code: EngineErrorCode,
    message: String,
    source: Option<Box<dyn std::error::Error + Send + Sync>>,
}

impl EngineError {
    fn new(code: EngineErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            source: None,
        }
    }

    fn storage(error: NativeStorageError) -> Self {
        Self {
            code: EngineErrorCode::Storage,
            message: error.to_string(),
            source: Some(Box::new(error)),
        }
    }

    fn format(error: FormatError) -> Self {
        Self {
            code: EngineErrorCode::Format,
            message: error.to_string(),
            source: Some(Box::new(error)),
        }
    }

    fn query(error: QueryError) -> Self {
        Self {
            code: EngineErrorCode::Query,
            message: error.to_string(),
            source: Some(Box::new(error)),
        }
    }

    /// Stable error code.
    #[must_use]
    pub const fn code(&self) -> EngineErrorCode {
        self.code
    }
}

impl fmt::Display for EngineError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.code.as_str(), self.message)
    }
}

impl std::error::Error for EngineError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.source
            .as_ref()
            .map(|error| error.as_ref() as &(dyn std::error::Error + 'static))
    }
}
