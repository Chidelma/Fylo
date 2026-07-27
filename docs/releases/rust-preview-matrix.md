# Rust Preview Qualification Matrix

This matrix records evidence required before a platform label can move from
buildable to preview or supported. A configured CI job is not evidence until
it completes against the exact commit/artifact.

| Surface                                         | Linux x86_64    | macOS arm64                          | Windows x86_64                                | Current label |
| ----------------------------------------------- | --------------- | ------------------------------------ | --------------------------------------------- | ------------- |
| Portable format/query corpus                    | CI required     | Local pass + CI required             | CI required                                   | Buildable     |
| Native read-only unit tests                     | CI required     | Local pass + CI required             | CI required                                   | Buildable     |
| JavaScript-root differential read               | CI required     | Unicode/long-path local pass + CI    | Unicode/long-path CI required                 | Buildable     |
| Link/reparse/identity/case/Unicode/long path    | CI required     | Link replacement/exact-case/Unicode/long-path local pass | Handle identity + junction + exact-case tests configured; CI required | Unqualified   |
| Raw-file/custom metadata/permissions/encryption | CI required     | Permission denial + metadata/encryption local pass | ADS/metadata/encryption CI required           | Buildable     |
| Native writes/recovery                          | Not implemented | Not implemented                      | Not implemented                               | Unsupported   |

The `native-read-only` matrix runs on all three operating systems. Results
belong in retained CI evidence and this document is updated only after the
required commit passes. Cross-compilation alone never advances a support label.
