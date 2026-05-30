---
title: merge: #271 AFK reaper: 404-aware grace cleanup for afk-attempts/* (pure keep/reap decider)
type: source
tags: [pr, merged]
created: 2026-05-30
updated: 2026-05-30
sources: [pr-277]
pr: 277
merge_sha: 50f1b26468379eb265e2d076ed1473c277d143c0
---

# merge: #271 AFK reaper: 404-aware grace cleanup for afk-attempts/* (pure keep/reap decider)

- **PR:** [#277](https://github.com/reddb-io/red-skills/pull/277)
- **Author:** @filipeforattini
- **Merge SHA:** `50f1b26468379eb265e2d076ed1473c277d143c0`
- **Format:** merged pull request

## Summary

Automated AFK landing for #271. Per-attempt history lives in the issue Envelopes, the JSONL logs, and the `afk-attempts/*` snapshot branches.

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/277"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1782716334&installation_id=129708444&pr_number=277&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F277&signature=9b627d312276080ca41a4f7df084e0a7fb7053363444cd660eceadc1c438448f"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>@codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

## Commits

- feat(afk): plan snapshot cleanup decisions
- test(afk): cover 404 snapshot cleanup planning

## Files changed

- `plugins/dev/skills/engineering/afk/scripts/lib/remote-branch.sh`
- `plugins/dev/skills/engineering/afk/scripts/tests/snapshot-grace-cleanup.test.sh`

