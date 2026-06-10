---
title: feat(brain): scheduled channel-event ingestion via EventArtifactMapper (#476)
type: source
tags: [pr, merged]
created: 2026-06-10
updated: 2026-06-10
sources: [pr-653]
pr: 653
merge_sha: 6294a296837efd83c6336d7964e7839f6165f0d2
---

# feat(brain): scheduled channel-event ingestion via EventArtifactMapper (#476)

- **PR:** [#653](https://github.com/reddb-io/red-skills/pull/653)
- **Author:** @filipeforattini
- **Merge SHA:** `6294a296837efd83c6336d7964e7839f6165f0d2`
- **Format:** merged pull request

## Summary

## Summary

- Adds `scheduledIngest` in `src/apps/brain/src/scheduled-ingestion.ts` — polls the ChannelBridge, delegates to `ingestEvents`, and persists a cursor + `lastRunAt` for incremental polling across runs
- Adds `loadIngestionState` / `saveIngestionState` helpers for JSON-file cursor persistence
- Wires a new `schedule-ingest` CLI command in `src/apps/brain/src/cli.ts` that loads state, runs ingestion, and saves the updated cursor back to disk

All dedup is handled by the store's content-hash gate (`store.capture()` returns existing artifacts on hash collision) with an additional RID-set check in `ingestEvents` to distinguish skip vs. capture counts.

Closes #476

## Test plan

- [ ] `pnpm --filter @reddb-io/brain test` — 58 tests, all pass (7 test files)
- [ ] Cursor advances across successive runs with a real next-cursor from the bridge
- [ ] Identical events polled twice increment `skipped`, not `captured`, on the second run
- [ ] `lastRunAt` is set on every run
- [ ] `schedule-ingest --state /path/to/state.json` loads, runs, and persists state

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/653"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783694701&installation_id=129708444&pr_number=653&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F653&signature=f3a1caa2bd9d08c8dc679ab9b9a8e62c83bee7a17fcd3590970e93a4c20191f6"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

* **New Features**
  * Added `schedule-ingest` CLI command with configuration options (`--session-key`, `--limit`, `--state`) to manage scheduled ingestion operations.
  * Added persistent state management for ingestion operations, allowing state to be saved and restored across runs.

* **Tests**
  * Added test coverage for scheduled ingestion functionality.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- feat(brain): add scheduled ingestion with cursor-state persistence (#…

## Files changed

- `src/apps/brain/src/cli.ts`
- `src/apps/brain/src/scheduled-ingestion.ts`
- `src/apps/brain/tests/scheduled-ingestion.test.ts`

