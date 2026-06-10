---
title: feat(brain): scheduled channel-event ingestion via EventArtifactMapper
type: source
tags: [pr, merged]
created: 2026-06-10
updated: 2026-06-10
sources: [pr-648]
pr: 648
merge_sha: 6cac7cf3e0bd1d9f4e47c3e370e5b93fdfa0996b
---

# feat(brain): scheduled channel-event ingestion via EventArtifactMapper

- **PR:** [#648](https://github.com/reddb-io/red-skills/pull/648)
- **Author:** @filipeforattini
- **Merge SHA:** `6cac7cf3e0bd1d9f4e47c3e370e5b93fdfa0996b`
- **Format:** merged pull request

## Summary

## Summary

Closes #476.

- **EventArtifactMapper** (`src/apps/brain/src/event-artifact-mapper.ts`): maps a `ChannelEvent` to a `CaptureInput` with `kind:event`, `hermes` provenance, and a stable dedup key derived from `event.id` → `cursor` → content hash.
- **ingestEvents()** (`src/apps/brain/src/ingest-events.ts`): polls the `ChannelBridge`, captures each event via `EventArtifactMapper`, and reports `polled`/`captured`/`skipped` counts; re-polling identical events is detected via the store's existing content-hash dedup so no duplicates are created.
- **CLI** (`brain ingest-events [--after-cursor N] [--session-key KEY] [--limit N]`): connects to `McpStdioChannelBridge` (requires the hermes gateway daemon) only for this ingestion command; outbound `brain send` remains daemon-free.

## Acceptance criteria

- [x] A scheduled job polls events via the ChannelBridge and captures them as `kind:event` artifacts
- [x] EventArtifactMapper maps an event to an artifact with provenance and a stable dedup hash
- [x] Re-polling identical events does not create duplicate artifacts
- [x] The gateway daemon is required only for ingestion; outbound actions remain daemon-free
- [x] Unit tests cover the event→artifact mapping and dedup-hash stability (no live Hermes)

## Test plan

- [ ] `pnpm test` in `src/apps/brain` → 37 tests pass (9 mapper + 7 ingest integration + existing store/config/bridge)
- [ ] TypeScript: `pnpm tsc --noEmit` → no errors
- [ ] Dedup: re-polling the same events returns `captured: 0, skipped: N` — covered by `ingest-events.test.ts`

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/648"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783690597&installation_id=129708444&pr_number=648&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F648&signature=be07e50126b403d7cac6d18dbc2a8ed981075bf70b7dd888d3530e0e090ebd24"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

## Commits

- feat(brain): scheduled channel-event ingestion via EventArtifactMappe…

## Files changed

- `src/apps/brain/src/cli.ts`
- `src/apps/brain/src/event-artifact-mapper.ts`
- `src/apps/brain/src/ingest-events.ts`
- `src/apps/brain/tests/event-artifact-mapper.test.ts`
- `src/apps/brain/tests/ingest-events.test.ts`

