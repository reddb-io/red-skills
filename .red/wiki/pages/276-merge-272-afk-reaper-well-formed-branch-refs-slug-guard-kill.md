---
title: merge: #272 AFK reaper: well-formed branch refs + slug guard (kill double-nested names)
type: source
tags: [pr, merged]
created: 2026-05-30
updated: 2026-05-30
sources: [pr-276]
pr: 276
merge_sha: 13cb2ee7e5774e3db3ddd18f90a1819a2e9451a0
---

# merge: #272 AFK reaper: well-formed branch refs + slug guard (kill double-nested names)

- **PR:** [#276](https://github.com/reddb-io/red-skills/pull/276)
- **Author:** @filipeforattini
- **Merge SHA:** `13cb2ee7e5774e3db3ddd18f90a1819a2e9451a0`
- **Format:** merged pull request

## Summary

Automated AFK landing for #272. Per-attempt history lives in the issue Envelopes, the JSONL logs, and the `afk-attempts/*` snapshot branches.

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/276"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1782716321&installation_id=129708444&pr_number=276&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F276&signature=1fe6d63afe45a1101d467f3ebdd56e37b6e2302d2e6e9450218b227f7352a88c"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>@codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

## Commits

- feat(afk): add branch ref guard
- fix(afk): build refs through guard
- fix(afk): guard supervisor reaper refs
- test(afk): cover branch ref guard

## Files changed

- `plugins/dev/skills/engineering/afk/scripts/afk.sh`
- `plugins/dev/skills/engineering/afk/scripts/lib/branch-ref.sh`
- `plugins/dev/skills/engineering/afk/scripts/supervisor.sh`
- `plugins/dev/skills/engineering/afk/scripts/tests/branch-ref-guard.test.sh`

