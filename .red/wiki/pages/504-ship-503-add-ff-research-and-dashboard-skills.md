---
title: ship: #503 Add /ff, /research, and /dashboard skills
type: source
tags: [pr, merged]
created: 2026-06-05
updated: 2026-06-05
sources: [pr-504]
pr: 504
merge_sha: e1fdbfdad64223bee279b3591820c8a5bf08c821
---

# ship: #503 Add /ff, /research, and /dashboard skills

- **PR:** [#504](https://github.com/reddb-io/red-skills/pull/504)
- **Author:** @filipeforattini
- **Merge SHA:** `e1fdbfdad64223bee279b3591820c8a5bf08c821`
- **Format:** merged pull request

## Summary

Interactive /ship landing for #503.

Closes #503

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/504"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783282704&installation_id=129708444&pr_number=504&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F504&signature=3ca5f753e0b98c3981d6b476517098033996dd5563b3d638262410b15b6dc046"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

* **New Features**
  * Added dashboard reporting to display development metrics including PRDs, open issues, worker status, and operational insights (cycle times, DORA proxies).
  * Added research skill for conducting and documenting deep technical investigations.
  * Added fast-forward clarity feature to preview multiple interpretations of requests before execution.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- feat(dev): add ff research and dashboard skills

## Files changed

- `plugins/dev/.claude-plugin/plugin.json`
- `plugins/dev/skills/engineering/README.md`
- `plugins/dev/skills/engineering/afk/SKILL.md`
- `plugins/dev/skills/engineering/dashboard/SKILL.md`
- `plugins/dev/skills/knowledge/README.md`
- `plugins/dev/skills/knowledge/research/SKILL.md`
- `plugins/dev/skills/productivity/README.md`
- `plugins/dev/skills/productivity/ff/SKILL.md`
- `src/apps/dev/src/cli.ts`
- `src/apps/dev/src/commands/dashboard.ts`
- `src/apps/dev/src/core/dashboard.ts`
- `src/apps/dev/tests/cli-routing.test.ts`
- `src/apps/dev/tests/dashboard.test.ts`

