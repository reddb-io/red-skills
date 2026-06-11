---
title: fix(afk): seed attempt state synchronously so the worker's identity survives (monitor/statusline ghost)
type: source
tags: [pr, merged]
created: 2026-06-11
updated: 2026-06-11
sources: [pr-721]
pr: 721
merge_sha: 404ecab55708629e156e558fbff044f107486bf7
---

# fix(afk): seed attempt state synchronously so the worker's identity survives (monitor/statusline ghost)

- **PR:** [#721](https://github.com/reddb-io/red-skills/pull/721)
- **Author:** @filipeforattini
- **Merge SHA:** `404ecab55708629e156e558fbff044f107486bf7`
- **Format:** merged pull request

## Summary

## What a live fleet exposed
Worker wL30L's #583 attempt state had every **vital** (cost $4.01, loc +151/-21, stage) but **empty identity** — `pid=0`, `worker_id=''`, `current.number=''`, `started_at=''`. So:
- the monitor rendered it as a `? [stale] … idle issues 0/0` ghost,
- the statusline dropped it entirely (the `isStateActive` filter needs a live pid),
- and the $4.01 cost existed on disk but was visible nowhere.

Its sibling #585 attempt was perfectly populated — a **non-deterministic race**.

## Root cause
`buildProcessInput` seeded the attempt state with a **fire-and-forget async `initState`**, while the agent-event sink + heartbeat fire async `updateState` read-modify-writes against the **same path**. When a sink write read the file *before* the seed landed, it got the schema **DEFAULT** (empty identity), patched only its vitals, and wrote that back. Every later read then preserved the empty identity — vitals accrue, identity stays blank.

## Fix
New **`initStateSync`** (synchronous `writeFileSync`+rename) seeds the identity **before any `updateState` can run**, so reads always see pid/number/worker_id. Wrapped best-effort so a seed failure never blocks the worker. One `void initState` → `initStateSync` at the attempt-start seam; red-castle untouched.

This is the single root cause of three reported symptoms: **empty `current.number`**, **`pid=0` during the run**, and the monitor **`? idle` ghost**.

## Validation
- typecheck clean; state tests green incl. a new seed→patch test proving identity survives.

## Note on the '2nd slot' observation
The same fleet run showed wL30L draining #583 **and** #585 sequentially (two attempt dirs, one worker) — not a second concurrent worker. That points to the GitHub search-index propagation lag at boot (the queue read 0-ready right after labeling), so the supervisor spawned for the one visible issue. Operational (wait for propagation before launching) rather than a code defect; to be confirmed on the next fleet run.

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/721"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783812672&installation_id=129708444&pr_number=721&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F721&signature=2536253e87ba31386ddd5d16eec899de258844a6b3cc761b74c31e491ea678cd"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

## Release Notes

* **Bug Fixes**
  * Fixed a race condition where concurrent operations could access the application state before it was fully initialized, potentially resulting in incomplete or missing identity data being persisted. State initialization now completes synchronously before other operations can proceed.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- fix(afk): seed attempt state synchronously so the worker's identity s…

## Files changed

- `apps/dev/src/commands/run.ts`
- `apps/dev/src/core/state.ts`
- `apps/dev/tests/state.test.ts`

