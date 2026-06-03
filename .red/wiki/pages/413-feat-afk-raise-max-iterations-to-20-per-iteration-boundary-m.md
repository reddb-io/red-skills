---
title: feat(afk): raise max iterations to 20 + per-iteration boundary markers
type: source
tags: [pr, merged]
created: 2026-06-03
updated: 2026-06-03
sources: [pr-413]
pr: 413
merge_sha: c43b97c7ed956e5f7f5ff1f5afb71f16b0599d58
---

# feat(afk): raise max iterations to 20 + per-iteration boundary markers

- **PR:** [#413](https://github.com/reddb-io/red-skills/pull/413)
- **Author:** @filipeforattini
- **Merge SHA:** `c43b97c7ed956e5f7f5ff1f5afb71f16b0599d58`
- **Format:** merged pull request

## Summary

For the heavy-issue no-sentinel pattern (#834/#835/#836 — Rust issues that re-run the full `cargo test` suite each turn, exhaust iterations, and hit the cap with a complete-but-unsignaled mergeable branch):

1. **`DEFAULT_MAX_ITERATIONS` 12 → 20** — headroom for legitimately-heavy issues. Symptom-bound, not the cure (the root fixes — agent emits DONE on green + runtime no-sentinel-mergeable salvage — are tracked separately). Still env-tunable via `RED_AFK_MAX_ITERATIONS`.
2. **Per-agentic-iteration boundary markers** — when sandcastle's re-invocation count ticks, emit `[afk] agent iteration N/max ended` + `… N+1 started` to **afk.log + the firehose** (`type=iteration`, a new SYNTHETIC kind — **never** the agent lane), and advance `current.iteration` in `afk.state.json`. So a run burning through iterations is visible at a glance. Reset per attempt. New `formatIterationMarker()`.

Tests: `heartbeat` (formatIterationMarker N/max, no-max, distinct-from-attempt-marker) + execution/jsonl-log/state/wire green; typecheck clean.

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/413"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783041590&installation_id=129708444&pr_number=413&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F413&signature=bdfd016046b187d1a634001039d2b21950e98be1deeb171da169ed4f4ff0e765"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

* **Improvements**
  * Increased default maximum agent iterations from 12 to 20, providing more capacity for complex tasks.

* **New Features**
  * Added iteration boundary markers in execution logs to track agent progress across iterations.
  * Enhanced observability with current iteration information in execution state.

* **Tests**
  * Added test coverage for iteration boundary marker generation.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- feat(afk): raise max iterations to 20 + emit per-iteration boundary m…

## Files changed

- `src/apps/dev/src/commands/run.ts`
- `src/apps/dev/src/core/execution.ts`
- `src/apps/dev/src/core/heartbeat.ts`
- `src/apps/dev/src/core/jsonl-log.ts`
- `src/apps/dev/src/types/state.ts`
- `src/apps/dev/tests/heartbeat.test.ts`

