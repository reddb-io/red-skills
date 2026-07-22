# Changesets

This folder holds the pending release intents for `red-skills`. Every
user-visible change lands with a changeset; `red-release.yml` turns the
accumulated changesets into a **Version Packages PR**, and merging that PR is
what cuts the next `vX.Y.Z` tag.

## Adding a changeset

```bash
pnpm changeset
```

Pick a bump kind (`patch` / `minor` / `major`) and write one line describing the
change from a consumer's point of view. The command writes a markdown file here;
commit it with your change.

## One version for the whole product

Every release-tracked workspace package is in one `fixed` group (see
`config.json`), so a changeset naming any member bumps them all to the same
number. `pnpm release:version` then runs `scripts/sync-version.mjs`, which
propagates that number to the files changesets does not own — the root
`package.json`, the plugin manifests (`.claude-plugin` / `.codex-plugin`), and
the Pi package manifests (ADR 0040: one version, one writer).

Packages with their own release cadence (`@reddb-io/red-castle`,
`@reddb-io/rsp`, `@reddb-io/red-browser`, …) are in `ignore` and never move with
a product release.

## What NOT to do

- Do not hand-edit a `version` field. `pnpm release:version` is the only writer;
  `pnpm version:sync:check` fails CI when a version drifts.
- Do not push a version bump to `main` directly. The Version Packages PR is the
  only path, and it passes branch protection like any other PR.
