---
title: fix(afk): boot-reconcile base resolution + claim-race recovery safety (#568)
type: source
tags: [pr, merged]
created: 2026-06-09
updated: 2026-06-09
sources: [pr-601]
pr: 601
merge_sha: dd8437f8e9b704db48351c199a801c9945594da2
---

# fix(afk): boot-reconcile base resolution + claim-race recovery safety (#568)

- **PR:** [#601](https://github.com/reddb-io/red-skills/pull/601)
- **Author:** @filipeforattini
- **Merge SHA:** `dd8437f8e9b704db48351c199a801c9945594da2`
- **Format:** merged pull request

## Summary

Closes #568 (the urgent trunk-safety / claim-race cluster extracted from PRD #567). Implemented directly (worktree→PR) because the autonomous fleet on the buggy 1.180.0 bundle lost two attempts here (orchestrator died mid-commit).

## The four fixes
1. **CRITICAL — wrong-base merge onto the trunk** (`commands/run.ts`): the boot reconcile sweep hardcoded `base: "main"`, so a parked issue pinned to a non-main branch — or a branch-locked session — was validated and **merged onto `main`**, bypassing the human's pin/lock. Now resolves the effective base via `resolveBase` (lock > pin > main, ADR 0031), mirroring the per-issue path.
2. **Boot reconcile sweep took no claim lock** (`commands/run.ts`): two concurrent boots could both validate-and-land the same parked branch. The runner now acquires the per-issue `claims/{N}` lock before validate/land (released in `finally`), mutually exclusive with the live per-issue path; skips when another live pid holds it.
3. **Stale-claim reclaim TOCTOU** (`runtime/fs.ts`): the `rm`-then-`mkdir` reclaim let two workers that both saw a dead holder both reclaim it — the #434 duplicate-claim race, reopened on the post-crash recovery path. Reclaim is now **atomic**: rename the dead dir to a unique temp (rename(2) is atomic → exactly one winner; losers get ENOENT and bail), only the winner deletes + re-claims.
4. **terminalFailure leaked the claim** (`core/process-issue.ts`): the shared no-sentinel / blocked / feedback-failed / stalled tail never released the per-issue claim, so a retry-routed / re-queued issue stayed un-claimable until the worker died. Now releases, matching every other terminal path.

Plus a belt-and-suspenders re-check in `core/reconcile.ts`: re-verify the issue is still open immediately before landing (`already-closed` skip).

## Tests
- `fs-sweep`: N concurrent reclaimers on a stale dir → **exactly one** wins.
- `process-issue`: `trace.released` now asserted on the **BLOCKED** and **no-sentinel** terminals (the test gap the audit flagged).
- `reconcile`: `already-closed` skip does not land/close/relabel.

Gate green in the worktree: **typecheck + 1150 tests + build**.

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/601"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783609428&installation_id=129708444&pr_number=601&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F601&signature=8cfdda8678af505d6b2c10509019cd9bc6ef54b9bf3fa396941a876d8493d1d2"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

## Commits

- fix(afk): boot-reconcile base resolution + claim-race recovery safety…

## Files changed

- `src/apps/dev/src/commands/run.ts`
- `src/apps/dev/src/core/process-issue.ts`
- `src/apps/dev/src/core/reconcile.ts`
- `src/apps/dev/src/runtime/fs.ts`
- `src/apps/dev/tests/fs-sweep.test.ts`
- `src/apps/dev/tests/process-issue.test.ts`
- `src/apps/dev/tests/reconcile.test.ts`

