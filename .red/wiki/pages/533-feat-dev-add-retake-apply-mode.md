---
title: feat(dev): add retake apply mode
type: source
tags: [pr, merged]
created: 2026-06-07
updated: 2026-06-07
sources: [pr-533]
pr: 533
merge_sha: 655ae053c905d049af5fe8ea1d5df1e49a6e2cc2
---

# feat(dev): add retake apply mode

- **PR:** [#533](https://github.com/reddb-io/red-skills/pull/533)
- **Author:** @filipeforattini
- **Merge SHA:** `655ae053c905d049af5fe8ea1d5df1e49a6e2cc2`
- **Format:** merged pull request

## Summary

Adds safe --apply support to /retake. It executes only deterministic local setup git operations, keeps --json valid, and tightens PR body matching to avoid prose-only number false positives. Validation: focused retake/cli/ship tests, dev typecheck, retake 520 --apply integration, dev build. Closes #532

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/533"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783383006&installation_id=129708444&pr_number=533&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F533&signature=dac0bb59dfaa7dd9b1e68120be27ebb20b039b11ce4a4546797370343ea76909"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

## Commits

- feat(dev): add retake apply mode

## Files changed

- `plugins/dev/skills/engineering/afk/SKILL.md`
- `plugins/dev/skills/engineering/retake/SKILL.md`
- `src/apps/dev/src/commands/retake.ts`
- `src/apps/dev/src/core/retake.ts`
- `src/apps/dev/tests/retake.test.ts`

