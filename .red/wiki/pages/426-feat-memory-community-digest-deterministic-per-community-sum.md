---
title: feat(memory): community digest — deterministic per-community summary cached by graph hash (#300)
type: source
tags: [pr, merged]
created: 2026-06-03
updated: 2026-06-03
sources: [pr-426]
pr: 426
merge_sha: 92025ea056b52dc2fa76e3d55df26ce7b2f880cf
---

# feat(memory): community digest — deterministic per-community summary cached by graph hash (#300)

- **PR:** [#426](https://github.com/reddb-io/red-skills/pull/426)
- **Author:** @filipeforattini
- **Merge SHA:** `92025ea056b52dc2fa76e3d55df26ce7b2f880cf`
- **Format:** merged pull request

## Summary

Salvages the completed work from AFK worker `wJ3YX` on #300.

## Context — the no-sentinel defect (Defeito 1+2)

The AFK inner agent **implemented #300 fully in iteration 1** (commit `7c1b285`) — typecheck clean, tests green — but **never emitted `<promise>DONE</promise>`**, so the runtime re-invoked it (iterations 2→4/20) re-verifying already-done work, never closing the issue. Same no-sentinel-on-completion pattern as #334. The runtime salvage that would auto-handle this is PR #335 (still CONFLICTING/unmerged). Salvaged manually here.

## What's here (one commit, +466)

`community-digest.ts` (deterministic per-community top-label summary, cached by graph hash) + `operations.ts` registry wiring + CLI + 214-line integration test, across 8 files in `src/apps/memory`.

## Validation (merged onto current main)

- `tsc --noEmit` clean.
- `vitest --config vitest.integration.config.ts tests/community-digest-cli.test.ts` → **2/2 pass** (deterministic digest, graph-hash cache read-write/read-only/off, no graph mutation).
- Clean merge — none of the 8 files overlap main's changes since the branch base.

Closes #300.

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/426"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783079576&installation_id=129708444&pr_number=426&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F426&signature=6abe67e232bc81f53d8422403e0252e1bcec13528709ac170c1c7e376e8efac9"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

## Commits

- feat(memory): community digest — deterministic per-community top-labe…

## Files changed

- `src/apps/memory/src/cli.ts`
- `src/apps/memory/src/communities.ts`
- `src/apps/memory/src/community-digest.ts`
- `src/apps/memory/src/operations.ts`
- `src/apps/memory/tests/community-digest-cli.test.ts`
- `src/apps/memory/tests/mcp-server.test.ts`
- `src/apps/memory/tests/operations-registry.test.ts`
- `src/apps/memory/vitest.suites.ts`

