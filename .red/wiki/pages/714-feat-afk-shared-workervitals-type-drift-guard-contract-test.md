---
title: feat(afk): shared WorkerVitals type + drift-guard contract test (S4 #710)
type: source
tags: [pr, merged]
created: 2026-06-11
updated: 2026-06-11
sources: [pr-714]
pr: 714
merge_sha: 24d53ad1dc396d18520bbc7937671b61e4bb8ab9
---

# feat(afk): shared WorkerVitals type + drift-guard contract test (S4 #710)

- **PR:** [#714](https://github.com/reddb-io/red-skills/pull/714)
- **Author:** @filipeforattini
- **Merge SHA:** `24d53ad1dc396d18520bbc7937671b61e4bb8ab9`
- **Format:** merged pull request

## Summary

Closes #710. **Final slice (S4)** of PRD #706 — completes the WorkerVitals canonical vocabulary (ADR 0065).

## What this does
- **Shared `WorkerVitals` type** next to `AfkCurrentSchema`, grouping the canonical signals (identity / lifecycle / progress / activity / liveness / cost). A compile-time assertion guarantees `current.*` (`AfkCurrent`) satisfies it — rename a vital on one but not the other and it **fails to compile**.
- **A consumer reads via the contract**: `collectStatuslineAfk` now reads the fleet's signals through a `WorkerVitals`-typed binding instead of ad-hoc field access.
- **Capstone contract test** (`worker-vitals.contract.test.ts`) pinning the red-castle stream-event type → canonical `current.*` field map, guarding three ways:
  - **completeness** (compile): a new `AgentStreamEvent` variant without a map entry fails the `satisfies Record<AgentStreamEvent["type"], …>`
  - **validity** (compile): each mapped target is `keyof WorkerVitals` — a renamed/typo'd field fails; proven by two `@ts-expect-error` fixtures (e.g. `thinking_called_count` no longer compiles)
  - **persistence** (runtime/CI): every mapped field survives the schema round-trip, catching an accidental schema rename in vitest/CI

## Note on CI coverage
The **persistence** guard runs in CI (vitest). The **compile-time** guards (`satisfies` + `@ts-expect-error`) need `tsc`, which `core-regression-gate` does not run — the same gap that let S1's usage-variant typecheck break land silently. Recommend a follow-up adding an `apps/dev` typecheck job to CI so the full contract is enforced automatically; out of scope here.

## Tests
+4 contract-test cases; full apps/dev suite green (1245 pass; the lone `args.test.ts` failure is the pre-existing `cli-args-parser` worktree-resolution artifact, unrelated).

After this merges, **PRD #706 is fully delivered** (S1+S2+S3+S4).

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/714"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783789543&installation_id=129708444&pr_number=714&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F714&signature=ff2a92e5bf05af5ac0d549b616ba49f6f3f7cfa378fadac0a4bb5e26e0c4736c"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

* **Refactor**
  * Standardized access to worker status and performance metrics through a canonical contract interface, improving code consistency and maintainability.

* **Tests**
  * Added contract test to validate complete and correct mapping between system events and worker status metrics with compile-time type safety.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- feat(afk): shared WorkerVitals type + drift-guard contract test (S4 #…

## Files changed

- `apps/dev/src/runtime/wire.ts`
- `apps/dev/src/types/state.ts`
- `apps/dev/tests/worker-vitals.contract.test.ts`

