---
title: feat(afk): RED_AFK_SANDBOX env override + fix E2E smoke docker path
type: source
tags: [pr, merged]
created: 2026-05-31
updated: 2026-05-31
sources: [pr-310]
pr: 310
merge_sha: 968be3203610e28abe067255d693c508a66cd2a5
---

# feat(afk): RED_AFK_SANDBOX env override + fix E2E smoke docker path

- **PR:** [#310](https://github.com/reddb-io/red-skills/pull/310)
- **Author:** @filipeforattini
- **Merge SHA:** `968be3203610e28abe067255d693c508a66cd2a5`
- **Format:** merged pull request

## Summary

resolveRunSettings only read afk.sandbox from config, so the E2E smoke's docker path was a dead no-op (ran as noSandbox). Adds RED_AFK_SANDBOX env override (env > config > none) so the #284 docker acceptance criterion is actually exercisable; fixes the smoke to export the var the runtime reads. 2 new wire tests. [skip release].

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/310"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1782793067&installation_id=129708444&pr_number=310&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F310&signature=718fbdc78e06110d30e0788f1ac5918c1b74e132f5e4fa8a01c38c0030fcff9b"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>@codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

## Commits

- feat(afk): RED_AFK_SANDBOX env override + fix the E2E smoke docker path

## Files changed

- `scripts/afk-e2e-smoke.sh`
- `src/domains/dev/src/runtime/wire.ts`
- `src/domains/dev/tests/wire.test.ts`

