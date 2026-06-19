---
title: fix(afk): cure the supervisor.test.ts OOM and gate the apps/dev suite in CI (#446)
type: source
tags: [pr, merged]
created: 2026-06-11
updated: 2026-06-11
sources: [pr-719]
pr: 719
merge_sha: 9a3f39decdbf8269cf66d3c01e5afe3a7b356123
---

# fix(afk): cure the supervisor.test.ts OOM and gate the apps/dev suite in CI (#446)

- **PR:** [#719](https://github.com/reddb-io/red-skills/pull/719)
- **Author:** @filipeforattini
- **Merge SHA:** `9a3f39decdbf8269cf66d3c01e5afe3a7b356123`
- **Format:** merged pull request

## Summary

## The keystone
The apps/dev vitest suite (1300+ tests) **OOM-killed its worker** (~42s, even at 4GB heap), so it ran in **no workflow** — type/test breaks landed unseen, and a real AFK worker's `pnpm test` validation gate crashed, parking **every apps/dev attempt as `blocked:validation`** (why #584 never landed). Fixing this unblocks CI test-gating, apps/dev AFK landings, AND the live cost-vital confirmation in one move.

## Two bugs, both masked by the OOM
1. **`does NOT advance lastProgressEpoch on an abandoned tick`** drove the full `runSupervisor` loop with `io.sleep` mocked to resolve **instantly** and a tick that always abandons → `stopFn` never reached → an infinite, allocating spin. The real assertion is the direct `guardedTick` call; the loop form was vestigial (its own comment admitted it). Dropped it.
2. **`emits one structured fleet heartbeat per supervise tick`** mocked `deps.now()` with a fixed list of 5 values, but the loop calls `now()` more times per tick, so the 6th returned `undefined` → `isoFromEpoch(undefined)` `RangeError`. Replaced with a controllable clock that flips `NOW→NOW+15` at the stop tick.

## Result
- `supervisor.test.ts`: 86/86 in ~0.5s (was 42s → OOM kill).
- Full apps/dev suite: **1333/1333** in 19s (the lone worktree-local `cli-args-parser` load error resolves under CI's `pnpm install`).
- `red-workspace-typecheck.yml` → **`red-workspace-ci.yml`** with a new per-PR **`test`** job (apps/dev) beside `typecheck`.

## Scope note
This is the unblocker (#3 of the three open threads). The **setup-visibility tailer** (#2 — surfacing red-castle's now-unified setup log into `current.last_event_at`/stage so the monitor sees setup) and the **live cost confirm** (#1 — now unblocked: an apps/dev worker can finally pass validation, land, and populate `cost_usd`) are the immediate next steps.

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/719"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783808669&installation_id=129708444&pr_number=719&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F719&signature=5856297095c069960e3c349e2602c2854c8696ff89824fe01da14b2e893370ab"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

## Commits

- fix(afk): cure the supervisor.test.ts OOM and gate the apps/dev suite…

## Files changed

- `.github/workflows/red-workspace-ci.yml`
- `.github/workflows/red-workspace-typecheck.yml`
- `apps/dev/tests/supervisor.test.ts`

