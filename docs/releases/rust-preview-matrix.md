# Rust Preview Qualification Matrix

This matrix records evidence required before a platform label can move from
buildable to preview or supported. A configured CI job is not evidence until
it completes against the exact commit/artifact.

| Surface                                         | Linux x86_64     | macOS arm64              | Windows x86_64   | Current label |
| ----------------------------------------------- | ---------------- | ------------------------ | ---------------- | ------------- |
| Portable format/query corpus                    | CI required      | Local pass + CI required | CI required      | Buildable     |
| Native read-only unit tests                     | CI required      | Local pass + CI required | CI required      | Buildable     |
| JavaScript-root differential read               | CI required      | Local pass + CI required | CI required      | Buildable     |
| Symlink/reparse/case/Unicode/long path          | Partial          | Symlink pass             | Not yet complete | Unqualified   |
| Raw-file/custom metadata/permissions/encryption | Not yet complete | Not yet complete         | Not yet complete | Unsupported   |
| Native writes/recovery                          | Not implemented  | Not implemented          | Not implemented  | Unsupported   |

The `native-read-only` matrix runs on all three operating systems. Results
belong in retained CI evidence and this document is updated only after the
required commit passes. Cross-compilation alone never advances a support label.
