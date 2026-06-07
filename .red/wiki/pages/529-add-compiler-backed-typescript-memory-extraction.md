---
title: Add compiler-backed TypeScript memory extraction
type: source
tags: [pr, merged]
created: 2026-06-06
updated: 2026-06-06
sources: [pr-529]
pr: 529
merge_sha: 48683cd97f5df292d91d0b781bb8ce664982c3eb
---

# Add compiler-backed TypeScript memory extraction

- **PR:** [#529](https://github.com/reddb-io/red-skills/pull/529)
- **Author:** @filipeforattini
- **Merge SHA:** `48683cd97f5df292d91d0b781bb8ce664982c3eb`
- **Format:** merged pull request

## Summary

Closes #522.\n\n## Summary\n- Add compiler-backed TypeScript/TSX extraction for Memory code maps with stable file/symbol/import nodes and source locations.\n- Persist IMPORTS/CALLS/USES_TYPE/DEFINED_IN edge metadata with confidence, provenance, and initial topological weights.\n- Keep a marked regex fallback when TypeScript compiler extraction is unavailable.\n\n## Validation\n- pnpm --dir src/apps/memory typecheck\n- pnpm --dir src/apps/memory exec vitest run tests/extract-code.test.ts tests/ingest.test.ts\n- pnpm --dir src/apps/memory lint:deterministic-extractors

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/529"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783381578&installation_id=129708444&pr_number=529&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F529&signature=f0040ecf6847daca899e75d8a46628df2d2d401f4480bfe7d8f55e3a4be241f3"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

* **New Features**
  * Added TypeScript compiler-based code extraction for improved accuracy in identifying symbols and code relationships.

* **Refactor**
  * Enhanced code relationship metadata with extraction source tracking, confidence scoring, and improved provenance information.
  * Updated extraction API to support configurable backends with automatic fallback to regex-based extraction for reliability.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- Add compiler-backed TypeScript memory extraction

## Files changed

- `src/apps/memory/src/extract-code.ts`
- `src/apps/memory/src/ingest.ts`
- `src/apps/memory/src/schema.ts`
- `src/apps/memory/tests/extract-code.test.ts`
- `src/apps/memory/tests/ingest.test.ts`

