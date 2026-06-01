---
title: refactor(dev): ship dev runtime as fetched asset, not committed bundle (ADR 0038)
type: source
tags: [pr, merged]
created: 2026-06-01
updated: 2026-06-01
sources: [pr-376]
pr: 376
merge_sha: 2123b8ab78a39f6376bc74f5460e7fa09c3c0a29
---

# refactor(dev): ship dev runtime as fetched asset, not committed bundle (ADR 0038)

- **PR:** [#376](https://github.com/reddb-io/red-skills/pull/376)
- **Author:** @filipeforattini
- **Merge SHA:** `2123b8ab78a39f6376bc74f5460e7fa09c3c0a29`
- **Format:** merged pull request

## Summary

## Why

The repo working tree had ballooned and `.git` reached **67 MB**. Investigation
found two causes; this PR fixes the structural one.

The committed `bin/afk.mjs` has grown to **~2.6 MB** and the release workflow
**rebuilds and re-commits it on every version bump** → dozens of 2.6 MB blobs in
history, the single largest history-bloat contributor. ADR 0032 only accepted a
committed bundle because it assumed the bundle was "single-digit KB to low tens of
KB". That premise stopped holding once the shell→TS port completed.

## What

Completes the **ADR 0034** dynamic-fetch migration for the `dev` domain — the same
move `code-nav` already made. The runtime ships as the `dev.bundle.min.mjs` GitHub
Release asset (already uploaded + sha256-pinned via `dev.manifest.json`), fetched
into a version-keyed cache by `red-fetch` on SessionStart.

- **`bin/afk.mjs`: 2.6 MB committed bundle → ~4 KB hand-written launcher** that
  resolves the bundle (`cache → repo-root dist → red-fetch`) and delegates. Every
  `node bin/afk.mjs <cmd>` call site (SKILL.md, statusline) is unchanged.
- **`src/apps/dev`**: drop `bundle:bin`; `build` = `bundle` + `bundle:red-fetch`.
- **`red-release.yml`**: stop staging/committing `bin/afk.mjs` (the asset is already
  built + uploaded). `red-fetch.mjs` is still rebuilt+staged (it can't fetch itself).
- **ADR 0038** supersedes ADR 0032; `bin/README.md` rewritten.

## Verification

- ✅ **Real end-to-end fetch** from Release `v1.147.6`: cold cache + no dist →
  red-fetch downloads `dev.bundle.min.mjs`, verifies sha256 against the manifest,
  caches as `dev-1.147.6.bundle.min.mjs`, launcher execs it (`dev 1.147.6 656c320…`).
- ✅ Cache fast-path (no network), repo-root `dist/` fallback, and **loud failure**
  with build/network guidance when nothing resolves (AFK is interactive — no silent
  no-op).
- ✅ `828 tests pass`, `tsc` clean.

## Out of scope

Purging the **existing** 2.6 MB × N history blobs needs a coordinated
`git filter-repo`/BFG pass (all clones must re-clone) — tracked separately. This PR
stops the bleeding going forward.

> Note: this branch also carries `chore: stop tracking memory incompat-bak backup`
> (untracks a 36 MB `.red/memory/incompat-bak/graph.rdb` that was committed and is
> local memory state), since it isn't on `origin/main` yet.

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/376"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1782935339&installation_id=129708444&pr_number=376&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F376&signature=07a3d570cb667eb6019935a207ffccb8e42b3859aca7bf4cd576f8856f5338d7"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>@codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

* **Documentation**
  * Added Architecture Decision Record documenting the shift from committed to fetched dev runtime distribution.
  * Updated bootstrap and build process documentation.

* **Chores**
  * Streamlined release workflow and build scripts to fetch dev runtime on demand.
  * Cleaned up version control artifacts and ignored directories.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- chore: stop tracking memory incompat-bak backup
- refactor(dev): ship dev runtime as fetched asset, not committed bundl…

## Files changed

- `.github/workflows/red-release.yml`
- `.gitignore`
- `.red/adr/0032-afk-ships-as-a-committed-dependency-free-bundle.md`
- `.red/adr/0038-dev-runtime-ships-as-a-fetched-asset-not-a-committed-bundle.md`
- `.red/memory/incompat-bak/graph.rdb`
- `.red/memory/incompat-bak/graph.rdb-dwb`
- `.red/memory/incompat-bak/graph.rdb-hdr`
- `.red/memory/incompat-bak/graph.rdb-meta`
- `.red/memory/incompat-bak/graph.rdb-uwal`
- `.red/memory/incompat-bak/graph.rdb.meta.rdbx`
- `.red/memory/incompat-bak/graph.result-cache.l2`
- `.red/memory/incompat-bak/graph.result-cache.l2-dwb`
- `plugins/dev/skills/engineering/afk/bin/README.md`
- `plugins/dev/skills/engineering/afk/bin/afk.mjs`
- `src/apps/dev/package.json`

