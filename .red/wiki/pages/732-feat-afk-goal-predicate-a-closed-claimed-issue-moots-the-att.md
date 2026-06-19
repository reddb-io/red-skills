---
title: feat(afk): goal predicate — a CLOSED claimed issue moots the attempt (ADR 0057)
type: source
tags: [pr, merged]
created: 2026-06-12
updated: 2026-06-12
sources: [pr-732]
pr: 732
merge_sha: b156790c71f696f9c8badfcbf318d57d5f81aba1
---

# feat(afk): goal predicate — a CLOSED claimed issue moots the attempt (ADR 0057)

- **PR:** [#732](https://github.com/reddb-io/red-skills/pull/732)
- **Author:** @filipeforattini
- **Merge SHA:** `b156790c71f696f9c8badfcbf318d57d5f81aba1`
- **Format:** merged pull request

## Summary

## Summary

- Implements the goal predicate (ADR 0057): a CLOSED claimed issue moots the running attempt, terminating it as `done` (own-merge) or `claim-lost` (foreign close).
- `goal-predicate.ts`: pure `evaluateGoal` + `makeGoalProbe` — one gh issue-state read per 60s poll tick; own-merge git check only on a CLOSED tick.
- `execution.ts` / `process-issue.ts`: `goal-met` AgentOutcome carrying `goalOutcome`; clean terminal, no envelope spam.
- `git.ts`: `isAncestor` helper; `run.ts` wires `branchMerged` (fetch base + is-ancestor).
- ADR 0058 (goal predicate) and INDEX update.
- Tests: `goal-predicate.test.ts`, `execution.test.ts`, `git-branch-merged.test.ts`, `process-issue.test.ts`.

Closes #624

## Context

This PR is built on top of the current `origin/main` (post-ADR 0066 atomic claim, post-PR #719 supervisor OOM fix). The previous AFK attempt (`w57PX`) was blocked by `blocked:validation` because the feedback gate ran on a branch rooted at an old `origin/main` that still had the broken `supervisor.test.ts` (OOM during collection). This implementation was re-extracted from the `afk-attempts/w57PX/624` snapshot which was correctly based on the fixed `origin/main`.

## Test plan

- [ ] `pnpm -C apps/dev test` passes (supervisor.test.ts fix is in base)
- [ ] `pnpm typecheck` passes
- [ ] CI green on all required checks

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/732"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783863222&installation_id=129708444&pr_number=732&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F732&signature=c0000149f977b14678722e6c3173e7fc69564c3195f37c067d41e7a1468172d2"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

* **New Features**
  * System now detects when claimed issues are already closed, preventing wasted work attempts.
  * Added distinction between self-resolved issues and externally-resolved ones to accurately report outcomes.
  
* **Bug Fixes**
  * Automatically removes stale labels from issues that are already closed.

* **Tests**
  * Added comprehensive test coverage for the new goal-detection logic and outcome handling.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- feat(afk): pure goal predicate — closed-issue → outcome mapping (ADR …
- test(afk): exhaustive goal-predicate mapping table (ADR 0057)
- feat(afk): branchMergedInto — git own-merge signal for the goal predi…
- test(afk): branchMergedInto local/origin tip resolution + ancestry (A…
- feat(afk): goal predicate on the attempt-guard poll (ADR 0057)
- test(afk): goal-predicate guard + runAgent goal-moot wiring (ADR 0057)
- feat(afk): terminate moot attempts on the goal predicate (ADR 0057)
- test(afk): processIssue goal-moot → claim-lost / done, no envelope sp…
- feat(afk): wire the branchMerged own-merge lookup into the run deps (…

## Files changed

- `apps/dev/src/commands/run.ts`
- `apps/dev/src/core/execution.ts`
- `apps/dev/src/core/goal-predicate.ts`
- `apps/dev/src/core/process-issue.ts`
- `apps/dev/src/runtime/git.ts`
- `apps/dev/tests/execution.test.ts`
- `apps/dev/tests/git-branch-merged.test.ts`
- `apps/dev/tests/goal-predicate.test.ts`
- `apps/dev/tests/process-issue.test.ts`

