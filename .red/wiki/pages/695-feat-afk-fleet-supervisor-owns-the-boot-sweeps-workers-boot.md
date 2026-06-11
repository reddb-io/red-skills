---
title: feat(afk): fleet supervisor owns the boot sweeps — workers boot bootstrap+claim only (#623)
type: source
tags: [pr, merged]
created: 2026-06-11
updated: 2026-06-11
sources: [pr-695]
pr: 695
merge_sha: 85ce90bd1146fd5f75f82200315ec18570cd6f01
---

# feat(afk): fleet supervisor owns the boot sweeps — workers boot bootstrap+claim only (#623)

- **PR:** [#695](https://github.com/reddb-io/red-skills/pull/695)
- **Author:** @filipeforattini
- **Merge SHA:** `85ce90bd1146fd5f75f82200315ec18570cd6f01`
- **Format:** merged pull request

## Summary

Closes #623. Landed manually via admin-merge: the AFK worker wSC3A completed the work (commit 329a9480, 124/124 tests pass, typecheck clean) but looped without emitting the DONE sentinel. Work verified complete on the branch.

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/695"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783772886&installation_id=129708444&pr_number=695&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F695&signature=ee01342d9e40f59555cbaf60e9e0d381e6d0bc350145ae529ad7b65c4535ff8c"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

## Commits

- feat(afk): fleet supervisor owns the boot sweeps — workers boot boots…

## Files changed

- `apps/dev/src/commands/run.ts`
- `apps/dev/src/commands/supervise.ts`
- `apps/dev/src/core/boot.ts`
- `apps/dev/src/core/session.ts`
- `apps/dev/src/core/supervisor.ts`
- `apps/dev/src/runtime/wire.ts`
- `apps/dev/tests/boot.test.ts`
- `apps/dev/tests/session.test.ts`
- `apps/dev/tests/supervise-passthrough.test.ts`
- `apps/dev/tests/supervisor-boot.test.ts`
- `apps/dev/tests/wire.test.ts`
- `plugins/dev/skills/engineering/afk/docs/BOOT-SWEEPS.md`

