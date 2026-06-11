---
title: fix(afk): claude cost vitals + honest [live] badge + pre-merge typecheck gate
type: source
tags: [pr, merged]
created: 2026-06-11
updated: 2026-06-11
sources: [pr-715]
pr: 715
merge_sha: 4ed4c3ee2f259919c88f5fe80cd5eb6be5a1f639
---

# fix(afk): claude cost vitals + honest [live] badge + pre-merge typecheck gate

- **PR:** [#715](https://github.com/reddb-io/red-skills/pull/715)
- **Author:** @filipeforattini
- **Merge SHA:** `4ed4c3ee2f259919c88f5fe80cd5eb6be5a1f639`
- **Format:** merged pull request

## Summary

Resolves three follow-ups surfaced while validating the 1.200.x runner (ADR 0065). All found during a live runner check; the WorkerVitals activity/progress lanes already worked end-to-end, these close the remaining gaps.

## 1. Cost vitals populate on claude runs
The cost group (`input_tokens`/`output_tokens`/`cost_usd`) was **zero on every claude run** — claude never streamed a discrete `usage` event the way codex does, so the `activity-meter` consumer (already wired since S3) never received one. red-castle bumped to `207de381`: claude's terminal stream-json `result` line (which carries cumulative `usage` + `total_cost_usd`) now also yields a `usage` event through the existing `onUsage` path. So 🪙/💵 finally light up for claude.

## 2. The `[live]` badge is honest
A finished worker rendered as `[live]` on the monitor and inflated the statusline 🤖N badge. `isStateLive` checks **only the recorded pid**, which can be the shared supervisor's or recycled by the OS after the worker exits. New `isStateActive` requires **pid-live AND** latest activity within `WORKER_LIVE_MAX_AGE_S` (180s), used at the two display sites. Reaper/cap logic keeps the conservative pid-only `isStateLive` so a slow worker is never reaped on freshness; the window is generous so a real-but-quiet worker is never mis-flagged stale.

## 3. Pre-merge typecheck gate
`pnpm typecheck` ran only in `red-release.yml` on push-to-main — **after merge** — so a type break landed silently on a PR and surfaced only at release. That's the path the S2 `usage` variant break slipped through. New `red-workspace-typecheck.yml` runs the same workspace typecheck on every PR. Tests stay out for now (`supervisor.test.ts` OOM, #446).

## Validation
- red-castle: 217 AgentProvider tests pass (incl. 2 new for the result→usage emission); typecheck clean (pre-existing template-only tsgo noise unrelated).
- apps/dev: typecheck clean (only the known environmental `cli-args-parser` worktree artifact, resolves in CI); state/wire/monitor/activity-meter/statusline/worker-vitals tests all green (incl. new isStateActive coverage).

Also done in the same session (operational, not in this PR): killed a stale 1.190.0 orphan fleet and cleaned ~430 stale worker scratch dirs (16M).

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/715"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783802693&installation_id=129708444&pr_number=715&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F715&signature=fd6f4653d4cb896ecf83ed5974120149e1e258247bb4cd31e9be28e8f2b02bbe"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

* **New Features**
  * Enhanced worker activity tracking to distinguish between active and stale workers based on recent activity, improving accuracy of worker status monitoring.

* **Chores**
  * Added automated type checking workflow for continuous validation.

* **Tests**
  * Expanded test coverage for worker activity detection.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- fix(afk): claude cost vitals + honest [live] badge + pre-merge typech…

## Files changed

- `.github/workflows/red-workspace-typecheck.yml`
- `apps/dev/src/core/state.ts`
- `apps/dev/src/runtime/wire.ts`
- `apps/dev/tests/state.test.ts`
- `packages/red-castle`

