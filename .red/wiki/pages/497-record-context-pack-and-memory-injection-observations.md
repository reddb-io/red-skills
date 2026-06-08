---
title: Record context-pack and Memory injection observations
type: source
tags: [pr, merged]
created: 2026-06-05
updated: 2026-06-05
sources: [pr-497]
pr: 497
merge_sha: b28b00a9b87619aa57b62e4e5a1829cdea0fc43d
---

# Record context-pack and Memory injection observations

- **PR:** [#497](https://github.com/reddb-io/red-skills/pull/497)
- **Author:** @filipeforattini
- **Merge SHA:** `b28b00a9b87619aa57b62e4e5a1829cdea0fc43d`
- **Format:** merged pull request

## Summary

Closes #491

## Summary
- add validated Memory event-log observations for context-pack generation and Memory injection delivery
- record context-pack generation from CLI/MCP/HTTP surfaces without counting it as injection
- record injection only when SessionStart hook delivery returns Memory context to the runner
- derive injection counters and last-injected timestamps from event-log observations

## Verification
- pnpm -C src/apps/memory exec vitest run tests/memory-events.test.ts tests/hook-runtime.test.ts
- pnpm -C src/apps/memory exec tsc -p tsconfig.json --noEmit
- pnpm -C src/apps/memory exec vitest run --config vitest.integration.config.ts tests/context-pack-cli.test.ts
- pnpm -C src/apps/memory exec vitest run --config vitest.integration.config.ts tests/session-timeline.test.ts tests/session-timeline-viewer.test.ts

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/497"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783253003&installation_id=129708444&pr_number=497&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F497&signature=9e758f7f0665df82b492ff3216818a86ac01ce5b88c81fa37235cf9dc4b562dd"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

* **New Features**
  * Context-pack generation is now tracked across all interfaces (CLI, HTTP, MCP) with metadata about generation surface and status.
  * Memory injection delivery is now recorded with details about delivered citations, nodes, and delivery surface for improved auditing and timeline visibility.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- Record Memory context pack and injection events

## Files changed

- `src/apps/memory/src/cli.ts`
- `src/apps/memory/src/hook-runtime.ts`
- `src/apps/memory/src/http-server.ts`
- `src/apps/memory/src/mcp-server.ts`
- `src/apps/memory/src/memory-events.ts`
- `src/apps/memory/src/operations.ts`
- `src/apps/memory/src/session-timeline.ts`
- `src/apps/memory/tests/context-pack-cli.test.ts`
- `src/apps/memory/tests/hook-runtime.test.ts`
- `src/apps/memory/tests/memory-events.test.ts`

