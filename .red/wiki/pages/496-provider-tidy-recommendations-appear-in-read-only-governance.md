---
title: Provider tidy recommendations appear in read-only governance
type: source
tags: [pr, merged]
created: 2026-06-05
updated: 2026-06-05
sources: [pr-496]
pr: 496
merge_sha: a3e002d9e9b1aae1d3ae80136b1dbe22a6639024
---

# Provider tidy recommendations appear in read-only governance

- **PR:** [#496](https://github.com/reddb-io/red-skills/pull/496)
- **Author:** @filipeforattini
- **Merge SHA:** `a3e002d9e9b1aae1d3ae80136b1dbe22a6639024`
- **Format:** merged pull request

## Summary

Closes #489.

## Summary
- add read-only provider-backed tidy recommendations to memory governance
- limit provider output to bounded duplicate/near-duplicate SOFT_MERGE/SAME_AS recommendations
- expose counts/samples through CLI, MCP summaries, HTTP JSON, Workbench, and governance viewer
- keep provider failure/malformed output degraded without mutating graph/doc/recall data

## Validation
- pnpm -C src/apps/memory typecheck
- pnpm -C src/apps/memory exec vitest run --config vitest.integration.config.ts tests/governance.test.ts
- pnpm -C src/apps/memory exec vitest run --config vitest.integration.config.ts tests/mcp-server.test.ts tests/http-server.test.ts tests/workbench.test.ts
- pnpm -C src/apps/memory exec vitest run tests/operations-registry.test.ts tests/provider-review-artifacts.test.ts
- pnpm -C src/apps/memory exec vitest run --config vitest.integration.config.ts tests/memory-merge-pass.test.ts

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/496"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783252131&installation_id=129708444&pr_number=496&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F496&signature=b9227b23f5cda2ef5ab8dbdde94aded6c1ecfe50594a37e906a41c65e7ea74fa"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

## Commits

- feat(memory): surface provider tidy recommendations in governance

## Files changed

- `src/apps/memory/src/cli.ts`
- `src/apps/memory/src/governance-tidy.ts`
- `src/apps/memory/src/governance-viewer.ts`
- `src/apps/memory/src/governance.ts`
- `src/apps/memory/src/mcp-server.ts`
- `src/apps/memory/src/operations.ts`
- `src/apps/memory/src/workbench.ts`
- `src/apps/memory/tests/governance.test.ts`

