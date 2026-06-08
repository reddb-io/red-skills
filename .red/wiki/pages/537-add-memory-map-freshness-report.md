---
title: Add Memory map freshness report
type: source
tags: [pr, merged]
created: 2026-06-07
updated: 2026-06-07
sources: [pr-537]
pr: 537
merge_sha: e81e6e72738a3ddc87fcea00cecc16a3cb247012
---

# Add Memory map freshness report

- **PR:** [#537](https://github.com/reddb-io/red-skills/pull/537)
- **Author:** @filipeforattini
- **Merge SHA:** `e81e6e72738a3ddc87fcea00cecc16a3cb247012`
- **Format:** merged pull request

## Summary

Closes #525.\n\n## Summary\n- add a read-only Memory map freshness report with source revision, extractor identity, source input freshness, extraction coverage, relationship gaps, and next actions\n- expose it through `memory map freshness`, the read-only operation registry/MCP tool, and `/api/map/freshness`\n- cover clean, changed, stale, CLI JSON, and registry contracts\n\n## Validation\n- `pnpm vitest run tests/map-freshness.test.ts tests/operations-registry.test.ts`\n- `pnpm typecheck`

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/537"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783385738&installation_id=129708444&pr_number=537&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F537&signature=919cf5575e707e4faec02964e11a97dbe1d7d3a15d401a5a3bcc13600e133056"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

## New Features
* Added `memory map freshness` CLI command with optional `--root` and `--json` flags for diagnostics
* Added HTTP GET endpoint `/api/map/freshness` for retrieving memory map freshness reports
* Added new read-only operation for analyzing map freshness with diagnostic recommendations

## Tests
* Added comprehensive test coverage for map freshness functionality and CLI integration

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- Add memory map freshness report

## Files changed

- `src/apps/memory/src/cli.ts`
- `src/apps/memory/src/http-server.ts`
- `src/apps/memory/src/ingest.ts`
- `src/apps/memory/src/map-freshness.ts`
- `src/apps/memory/src/operations.ts`
- `src/apps/memory/tests/map-freshness.test.ts`
- `src/apps/memory/tests/operations-registry.test.ts`

