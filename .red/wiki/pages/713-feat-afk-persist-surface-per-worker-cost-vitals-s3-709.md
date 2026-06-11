---
title: feat(afk): persist + surface per-worker cost vitals (S3 #709)
type: source
tags: [pr, merged]
created: 2026-06-11
updated: 2026-06-11
sources: [pr-713]
pr: 713
merge_sha: 3669ef2469850037ec4b9db2f0fbe0c7ceb84656
---

# feat(afk): persist + surface per-worker cost vitals (S3 #709)

- **PR:** [#713](https://github.com/reddb-io/red-skills/pull/713)
- **Author:** @filipeforattini
- **Merge SHA:** `3669ef2469850037ec4b9db2f0fbe0c7ceb84656`
- **Format:** merged pull request

## Summary

Closes #709. Slice S3 of PRD #706 (WorkerVitals canonical vocabulary, ADR 0065).

## What this does
Consumes red-castle's `usage` stream event (delivered by S2 #707) in the apps/dev sink and persists the **WorkerVitals cost group** on `current.*`: `input_tokens`, `output_tokens`, `cost_usd`.

- **activity-meter** sums usage events into cumulative `inputTokens`/`outputTokens`/`costUsd` — usage is summed for cost but **not** counted as a tool/text/reasoning liveness unit (a usage-only window still counts as waiting).
- **heartbeat** persists the cost group on `current.*` + firehose `extra`, and appends `tok:in/out $cost` to the afk.log tail.
- **state schema** gains `input_tokens`/`output_tokens`/`cost_usd`.
- **statusline** renders `🪙<tokens>` (humanized) + `💵$<cost>` (only when the runner reports USD).
- **monitor** per-worker line appends `tok:in/out $cost`.

## Per-runner
codex/opencode feed cost live via the `usage` stream event; claude's usage arrives at the iteration boundary (not the stream), so a pure-claude attempt accrues 0 here — claude live cost is a follow-up.

## Tests
+2 activity-meter cases (usage accumulation; usage-only window is waiting), +1 statusline case (🪙/💵 render), +1 monitor case (per-worker spend); heartbeat fixtures assert the cost group. Full apps/dev suite green (1241 pass; the lone `args.test.ts` failure is the pre-existing `cli-args-parser` worktree-resolution artifact, unrelated).

After this, **S4 (#710)** — the shared `WorkerVitals` type + drift-guard contract test — is the last slice.

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/713"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783788168&installation_id=129708444&pr_number=713&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F713&signature=78a1171a2ca66aac658835ea5c237aaa1372ab85902adbfc1597211c51bb4618"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

* **New Features**
  * Added token usage tracking and cost metrics across monitoring dashboards
  * Per-worker token counts (input/output) and USD costs now displayed in real-time views
  * Fleet-wide aggregated token spend and cost reporting added to status monitoring
  * Token and cost information conditionally rendered in activity displays when available

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- feat(afk): persist + surface the per-worker cost vitals (S3 #709)

## Files changed

- `apps/dev/src/core/activity-meter.ts`
- `apps/dev/src/core/heartbeat.ts`
- `apps/dev/src/core/monitor.ts`
- `apps/dev/src/core/statusline.ts`
- `apps/dev/src/runtime/wire.ts`
- `apps/dev/src/types/state.ts`
- `apps/dev/tests/activity-meter.test.ts`
- `apps/dev/tests/heartbeat.test.ts`
- `apps/dev/tests/monitor.test.ts`
- `apps/dev/tests/statusline.test.ts`

