---
title: fix(afk): supervisor.test runSupervisor tests spin → OOM, false-failing every gate (#446)
type: source
tags: [pr, merged]
created: 2026-06-03
updated: 2026-06-03
sources: [pr-464]
pr: 464
merge_sha: 7a5c7ee83b0fdd479407d68b5fb2b4c646bec227
---

# fix(afk): supervisor.test runSupervisor tests spin → OOM, false-failing every gate (#446)

- **PR:** [#464](https://github.com/reddb-io/red-skills/pull/464)
- **Author:** @filipeforattini
- **Merge SHA:** `7a5c7ee83b0fdd479407d68b5fb2b4c646bec227`
- **Format:** merged pull request

## Summary

Closes #446.

## Root cause (the real reason the AFK could not self-merge)
`runSupervisor` wraps each tick in `guardedTick`, which **races the tick against `sleep(ceiling)`**. The `runSupervisor` tests mocked `deps.proc.sleep` as an **immediately-resolving** `vi.fn`, so the ceiling won every race → guardedTick discarded the real `{stopped:true}` → the `for(;;)` loop **spun forever**, ballooning heap to ~2GB and **OOM-crashing the whole `pnpm test` run**. The AFK feedback gate read that crash as a test failure → **false `blocked:validation`** on every `afk/*` attempt touching the dev package.

Production was never affected (real `sleep` is a timer that never beats a sub-second tick); the tests just weren't updated when `guardedTick` landed.

## Fix
- The mocked `sleep` resolves on a **macrotask** (`setTimeout(…, 0)`) so the tick wins the race and `stopped` propagates.
- Updated the three `runSupervisor` assertions for guardedTick's per-tick ceiling sleep (filter the cadence sleeps by arg).

## Validation
- `supervisor.test.ts` alone: **31/31, 171ms** (was hang/OOM).
- Full dev suite: **917/917 in ~77s** (was OOM-crashing at ~64/65 files).

This is *the* unlock for autonomous throughput — the gate stops false-failing, so the AFK can self-merge again. Test-only change; no production code touched.

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/464"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783107251&installation_id=129708444&pr_number=464&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F464&signature=277fa330f36f8cea7e0f52ef782fa82c978f58852fdb599ad69c4e5e34eecd79"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

* **Tests**
  * Improved test reliability for timing-sensitive supervisor behavior by fixing mock resolution timing and updating expectations for stop-file handling scenarios.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- fix(afk): supervisor.test runSupervisor tests no longer spin → OOM (#…

## Files changed

- `src/apps/dev/tests/supervisor.test.ts`

