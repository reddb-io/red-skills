# Releasing RedSkills

This is the internal deploy flow for maintainers of this repository. Consuming
RedSkills needs none of it — see [Install](../README.md#install).

Releases run on [changesets](https://github.com/changesets/changesets) in two
halves (ADR 0121). **Nothing pushes a commit to `main`** — the version bump is a
reviewed PR like any other.

1. **Land your change with a changeset.** Run `pnpm changeset`, pick
   `patch`/`minor`/`major`, describe the change in one consumer-facing line, and
   commit the generated file under `.changeset/`. A change that ships without
   one accumulates no bump and never releases.
2. **[red-release.yml](../.github/workflows/red-release.yml) maintains the Version
   Packages PR.** On every push to `main` it collects the pending changesets and
   opens/updates a `chore(release): version packages` PR. That PR runs
   `pnpm release:version` — `changeset version` plus
   [`scripts/sync-version.mjs`](../scripts/sync-version.mjs), the single writer
   (ADR 0040) that carries the version into the root `package.json`, the Claude
   and Codex plugin manifests, and the Pi manifests. `pnpm version:sync:check`
   fails CI if any of them drifts.
3. **Merging that PR cuts the tag.** `main` now has no pending changesets and a
   version no tag points at, so `red-release.yml` tags `vX.Y.Z`.
4. **[red-publish.yml](../.github/workflows/red-publish.yml) publishes the tag.**
   It builds the bundles, stages them into the `@reddb-io/red-skills` npm
   package, runs the real packaged client against the packed tarball as a
   producer/consumer contract check, `npm publish`es, smokes the published
   package from the registry, cuts the GitHub Release with the assets, and moves
   the matching major tag such as `v3` so reusable workflows pinned to `@v3`
   keep advancing.

The `publish` job runs in the GitHub environment named `red-release`. Repository
settings must keep that environment protected with required reviewers, because
approval is the gate before the job publishes release assets or moves the major
tag. Once an approved reviewer approves the environment deployment, the publish
continues without any extra manual step.

Publishing defers while any open issue carries the `running` label (a drain is
mid-iteration); an hourly schedule retries the newest tag that has no GitHub
Release yet, and every stage is idempotent so the retry resumes rather than
conflicts.

A shipped daemon keeps itself current without any of this: it resolves the
published version on its own tick, finds a successor running exactly that
version, hands over the socket and the lease, and lets the successor re-adopt
every Worker off the event lane. A **major boundary is held and the hold is said
out loud** — `upgrade.major_held` and `upgrade.major_hold` name the newest
release and the manual step that crosses it — because a breaking change must not
arrive on a machine that is holding Workers just because a timer noticed it.
