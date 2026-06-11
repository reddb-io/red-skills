---
title: feat(afk): canonicalize worker-vitals names + last_event_at liveness clock (S1 #708)
type: source
tags: [pr, merged]
created: 2026-06-11
updated: 2026-06-11
sources: [pr-712]
pr: 712
merge_sha: f9ce3d1c156e27e6677a86d283cdffa56467d3f8
---

# feat(afk): canonicalize worker-vitals names + last_event_at liveness clock (S1 #708)

- **PR:** [#712](https://github.com/reddb-io/red-skills/pull/712)
- **Author:** @filipeforattini
- **Merge SHA:** `f9ce3d1c156e27e6677a86d283cdffa56467d3f8`
- **Format:** merged pull request

## Summary

Closes #708. Slice S1 of PRD #706 (WorkerVitals canonical vocabulary, ADR 0065) — the heart of the rename.

## Renames (one-release back-compat read shim in `parseState`)
- `thinking_called_count` → **`reasoning_events`**
- `diff_added`/`diff_removed` collapsed into **`loc_added`/`loc_removed`** (single canonical name)
- `last_progress_at` → **`last_commit_at`** (it tracks commits, not generic progress)

## New: the honest liveness clock
- **`last_event_at`** — stamped on every DISCRETE stream event (tool/reasoning/usage, not per-text-chunk) in `recordAgentEvent`. Advances every few seconds for an exploring-but-not-committing worker, so `silent_for_s` (now − last_event_at) is the true stuck signal, distinct from `last_commit_at`. The attempt-progress guard's **ABORT** logic stays commit-anchored (ADR 0044) — only the displayed clock changes.

## S2 usage integration (forced, necessary)
S1 branches from main-with-S2, so apps/dev's re-exported `AgentStreamEvent` now includes the `usage` variant. The sink integrates it minimally (msg formatting, activity-meter accepts-but-ignores it as a cost meta-event, `last_event_at`) so the bundle **typechecks** against the usage-emitting red-castle. `core-regression-gate` runs vitest (no tsc), so this was a latent typecheck break. Full cost persistence is **S3 (#709)**.

## Back-compat
- `parseState` maps legacy keys → canonical on read (state file is ephemeral; bridges the upgrade window). Removed one release after this.
- statePatch (live state) is **canonical-only**; the firehose `extra` keeps legacy aliases for one release.

## Tests
Updated heartbeat statePatch/extra assertions; +2 new state shim tests (legacy→canonical read, canonical-wins). Full apps/dev suite green (1235 pass; the lone `args.test.ts` failure is the pre-existing `cli-args-parser` worktree-resolution artifact, unrelated).

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/712"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783784613&installation_id=129708444&pr_number=712&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F712&signature=e963bb700a9434667a757e134d210e8d659756a8e463a503254c0a10d2803247"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

* **Improvements**
  * Enhanced activity monitoring with improved tracking of reasoning and usage events.
  * Refined liveness timing updates across different event types for more accurate monitoring.
  * Standardized metric naming and fields for better consistency in telemetry data.

* **Bug Fixes**
  * Added legacy data migration to ensure smooth compatibility with previous state formats.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- feat(afk): canonicalize worker-vitals names + add the last_event_at l…

## Files changed

- `apps/dev/src/commands/run.ts`
- `apps/dev/src/core/activity-meter.ts`
- `apps/dev/src/core/heartbeat.ts`
- `apps/dev/src/core/state.ts`
- `apps/dev/src/runtime/wire.ts`
- `apps/dev/src/types/state.ts`
- `apps/dev/tests/heartbeat.test.ts`
- `apps/dev/tests/state.test.ts`

