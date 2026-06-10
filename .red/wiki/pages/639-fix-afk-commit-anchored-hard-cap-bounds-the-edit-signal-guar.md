---
title: fix(afk): commit-anchored hard cap bounds the edit-signal guard extension
type: source
tags: [pr, merged]
created: 2026-06-10
updated: 2026-06-10
sources: [pr-639]
pr: 639
merge_sha: b6f8d0cf146bdbc794a03dc4229c9cfc2cf0f01c
---

# fix(afk): commit-anchored hard cap bounds the edit-signal guard extension

- **PR:** [#639](https://github.com/reddb-io/red-skills/pull/639)
- **Author:** @filipeforattini
- **Merge SHA:** `b6f8d0cf146bdbc794a03dc4229c9cfc2cf0f01c`
- **Format:** merged pull request

## Summary

Closes #637.

## Problem

The ADR 0051 edit-signal (`progressProbe`) resets the attempt guard deadline on ANY worktree line-volume change. A busy-but-unproductive agent that re-validates in a loop while occasionally touching a file therefore never accumulates 45min of "no progress" — the observed #579 worker burned 5h+ this way, and the ADR 0055 reconcile backstop on the `timeout` terminal (which would have landed its already-committed green branch) was never reached.

## Fix

- `startAttemptGuard` takes an optional `hardCapMs`: edit-signal resets extend the soft deadline only up to the hard cap since the last **commit** (or spawn); past it the guard aborts regardless of edits.
- Abort reason is now `"stalled" | "hard-cap"`, surfaced in the abort error message for operator forensics.
- Default 90min (`DEFAULT_ATTEMPT_HARD_CAP_S = 5400`), env-tunable via `RED_AFK_ATTEMPT_HARD_CAP_S` (typo-safe; `0` cannot disable it). Clamped in `wire.ts` to never fire before the plain soft cap.
- Codex non-regression: editing-without-committing within the hard cap still counts as progress (ADR 0051 behaviour unchanged when `hardCapMs` is absent — pinned by test).

## Known gap (documented, out of scope)

Per-iteration post-commit DONE enforcement ("committed but no DONE after K iterations → stop and reconcile") is not implementable from AFK today: sandcastle 0.6.x exposes `maxIterations`/`completionSignal` but no per-iteration hook. The hard cap bounds the same failure at the whole-run level (guard spans iterations), so the practical stall ceiling drops from unbounded to ~90min, after which reconcile lands the branch.

## Tests

5 new tests: hard cap fires despite periodic edits; commit re-anchors the cap; soft expiry still reports `stalled`; no-hardCap behaviour unchanged (ADR 0051 pin); `runAgent` wiring returns `timeout` with a "hard cap" abort message. `tests/execution.test.ts` 83/83, `tests/wire.test.ts` 26/26, tsc clean.

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/639"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783681196&installation_id=129708444&pr_number=639&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F639&signature=c67f5ef4f53e9480d6d8d4e27000c847bac4f5cedb0bc8868576abe0aafdc6d4"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

## Release Notes

* **New Features**
  * Introduced a hard cap timeout for agent execution that cannot be extended by edits, providing an absolute deadline alongside the existing soft timeout.
  * Enhanced error messaging to distinguish between soft timeout failures and hard cap timeout failures.

* **Tests**
  * Added comprehensive test coverage for hard cap timeout behavior across various execution scenarios.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- fix(afk): commit-anchored hard cap bounds the edit-signal guard exten…

## Files changed

- `src/apps/dev/src/core/execution.ts`
- `src/apps/dev/src/runtime/wire.ts`
- `src/apps/dev/tests/execution.test.ts`

