---
title: fix(afk): carry the line-diff in the heartbeat + persist it for the monitor (#448)
type: source
tags: [pr, merged]
created: 2026-06-03
updated: 2026-06-03
sources: [pr-462]
pr: 462
merge_sha: 6a15ba3f662d370f9ce4dd92878c55dc5d90fac8
---

# fix(afk): carry the line-diff in the heartbeat + persist it for the monitor (#448)

- **PR:** [#462](https://github.com/reddb-io/red-skills/pull/462)
- **Author:** @filipeforattini
- **Merge SHA:** `6a15ba3f662d370f9ce4dd92878c55dc5d90fac8`
- **Format:** merged pull request

## Summary

## Summary

Fixes #448 — the AFK monitor loop runs every ~10min, but the underlying heartbeat carried no line-diff, so between ticks there was no way to see how an attempt was evolving (the frozen-duration symptom in the report). One had to `pstree` the worker to tell "live but quiet" from "stalled".

## Change

The externalized proof-of-life heartbeat (the attempt-progress guard's ~60s poll, ADR 0045) now computes the worktree diff vs the merge-base with `origin/main` and carries the `+A -R` volume in:

- the firehose `type=heartbeat` record (`extra.diff` / `diff_added` / `diff_removed`) and the `[heartbeat] …` `afk.log` line — evolution visible in the log every 60s; **and**
- `current.diff_added` / `current.diff_removed` in `afk.state.json`, which the monitor/statusline **already prefer** over a live `git diff` (`wire.ts`) — so the dashboard's `+A -R` stays fresh between its sparse 10-min ticks for free.

The 60s cadence already satisfies the "more frequent" half (guard interval is `min(capMs, 60_000)`); this PR adds the missing diff half.

## Design

New pure helper `buildProgressHeartbeat` (returns `{msg, extra, statePatch}`) keeps the wiring unit-testable; `run.ts` only adds the async `diffstatShortstat` read (best-effort, swallowed).

## Tests

- 3 new tests in `heartbeat.test.ts` (`formatDiffVolume` + `buildProgressHeartbeat`): diff in msg/extra/state patch, head-omission + negative clamping.
- `heartbeat` + `wiring-integration`: **22/22**. `tsc --noEmit` clean. Full dev suite exits 0 (only the pre-existing #460 tinypool teardown flake remains, unrelated).

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/462"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783098984&installation_id=129708444&pr_number=462&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F462&signature=d782ef07391d1be73b94a3399bd80f0cb98b84c875fd2cf86e48d9bdbe75d930"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

* **New Features**
  * Enhanced progress tracking with detailed heartbeat telemetry capturing elapsed time since last progress event, file change metrics (additions and removals), and persistent state snapshots for improved development activity monitoring.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- fix(afk): carry the line-diff in the heartbeat + persist it for the m…

## Files changed

- `src/apps/dev/src/commands/run.ts`
- `src/apps/dev/src/core/heartbeat.ts`
- `src/apps/dev/tests/heartbeat.test.ts`

