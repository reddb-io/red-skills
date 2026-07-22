# Releases flow through a changesets Version Packages PR, and a tag triggers the publish

## Context

`red-release.yml` was a single run that did everything on every push to `main`:
parse conventional commits to decide a bump, build every bundle, publish to npm,
**push the version-bump commit straight to `main`**, then tag and cut the GitHub
Release.

That direct push is the load-bearing mistake. `main` carries classic branch
protection with `test` and `typecheck` as required status checks, and a commit
the release job just created can never carry those contexts at push time, so the
push is declined with `GH006`. Every mechanism we added afterwards existed only
to compensate for that one design choice:

- `RED_RELEASE_TOKEN` / `RELEASE_PAT` — a repo-admin bypass credential. Never
  provisioned, so the "fully automatic" path never actually ran.
- A GH006 fallback that parked the bump on `release/bump-vX.Y.Z`, opened a PR,
  and **returned success** — because npm was already published by then and
  failing would have left a half-cut release.
- `scripts/release-push-bump.sh`, a three-strategy rebase-and-retry helper.
- A contract self-test for that helper — which broke the release run on its
  first real execution (2026-07-21) on a latent `init.defaultBranch` bug in its
  own fixture. The compensating machinery became the outage.

Ordering was also fragile: npm publish happened *before* the bump commit
existed, so a failure anywhere after publish left the registry ahead of the
repo.

## Decision

**Split "decide the version" from "publish the version", and let a reviewed PR
be the only writer of `main`.**

1. **`red-release.yml` maintains a Version Packages PR.** On every push to
   `main`, `changesets/action` collects the pending changesets under
   `.changeset/` and opens/updates a `chore(release): version packages` PR. That
   PR passes branch protection exactly like a human PR — no bypass token, no
   fallback, no direct push. The bump is reviewable before it is real.

2. **The version script is `pnpm release:version`** = `changeset version` +
   `node scripts/sync-version.mjs`. Changesets owns the workspace packages in
   the `fixed` group; `sync-version.mjs` carries that number into everything
   outside the pnpm workspace — the root `package.json`, the Claude and Codex
   plugin manifests, and the Pi package manifests. This is ADR 0040's single
   writer, now fed by changesets instead of an inline `jq` loop.
   `pnpm version:sync:check` pins it on every PR.

3. **Merging the Version PR cuts the tag.** Main then has zero pending
   changesets and a version no tag points at; `red-release.yml` tags `vX.Y.Z`
   and hands off.

4. **`red-publish.yml` owns everything downstream of the tag** — bundles, npm
   publish, registry smoke, GitHub Release, and the moving major tag. It writes
   no version and pushes no commit. It re-runs `sync-version.mjs --check` at the
   tagged tree and fails if the tag disagrees with it.

5. **The fleet-deferral gate moves to the publish side.** An open issue labelled
   `running` still defers, and an hourly schedule retries the newest tag that has
   no GitHub Release yet. Publishing is idempotent at every stage (npm version
   already served, Release already cut), so a retry resumes rather than
   conflicts.

### On the external dependency

RedSkills builds its tooling internally by default. `@changesets/cli` is a
deliberate exception: the thing we would be rebuilding is *changeset files plus
a bot-maintained PR*, the sibling reddb repo already runs this exact flow, and
the homegrown alternative is precisely the bespoke machinery this ADR deletes.

## Consequences

- **A release now requires a changeset.** A change that ships user-visible
  behaviour without one accumulates no bump and never releases. `pnpm changeset`
  is part of landing work, including for `/afk` and `/go` slices.
- Bump kind becomes an explicit authored decision instead of a conventional-
  commit inference. `scripts/decide-release-bump-kind.mjs` and the
  `RED_RELEASE_ALLOW_MAJOR` repository variable are retired with it — a major
  bump is now just a `major` changeset that a human approves in the Version PR.
- Two workflows instead of one, and one extra merge in the loop (the Version PR)
  before a release goes out.
- A tag pushed by `GITHUB_TOKEN` cannot trigger `on: push: tags` (GitHub
  suppresses recursive triggers), so `red-release.yml` dispatches
  `red-publish.yml` by name after tagging. A tag pushed by a human still
  triggers it the advertised way.
- Deleted: `scripts/release-push-bump.sh`,
  `scripts/test-red-release-bump-push-contract.sh`,
  `scripts/decide-release-bump-kind.mjs`,
  `scripts/test-red-release-bump-kind.sh`, and every `RED_RELEASE_TOKEN` /
  `RELEASE_PAT` reference.

## Status

Accepted.

## Related

- ADR 0040 — version is a single source written by one script (this ADR names
  `scripts/sync-version.mjs` as that script).
- ADR 0091 — npm is the client bundle transport; the publish side is unchanged.
- ADR 0111 — Pi packages are published by the same publish run.
- `.changeset/README.md` — how to author a changeset.
