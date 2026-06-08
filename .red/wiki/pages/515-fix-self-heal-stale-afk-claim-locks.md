---
title: fix: self-heal stale AFK claim locks
type: source
tags: [pr, merged]
created: 2026-06-06
updated: 2026-06-06
sources: [pr-515]
pr: 515
merge_sha: 641f416b534c92a47300d6f5ec6315e2c5cb2eee
---

# fix: self-heal stale AFK claim locks

- **PR:** [#515](https://github.com/reddb-io/red-skills/pull/515)
- **Author:** @filipeforattini
- **Merge SHA:** `641f416b534c92a47300d6f5ec6315e2c5cb2eee`
- **Format:** merged pull request

## Summary

Closes #483

## Summary
- self-heal stale or poisoned .red/tmp/claims/<issue> lock paths during claim acquisition
- preserve live claim locks by checking the recorded pid before removing anything
- write explicit boot-error/session-error logs under the worker dir when the session dies before normal issue handling
- cover stale, live, and poisoned claim paths in fs tests

## Verification
- pnpm --filter @reddb-io/dev exec vitest run tests/fs-sweep.test.ts tests/run-flags.test.ts
- pnpm --filter @reddb-io/dev typecheck
- pnpm --filter @reddb-io/dev build

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/515"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783301184&installation_id=129708444&pr_number=515&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F515&signature=54b4bd6f55e637b2b2d09cd3e6501df1a0c9d074302f0face2be4f3642a4dddd"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

* **Bug Fixes**
  * Enhanced error reporting with improved logging and persistence for boot initialization and session execution failures
  * Strengthened process lock management with automatic detection and self-healing of stale locks to prevent conflicts

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- fix: self-heal stale AFK claim locks

## Files changed

- `src/apps/dev/src/commands/run.ts`
- `src/apps/dev/src/runtime/fs.ts`
- `src/apps/dev/tests/fs-sweep.test.ts`

