---
title: feat(afk): statusline worker liveness + WorkerVitals vocab (ADR 0065)
type: source
tags: [pr, merged]
created: 2026-06-11
updated: 2026-06-11
sources: [pr-705]
pr: 705
merge_sha: d9f207ccc8c13a5845efc765cc766433f9fa5399
---

# feat(afk): statusline worker liveness + WorkerVitals vocab (ADR 0065)

- **PR:** [#705](https://github.com/reddb-io/red-skills/pull/705)
- **Author:** @filipeforattini
- **Merge SHA:** `d9f207ccc8c13a5845efc765cc766433f9fa5399`
- **Format:** merged pull request

## Summary

First vertical slice of the **AFK worker-vitals canonical vocabulary** (ADR 0065, proposed in this PR).

## What this slice does
- **Persists the activity counters.** `updateState` round-trips state through `AfkCurrentSchema` before writing, which silently stripped the heartbeat's `tools_called_count` / `waiting_count` / etc. — so they never survived in `afk.state.json`. Declaring them on `AfkCurrentSchema` unblocks both write and read. No `run.ts` change: the heartbeat already emitted them.
- **Surfaces liveness on the statusline.** Each `#N` issue token now carries its `current.stage` (`#629·impl`), and a `💤N` token shows summed `waiting_count` (heartbeat windows with zero new stream events — the clean silent-agent signal). Both are optional, so the legacy render is byte-for-byte unchanged for callers that don't populate them.

## ADR 0065 (proposed, in this PR)
Defines the canonical `WorkerVitals` vocabulary the whole chain (red-castle → state → statusline/monitor/dashboard) should speak: one name per signal, a single translation boundary in `apps/dev`. Kills the drift (`thinking_called_count`→`reasoning_events`, drop the `diff_*`/`loc_*` alias, `last_progress_at`→`last_commit_at`), adds the honest `last_event_at` liveness clock and per-worker `cost` from red-castle's `usage` event. The full migration is tracked by a follow-up PRD.

## Tests
`statusline` (28, +4 new), `state` (3), `wire` (28), `heartbeat` (23), `activity-meter` (9) — all green.

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/705"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783781475&installation_id=129708444&pr_number=705&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F705&signature=e457b32e7ba8894303eb2eb93f6b4fb5a7a7aa61eaf4172a05f7318515778a4e"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->
## Summary by CodeRabbit

* **New Features**
  * AFK statusline now shows waiting worker count (💤) and per-issue progress stages for clearer agent activity.

* **Documentation**
  * Added ADR establishing a canonical WorkerVitals vocabulary to standardize lifecycles, liveness timing, and per-worker cost/token fields.

* **Tests**
  * Added tests for stage rendering, waiting-count behavior, and backward-compatible rendering when new fields are absent.
<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- feat(afk): surface worker liveness on the statusline + propose vitals…

## Files changed

- `.red/adr/0065-afk-worker-vitals-canonical-vocabulary.md`
- `.red/adr/INDEX.md`
- `apps/dev/src/core/statusline.ts`
- `apps/dev/src/runtime/wire.ts`
- `apps/dev/src/types/state.ts`
- `apps/dev/tests/statusline.test.ts`

