---
title: feat(afk): supervisor proof-of-life requires forward progress
type: source
tags: [pr, merged]
created: 2026-06-10
updated: 2026-06-10
sources: [pr-636]
pr: 636
merge_sha: 3df2cb005e1ee0c0adfa272cc35e14d5327f51d3
---

# feat(afk): supervisor proof-of-life requires forward progress

- **PR:** [#636](https://github.com/reddb-io/red-skills/pull/636)
- **Author:** @filipeforattini
- **Merge SHA:** `3df2cb005e1ee0c0adfa272cc35e14d5327f51d3`
- **Format:** merged pull request

## Summary

Closes #579

## Summary

- **Progress-stale quiescence gate**: A supervisor whose `guardedTick` keeps timing out still stamps a fresh `lastHeartbeatEpoch` on every loop, making the watchdog believe it's healthy. We now track `lastProgressEpoch` separately — it only advances when a tick completes without being abandoned. If `lastProgressEpoch` is stale by `progressStaleS` (default 900s) **and** `slotsBusy > 0`, the supervisor is classified `quiescent` regardless of heartbeat freshness.

- **Watchdog tears down detached workers**: Detached workers (spawned with `detached: true`) are NOT children of the supervisor, so `killTree(supervisorPid)` misses them. `teardownWedgedSupervisor` now calls `killWorkers()` which enumerates `<workersRoot>/<id>/worker.pid` and kills any surviving processes.

## Acceptance criteria checklist

- [x] A supervisor that loops with zero completed ticks and busy slots is classified `quiescent` and recovered
- [x] Health keys off forward progress (`lastProgressEpoch`), not just wall-clock heartbeat epoch
- [x] Watchdog recovery calls `killWorkers()` to tear down orphaned detached workers
- [x] Tests cover the abandon-every-tick case (`guardedTick — abandoned flag` + `runSupervisor — lastProgressEpoch tracking`)
- [x] Idle fleet (no busy slots, stale progress) stays `healthy` — no false-positive recovery

## Test plan

- `pnpm --filter dev exec vitest run tests/supervisor.test.ts tests/watchdog.test.ts` — all 10 new watchdog tests and the updated supervisor suite pass
- New `validateSupervisorProgressThreshold` suite (4 cases)
- New progress-stale `classifySupervisor` cases (4 cases)
- New `guardedTick — abandoned flag` suite (3 cases)
- New `runSupervisor — lastProgressEpoch tracking` suite (2 cases)
- Watchdog test now asserts `killWorkers` call order in the recovery sequence

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/636"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783661493&installation_id=129708444&pr_number=636&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F636&signature=eb2eab0c760b1e337e080f2ffa93c66b82f67d9c9cf3a9a79c76ab21913cb4c4"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->
## Summary by CodeRabbit

* **New Features**
  * Added progress-staleness detection alongside heartbeat monitoring.
  * Watchdog can now terminate lingering worker processes during recovery.
  * Fleet state now records a last-progress epoch; monitor/watchdog consider both heartbeat and progress thresholds.
  * New configurable progress-stale threshold with validation.

* **Tests**
  * Expanded unit tests and watchdog/supervisor test coverage for progress-staleness, abandoned ticks, and recovery ordering.
<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- feat(afk): supervisor proof-of-life requires forward progress (#579)

## Files changed

- `src/apps/dev/src/commands/fleet.ts`
- `src/apps/dev/src/commands/monitor.ts`
- `src/apps/dev/src/commands/supervise.ts`
- `src/apps/dev/src/core/monitor.ts`
- `src/apps/dev/src/core/supervisor.ts`
- `src/apps/dev/src/core/watchdog.ts`
- `src/apps/dev/src/runtime/supervisor-spawn.ts`
- `src/apps/dev/src/runtime/watchdog-io.ts`
- `src/apps/dev/src/runtime/wire.ts`
- `src/apps/dev/tests/supervisor.test.ts`
- `src/apps/dev/tests/watchdog.test.ts`

