---
title: fix(afk): anchor sandcastle under the attempt dir, not the repo root
type: source
tags: [pr, merged]
created: 2026-05-31
updated: 2026-05-31
sources: [pr-326]
pr: 326
merge_sha: 5895fef6630cc481b1cc3528b3f6f6e057876918
---

# fix(afk): anchor sandcastle under the attempt dir, not the repo root

- **PR:** [#326](https://github.com/reddb-io/red-skills/pull/326)
- **Author:** @filipeforattini
- **Merge SHA:** `5895fef6630cc481b1cc3528b3f6f6e057876918`
- **Format:** merged pull request

## Summary

sandcastle's .sandcastle/ (worktrees/logs/.env/patches) leaked to the repo root because RunOptions.cwd defaulted to process.cwd(). Set cwd to the per-attempt dir (.red/tmp/workers/.../, absolute, self-cleaning) so everything lands under .red/. Unit-tested wiring; runtime confirmation pending #284. 695 tests. [skip release].

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/326"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1782834374&installation_id=129708444&pr_number=326&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F326&signature=cfeabb39d7efeb72d39778d83dfc11602d04a5fc5881245db12721d1e1be2e79"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>@codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

## Commits

- fix(afk): anchor sandcastle under the attempt dir, never the repo root

## Files changed

- `plugins/dev/skills/engineering/afk/bin/afk.mjs`
- `src/domains/dev/src/core/execution.ts`
- `src/domains/dev/src/core/process-issue.ts`
- `src/domains/dev/tests/execution.test.ts`
- `src/domains/dev/tests/process-issue.test.ts`

