# Filesystem Snapshot and Restore

FYLO is filesystem-only (ADR 0007). Disaster recovery copies a quiesced root
with a platform tool that preserves file bytes, directory structure, ownership,
permissions, timestamps, extended attributes, and NTFS alternate data streams.
Object-storage and cloud-drive synchronization are not FYLO transaction or
restore protocols.

## Snapshot

1. Stop every process that can open the root for writes. Do not snapshot a
   live root merely because its document files look idle.
2. Record the FYLO binary identity, source path, filesystem type, snapshot tool
   and version, wall-clock time, and the root's byte count.
3. Copy the entire root, including `.fylo-catalog`, `.fylo-transactions`,
   `.fylo-vcs`, `.collections`, and `.buckets`. Do not copy only documents.
4. Preserve native metadata. Suitable qualified profiles are:
   - Linux: `rsync -aHAX --numeric-ids` on a local filesystem;
   - macOS: an APFS snapshot/clone or `ditto` with resource forks, ACLs, and
     extended attributes preserved;
   - Windows: VSS or `robocopy /COPYALL /DCOPY:DAT /XJ` between NTFS volumes.
5. Generate a read-only inventory of relative paths, types, sizes, content
   hashes, and supported native metadata. Retain it beside the snapshot.
6. Reopen the source with the same binary only after the copy and inventory
   have completed.

Network shares and synchronized folders are not qualified by these profiles.
Copy tools must be tested on the actual source and destination filesystems;
their flags do not prove that a provider preserves xattrs or ADS.

## Restore drill

1. Choose a new, empty local path. Never restore over the source root.
2. Restore the complete snapshot with the corresponding metadata-preserving
   profile.
3. Compare the restored inventory with the retained snapshot inventory before
   opening FYLO.
4. Open the restored root exclusively. Startup recovery may complete a journal
   captured at a documented durable boundary; repeat the open to prove recovery
   is idempotent.
5. Verify every collection index against its documents, rebuild derived indexes
   when required, and verify the reachable version history and object hashes.
6. Run the representative non-empty query and permission corpus. Encryption
   keys remain outside the snapshot and must be supplied through the normal
   secret boundary.
7. Record elapsed restore time, recovered bytes, verification results, binary
   identity, filesystem, and any metadata that the platform cannot preserve.

A restore is accepted only when integrity and query-equivalence checks pass.
Failure leaves both source and failed restore intact for investigation; retry
into another empty path.

## Release evidence

Production promotion requires retained Linux, macOS, and Windows drill reports
for the exact candidate artifact and qualified filesystem. A local successful
copy documents implementation readiness but does not promote a support tier.
