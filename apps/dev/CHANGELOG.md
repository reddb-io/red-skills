# @reddb-io/dev

## 2.84.1

### Patch Changes

- c86e487: Claim explicitly dispatched issues before shared boot hygiene, expose booting workers in vitals, and serialize validation gates host-wide.
  - @reddb-io/shared@2.84.1
  - @reddb-io/build-info@2.84.1

## 2.84.0

### Patch Changes

- @reddb-io/shared@2.84.0
- @reddb-io/build-info@2.84.0

## 2.83.0

### Patch Changes

- @reddb-io/shared@2.83.0
- @reddb-io/build-info@2.83.0

## 2.82.0

### Patch Changes

- @reddb-io/shared@2.82.0
- @reddb-io/build-info@2.82.0

## 2.81.0

### Minor Changes

- b668e65: Attempts now keep their base fresh instead of letting drift accumulate until
  landing pays for it. A notes-loop attempt merges `origin/<trunk>` into its
  working branch at every iteration boundary (`afk.notes_loop.trunk_sync`, on by
  default): uncommitted work is never merged over, and a conflicting merge is
  aborted and handed to the inner agent as its first instruction in the next
  iteration. Landing gained the companion refusal — measured after the squash, a
  branch more than 40 commits ahead of a base more than 12h stale parks with the
  guard's own actionable reason instead of grinding a rebase that cannot
  converge. (#2481)

### Patch Changes

- e7ef0d0: Rename the dev plugin's MCP servers to colon-free names: `dev:afk` → `castle` and
  `code-nav` → `navigator`. Codex rejects `:` in MCP server names, which broke every
  `dev:*` form. The AFK launcher is now `plugins/dev/hooks/castle-mcp.sh`, the bundle
  is `castle-mcp.bundle.min.mjs`, and the npm bin is `red-skills-castle-mcp`. Pure
  rename, zero behavior change; takes effect on the next plugin update.
  - @reddb-io/shared@2.81.0
  - @reddb-io/build-info@2.81.0

## 2.80.0

### Minor Changes

- 70b50c3: Landing squashes a worker branch's own micro-history to one commit at its fork
  point before the pre-merge rebase, so a 60-commit retry chain presents ONE
  consolidated conflict set instead of replaying every continuous-push commit
  sequentially onto fresh trunk. Branch adoption (re-claim resume) now opens with
  a mandatory base sync instruction — fetch + rebase onto origin/<base>, resolving
  conflicts while the agent is present and drift is smallest. (#2481)

### Patch Changes

- 7ae5d01: Skill docs now teach the npx direct-run form (`npx -y -p @reddb-io/red-skills@<version>
red-skills-dev ...`) as the canonical invocation everywhere; a bare `red-skills-dev`
  shim is demoted to a warm-cache optimization. Field installs without the shim
  followed the old docs into command-not-found failures.
  - @reddb-io/shared@2.80.0
  - @reddb-io/build-info@2.80.0

## 2.79.1

### Patch Changes

- 46aed06: Ship the changesets-flow reliability tail that landed after the v2.79.0 npm
  publish was cut from the pre-migration branch: ordered publish retries with
  tail reconciliation, CI running on the `changeset-release/main` branch, the
  bypass-credential check scoped to the release flow, and the release/README
  documentation for the Version Packages PR + tag-triggered `red-publish` flow
  (ADR 0121). This cut also re-aligns the published npm content with `main`,
  which the transitional v2.79.0 tarball predates.
  - @reddb-io/shared@2.79.1
  - @reddb-io/build-info@2.79.1

## 2.79.0

### Minor Changes

- 31b4f21: Releases now flow through a changesets Version Packages PR and a tag-triggered
  publish workflow (ADR 0121). The version bump lands as a normal reviewed PR
  instead of being pushed straight to protected `main`, which retires the
  `RED_RELEASE_TOKEN` admin bypass, the GH006 side-branch fallback,
  `release-push-bump.sh`, and the conventional-commit bump decider.

### Patch Changes

- @reddb-io/shared@2.79.0
- @reddb-io/build-info@2.79.0
