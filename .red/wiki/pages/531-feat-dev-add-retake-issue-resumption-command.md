---
title: feat(dev): add retake issue resumption command
type: source
tags: [pr, merged]
created: 2026-06-06
updated: 2026-06-06
sources: [pr-531]
pr: 531
merge_sha: 22a6a561245f9086b0f88edd5290bf0d67af2ada
---

# feat(dev): add retake issue resumption command

- **PR:** [#531](https://github.com/reddb-io/red-skills/pull/531)
- **Author:** @filipeforattini
- **Merge SHA:** `22a6a561245f9086b0f88edd5290bf0d67af2ada`
- **Format:** merged pull request

## Summary

Adds /retake as a read-only issue resumption command that discovers the issue, linked PRs, matching branches, local worktrees, HITL state, and prints the next action. Validation: focused retake/cli/ship tests, dev typecheck, retake 520 integration, dev build. Closes #530

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/531"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783381949&installation_id=129708444&pr_number=531&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F531&signature=2253e664e7ef5d584eb66d2d8d8b49d4c7d8b9880a98747c2170d6ff52fd8053"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

## Commits

- feat(dev): add retake issue resumption command

## Files changed

- `plugins/dev/skills/engineering/README.md`
- `plugins/dev/skills/engineering/afk/SKILL.md`
- `plugins/dev/skills/engineering/retake/SKILL.md`
- `src/apps/dev/src/cli.ts`
- `src/apps/dev/src/commands/retake.ts`
- `src/apps/dev/src/core/retake.ts`
- `src/apps/dev/tests/cli-routing.test.ts`
- `src/apps/dev/tests/retake.test.ts`

