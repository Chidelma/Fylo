# Rust Native Qualification Matrix

This matrix records evidence required before a platform label can move from
buildable to preview or supported. A configured CI job is not evidence until
it completes against the exact commit/artifact.

| Surface                                         | Linux x86_64       | macOS arm64        | Windows x86_64             | Required gate                         |
| ----------------------------------------------- | ------------------ | ------------------ | -------------------------- | ------------------------------------- |
| Portable format/query corpus                    | Native CI          | Native CI          | Native CI                  | Rust contract and fixture corpus      |
| Native storage and engine                       | Native CI          | Native CI          | Server 2022 + 2025 CI      | Unit, negative, path, and permissions |
| Link/reparse/identity/case/Unicode/long path    | Native CI          | Native CI          | Native NTFS CI             | Platform-specific adversarial tests   |
| Raw-file/custom metadata/permissions/encryption | Native CI          | Native CI          | Native NTFS CI             | Storage and machine corpus            |
| Native writes/recovery                          | Failpoint matrix   | Failpoint matrix   | Failpoint matrix           | Abort, ENOSPC, and EDQUOT recovery     |
| Exact executable identity/root lease            | Candidate artifact | Candidate artifact | Candidate artifact         | Embedded identity and exclusive lease |
| Machine protocol/direct CLI                     | Native CI          | Native CI          | Native CI                  | Versioned protocol and CLI corpus      |
| Language clients                                | Release/interop CI | Release/interop CI | Runtime-dependent coverage | Published nine-client corpus           |

The native matrix runs format, read, write/recovery, protocol, CLI, exact-binary,
soak, and candidate-staging gates across the three operating systems. Results
belong in retained CI evidence. Cross-compilation alone never advances a support
label, and a local pass does not promote an operating system.
