---
title: feat(brain): add scheduled ingestion with cursor-state persistence (#476)
type: source
tags: [pr, merged]
created: 2026-06-10
updated: 2026-06-10
sources: [pr-650]
pr: 650
merge_sha: 718213de0cc2bd017035aba3a396ce678399a6e9
---

# feat(brain): add scheduled ingestion with cursor-state persistence (#476)

- **PR:** [#650](https://github.com/reddb-io/red-skills/pull/650)
- **Author:** @filipeforattini
- **Merge SHA:** `718213de0cc2bd017035aba3a396ce678399a6e9`
- **Format:** merged pull request

## Summary

Closes #476

## Summary

- Add `scheduledIngest()`: wraps `ingestEvents` with `IngestionState` tracking so successive cron/scheduled runs automatically advance the poll cursor
- Add `loadIngestionState()` / `saveIngestionState()` to persist `cursor + lastRunAt` across invocations (defaults to `.red/brain/ingestion-state.json`)
- Wire `brain schedule-ingest [--session-key KEY] [--limit N] [--state PATH]` CLI command as the entry point for scheduled ingestion

## Test plan

- [ ] All 46 brain tests pass (`pnpm test` in `src/apps/brain`)
- [ ] 9 new `scheduled-ingestion.test.ts` tests: cursor advancement, successive-run forwarding, cursor retention, cross-run dedup, `lastRunAt`, state-file round-trip
- [ ] `brain schedule-ingest` requires hermes gateway only for ingestion; outbound commands remain daemon-free

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/650"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783692871&installation_id=129708444&pr_number=650&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F650&signature=92a027de9a265d7960e11bef40dbb1eb140addcc36c57a75fbf0107c59a9c12b"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

* **New Features**
  * Added `schedule-ingest` CLI command for orchestrating scheduled ingestion tasks with support for `--session-key`, `--limit`, and `--state` flags.
  * Implemented ingestion state management with cursor tracking and timestamp recording to track scheduling progress across runs.
  * Command output is provided as JSON for programmatic consumption.

* **Tests**
  * Added comprehensive test coverage for scheduled ingestion functionality, including cursor advancement, deduplication, and state persistence.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- feat(brain): add scheduled ingestion with cursor-state persistence (#…

## Files changed

- `src/apps/brain/src/cli.ts`
- `src/apps/brain/src/scheduled-ingestion.ts`
- `src/apps/brain/tests/scheduled-ingestion.test.ts`

