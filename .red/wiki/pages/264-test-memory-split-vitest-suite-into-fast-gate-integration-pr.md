---
title: test(memory): split vitest suite into fast gate + integration project (#242)
type: source
tags: [pr, merged]
created: 2026-05-30
updated: 2026-05-30
sources: [pr-264]
pr: 264
merge_sha: 40f07e35695d67d65388fc731f3bc1fe96ed9f98
---

# test(memory): split vitest suite into fast gate + integration project (#242)

- **PR:** [#264](https://github.com/reddb-io/red-skills/pull/264)
- **Author:** @filipeforattini
- **Merge SHA:** `40f07e35695d67d65388fc731f3bc1fe96ed9f98`
- **Format:** merged pull request

## Summary

Resolves #242.

## Problem
The `plugins/memory` vitest suite bounced green AFK slices: `pnpm test` ran the heavy RedDB real-server / real-CLI suite that can exceed the AFK pnpm-shim's 300s cap under load (exit 124 → `ready-for-human`).

## Fix
Split the suite (building on the inner agent's blocked attempt `afk-attempts/wPRXE/242`):
- default `test` → in-process unit suite only (the AFK feedback gate)
- new `test:integration` → the RedDB real-server / real-CLI / latency-budget suite, run explicitly / in CI
- `vitest.suites.ts` is the single source of truth for the partition; `suite-split.test.ts` guards it

**One correction over the blocked attempt:** the default gate keeps `fileParallelism: false`. Several in-process suites share the SDK-managed `memory_docs`/`memory_nodes`/`memory_edges` collections; concurrent forks raced on the collection schema (`INVALID_OPERATION: collection 'memory_docs' is declared as 'table'`) — the exact non-determinism #242 set out to remove, and the reason the attempt bounced. Serial file execution keeps the shared store consistent; the speedup comes from excluding the integration suite, not from parallelising the unit gate.

## Validation
`pnpm -C plugins/memory test` → **63 files / 657 tests pass, 258s** (< 300s shim cap, measured under concurrent AFK load). `public-docs-claims.test.ts` — which failed in the attempt's parallel run — passes serially. typecheck + build clean.

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/264"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1782712550&installation_id=129708444&pr_number=264&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F264&signature=36eb55dc179117c34ca989abaf2ebbdf6c35856173a8463f3d1b52d921cd4e74"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>@codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

## Commits

- test(memory): split vitest suite into fast gate + integration project…

## Files changed

- `plugins/memory/README.md`
- `plugins/memory/package.json`
- `plugins/memory/tests/suite-split.test.ts`
- `plugins/memory/vitest.config.ts`
- `plugins/memory/vitest.integration.config.ts`
- `plugins/memory/vitest.suites.ts`

