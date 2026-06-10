---
title: feat(brain): scheduled channel-event ingestion with cursor-state persistence (#476)
type: source
tags: [pr, merged]
created: 2026-06-10
updated: 2026-06-10
sources: [pr-654]
pr: 654
merge_sha: 7a0d86e9d8c4f14e3ea620158a4180e2bc371521
---

# feat(brain): scheduled channel-event ingestion with cursor-state persistence (#476)

- **PR:** [#654](https://github.com/reddb-io/red-skills/pull/654)
- **Author:** @filipeforattini
- **Merge SHA:** `7a0d86e9d8c4f14e3ea620158a4180e2bc371521`
- **Format:** merged pull request

## Summary

## Summary

- Adds `scheduledIngest` function that wraps `ingestEvents` with cursor-state persistence, allowing repeated polls to pick up only new events
- Adds `loadIngestionState`/`saveIngestionState` helpers for reading/writing a JSON cursor file (creates parent dirs, tolerates missing file)
- Wires up a `schedule-ingest` CLI command in `brain` that loads state, runs a poll, and saves the updated cursor + timestamp

## Acceptance criteria coverage

- Scheduled job polls events via ChannelBridge and captures them as `kind:event` artifacts ✅
- EventArtifactMapper maps events with provenance and stable dedup hash ✅ (landed in prior commit on main)
- Re-polling identical events does not create duplicate artifacts ✅ (store-level hash dedup + ingestEvents skip counter)
- Gateway daemon required only for ingestion; outbound `brain act` remains daemon-free ✅
- Unit tests cover event→artifact mapping and dedup-hash stability with no live Hermes ✅ (9 new tests, 58 total pass)

## Test plan

- [ ] `pnpm test --run` in `src/apps/brain` → all 58 tests pass
- [ ] `pnpm exec tsc --noEmit` → no type errors
- [ ] `brain schedule-ingest` CLI command listed in `brain help`

Closes #476

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/654"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783695412&installation_id=129708444&pr_number=654&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F654&signature=eb7c89f48a79672c9820397044f465bc650d80d29a373bc42c56ae895ac6180b"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

* **New Features**
  * Added `schedule-ingest` CLI command for managing data ingestion operations with configurable session keys and limit options
  * Ingestion state is now automatically persisted, enabling resumable operations with progress tracking

* **Tests**
  * Added comprehensive test coverage for scheduled ingestion workflows and state persistence

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- feat(brain): add scheduled ingestion with cursor-state persistence (#…

## Files changed

- `src/apps/brain/src/cli.ts`
- `src/apps/brain/src/scheduled-ingestion.ts`
- `src/apps/brain/tests/scheduled-ingestion.test.ts`

