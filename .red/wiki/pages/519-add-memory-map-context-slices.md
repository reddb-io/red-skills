---
title: Add Memory map context slices
type: source
tags: [pr, merged]
created: 2026-06-06
updated: 2026-06-06
sources: [pr-519]
pr: 519
merge_sha: e43099c28975cc73de5dac3febce6cb6900926ec
---

# Add Memory map context slices

- **PR:** [#519](https://github.com/reddb-io/red-skills/pull/519)
- **Author:** @filipeforattini
- **Merge SHA:** `e43099c28975cc73de5dac3febce6cb6900926ec`
- **Format:** merged pull request

## Summary

## Summary
- add `memory map-context` to build Graphify-style compact RedDB graph slices for code-agent routing
- expose `memory_map_context` through the read-only operation registry and MCP structured content
- update routing guidance and Memory glossary to keep UI decisions in red-ui and Brain disconnected from Memory map

## Validation
- `pnpm --dir src/apps/memory typecheck`
- `pnpm --dir src/apps/memory exec vitest run tests/map-context.test.ts tests/operations-registry.test.ts`
- `pnpm --dir src/apps/memory exec vitest run --config vitest.integration.config.ts tests/routing-guide.test.ts`
- `pnpm --dir src/apps/memory exec vitest run --config vitest.integration.config.ts tests/mcp-server.test.ts`
- CLI smoke: `memory init/store/map-context --json` against a temp graph store

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/519"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783363903&installation_id=129708444&pr_number=519&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F519&signature=ef99e3896781215ac67af8ed3b0d88869b18160da313e875e5cb6312f1b06fd5"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->
## Summary by CodeRabbit

* **New Features**
  * Added a memory map context query: graph-based traversal with configurable depth, BFS/DFS mode, context filters, token-budgeted markdown output, and optional JSON; available via CLI and MCP.

* **Documentation**
  * Expanded glossary and clarified memory map concepts, relationships, scoring (weight vs salience), caching, and separation from Brain.

* **Tests**
  * Added end-to-end and unit tests covering traversal, filtering, scoring, output truncation, and MCP/CLI integration.
<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- Add memory map context slices

## Files changed

- `.red/contexts/memory/CONTEXT.md`
- `src/apps/memory/src/cli.ts`
- `src/apps/memory/src/map-context.ts`
- `src/apps/memory/src/mcp-server.ts`
- `src/apps/memory/src/operations.ts`
- `src/apps/memory/src/routing-guide.ts`
- `src/apps/memory/tests/map-context.test.ts`
- `src/apps/memory/tests/mcp-server.test.ts`
- `src/apps/memory/tests/operations-registry.test.ts`
- `src/apps/memory/tests/routing-guide.test.ts`

