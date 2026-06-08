---
title: Add Memory community navigation analytics
type: source
tags: [pr, merged]
created: 2026-06-07
updated: 2026-06-07
sources: [pr-536]
pr: 536
merge_sha: ec624b0e50a22895613eb41e2798ec9c73b13181
---

# Add Memory community navigation analytics

- **PR:** [#536](https://github.com/reddb-io/red-skills/pull/536)
- **Author:** @filipeforattini
- **Merge SHA:** `ec624b0e50a22895613eb41e2798ec9c73b13181`
- **Format:** merged pull request

## Summary

Closes #524

## Summary
- extend memory.communities.v1 with node degree/centrality navigation metadata
- add weighted inter-community edge summaries cached under a graph-hash analytic cache key
- surface the metadata through CLI, MCP summaries, readiness fallback, and the communities viewer

## Tests
- pnpm --dir src/apps/memory typecheck
- pnpm --dir src/apps/memory exec vitest run --config vitest.integration.config.ts tests/communities-cli.test.ts
- pnpm --dir src/apps/memory test

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/536"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783384302&installation_id=129708444&pr_number=536&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F536&signature=1746770557440acfa8d936ef138b11dc74b2ff9772c59689f1e6030c937abb97"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

* **New Features**
  * Enhanced community analytics with additional per-community metrics (total degree, average centrality, external edge weight)
  * Added inter-community relationship data showing weighted edges and connections between communities
  * Improved navigation analytics with per-node community details

* **Tests**
  * Expanded test coverage for analytics output, caching behavior, and cache invalidation scenarios

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- Add Memory community navigation analytics

## Files changed

- `src/apps/memory/src/cli.ts`
- `src/apps/memory/src/communities-viewer.ts`
- `src/apps/memory/src/communities.ts`
- `src/apps/memory/src/mcp-server.ts`
- `src/apps/memory/src/operations.ts`
- `src/apps/memory/src/readiness.ts`
- `src/apps/memory/tests/communities-cli.test.ts`

