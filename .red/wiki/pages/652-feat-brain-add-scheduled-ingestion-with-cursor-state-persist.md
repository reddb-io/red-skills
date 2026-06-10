---
title: feat(brain): add scheduled ingestion with cursor-state persistence (#476)
type: source
tags: [pr, merged]
created: 2026-06-10
updated: 2026-06-10
sources: [pr-652]
pr: 652
merge_sha: 1d61152e1d27a7efdd7f71a3d415dda09117ae5c
---

# feat(brain): add scheduled ingestion with cursor-state persistence (#476)

- **PR:** [#652](https://github.com/reddb-io/red-skills/pull/652)
- **Author:** @filipeforattini
- **Merge SHA:** `1d61152e1d27a7efdd7f71a3d415dda09117ae5c`
- **Format:** merged pull request

## Summary

## Summary

- Adds `scheduledIngest()` which wraps `ingestEvents()` with cursor-state persistence: saves cursor + `lastRunAt` between runs so re-polls advance from where the last run stopped
- Wires two CLI commands: `brain ingest-events` (stateless, one-shot) and `brain schedule-ingest` (stateful, reads/writes a JSON state file alongside the brain store)
- All state I/O (`loadIngestionState` / `saveIngestionState`) is isolated so it can be injected or mocked in tests

## Test plan

- [ ] `pnpm test` in `src/apps/brain` — 58 tests pass across 7 suites
- [ ] `scheduled-ingestion.test.ts` (9 tests): cursor advance, cursor retention when absent, dedup across runs, `lastRunAt` written on each run
- [ ] `ingest-events.test.ts` (7 tests): event capture, dedup, provenance metadata, cursor pass-through
- [ ] `event-artifact-mapper.test.ts` (9 tests): stable dedup hash, mapping correctness

Closes #476

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/652"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783694287&installation_id=129708444&pr_number=652&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F652&signature=e8be5182da6e30983172b66c8b135b89afa0175b23bd14803a2c08485e5f1c01"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

## Release Notes

* **New Features**
  * Added `schedule-ingest` command to the CLI with optional flags for session key configuration, event limit, and custom state file path for managing scheduled event ingestion.

* **Tests**
  * Added comprehensive test coverage for scheduled ingestion functionality and state persistence.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- feat(brain): add scheduled ingestion with cursor-state persistence (#…

## Files changed

- `src/apps/brain/src/cli.ts`
- `src/apps/brain/src/scheduled-ingestion.ts`
- `src/apps/brain/tests/scheduled-ingestion.test.ts`

