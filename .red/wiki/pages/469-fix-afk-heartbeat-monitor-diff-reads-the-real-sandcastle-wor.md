---
title: fix(afk): heartbeat/monitor diff reads the real sandcastle worktree (kills the +0 -0 phantom)
type: source
tags: [pr, merged]
created: 2026-06-03
updated: 2026-06-03
sources: [pr-469]
pr: 469
merge_sha: e1e2baf4f8a31ae9576fcf20d8c09c998043233a
---

# fix(afk): heartbeat/monitor diff reads the real sandcastle worktree (kills the +0 -0 phantom)

- **PR:** [#469](https://github.com/reddb-io/red-skills/pull/469)
- **Author:** @filipeforattini
- **Merge SHA:** `e1e2baf4f8a31ae9576fcf20d8c09c998043233a`
- **Format:** merged pull request

## Summary

## Problem (observed live on reddb #894, codex runner)

The attempt heartbeat shows a line-diff (`+A -R`) so you can see progress between commits. But it was stuck at **`+0 -0` for the entire run** even with substantial work in the worktree:

```
heartbeat:      …1140s since last commit @ 7cbb0beb · +0 -0     ← phantom
real worktree:  3 files changed, 228 insertions(+), 29 deletions(-)
```

**Root cause:** `emitHeartbeat` computes the diff with `diffstatShortstat({ cwd: join(attemptDir, "worktree") })`, but sandcastle creates the agent's worktree at `{attemptDir}/.sandcastle/worktrees/{slug}` — the legacy `{attemptDir}/worktree` path **never exists**. `git diff` there fails (`fatal: cannot change to …/worktree`), the error is swallowed → `{added:0, removed:0}` → `+0 -0`.

Impact:
- No real progress precision (the whole point of the diff field).
- Starved the **attempt-progress guard** proof-of-life (it keys off commit-anchored progress; a non-committing runner + a phantom diff = looks stalled).
- Hit the **codex runner** hardest — it doesn't commit mid-run, so there was nothing committed to show either.
- Same blind spot in the **monitor** dashboard, which reads `state.current.worktree` (the same phantom path) for its diff column.

## Fix

- `worktreePathUnder(ctx, dirPrefix)` (runtime/git.ts) — resolve the worktree registered under the attempt dir via `git worktree list --porcelain` (sibling of the salvage's `worktreePathForBranch`, same `runGit` seam → testable).
- `emitHeartbeat` (run.ts) — diff the **real** worktree, and persist it into `current.worktree` so the **monitor gets the live path for free**. Falls back to the legacy path when no worktree is registered yet (pre-worktree ticks).

Now the heartbeat shows `+228 -29` climbing instead of `+0 -0`, and the progress guard sees genuine activity.

## Tests
- 4 new `worktreePathUnder` unit tests (real-path resolution, trailing-slash, **sibling-prefix guard** so `894-a1` ≠ `894-a10`, not-registered-yet).
- Full `src/apps/dev` suite: **938/938**, typecheck clean.

## Lineage
Same sandcastle-blind path hazard as the DONE-without-commit salvage (ADR 0050 / #468) and the monitor note (#392). This closes the heartbeat/monitor half.

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/469"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783118046&installation_id=129708444&pr_number=469&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F469&signature=f184507c9899cf27d6a3cc782565c0320a3589af0341d9e93cf5f149499c0555"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

* **Bug Fixes**
  * Improved worktree path detection in the heartbeat monitoring system to more reliably identify and track the correct working directory.

* **Tests**
  * Added comprehensive test coverage for worktree path resolution scenarios.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- fix(afk): heartbeat/monitor diff reads the real sandcastle worktree (…

## Files changed

- `src/apps/dev/src/commands/run.ts`
- `src/apps/dev/src/runtime/git.ts`
- `src/apps/dev/tests/runtime-git-branch.test.ts`

