---
title: merge: #274 AFK reaper: local afk/* branch GC at boot (closed/merged, never checked-out)
type: source
tags: [pr, merged]
created: 2026-05-30
updated: 2026-05-30
sources: [pr-278]
pr: 278
merge_sha: a077eed2502f94179c60207ce3b79a67cc1405bc
---

# merge: #274 AFK reaper: local afk/* branch GC at boot (closed/merged, never checked-out)

- **PR:** [#278](https://github.com/reddb-io/red-skills/pull/278)
- **Author:** @filipeforattini
- **Merge SHA:** `a077eed2502f94179c60207ce3b79a67cc1405bc`
- **Format:** merged pull request

## Summary

Automated AFK landing for #274. Per-attempt history lives in the issue Envelopes, the JSONL logs, and the `afk-attempts/*` snapshot branches.

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/278"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1782716802&installation_id=129708444&pr_number=278&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F278&signature=814c8530359a7e53c78387f65a05bd91ad9875ac2eb0dfbb99408d34ceeae4d9"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>@codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

## Commits

- fix(afk): prune closed local live branches
- fix(afk): run local branch cleanup at boot
- test(afk): cover local live branch cleanup

## Files changed

- `plugins/dev/skills/engineering/afk/scripts/afk.sh`
- `plugins/dev/skills/engineering/afk/scripts/lib/remote-branch.sh`
- `plugins/dev/skills/engineering/afk/scripts/tests/local-branch-cleanup.test.sh`

