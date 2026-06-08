---
title: Memory governance reports tidy availability
type: source
tags: [pr, merged]
created: 2026-06-05
updated: 2026-06-05
sources: [pr-492]
pr: 492
merge_sha: 38a4ef9c6ec8c9d36f4986757cf5470efae00dfa
---

# Memory governance reports tidy availability

- **PR:** [#492](https://github.com/reddb-io/red-skills/pull/492)
- **Author:** @filipeforattini
- **Merge SHA:** `38a4ef9c6ec8c9d36f4986757cf5470efae00dfa`
- **Format:** merged pull request

## Summary

Closes #485.

## Summary
- add read-only `tidy_availability` to memory governance reports
- expose tidy status/reason/next action through CLI, MCP structured summaries, HTTP JSON, governance viewer, and Workbench governance panel
- cover no-provider and invalid-provider behavior without provider calls

## Validation
- pnpm --dir src/apps/memory typecheck
- pnpm --dir src/apps/memory build
- pnpm exec vitest run --config vitest.integration.config.ts tests/governance.test.ts
- pnpm exec vitest run --config vitest.integration.config.ts tests/http-server.test.ts
- pnpm exec vitest run --config vitest.integration.config.ts tests/mcp-server.test.ts -t "registry-backed readiness and trust tools"
- Workbench smoke: build artifact includes tidy availability

## Known unrelated validation notes
- Full targeted integration batch also exposed existing unrelated failures: `tests/mcp-server.test.ts` hook coverage expected 4 Claude hooks but saw 1, and `tests/workbench.test.ts` expects `memory.references_radar.v1` while implementation returns `memory.reference_radar.v1`.

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/492"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783248827&installation_id=129708444&pr_number=492&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F492&signature=9d312c625d1dd70d3dd7a8f59a83d40015eb92f8abe153f96c6d35e633acddc3"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

* **New Features**
  * Added "Tidy availability" governance metric to report AI provider status for system operations, displaying availability state (available/degraded/unavailable) with configuration details and recommended next steps when unavailable.

* **Tests**
  * Extended test coverage for tidy availability status reporting across governance reports, HTTP server, MCP server, and workbench displays.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- memory governance reports tidy availability

## Files changed

- `src/apps/memory/src/cli.ts`
- `src/apps/memory/src/governance-viewer.ts`
- `src/apps/memory/src/governance.ts`
- `src/apps/memory/src/http-server.ts`
- `src/apps/memory/src/mcp-server.ts`
- `src/apps/memory/src/operations.ts`
- `src/apps/memory/src/workbench.ts`
- `src/apps/memory/tests/governance.test.ts`
- `src/apps/memory/tests/http-server.test.ts`
- `src/apps/memory/tests/mcp-server.test.ts`
- `src/apps/memory/tests/workbench.test.ts`

