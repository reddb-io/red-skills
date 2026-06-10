---
title: feat(afk): exempt idle drain from fast-death ring, idle-park fleet on empty queue (#578)
type: source
tags: [pr, merged]
created: 2026-06-10
updated: 2026-06-10
sources: [pr-633]
pr: 633
merge_sha: 70012438f731be5529fecd00a653cf3e22e264d6
---

# feat(afk): exempt idle drain from fast-death ring, idle-park fleet on empty queue (#578)

- **PR:** [#633](https://github.com/reddb-io/red-skills/pull/633)
- **Author:** @filipeforattini
- **Merge SHA:** `70012438f731be5529fecd00a653cf3e22e264d6`
- **Format:** merged pull request

## Summary

Closes #578

## Summary

- Exit code 0 (NO_MORE_TASKS) is never counted as a fast-death; K consecutive idle drains can no longer trip the circuit breaker
- Clean drain with empty queue → slot enters `idleParked` state: no sweep, no discard envelope, no respawn timer; a queue refill on the next tick un-parks and respawns automatically
- `readyQueueDepth` fetched once per tick and threaded to heartbeat (single `gh` call, not two)
- `spawning` flag on `SlotState` prevents double-spawn if the enclosing tick is abandoned mid-`spawnSlot`
- `pollStallDetector` skips idle-parked slots; `fleetSlotCounts` counts both `parked` and `idleParked` in `slotsParked`

## Test plan

- [x] All 1215 existing tests pass
- [x] 14 new tests: `idle-drain-does-not-trip`, `exit-0-not-fast-death`, `queue-refill-unparks-idle`, `spawning-guard` double-spawn prevention
- [x] CHANGES.md entry added

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/633"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783656803&installation_id=129708444&pr_number=633&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F633&signature=42c00738313abd874a42f6ca4efc4470d49533d71c63c39fb731306c704655c0"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->
## Summary by CodeRabbit

* **Bug Fixes**
  * Fixed fleet slot behavior when idle workers exit cleanly—slots no longer permanently park and are properly restored when work arrives.
  * Added safeguards to prevent duplicate slot spawning during tick processing.
  * Improved stall detection to skip idle-parked slots.

* **Tests**
  * Added comprehensive tests for idle-drain behavior, queue-refill un-parking, exit-0 handling, and spawn-guard correctness.

* **Documentation**
  * Documented the idle-drain fix and supervisor behavior in CHANGES.
<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- feat(afk): exempt idle drain from fast-death ring, idle-park fleet on…
- chore(afk): add CHANGES.md entry for #578 idle-park / clean-drain fix
- fix(afk): capture exit code for regular spawnSlot workers (#578)

## Files changed

- `CHANGES.md`
- `src/apps/dev/src/commands/supervise.ts`
- `src/apps/dev/src/core/supervisor.ts`
- `src/apps/dev/tests/supervisor.test.ts`

