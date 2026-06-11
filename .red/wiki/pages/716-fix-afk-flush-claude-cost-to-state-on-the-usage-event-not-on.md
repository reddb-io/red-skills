---
title: fix(afk): flush claude cost to state on the usage event (not only on the heartbeat)
type: source
tags: [pr, merged]
created: 2026-06-11
updated: 2026-06-11
sources: [pr-716]
pr: 716
merge_sha: 5f7c1a5233e23ae5605e080ceb3451e1876ec19c
---

# fix(afk): flush claude cost to state on the usage event (not only on the heartbeat)

- **PR:** [#716](https://github.com/reddb-io/red-skills/pull/716)
- **Author:** @filipeforattini
- **Merge SHA:** `5f7c1a5233e23ae5605e080ceb3451e1876ec19c`
- **Format:** merged pull request

## Summary

## The bug a live run surfaced
After v1.200.1 (claude emits a `usage` stream event), a real claude AFK run on #584 STILL persisted `cost_usd=0`. Instrumentation proved the event fires correctly end-to-end — `agent.log.jsonl` logged `kind:usage` exactly once with the `💰` message — but none of the 7 heartbeat records captured the cost.

**Root cause:** the cost group reaches the state file ONLY through the ~60s heartbeat's `activityMeter.snapshotWindow()`. Claude's usage arrives **exactly once**, on the terminal `result` line — *after* the last heartbeat poll and right before the agent exits. The heartbeat loop stops at completion, so it never folds the cost in. The meter had the value; the state never saw it.

## Fix
In the agent-event sink, when a `usage` event lands, flush `current.input_tokens/output_tokens/cost_usd` straight from `activityMeter.peek()` (next to the existing `last_event_at` stamp) instead of waiting for a heartbeat that won't come. Idempotent for codex — it emits many usage events and each re-stamps the cumulative total.

## Validation
- apps/dev typecheck clean (only the known environmental `cli-args-parser` worktree artifact); activity-meter tests green.
- Live re-run to confirm `cost_usd` > 0 follows once this releases.

Completes the cost-vitals chain started in #715. Found while studying a live 1.200.1 run via supervisor/monitor.

### Bonus finding (not in this PR)
The same #584 run's landing failed `blocked:validation` because `pnpm -C apps/dev test` crashed in ~49ms — the `supervisor.test.ts` OOM (#446). That's the real reason apps/dev AFK work keeps parking, and exactly why the new typecheck CI gate (#715) excludes `pnpm test`. #446 still blocks any apps/dev AFK landing.

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/716"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783804757&installation_id=129708444&pr_number=716&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F716&signature=e9911aa5193192cc98ab7dbe735b30cbef68e715a45f9780e8848746992584d4"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

* **Bug Fixes**
  * Improved real-time tracking and persistence of cost and token metrics during agent operations.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- fix(afk): flush claude cost to state on the usage event, not only on …

## Files changed

- `apps/dev/src/commands/run.ts`

