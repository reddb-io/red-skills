---
title: merge: #275 AFK reaper: on-demand invocation + branch-count visibility
type: source
tags: [pr, merged]
created: 2026-05-30
updated: 2026-05-30
sources: [pr-281]
pr: 281
merge_sha: 1b2b78069fbfba6d1f51cd09c3ad5011cce4ec02
---

# merge: #275 AFK reaper: on-demand invocation + branch-count visibility

- **PR:** [#281](https://github.com/reddb-io/red-skills/pull/281)
- **Author:** @filipeforattini
- **Merge SHA:** `1b2b78069fbfba6d1f51cd09c3ad5011cce4ec02`
- **Format:** merged pull request

## Summary

Automated AFK landing for #275. Per-attempt history lives in the issue Envelopes, the JSONL logs, and the `afk-attempts/*` snapshot branches.

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/281"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1782718235&installation_id=129708444&pr_number=281&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F281&signature=d47fd66c3f0c93da7ed2085f97f0e3e0bcd1f9a53462afa85fd6dc0fb3502fc4"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>@codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

## Commits

- feat(afk): add on-demand branch reaper core
- feat(afk): expose branch reaper command
- test(afk): cover on-demand branch reaper
- docs(afk): document on-demand branch reaper

## Files changed

- `plugins/dev/skills/engineering/afk/SKILL.md`
- `plugins/dev/skills/engineering/afk/scripts/afk-reap.sh`
- `plugins/dev/skills/engineering/afk/scripts/lib/remote-branch.sh`
- `plugins/dev/skills/engineering/afk/scripts/tests/on-demand-reaper.test.sh`

