---
title: refactor(core): extract triage-labels.ts as single shared vocabulary owner
type: source
tags: [pr, merged]
created: 2026-06-10
updated: 2026-06-10
sources: [pr-670]
pr: 670
merge_sha: a1cb62e401fbbe0f4313360d5faa671e7b0308e5
---

# refactor(core): extract triage-labels.ts as single shared vocabulary owner

- **PR:** [#670](https://github.com/reddb-io/red-skills/pull/670)
- **Author:** @filipeforattini
- **Merge SHA:** `a1cb62e401fbbe0f4313360d5faa671e7b0308e5`
- **Format:** merged pull request

## Summary

## Summary
- Extracts `src/apps/dev/src/core/triage-labels.ts` as the single canonical owner of triage-label string constants
- Removes all duplicated local `LABEL_*` consts from core modules (`process-issue`, `supervisor`, `boot`, `reconcile`, etc.)
- All call sites now import from the shared module

## Related
Closes #599
Parent: #567

## Test plan
- [ ] `pnpm --filter @reddb-io/dev test` passes (1208 tests; one pre-existing supervisor.test.ts OOM unrelated to this change)
- [ ] No local `LABEL_*` const definitions remain outside `triage-labels.ts`

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/670"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783726712&installation_id=129708444&pr_number=670&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F670&signature=326d485bd2d4d5ee4d660d1a77a56e758466c2eeb4d6a30d6c9da716c56972df"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

* **New Features**
  * `/ship` command now waits for advisory bot reviews (CodeRabbit by default) before merging; skip with `--no-review-wait`.
  * CLI now reports errors for unknown subcommands instead of silently falling back.
  * Expanded AFK documentation suite covering lifecycle, monitoring, configuration, and workflow mechanics.

* **Bug Fixes**
  * Stage classification no longer misidentifies file paths containing "test" as test-runner invocations.
  * `--issues` flag validation prevents empty selection.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- refactor(core): extract triage-labels.ts as single vocabulary owner
- refactor(core): migrate inline triage-label literals to shared consts

## Files changed

- `src/apps/dev/src/commands/activity-review.ts`
- `src/apps/dev/src/commands/run.ts`
- `src/apps/dev/src/commands/ship.ts`
- `src/apps/dev/src/core/activity-review.ts`
- `src/apps/dev/src/core/attempt-outcome.ts`
- `src/apps/dev/src/core/boot-sweep.ts`
- `src/apps/dev/src/core/boot.ts`
- `src/apps/dev/src/core/dashboard.ts`
- `src/apps/dev/src/core/hitl-resolution-plan.ts`
- `src/apps/dev/src/core/hitl-selection.ts`
- `src/apps/dev/src/core/process-issue.ts`
- `src/apps/dev/src/core/reclaim.ts`
- `src/apps/dev/src/core/reconcile.ts`
- `src/apps/dev/src/core/retake.ts`
- `src/apps/dev/src/core/session.ts`
- `src/apps/dev/src/core/supervisor.ts`
- `src/apps/dev/src/core/triage-labels.ts`
- `src/apps/dev/src/runtime/gh.ts`

