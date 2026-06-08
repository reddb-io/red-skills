---
title: Context packs render pinned core context
type: source
tags: [pr, merged]
created: 2026-06-05
updated: 2026-06-05
sources: [pr-494]
pr: 494
merge_sha: 3640dc7859594349aa27c10404e216d2dd437679
---

# Context packs render pinned core context

- **PR:** [#494](https://github.com/reddb-io/red-skills/pull/494)
- **Author:** @filipeforattini
- **Merge SHA:** `3640dc7859594349aa27c10404e216d2dd437679`
- **Format:** merged pull request

## Summary

Closes #487.

## Summary
- add a pinned coreContext projection to Memory context packs
- render core context first in markdown/viewer/Workbench surfaces while suppressing duplicate ordinary previews
- preserve citation, confidence, trust, importance, and warning metadata
- refresh stale Workbench expectations for current reference-radar naming/copy

## Validation
- pnpm --dir src/apps/memory exec vitest run tests/context-pack.test.ts
- pnpm --dir src/apps/memory exec tsc -p tsconfig.json --noEmit
- pnpm --dir src/apps/memory exec vitest run
- pnpm --dir src/apps/memory exec vitest run --config vitest.integration.config.ts tests/context-pack-cli.test.ts tests/workbench.test.ts tests/mcp-server.test.ts

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/494"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783250024&installation_id=129708444&pr_number=494&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F494&signature=ca0455c937599e624dae18bb676635badee942b4ebd1ce87862ef1835e17b14b"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

## Release Notes

* **New Features**
  * Introduced "Core Context" section to prioritize key information in context packs.
  * Enhanced metadata display with trust, importance, and provenance details for each entry.

* **Tests**
  * Added comprehensive test coverage for core context selection and rendering behavior.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- feat(memory): render pinned core context in context packs

## Files changed

- `src/apps/memory/src/context-pack-viewer.ts`
- `src/apps/memory/src/context-pack.ts`
- `src/apps/memory/src/workbench.ts`
- `src/apps/memory/tests/context-pack.test.ts`
- `src/apps/memory/tests/workbench.test.ts`

