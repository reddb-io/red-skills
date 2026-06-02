---
title: fix(afk): guard each supervise tick + per-tick heartbeat — unwedgeable fleet supervisor
type: source
tags: [pr, merged]
created: 2026-06-02
updated: 2026-06-02
sources: [pr-408]
pr: 408
merge_sha: b5a8ba13d82566e8d4258c062671219017f47176
---

# fix(afk): guard each supervise tick + per-tick heartbeat — unwedgeable fleet supervisor

- **PR:** [#408](https://github.com/reddb-io/red-skills/pull/408)
- **Author:** @filipeforattini
- **Merge SHA:** `b5a8ba13d82566e8d4258c062671219017f47176`
- **Format:** merged pull request

## Summary

Root-cause fix for a **live-but-quiescent fleet supervisor** (observed live this session: alive `__supervise` PID for ~6h, stopped spawning, fat `ready-for-agent` queue not draining, no log — had to be killed manually).

## Root cause

`runSupervisor`'s `for(;;)` loop sits on `await superviseTick(...)`, and a tick awaits gh / ps / git calls with **no timeout**. One hung call freezes the loop **forever** — process alive, zero spawn, zero log. Nothing detects or recovers it.

## Fix (the loop-robustness leg of #406/#407)

- **`guardedTick`** races each tick against a wall-clock ceiling (`RED_AFK_TICK_TIMEOUT_S` / `tickTimeoutS`, default **120s**) and isolates throws. A hung/failed tick is **abandoned** and the loop **continues** to the next pass instead of freezing. Pure over an injected `sleep` → fully unit-tested, no real timers.
- **Per-tick heartbeat**: `SupervisorDeps.log?` (wired in `supervise.ts` to append one timestamped line per tick to `afk-supervisor.log`). A healthy fleet's heartbeat **and** a wedged one's silence are now observable — kills the "guess fleet state from a stale log" failure mode that bit us twice.
- `0`/non-numeric `RED_AFK_TICK_TIMEOUT_S` floors to the default (never silently disabled).

## Relation to #406 / #407

- **#406 (detection):** delivers the per-tick liveness log; the richer surfacing (firehose record + fleet state file + monitor "last ticked N ago") remains.
- **#407 (recovery):** delivers the **unwedgeable drain loop** leg; the watchdog/self-heal **architecture decision** remains (HITL).

Supervisor-level analog of the per-worker progress guard (ADR 0044/0045).

## Tests

`guardedTick` (completes-before-ceiling / abandons-hung-tick / isolates-throw) + the tick-timeout knob (default + 0-floors + garbage); typecheck clean. **NOTE:** the full `supervisor.test.ts` OOM'd locally under memory pressure from a concurrent AFK worker hammering the box — the new tests pass in isolation and the existing tests are logically untouched (additive change; the loop change isn't exercised by them).

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/408"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783025113&installation_id=129708444&pr_number=408&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F408&signature=2197ca24593e5b04868e12020393fc82514a6eb79172249c13332b59045d6a07"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

## Release Notes

* **New Features**
  * Supervisor now supports configurable tick timeout protection (default 120 seconds) to prevent indefinite stalls from hung operations.
  * Added heartbeat logging for improved supervisor liveness monitoring and observability.

* **Tests**
  * Expanded test coverage for timeout handling and configuration behavior.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- fix(afk): guard each supervise tick + emit a per-tick heartbeat (unwe…

## Files changed

- `src/apps/dev/src/commands/supervise.ts`
- `src/apps/dev/src/core/supervisor.ts`
- `src/apps/dev/tests/supervisor.test.ts`

