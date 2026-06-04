---
title: build(release): one bundle-naming convention, all assets under ./dist/ (ADR 0052)
type: source
tags: [pr, merged]
created: 2026-06-04
updated: 2026-06-04
sources: [pr-480]
pr: 480
merge_sha: 3bd579b1e9da6409ff3e1bfa4f9fdea198206ece
---

# build(release): one bundle-naming convention, all assets under ./dist/ (ADR 0052)

- **PR:** [#480](https://github.com/reddb-io/red-skills/pull/480)
- **Author:** @filipeforattini
- **Merge SHA:** `3bd579b1e9da6409ff3e1bfa4f9fdea198206ece`
- **Format:** merged pull request

## Summary

## Problem
The release shipped **two inconsistent artifact shapes**:
- dev / code-nav / benchmark-* → `dist/<app>.bundle.min.mjs` (minified, in `dist/`) ✓
- **memory / brain** → `src/apps/<app>/dist-bundle/<app>-cli.mjs` + `<app>-mcp.mjs` (non-minified, wrong dir, no `.bundle.min`), manifest written outside `dist/`.

The clean `dist/<app>.bundle.min.mjs` was **already built by `pnpm bundle`** — but the release ran `pnpm bundle:legacy` and shipped the `dist-bundle/` artifacts instead, discarding the good ones. A half-finished migration (ADR 0029 → 0034) where nobody removed the legacy half.

## Fix (ADR 0052)
One convention: every release asset under `./dist/`, named `<app>[-<role>].bundle.min.mjs`.
- Drop `bundle:legacy*` from memory + brain `package.json`.
- Release runs `pnpm bundle`; the runtime-manifest + upload read `dist/<app>.bundle.min.mjs` (CLI) + `dist/<app>-mcp.bundle.min.mjs` (MCP) + `dist/<app>-runtime-manifest.json`.
- `plugins/brain/scripts/bootstrap.mjs` local dev-checkout fallback repointed `dist-bundle/` → `dist/`.

**Why it's low-coordination-risk:** the bootstraps read asset names **from the version-pinned manifest**, so the rename follows per-version and every released tag is internally self-consistent (no lockstep launcher↔asset release needed). The version-keyed runtime cache filenames (`…/memory-cli.mjs`) are internal and unchanged → `memory-bridge.sh` unaffected.

Bonus: the minified `dist/` bundles are **smaller** than the legacy non-minified ones (memory CLI 955K vs 1.8M).

## Verified
- `pnpm bundle` produces `dist/memory.bundle.min.mjs` + `dist/memory-mcp.bundle.min.mjs` (confirmed locally).
- Repo-wide grep: no remaining `dist-bundle` / `*-cli.mjs` / `bundle:legacy` consumers (except the intentional memory-bridge cache name).
- `red-release.yml` YAML + both `package.json` parse clean.

## ⚠️ Do NOT merge-and-release blindly
A wrong asset name/path here surfaces **only on a real `/plugin` install** of memory/brain (the bootstrap fetch), **not in CI**. Smoke-test the bootstrap fetch against a release built from this branch before relying on it.

## Scope note
For **memory** this is interim — ADR 0041 migrates the memory plugin to `red-memory`, after which red-skills deletes the memory app. Normalizing now keeps the shipping release coherent until then; it does not conflict (separate repo).

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/480"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783128873&installation_id=129708444&pr_number=480&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F480&signature=79fa00ff9bb2b14c7e6df55c2527048f90c8e660b586407e70c16c472ce52b61"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

* **Chores**
  * Standardized release artifact naming convention for Memory and Brain runtimes under `./dist/` directory.
  * Simplified build process by removing legacy bundling scripts.
  * Updated GitHub Actions workflow to use canonical minified artifact model for runtime releases.
  * Updated bootstrap fallback logic to reference new artifact locations.

* **Documentation**
  * Added Architecture Decision Record (ADR 0052) documenting unified bundle naming and placement conventions.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- build(release): one bundle-naming convention, all assets under ./dist…

## Files changed

- `.github/workflows/red-release.yml`
- `.red/adr/0052-one-bundle-naming-convention-under-dist.md`
- `.red/adr/INDEX.md`
- `plugins/brain/scripts/bootstrap.mjs`
- `src/apps/brain/package.json`
- `src/apps/memory/package.json`

