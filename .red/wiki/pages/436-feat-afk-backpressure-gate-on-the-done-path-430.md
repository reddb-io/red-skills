---
title: feat(afk): backpressure gate on the DONE path (#430)
type: source
tags: [pr, merged]
created: 2026-06-03
updated: 2026-06-03
sources: [pr-436]
pr: 436
merge_sha: 690501c08fd7c0d29cc6689284e29f041342482c
---

# feat(afk): backpressure gate on the DONE path (#430)

- **PR:** [#436](https://github.com/reddb-io/red-skills/pull/436)
- **Author:** @filipeforattini
- **Merge SHA:** `690501c08fd7c0d29cc6689284e29f041342482c`
- **Format:** merged pull request

## Summary

Closes #430. PRD #429.

AFK worker wY7AL implemented this (commit d283836); its feedback gate spuriously failed with an infrastructure bug (`ENOENT lstat .../red-skills/wY7AL` — worker-id-in-path), parking it to `blocked:validation` despite the code being correct. **Manually salvaged**: rebased onto current main (clean) and independently verified — typecheck clean, 104 tests green (backpressure 6, config 24, process-issue 54, run-flags+cli-routing 20).

Adds operator-declared `afk.backpressure: [cmd, …]` run after the feedback gate on the DONE (and salvage) path; any non-zero exit blocks the merge and parks to `ready-for-human` exactly like a feedback failure, with the failing command in the envelope + validation sidecar. No-op when unset.

The separate feedback-gate ENOENT bug is tracked for follow-up (it also threatens #431).

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/436"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783085563&installation_id=129708444&pr_number=436&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F436&signature=464af7b4d6705e201d8320b834cba5dd9c48660739f4ccfef52503cc97240ffa"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

## Commits

- feat(afk): backpressure gate on the DONE path (#430)

## Files changed

- `plugins/dev/skills/engineering/afk/SKILL.md`
- `src/apps/dev/src/commands/run.ts`
- `src/apps/dev/src/core/backpressure.ts`
- `src/apps/dev/src/core/config.ts`
- `src/apps/dev/src/core/process-issue.ts`
- `src/apps/dev/src/runtime/feedback-worktree.ts`
- `src/apps/dev/tests/backpressure.test.ts`
- `src/apps/dev/tests/config.test.ts`
- `src/apps/dev/tests/process-issue.test.ts`

