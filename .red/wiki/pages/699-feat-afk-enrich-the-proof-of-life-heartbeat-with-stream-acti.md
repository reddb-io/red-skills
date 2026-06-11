---
title: feat(afk): enrich the proof-of-life heartbeat with stream-activity metrics
type: source
tags: [pr, merged]
created: 2026-06-11
updated: 2026-06-11
sources: [pr-699]
pr: 699
merge_sha: cdcc17f0c821c49d6068dbfb1012448c088f88be
---

# feat(afk): enrich the proof-of-life heartbeat with stream-activity metrics

- **PR:** [#699](https://github.com/reddb-io/red-skills/pull/699)
- **Author:** @filipeforattini
- **Merge SHA:** `cdcc17f0c821c49d6068dbfb1012448c088f88be`
- **Format:** merged pull request

## Summary

## What

Slice 1 of richer liveness observability, **entirely in the dev CLI — no red-castle change**. A per-attempt activity meter counts the normalised stream events red-castle already exposes (`toolCall` / `text` via `onAgentStreamEvent`) and derives a *waiting* count. The proof-of-life heartbeat (each ~60s attempt-guard poll) now carries:

- `loc_added` / `loc_removed` — aliases of the existing diff volume
- `tools_called_count` — cumulative `toolCall` events this attempt
- `text_chunk_count` — cumulative `text` events
- `waiting_count` — cumulative heartbeat windows with **zero** new stream events (the agent was blocked/waiting). Rising `waiting` with a flat diff = stuck; rising `tools` = working.

These ride the firehose record `extra`, mirror into `current.*_count` in `afk.state.json`, and append a compact `tools:N text:N wait:N` tail to the `afk.log` line so `tail -f` shows liveness without opening the firehose.

## CLI coverage

Works identically for **claude / codex / opencode** because it consumes the already-normalised `AgentStreamEvent` (text|toolCall) — the same for all three runners. `loc_*` is git-based (CLI-agnostic).

## Deferred to a red-castle slice

`thinking_called_count` and token counts: the raw per-CLI streams carry reasoning/usage but the parsers drop them. Extending the normalised `AgentStreamEvent` is a substrate change (done once for all three runners) — that's slice 2.

## Design note

All fields are additive/optional — a caller that does not observe the stream emits the byte-for-byte pre-metrics record. The heartbeat lives in `apps/dev` (not red-castle) because it is an AFK-policy/observability concern: its inputs (the issue's git base, `afk.state.json`, the attempt-progress guard poll, the firehose) all live AFK-side; red-castle only needs to expose the normalised stream, which it already does.

## Verification

`apps/dev` typecheck clean. 1244/1244 tests pass (85 files; `supervisor.test.ts` excluded for the known environmental OOM). New `activity-meter.test.ts` (6) + heartbeat activity tests (3).

Refs #623

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/699"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783774998&installation_id=129708444&pr_number=699&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F699&signature=71e29af3a0f52e1e40a3c7cee59d5d11456b5bb69ef65eebae68592d2abe6356"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

* **New Features**
  * Progress heartbeats now include per-attempt activity metrics, displaying tool calls executed, text chunks generated, and idle periods for enhanced visibility into agent execution.

* **Tests**
  * Added comprehensive test coverage for activity tracking and heartbeat enrichment functionality.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- feat(afk): enrich the proof-of-life heartbeat with stream-activity me…

## Files changed

- `apps/dev/src/commands/run.ts`
- `apps/dev/src/core/activity-meter.ts`
- `apps/dev/src/core/heartbeat.ts`
- `apps/dev/tests/activity-meter.test.ts`
- `apps/dev/tests/heartbeat.test.ts`

