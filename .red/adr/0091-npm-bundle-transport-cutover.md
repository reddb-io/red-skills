# npm is the only client transport for plugin bundles (v2 cutover)

## Status

Accepted. Implements issue #1200. Amends **ADR 0038** (version-pinned launcher)
and **ADR 0084** (in-range self-update). Supersedes the GitHub-release +
hand-rolled sigstore delivery introduced by **ADR 0034** for the client fetch
path.

## Context

Since v1.279.0 the plugin-bundle delivery channel has been broken end to end:

1. **Manifest signature verification failed for 100% of releases.** The release
   workflow signed the checksum manifest with `cosign sign-blob`, which emits the
   *legacy* cosign bundle format. The client verifier (`sigstore-js` `verify()`)
   only accepts the *new* bundle-spec format, so every verification threw
   `invalid bundle` and every fetch was rejected.
2. **Self-update polled a channel that never existed.** ADR 0084's in-range
   self-update read a floating major-line manifest at
   `releases/download/v1/…`. That `v1` release was never published, so the query
   was an eternal 404 ("cached bundle keeps serving").

There is **no working installed base to preserve** — the channel has been dead
since v1.279.0. So the right move is to *delete* the broken channel, not repair
it, and adopt a transport that gives integrity for free.

The sibling reddb repo already distributes over npm, fetching per-platform
**Rust** binaries in a postinstall step. Our plugin bundles are
**platform-independent JS** (~2 MB each) that fit inside a tarball, so we can go
further than reddb: ship the bundles *in the tarball itself* — atomic delivery,
registry shasum/provenance integrity, and **no postinstall download**.

## Decision

**npm is the ONLY client transport for plugin bundles.**

1. **Package.** A single public npm package `@reddb-io/red-skills`
   (`packaging/npm/`, outside the pnpm workspace globs to avoid a name collision)
   carries the built JS bundles under `dist/` plus three bin shims —
   `red-skills-dev`, `red-skills-memory`, `red-skills-brain` — that exec the
   corresponding packaged bundle. No postinstall step.
2. **Client resolution (amends ADR 0038).** The shared launcher
   (`packages/shared/bundle-fetch.ts` + `entrypoint-cli.ts`) resolves the exact
   pinned version via npm — `npm install @reddb-io/red-skills@<pin>` semantics,
   cache-first — and copies the packaged `dist/<plugin>.bundle.min.mjs` into the
   existing version-keyed cache. The GitHub-release download path and the
   client-side sigstore verification are **removed**. `canary` is the npm
   `canary` dist-tag. Integrity is npm's tarball shasum; the client verifies no
   signature.
3. **Self-update (amends ADR 0084).** Discovery queries the npm registry
   (`registry.npmjs.org/@reddb-io%2Fred-skills`) for the newest same-major
   version instead of the phantom `v1` release. The ADR 0084 atomic
   pointer-swap semantics are unchanged; nothing constructs a
   `releases/download/` URL.
4. **Release workflow.** `red-release.yml` stages the bundles into the package,
   `pnpm pack`s it, runs the **real packaged client against the packed tarball**
   (`--version` smoke) as a producer/consumer contract check, then does an
   `NPM_TOKEN`-guarded `pnpm publish --access public --no-git-checks` (a
   `::warning::` skip when the secret is absent; `--tag canary` for
   prereleases). Cosign install + manifest signing are removed. Bundle assets are
   still uploaded to the GitHub Release as an **inert backup** the client never
   reads.
5. **Version.** Versioning stays on the **1.x line** — the release auto-bump
   owns the version, and the npm package publishes at whatever version the
   release computes (maintainer decision on #1200: the transport cutover is
   architectural, not semver). No major bump is needed for safety: the old
   channel never verified a single release (there is no working installed base
   to fence off), and launchers are replaced wholesale by marketplace plugin
   updates, not by self-update across the transport break.

### Memory / Brain runtimes are deliberately NOT redesigned

The Memory and Brain runtimes carry a per-platform native `red` engine binary
that cannot live in a platform-independent tarball. Those runtimes keep shipping
their JS + native assets as pinned GitHub-release artifacts, resolved by their
own bootstraps. ADR 0091 only changes, for those launchers, what issue #1200
mandates for *every* client: the broken sigstore verification is removed, and
self-update *version discovery* moves to the npm registry (killing the phantom
`v1` channel). The runtime distribution itself is unchanged.

## Consequences

- The dead delivery channel is gone; a fresh install resolves a real, pinned,
  shasum-verified bundle on first run.
- One fewer bespoke security surface (no hand-rolled sigstore verify to keep in
  lockstep with a signing step).
- npm availability is now on the first-run critical path (mitigated by the
  cache-first behaviour and the inert GitHub-release backup).
- The deliberate divergence from reddb's postinstall-fetch pattern (their
  binaries are per-platform Rust; ours are platform-independent JS that fit in
  the tarball) is recorded in the PR body.
