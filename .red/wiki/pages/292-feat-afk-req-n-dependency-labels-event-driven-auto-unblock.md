---
title: feat(afk): req:N dependency labels + event-driven auto-unblock
type: source
tags: [pr, merged]
created: 2026-05-30
updated: 2026-05-30
sources: [pr-292]
pr: 292
merge_sha: f9069560d9a8e7800d594fbbc460c35b81fd5118
---

# feat(afk): req:N dependency labels + event-driven auto-unblock

- **PR:** [#292](https://github.com/reddb-io/red-skills/pull/292)
- **Author:** @filipeforattini
- **Merge SHA:** `f9069560d9a8e7800d594fbbc460c35b81fd5118`
- **Format:** merged pull request

## Summary

Splits the overloaded `blocked`: dependencies become queryable `req:N` edge labels (like prd:N) + a `blocked:dependency` holding state that never pages, and closing an issue cascades to auto-unblock its dependents the moment their last dep closes. Boot sweep is the safety net. 664 tests. Docs (triage-labels, to-issues, setup-red-skills, AFK SKILL.md) updated. [skip release].

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/292"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1782775125&installation_id=129708444&pr_number=292&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F292&signature=37883e0ca4378f4444963b549beaf1e41f5480c316becdd282e6f5a3f313d8d6"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>@codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

## Commits

- feat(afk): structured req:N dependency labels + event-driven auto-unb…

## Files changed

- `.red/agents/triage-labels.md`
- `plugins/dev/skills/engineering/afk/SKILL.md`
- `plugins/dev/skills/engineering/setup-red-skills/SKILL.md`
- `plugins/dev/skills/engineering/to-issues/SKILL.md`
- `src/domains/dev/src/commands/run.ts`
- `src/domains/dev/src/core/boot-sweep.ts`
- `src/domains/dev/src/core/boot.ts`
- `src/domains/dev/src/core/process-issue.ts`
- `src/domains/dev/src/runtime/gh.ts`
- `src/domains/dev/tests/boot-sweep.test.ts`
- `src/domains/dev/tests/boot.test.ts`
- `src/domains/dev/tests/process-issue.test.ts`

