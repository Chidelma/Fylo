# Web release and rollback

Fylo has two independently deployed web surfaces:

| Surface                     | Build output                      | Production target                            |
| --------------------------- | --------------------------------- | -------------------------------------------- |
| Marketing and documentation | `website/dist/web`                | Amplify app `FYLO`, `https://fylo.del.ma`    |
| Browser loader and engine   | `dist-web` plus `clients/browser` | GitHub Pages, `https://d31ma.github.io/FYLO` |

The GitHub release also publishes the Explorer build as
`fylo-explorer-<CalVer>.zip`. The archive is created from the contents of
`explorer/dist/web`, places `index.html` at the ZIP root, is included in
`SHA256SUMS`, and is verified before the draft release becomes public.
Developers can extract it at the root of any static HTTPS origin that preserves
the generated paths and MIME types. There is no managed FXP Amplify target.

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

- Bucket-level `s3:ListBucket` on `arn:aws:s3:::your-private-release-bucket`, with a
  `StringLike` `s3:prefix` condition limited to `fylo/web-releases/*`
- Object-level `s3:GetObject`, `s3:PutObject`, and `s3:DeleteObject` on
  `arn:aws:s3:::your-private-release-bucket/fylo/web-releases/*`
- `amplify:CreateDeployment`, `amplify:StartDeployment`, `amplify:GetJob`,
  `amplify:GetApp`, and `amplify:UpdateApp` for the FYLO app

For example, substitute the exact release bucket name in this IAM policy:

```json
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Action": "s3:ListBucket",
            "Resource": "arn:aws:s3:::your-private-release-bucket",
            "Condition": {
                "StringLike": {
                    "s3:prefix": "fylo/web-releases/*"
                }
            }
        },
        {
            "Effect": "Allow",
            "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
            "Resource": "arn:aws:s3:::your-private-release-bucket/fylo/web-releases/*"
        }
    ]
}
```

`HeadObject` uses `s3:GetObject` when the object exists, but the scoped `s3:ListBucket`
permission is also required for S3 to report an absent artifact as `404 Not Found` instead of
`403 Forbidden`. Without that distinction, the release command correctly treats the result as an
authorization failure and stops rather than assuming the artifact is missing.

Export the bucket name; AWS credentials and region continue to use the normal AWS CLI credential
chain. Never place credentials in the repository or command history.

The release host also needs rustup, Bun at the version in `.bun-version`, the verified `ty` binary,
a current AWS CLI, and `zip`. The CLI's S3 input skeletons must expose `IfMatch` and `IfNoneMatch`
for `put-object` and `IfMatch` for `delete-object`; older builds such as AWS CLI 2.11.26 cannot
provide the required atomicity and the release command refuses to deploy with them. Install the
repository-pinned web compiler with
`sh ./scripts/install-vendor-bins.sh`, authenticate the AWS
CLI before starting and confirm it is using the intended account and region.

```sh
export FYLO_WEB_RELEASE_BUCKET=your-private-release-bucket
```

The non-secret app ID, branch, source directory, origin, header-policy path, and health probes live
in `ops/web-release.json`. Changes to the domain or Amplify app must update that file in the same
pull request.

The release command serializes production changes in
`fylo/web-releases/fylo/state/current.json`. During a release, one conditional write temporarily
adds a 75-minute `preparing` lease to the existing state; refresh, successful replacement, and
failure cleanup all require the exact ETag returned by the preceding write. Immediately before
each Amplify `StartDeployment`, the lease is conditionally refreshed and changed to (or preserved
as) `mutating`; it is refreshed again before the state commit. Successful completion atomically
replaces the leased object with the new flat state, while a safely compensated failure restores the
prior flat state (or conditionally deletes the first-deploy lease). A stale or concurrent writer
therefore cannot overwrite `current.json`.

An expired `preparing` lease may be conditionally replaced. A `mutating` lease is a durable
production fence and is never auto-stolen, even after its recorded expiry, because a crashed
process may have changed Amplify without committing state. Never delete or edit this object
manually to force a release through. If an embedded `mutating` lease remains, stop deployment,
compare the live Amplify job/content with the recorded current and previous checksums, preserve the
object and its version history for the incident record, and have a second operator review recovery
before using the break-glass role.

## Amplify response-header policy

`ops/web-release.json` currently selects the checked-in transitional policy
`ops/fylo-amplify-custom-headers-transition-v1.yml`. It applies HSTS, MIME sniffing protection, a
restrictive referrer and permissions policy, and a hash-only CSP that works with both the two
verified legacy rollback artifacts and the newly generated Tachyon pages. It permits no
`unsafe-inline`. It temporarily permits `unsafe-eval` because both immutable legacy archives use
`AsyncFunction` and one uses direct `eval`; script hashes cannot authorize either form of dynamic
compilation. This exception is limited to the rollback migration window. The narrower final policy
permits no `unsafe-eval` and remains checked in as
`ops/fylo-amplify-custom-headers-v1.yml`; do not select or apply it during the transition.

The global `Cache-Control: no-cache, must-revalidate` rule prevents the HTML entry points,
installers, service worker, and stable runtime JavaScript paths from remaining fresh across a
deployment. The fail-closed website post-build patch also makes every same-origin service-worker
request network-first, with the current versioned cache used only as an offline fallback. This
prevents an already controlling worker from mixing stale JavaScript with new HTML while preserving
loopback unregistration, live-reload bypass, and activation-time cleanup of old versioned caches.
Do not add a long-lived shared-cache directive to those stable URLs. Immutable, content-addressed
assets may receive a narrower cache rule in a future policy version after their paths and smoke
coverage are explicit.

