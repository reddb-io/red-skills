---
title: feat(afk): monitor renders parked slots — parked:N and per-slot TTY detail
type: source
tags: [pr, merged]
created: 2026-06-12
updated: 2026-06-12
sources: [pr-735]
pr: 735
merge_sha: 35a9c056ecd9bce4cd82e08d2cab11df9edcf1d7
---

# feat(afk): monitor renders parked slots — parked:N and per-slot TTY detail

- **PR:** [#735](https://github.com/reddb-io/red-skills/pull/735)
- **Author:** @filipeforattini
- **Merge SHA:** `35a9c056ecd9bce4cd82e08d2cab11df9edcf1d7`
- **Format:** merged pull request

## Summary

Closes #630

## Summary

- `supervisor.ts`: Added `HeartbeatSlotDetail` type + `slotDetails` field to `FleetHeartbeat`; `buildSlotDetails()` computes per-slot state (open/half-open/idle-parked with `retryAt` epoch for open slots); passes `config` to `emitFleetHeartbeat`
- `monitor.ts`: Added `SlotDetail` interface; `renderFleetLine` now includes `parked:N` unconditionally; new `renderSlotDetails()` renders one line per non-closed slot (open→retry countdown, half-open→probing, idle-parked→queue empty); `renderCompactDashboard` appends slot detail lines after the fleet line
- `wire.ts`: `parseFleetState` parses the new `slot_details` array from the supervisor heartbeat JSON, never the log
- `tests/monitor.test.ts`: Updated two exact-match fleet line snapshots for `parked:N`; added 9 new tests

## Test plan

- [ ] pnpm -C apps/dev test — 1458 tests pass
- [ ] pnpm typecheck — clean

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/735"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783870776&installation_id=129708444&pr_number=735&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F735&signature=21faece898510e7d15c50376e30b96115739014ae358e16438fc81d0fbb6744c"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

## Commits

- feat(afk): monitor renders parked slots — parked:N and per-slot TTY d…

## Files changed

- `apps/dev/src/core/monitor.ts`
- `apps/dev/src/core/supervisor.ts`
- `apps/dev/src/runtime/wire.ts`
- `apps/dev/tests/monitor.test.ts`

