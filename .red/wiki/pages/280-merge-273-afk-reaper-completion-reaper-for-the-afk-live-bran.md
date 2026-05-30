---
title: merge: #273 AFK reaper: completion reaper for the afk/* live-branch namespace
type: source
tags: [pr, merged]
created: 2026-05-30
updated: 2026-05-30
sources: [pr-280]
pr: 280
merge_sha: dca45704be5576ae326eaf3417d91d0a380e27b1
---

# merge: #273 AFK reaper: completion reaper for the afk/* live-branch namespace

- **PR:** [#280](https://github.com/reddb-io/red-skills/pull/280)
- **Author:** @filipeforattini
- **Merge SHA:** `dca45704be5576ae326eaf3417d91d0a380e27b1`
- **Format:** merged pull request

## Summary

Automated AFK landing for #273. Per-attempt history lives in the issue Envelopes, the JSONL logs, and the `afk-attempts/*` snapshot branches.

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/280"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1782717357&installation_id=129708444&pr_number=280&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F280&signature=4b74f1dbaec43ffd32015874b96533b7886253075e87977982ac4220be75b851"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>@codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

## Commits

- test(afk): cover remote live branch cleanup
- fix(afk): reap closed remote live branches
- fix(afk): run remote live cleanup at boot

## Files changed

- `plugins/dev/skills/engineering/afk/scripts/afk.sh`
- `plugins/dev/skills/engineering/afk/scripts/lib/remote-branch.sh`
- `plugins/dev/skills/engineering/afk/scripts/tests/remote-live-branch-cleanup.test.sh`

