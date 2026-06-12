---
title: feat(afk): atomic GitHub-native claim — pure reconciler over server-ordered claim comments (#622)
type: source
tags: [pr, merged]
created: 2026-06-12
updated: 2026-06-12
sources: [pr-730]
pr: 730
merge_sha: 22fefaf0c430037f1a5bf6931ac0c0d0897caa3d
---

# feat(afk): atomic GitHub-native claim — pure reconciler over server-ordered claim comments (#622)

- **PR:** [#730](https://github.com/reddb-io/red-skills/pull/730)
- **Author:** @filipeforattini
- **Merge SHA:** `22fefaf0c430037f1a5bf6931ac0c0d0897caa3d`
- **Format:** merged pull request

## Summary

Re-implements #622 (PRD #614 multi-user AFK keystone) on current main, ported from the surviving feature commit `65fcc16c` (the original landed nowhere — feedback gate failed on the now-fixed submodule bug; its branch was 178 commits behind on pre-monorepo `src/apps/` paths).

## Design (ADR 0066)
Atomic GitHub-native claim with **no external coordinator**: each claimant posts a structured marker comment (`<!-- afk:claim v1 worker=<host>:<id> kind=claim … -->`); GitHub's monotonic server-side comment `id` is the total cross-host order; **earliest active claim wins**. Pure `reconcileClaim(records, self, opts)` (`core/claim.ts`, garbage-tolerant parse, staleness injected via `opts.isStale` → cross-host recovery is a pure function), thin `acquireClaim` orchestrator that concedes cleanly on loss. The `running` label stops being the lock — it becomes a best-effort observability projection; `process-issue` keeps the `ready-for-agent` state-validity recheck.

ADR renumbered **0060 → 0066** (0060 is now the monorepo-move ADR; 0065 was prior max).

## Verification
- `apps/dev` typecheck: green
- `apps/dev` tests: **1379 passing** (new `claim.test.ts` 17 + 2 `process-issue.test.ts` cases)

Closes #622

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/730"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783827191&installation_id=129708444&pr_number=730&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F730&signature=c53cc20cd4c119c3ec544e3f9426252f80a951168b60a5c4f8578150a5053162"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

## Release Notes

* **New Features**
  * Added GitHub-native claim arbitration for multi-host worker coordination. Workers now post structured comments to determine issue ownership, ensuring only one worker processes each issue across multiple hosts.
  * Running labels demoted to observability only; claim decisions now rely on comment-based ordering instead.

* **Documentation**
  * Added ADR 0066 documenting the atomic GitHub-native claim substrate approach.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- feat(afk): atomic GitHub-native claim — pure reconciler over server-o…
- chore(afk): memory-noignore drift-guard for claim ADRs

## Files changed

- `.red/adr/0056-afk-landability-reconciler.md`
- `.red/adr/0066-afk-atomic-github-native-claim-substrate.md`
- `.red/adr/INDEX.md`
- `apps/dev/src/commands/run.ts`
- `apps/dev/src/core/claim.ts`
- `apps/dev/src/core/process-issue.ts`
- `apps/dev/src/runtime/gh.ts`
- `apps/dev/tests/claim.test.ts`
- `apps/dev/tests/process-issue.test.ts`

