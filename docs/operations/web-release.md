# Web release and rollback

Fylo has three independently deployed web surfaces:

| Surface                     | Build output                      | Production target                            |
| --------------------------- | --------------------------------- | -------------------------------------------- |
| Marketing and documentation | `website/dist/web`                | Amplify app `FYLO`, `https://fylo.del.ma`    |
| Explorer                    | `explorer/dist/web`               | Amplify app `FXP`, `https://fx.del.ma`       |
| Browser loader and engine   | `dist-web` plus `clients/browser` | GitHub Pages, `https://d31ma.github.io/FYLO` |

The GitHub release also publishes the Explorer build as
`fylo-explorer-<CalVer>.zip`. The archive is created from the contents of
`explorer/dist/web`, places `index.html` at the ZIP root, is included in
`SHA256SUMS`, and is verified before the draft release becomes public.
Developers can extract it at the root of any static HTTPS origin that preserves
the generated paths and MIME types.

Do not upload a mutable `dist/web` directory directly. The Amplify release command normalizes
file modes and timestamps, creates a deterministic ZIP, names it by its SHA-256 checksum, and
archives it before deployment. A deployment is recorded as current only after Amplify succeeds
and every configured production probe passes. These probes fetch the HTML routes plus required
CSS, JavaScript, Tachyon component, web-component, worker, and Wasm files. Each asset must return
the configured media type and content or binary marker, so an SPA fallback or stripped static
directory triggers automatic rollback instead of being promoted as current.

Web builds are reproducible only with the repository-pinned toolchains: Bun is read from
`.bun-version` (and mirrored by each `packageManager` field), Rust and the Wasm target are read from
`rust-toolchain.toml`, and the Rust-native TACHYON `ty` binary is pinned to v26.33.01 with a
repository-anchored SHA-256 digest in `scripts/install-vendor-bins.sh` and its PowerShell peer.
`build-browser.mjs` rejects a different Bun version, installs the exact Rust toolchain through
rustup, and builds the locked Cargo dependency graph. The marketing/docs site uses the verified
`ty` asset. Its bundle step then applies the fail-closed, v26.33.01-specific
`scripts/patch-tachyon-runtime.mjs` ownership guard to generated nested-island expressions and
injects the shared browser entry once per HTML route. The patch refuses an unfamiliar runtime;
remove it when the pinned compiler contains the upstream fix. Explorer remains on its
commit-pinned compatibility compiler because its dynamic structural templates and component
pub/sub are outside the 26.33.01 Rust compiler contract.

## One-time AWS setup

Create a private, versioned S3 bucket for release artifacts. Block all public access and enable
default encryption. Grant the release operator only these capabilities:

- `s3:GetObject` and `s3:PutObject` under `fylo/web-releases/` (S3 `HeadObject`
  authorization is covered by `s3:GetObject`)
- `amplify:CreateDeployment`, `amplify:StartDeployment`, and `amplify:GetJob` for the FYLO and FXP apps

Export the bucket name; AWS credentials and region continue to use the normal AWS CLI credential
chain. Never place credentials in the repository or command history.

The release host also needs rustup, Bun at the version in `.bun-version`, the verified `ty` binary,
the AWS CLI, and `zip`. Install the repository-pinned web compiler with
`sh ./scripts/install-vendor-bins.sh`, authenticate the AWS
CLI before starting and confirm it is using the intended account and region.

```sh
export FYLO_WEB_RELEASE_BUCKET=your-private-release-bucket
```

The non-secret app IDs, branches, source directories, origins, and health probes live in
`ops/web-release.json`. Changes to domains or Amplify apps must update that file in the same pull
request.

## Amplify deployment

Install the root and Explorer dependencies plus the verified toolchain, then build and validate
both applications before deployment. The website has no npm dependency or lockfile; Explorer keeps
its compatibility compiler in a frozen lockfile:

```sh
sh ./scripts/install-vendor-bins.sh
export PATH="$HOME/.local/bin:$PATH"
(cd website && bun install --frozen-lockfile && bun run bundle)
(cd explorer && bun install --frozen-lockfile && bun run bundle)
bun test tests/interop/explorer-standalone-app.test.js tests/interop/web-release-ops.test.js \
  --timeout 120000 --parallel=1
bun scripts/amplify-release.mjs deploy fylo
bun scripts/amplify-release.mjs deploy fxp
```

Deploy one surface at a time. After each command, confirm its JSON result records the expected
site and checksum. The command waits up to 30 minutes for Amplify and checks the production
origin with cache bypass headers. If deployment or smoke verification fails, it restores the
last recorded successful artifact automatically and exits unsuccessfully. Investigate before
continuing to the other surface.

For an independent health check:

```sh
bun scripts/web-smoke.mjs fylo
bun scripts/web-smoke.mjs fxp
```

## Amplify rollback

Rollback never rebuilds source. It deploys the archived checksum recorded as
`previousChecksum`, verifies the downloaded ZIP checksum, waits for Amplify,
runs the same production probes, and atomically swaps the current and previous
checksums so the rollback itself can be reversed.

```sh
bun scripts/amplify-release.mjs rollback fylo
bun scripts/amplify-release.mjs rollback fxp
```

If the command reports that no prior artifact exists, stop. Do not manufacture state files or
upload an unverified ZIP. Recover the desired checksum from S3 version history, verify it out of
band, and have a second operator review the recovery. Access to version history is a break-glass
role and additionally requires `s3:ListBucketVersions` and `s3:GetObjectVersion`; the normal
release role does not need them.

## GitHub Pages verification

The Pages workflow runs only after a successful Release workflow whose `v<version>` tag identifies
the same commit. It publishes immutable paths such as `version/26.30.03/` and a mutable
`version/latest/`. Its post-deploy step downloads the loader, engine, shared and dedicated workers,
Wasm module, and `SHA256SUMS`, then verifies every file by checksum and compares `latest`
byte-for-byte with the immutable version:

```sh
bun scripts/pages-smoke.mjs 26.30.03
```

Use the pinned URL in documentation and production integrations. `latest` is a convenience URL,
not a rollback boundary.

## GitHub Pages rollback

The `gh-pages` branch is the durable publication history. To roll back, identify the last known
good `gh-pages` commit, create a new revert commit (do not force-push or reset the branch), and
push that revert:

```sh
git fetch origin gh-pages
git log --oneline origin/gh-pages
git switch -c pages-rollback origin/gh-pages
git revert <bad-gh-pages-commit>
git push origin HEAD:gh-pages
```

Then run the repository's Pages deployment for the restored branch content and verify the pinned
version with `pages-smoke.mjs`. Immutable version directories must never be overwritten with
different bytes. If a released version is bad, restore `latest` to a known-good publication and
ship a new package version for the correction.
