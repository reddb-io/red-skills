---
title: fix(afk): claim-race loser skips instead of dying, and never clobbers the winner's claim
type: source
tags: [pr, merged]
created: 2026-06-10
updated: 2026-06-10
sources: [pr-646]
pr: 646
merge_sha: 3bccff4811ef415090ff70d5bbf174f84e86fea9
---

# fix(afk): claim-race loser skips instead of dying, and never clobbers the winner's claim

- **PR:** [#646](https://github.com/reddb-io/red-skills/pull/646)
- **Author:** @filipeforattini
- **Merge SHA:** `3bccff4811ef415090ff70d5bbf174f84e86fea9`
- **Format:** merged pull request

## Summary

Closes #644.

## The live failure

With a fleet of `--once` workers, every claim-race loser on the head-of-queue issue exited instead of moving on (the `--once` break fired on a `claim-lost` outcome), and the attempt dir + state that `buildProcessInput` pre-creates BEFORE the claim survived as debris naming an issue the loser never owned. The next boot's orphan sweep read that debris as a mid-issue crash and restored `ready-for-agent` over the live winner's `running` label — putting the issue back at the head of every respawned worker's queue. Net: deaths+respawns every 16s tick for ~25 min, 2 of 3 slots starved, breaker never tripped (claim-lost exits are clean — exempt by design, which this PR documents rather than changes).

## Fixes

1. **session.ts** — `--once` consumes the single supervised iteration only when an attempt actually ran; `claim-lost` continues to the next candidate (SKILL §Per-Issue Loop step 1: "abandon the attempt directory and skip to the next issue").
2. **run.ts** — abandon means **delete**: on `claim-lost` the pre-claim attempt dir/state are removed, so no debris dir can impersonate a crash.
3. **boot.ts** — the orphan sweep's `restore-and-remove` consults the issue's local claim lock first (new optional `BootLookups.claimHolderAlive`, wired to `claims/{N}/pid` liveness via the newly-exported `fs.claimPathHeldByLivePid`); a live holder downgrades to plain remove. Fail-open: a throwing lookup restores as before.

Drive-by: three `tests/supervisor.test.ts` mocks updated to the current `TickResult` shape — the #579 merge left main's typecheck broken (`abandoned`/`idleParked`/`reconciledSlots`/`queueDepth` missing).

## Tests

- session: `--once` + claim-lost skips to next candidate; all-lost drains the queue without burning the iteration.
- boot: live claim holder → no restore/no comment, dir removed; no live holder → restores as before; throwing lookup → fail-open restore.
- `tsc` clean (was broken on main); session+boot 71/71; supervisor `guardedTick` describes 6/6 (full suite validated by CI — local host is saturated by the running fleet).

## Breaker note (#644 item 4)

The circuit breaker exempts clean exits by design (a NO-MORE-TASKS drain must never trip it). The churn was only possible because claim-lost produced clean instant exits — fix 1 removes that source, so the exemption stays as-is.

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/646"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783688282&installation_id=129708444&pr_number=646&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F646&signature=3b9bbd230511d4d4c7c656a2a766c03a117c62f294ba80e9e1e76a68430bbd71"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

* **New Features**
  * Added live process detection for claim locks to better handle claim race scenarios.

* **Bug Fixes**
  * Fixed orphan directory cleanup to skip unnecessary restoration steps when processes are still active.
  * Corrected session behavior to properly continue processing when claim races occur with the `--once` flag.
  * Improved attempt directory handling to prevent orphaned state files from persisting.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- fix(afk): claim-race loser skips instead of dying, and never clobbers…

## Files changed

- `src/apps/dev/src/commands/run.ts`
- `src/apps/dev/src/core/boot.ts`
- `src/apps/dev/src/core/session.ts`
- `src/apps/dev/src/runtime/fs.ts`
- `src/apps/dev/tests/boot.test.ts`
- `src/apps/dev/tests/session.test.ts`
- `src/apps/dev/tests/supervisor.test.ts`

