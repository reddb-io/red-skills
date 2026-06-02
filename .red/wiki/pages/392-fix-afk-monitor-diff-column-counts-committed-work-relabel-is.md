---
title: fix(afk): monitor diff column counts committed work + relabel issue ratio
type: source
tags: [pr, merged]
created: 2026-06-02
updated: 2026-06-02
sources: [pr-392]
pr: 392
merge_sha: 91f9bb80e2485c55a88727e6af546315518fe1b3
---

# fix(afk): monitor diff column counts committed work + relabel issue ratio

- **PR:** [#392](https://github.com/reddb-io/red-skills/pull/392)
- **Author:** @filipeforattini
- **Merge SHA:** `91f9bb80e2485c55a88727e6af546315518fe1b3`
- **Format:** merged pull request

## Summary

## The bug (3rd time it bit a user)

A worker that had **committed +1788 lines** showed in `/afk monitor` as **`live` with an empty diff and `0/0 (0%)`** — reading as "live but zero code". Three independent lies:

1. **Diff range was uncommitted-only.** `diffstatShortstat` ran `git diff --shortstat origin/main` on the worktree → only *uncommitted* changes. The moment the inner agent commits, the worktree is clean → 0.
2. **The board never populated the diff at all.** `collectMonitorInputs` left `CompactWorker.diff` unset, so the column was always empty regardless.
3. **`0/0 (0%)` is issues-closed/total**, trivially misread as lines or completion.

## Fix

- `diffstatShortstat` diffs against `merge-base(origin/main, HEAD)` → **committed + uncommitted** work since the branch point (falls back to the bare base on an unborn branch).
- `collectMonitorInputs` now computes & sets `+N -M` per live worktree using that range → the board shows real work.
- worker line: `<done>/<total> (<pct>%)` → **`issues <done>/<total>`** (issues closed / queue total, explicitly not lines/completion). Dropped the unused `percentDone`.

## Tests

dev suite **844 pass** (+3 new `git-diffstat` tests asserting it resolves merge-base and diffs the resolved commit, with an unborn-branch fallback). typecheck clean. `monitor.test` updated to the `issues N/M` shape.

Ships via release build (no bundle staged). Fixes the recurring "live with empty diff" confusion.

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/392"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783007152&installation_id=129708444&pr_number=392&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F392&signature=9a539f7bbba01a5550b253743203e267e5b3b8684c4d3fba0e8c8acd8066bcbc"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

* **New Features**
  * Added a diff column displaying code changes (additions/deletions) for active workers.

* **Updates**
  * Simplified progress display format to show counter-only format (`issues <done>/<total>`) instead of percentages.

* **Tests**
  * Added test suite for diff statistics functionality.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- fix(afk): monitor diff column counts committed work + relabel issue r…

## Files changed

- `src/apps/dev/src/core/monitor.ts`
- `src/apps/dev/src/runtime/git.ts`
- `src/apps/dev/src/runtime/wire.ts`
- `src/apps/dev/tests/git-diffstat.test.ts`
- `src/apps/dev/tests/monitor.test.ts`

