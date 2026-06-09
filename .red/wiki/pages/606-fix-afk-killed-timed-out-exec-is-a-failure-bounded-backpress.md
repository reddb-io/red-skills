---
title: fix(afk): killed/timed-out exec is a failure + bounded backpressure timeout (#574)
type: source
tags: [pr, merged]
created: 2026-06-09
updated: 2026-06-09
sources: [pr-606]
pr: 606
merge_sha: 9c9f67efdb0e96449850eb443d167f0b307f73aa
---

# fix(afk): killed/timed-out exec is a failure + bounded backpressure timeout (#574)

- **PR:** [#606](https://github.com/reddb-io/red-skills/pull/606)
- **Author:** @filipeforattini
- **Merge SHA:** `9c9f67efdb0e96449850eb443d167f0b307f73aa`
- **Format:** merged pull request

## Summary

Closes #574. Landed via the PRD #567 parallel-landing workflow — a worktree-isolated agent implemented + tested the slice and ran the dev gate green (typecheck + the dev vitest suite) before pushing. Part of PRD #567.

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/606"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783624406&installation_id=129708444&pr_number=606&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F606&signature=888f13127fa11457d3b011202cd42db5b97d553f40f6e3c548769552f4fe4064"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

* **Bug Fixes**
  * Command execution now enforces timeout deadlines, preventing indefinite hangs
  * Improved error detection for processes terminated by timeout or signal, ensuring they are properly reported as failures

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- fix(afk): treat killed/timed-out commands as failures + bound backpre…

## Files changed

- `src/apps/dev/src/core/backpressure.ts`
- `src/apps/dev/src/runtime/exec.ts`
- `src/apps/dev/src/runtime/feedback-worktree.ts`
- `src/apps/dev/tests/backpressure.test.ts`
- `src/apps/dev/tests/exec.test.ts`

