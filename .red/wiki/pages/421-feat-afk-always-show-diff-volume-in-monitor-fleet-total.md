---
title: feat(afk): always show diff volume in monitor + fleet total
type: source
tags: [pr, merged]
created: 2026-06-03
updated: 2026-06-03
sources: [pr-421]
pr: 421
merge_sha: 109b58c217978e6b7e4a9665b39966ec70f2833c
---

# feat(afk): always show diff volume in monitor + fleet total

- **PR:** [#421](https://github.com/reddb-io/red-skills/pull/421)
- **Author:** @filipeforattini
- **Merge SHA:** `109b58c217978e6b7e4a9665b39966ec70f2833c`
- **Format:** merged pull request

## Summary

## What

`/afk monitor` now **always** surfaces the diff volume — how many lines `[+]` added and `[-]` removed:

- **Every worker line** carries the `+A -R` suffix unconditionally — including idle workers and a zero diff (`+0 -0`). Previously the diff only appeared on the in-progress line and was suppressed entirely when `0/0`.
- **Fleet total** in the sparkline header: `   Δ fleet +A -R`, summed over all workers, always present (even with zero workers → `+0 -0`).

## Why

The diff volume is the real "is there work" signal (the `issues N/M` counter is issues *closed*, not lines). Hiding it on idle/zero and having no aggregate meant you couldn't see the overall volume at a glance.

## How

- `core/monitor.ts`: `CompactWorker` carries numeric `diffAdded`/`diffRemoved` (was a pre-formatted optional `diff` string); new `formatDiff()` helper; `renderWorkerCompactLine` appends the volume on both the in-progress and idle branches; `renderCompactDashboard` sums the fleet total into the header.
- `runtime/wire.ts`: prefers the state file's persisted `diff_added`/`diff_removed`, falls back to a live `git diff --shortstat` of the worktree against the `origin/main` merge-base (same logic as the statusline), and always populates the numeric fields.
- `afk/SKILL.md`: refreshed the compact-dashboard sample (also drops the stale `(80%)` percent form the code abandoned).

## Tests

`tests/monitor.test.ts` — 21 pass. New/updated: numeric diff render, always-on `+0 -0` default, idle line carrying the volume, fleet-total header sum, `+0 -0` header with zero workers.

Runtime ships via the release-built bundle (ADR 0038) — not rebuilt here.

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/421"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783046102&installation_id=129708444&pr_number=421&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F421&signature=4f58027ec8a1d7b91335f6b82560e106fea2f11a1a7cb958b29cacea8936c419"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

* **New Features**
  * Compact dashboard now displays per-worker stage and elapsed timer information alongside diff metrics.
  * Fleet-wide aggregated diffs are summed and displayed in the dashboard header.
  * Worker diff format updated from percentages to `+A -R` notation for clearer volume signaling.

* **Documentation**
  * Clarified invocation guidance and sparkline aggregation expectations.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- feat(afk): always show diff volume in monitor + fleet total

## Files changed

- `plugins/dev/skills/engineering/afk/SKILL.md`
- `src/apps/dev/src/core/monitor.ts`
- `src/apps/dev/src/runtime/wire.ts`
- `src/apps/dev/tests/monitor.test.ts`

