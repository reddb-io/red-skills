---
title: Define RedDB Memory map consumer contract
type: source
tags: [pr, merged]
created: 2026-06-07
updated: 2026-06-07
sources: [pr-535]
pr: 535
merge_sha: 0aa861d44f72ace884437885ec5d99c72a86bc64
---

# Define RedDB Memory map consumer contract

- **PR:** [#535](https://github.com/reddb-io/red-skills/pull/535)
- **Author:** @filipeforattini
- **Merge SHA:** `0aa861d44f72ace884437885ec5d99c72a86bc64`
- **Format:** merged pull request

## Summary

Closes #523

## Summary
- Bump the Memory graph consumer contract to v2 with weight, salience, confidence, provenance, source location, and freshness fields.
- Add direct read-only `memory.map-contract` access through CLI/MCP/HTTP so consumers can read the RedDB-backed contract without file export.
- Document that Memory provides high-quality graph data and parameters while red-ui owns rendering/UI decisions.

## Validation
- `pnpm exec vitest run tests/graph-contract.test.ts tests/export.test.ts tests/architecture-overview.test.ts tests/architecture-overview-cli.test.ts`
- `pnpm exec vitest run --config vitest.integration.config.ts tests/mcp-server.test.ts`
- `pnpm typecheck`
- `pnpm exec vitest run tests/operation-transport-adapter.test.ts tests/graph-contract.test.ts tests/operations-registry.test.ts`
- `git diff --check`

Note: a broad loose-filter Vitest run also exercised the touched suites but failed unrelated `ingest.test.ts` cases; focused changed suites pass.

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/535"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783383481&installation_id=129708444&pr_number=535&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F535&signature=b7d2700402bd6a53c03f5455b9162d14bba8db02820fc39c6adf28525313cb0c"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

* **New Features**
  * Added `memory map-contract` command to retrieve graph contracts with expanded metadata including producer signals, provenance, and freshness data.
  * Graph contract upgraded to v2 with enhanced node and edge properties (confidence, source location, freshness tracking, salience, and weight).
  * New `/map-contract` API endpoints for contract access.

* **Documentation**
  * Updated graph contract documentation and schema for v2 specification.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- Define Memory graph consumer contract
- Define Memory map consumer contract surface

## Files changed

- `plugins/memory/docs/graph-contract.md`
- `src/apps/memory/src/cli.ts`
- `src/apps/memory/src/graph-contract.ts`
- `src/apps/memory/src/http-server.ts`
- `src/apps/memory/src/mcp-server.ts`
- `src/apps/memory/src/operations.ts`
- `src/apps/memory/tests/architecture-overview-cli.test.ts`
- `src/apps/memory/tests/architecture-overview.test.ts`
- `src/apps/memory/tests/export.test.ts`
- `src/apps/memory/tests/graph-contract.test.ts`
- `src/apps/memory/tests/mcp-server.test.ts`
- `src/apps/memory/tests/operation-transport-adapter.test.ts`
- `src/apps/memory/tests/operations-registry.test.ts`

