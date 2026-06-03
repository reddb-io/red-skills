---
title: fix(afk): orphan sweep skips LIVE sibling workers — no more reaping a running attempt (#444)
type: source
tags: [pr, merged]
created: 2026-06-03
updated: 2026-06-03
sources: [pr-465]
pr: 465
merge_sha: 81c1fa6ee7ed5f08065967bc01071fe897c43de4
---

# fix(afk): orphan sweep skips LIVE sibling workers — no more reaping a running attempt (#444)

- **PR:** [#465](https://github.com/reddb-io/red-skills/pull/465)
- **Author:** @filipeforattini
- **Merge SHA:** `81c1fa6ee7ed5f08065967bc01071fe897c43de4`
- **Format:** merged pull request

## Summary

Closes #444.

`listOrphanDirs` globbed **every** `.red/tmp/workers/*/*` attempt dir and returned them all — it **never checked the parent `worker.pid` liveness**, unlike its siblings `listStaleClaimDirs`/`listLegacyWorkDirs`. So a newly-booted parallel worker's boot orphan-sweep classified a **live** sibling's running attempt as orphaned → restored its issue to `ready-for-agent` + `rm -rf`'d the live worktree ("orchestrator died mid-issue"). It stayed latent only because normally no sibling is live at boot (observed live when a 2nd worker was spawned alongside a running one).

**Fix:** skip a worker entirely when its `worker.pid` is alive (missing/blank/dead → treated as dead, the conservative orphan path, matching the claim/legacy sweeps). Also skip non-directory entries so the `worker.pid` file is never listed as a bogus orphan.

Tests: dead worker → orphan; no-pid → orphan; **live sibling → skipped** (only the dead sibling collected). Dev suite 920/920.

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/465"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783107670&installation_id=129708444&pr_number=465&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F465&signature=5210d93f11cadcc1f20a131439705102a48cef41131e36d067ff3944d6edb378"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

## Release Notes

* **Bug Fixes**
  * Improved orphan cleanup logic to prevent accidental removal of attempt directories belonging to active worker processes.
  * Enhanced directory enumeration to only target attempt subdirectories, ignoring non-directory filesystem entries during cleanup operations.

* **Tests**
  * Added test coverage for orphan directory cleanup scenarios, including verification that active workers are properly excluded from cleanup operations.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- fix(afk): orphan sweep skips LIVE sibling workers (#444)

## Files changed

- `src/apps/dev/src/runtime/fs.ts`
- `src/apps/dev/tests/fs-sweep.test.ts`

