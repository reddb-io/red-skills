---
title: fix(afk): HITL extractor ignores its own prior resolution + sheds stale blocked labels (#586)
type: source
tags: [pr, merged]
created: 2026-06-09
updated: 2026-06-09
sources: [pr-607]
pr: 607
merge_sha: c5a95903f6f01af922b8d6cf7a28194ddbf2362e
---

# fix(afk): HITL extractor ignores its own prior resolution + sheds stale blocked labels (#586)

- **PR:** [#607](https://github.com/reddb-io/red-skills/pull/607)
- **Author:** @filipeforattini
- **Merge SHA:** `c5a95903f6f01af922b8d6cf7a28194ddbf2362e`
- **Format:** merged pull request

## Summary

Closes #586. Landed via the PRD #567 parallel-landing workflow — a worktree-isolated agent implemented + tested the slice and ran the dev gate green (typecheck + the dev vitest suite) before pushing. Part of PRD #567.

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/607"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783624432&installation_id=129708444&pr_number=607&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F607&signature=aeda4dffaa59db71de2299bbae0a073dbc808927fb1af90de3bac90789aeaa6f"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

* **Bug Fixes**
  * Fixed HITL re-loops incorrectly re-processing previous HITL-resolution directives as new human guidance.
  * Improved cleanup of stale blocker labels when issues transition from blocked to ready-for-agent state.

* **Documentation**
  * Updated HITL workflow documentation to clarify handling of prior resolution directives and label cleanup behavior.

* **Tests**
  * Added test coverage for HITL decision extraction with prior resolution directives.
  * Added test coverage for blocker label removal during delegable resolution.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- fix(afk): HITL extractor ignores its own prior resolution; shed stale…

## Files changed

- `CHANGES.md`
- `plugins/dev/skills/engineering/hitl/SKILL.md`
- `src/apps/dev/src/core/hitl-decision-extraction.ts`
- `src/apps/dev/src/core/hitl-resolution-plan.ts`
- `src/apps/dev/tests/hitl-decision-extraction.test.ts`
- `src/apps/dev/tests/hitl-resolution-plan.test.ts`

