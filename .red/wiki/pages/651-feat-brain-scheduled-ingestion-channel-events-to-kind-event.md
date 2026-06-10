---
title: feat(brain): scheduled ingestion — channel events to kind:event artifacts (#476)
type: source
tags: [pr, merged]
created: 2026-06-10
updated: 2026-06-10
sources: [pr-651]
pr: 651
merge_sha: 888f2b4349b366fb9c2d85a07137f28f632b58fe
---

# feat(brain): scheduled ingestion — channel events to kind:event artifacts (#476)

- **PR:** [#651](https://github.com/reddb-io/red-skills/pull/651)
- **Author:** @filipeforattini
- **Merge SHA:** `888f2b4349b366fb9c2d85a07137f28f632b58fe`
- **Format:** merged pull request

## Summary

## Summary

- Adds `scheduledIngest` function that wraps `ingestEvents` with cursor-state persistence, enabling idempotent incremental polling
- Adds `loadIngestionState` / `saveIngestionState` helpers for persisting cursor position between runs
- Wires `brain schedule-ingest` CLI command that loads state, runs ingestion, saves updated state, and prints a JSON result

The EventArtifactMapper (already landed) handles the event→artifact mapping with dedup hash stability; the `ingestEvents` layer (also already landed) handles polling and dedup via `sourceSession`. This PR adds the scheduled-run wrapper on top.

## Acceptance criteria coverage

- [x] Scheduled job polls events via ChannelBridge and captures them as `kind:event` artifacts
- [x] EventArtifactMapper maps an event to an artifact with provenance and stable dedup hash
- [x] Re-polling identical events does not create duplicate artifacts (9 tests cover cursor + dedup behaviour)
- [x] Gateway daemon required only for ingestion; outbound actions remain daemon-free
- [x] Unit tests cover event→artifact mapping and dedup-hash stability (no live Hermes)

## Test plan

- [ ] `pnpm test` in `src/apps/brain` — all 58 tests pass
- [ ] `brain schedule-ingest` CLI command reachable and documented in `brain help`

Closes #476

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/651"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783693952&installation_id=129708444&pr_number=651&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F651&signature=944716d91e2170e8f024daa4e447cca7f89dfea792bc931c5bcb2f47cc335c29"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

* **New Features**
  * Added `schedule-ingest` CLI command for scheduled event ingestion with progress tracking.
  * Supports configurable options for session filtering, result limits, and persistent state management across runs.

* **Tests**
  * Added comprehensive test suite for scheduled ingestion functionality.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- feat(brain): add scheduled ingestion with cursor-state persistence (#…

## Files changed

- `src/apps/brain/src/cli.ts`
- `src/apps/brain/src/scheduled-ingestion.ts`
- `src/apps/brain/tests/scheduled-ingestion.test.ts`