Apply the policy selected by `headersPolicy` to Amplify before deploying the site. `customHeaders`
is app configuration, so it is not carried inside the deployment ZIP:

```sh
FYLO_AMPLIFY_APP_ID=$(bun -e \
  'const c = await Bun.file("ops/web-release.json").json(); console.log(c.sites.fylo.appId)')
FYLO_AMPLIFY_HEADERS_POLICY=$(bun -e \
  'const c = await Bun.file("ops/web-release.json").json(); console.log(c.sites.fylo.headersPolicy)')
aws amplify update-app \
  --app-id "$FYLO_AMPLIFY_APP_ID" \
  --custom-headers "$(cat "$FYLO_AMPLIFY_HEADERS_POLICY")"
aws amplify get-app \
  --app-id "$FYLO_AMPLIFY_APP_ID" \
  --query 'app.customHeaders' \
  --output text
```

Compare the returned value with the selected checked-in file before continuing. The post-deploy
smoke test then requires every configured route and asset to return the exact security and cache
headers. The release command also reads `app.customHeaders` and compares it byte-for-byte with the
selected policy before it acquires the release lease, creates an artifact, or requests an Amplify
upload. Missing policy, AWS errors, invalid responses, or drift all fail closed without changing
release state.

The release state stores a checksum-bound probe and header contract for the current and previous
artifacts. An automatic or manual rollback therefore validates the archived artifact's own routes
and assets instead of applying the new layout to legacy files. Contract-specific headers may only
add checks: the active security and cache headers from `ops/web-release.json` always win, so an old
contract cannot relax them. The two verified legacy checksums
`0c14fea889d6ff7b69b75c40b506b92247353ec34d938c4221b93a3c7cd6aa6c` and
`16e24d877d60e40aa88f1611492d8abd42174ea7b669f482e0977dcf22554736` are seeded in the config so
the first new deployment and its rollback are safe. Any other archived checksum without a
persisted or configured contract fails closed.

Each legacy contract also records its required `script-src` token. Before an archived deployment
begins, the release command verifies that the active policy contains exactly one non-empty
`script-src` directive and that the token is present in that directive. A token misplaced under
`style-src` or another directive does not count. This prevents a future strict policy from
deploying an older evaluator-dependent artifact and only discovering the incompatibility after
production has changed.

Promote to the final policy only after `state/current.json` records both `checksum` and
`previousChecksum` as artifacts whose inline HTML is compatible with
`ops/fylo-amplify-custom-headers-v1.yml`. In practice, the first successful new deployment still
keeps a legacy artifact as `previousChecksum`, so a second distinct final-compatible artifact must
be deployed successfully first. Then, in one reviewed change, point `headersPolicy` to
`finalHeadersPolicy`, replace the configured `content-security-policy` required-header value with
the final policy value, apply that final policy with `update-app`, verify `get-app`, and run the
production smoke test. Do not promote solely because the current checksum is compatible; doing so
would break the recorded rollback target. Removing `unsafe-eval` at this promotion is mandatory;
it must never be added to the final policy.

## Amplify deployment

Install the root dependencies plus the verified toolchain, then build and validate the website
before deployment. The website has no npm dependency or lockfile:

```sh
sh ./scripts/install-vendor-bins.sh
export PATH="$HOME/.local/bin:$PATH"
(cd website && bun install --frozen-lockfile && bun run bundle)
bun test tests/interop/web-release-ops.test.js \
  --timeout 120000 --parallel=1
bun scripts/amplify-release.mjs deploy fylo
```

After the command, confirm its JSON result records the expected site and checksum. The command
waits up to 30 minutes for Amplify and checks the production origin with cache bypass headers. If
there is a recorded current release, its archived ZIP is downloaded, checksum-verified, and
validated against its contract before any Amplify mutation. Deployment, production smoke, and the
conditional state commit then run as one compensated transition. If target deployment, smoke, or a
known-uncommitted state write fails, the command redeploys and smokes that already verified local
fallback before exiting unsuccessfully.

The presigned artifact upload and every AWS CLI subprocess have hard timeouts. A timeout before
`StartDeployment` is a preparation failure and releases the owned lease normally. Once the start
request may have reached Amplify, failures retain the `mutating` fence unless the prior artifact is
successfully redeployed and verified.

An ambiguous state-write response is read back before compensation. If the exact intended flat
state is present, the release is treated as committed. If the exact owned lease and prior state are
still present, compensation is safe. An unreadable, unexpected, or concurrently owned state stops
without another production mutation and reports a manual-reconciliation incident. On a first
deployment there is no prior artifact to restore; any failure after an Amplify mutation may have
begun is reported as a distinct incident and must be reconciled before another release.

For an independent health check:

```sh
bun scripts/web-smoke.mjs fylo
```

## Amplify rollback

Rollback never rebuilds source. It deploys the archived checksum recorded as
`previousChecksum`, verifies the downloaded ZIP checksum, waits for Amplify, runs that checksum's
persisted probe/header contract plus the invariant active security headers, and atomically swaps
the current and previous checksums and their contracts so the rollback itself can be reversed. It
also downloads and verifies the current artifact before mutation; if target smoke or the state
swap fails safely, that local artifact is redeployed and verified as compensation.

```sh
bun scripts/amplify-release.mjs rollback fylo
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
