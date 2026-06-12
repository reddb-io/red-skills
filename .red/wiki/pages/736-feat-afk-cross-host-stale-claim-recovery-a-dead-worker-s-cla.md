---
title: feat(afk): cross-host stale-claim recovery — a dead worker's claim no longer blocks the queue
type: source
tags: [pr, merged]
created: 2026-06-12
updated: 2026-06-12
sources: [pr-736]
pr: 736
merge_sha: bcd3c7fb39b62094376b1f730c62c52335359503
---

# feat(afk): cross-host stale-claim recovery — a dead worker's claim no longer blocks the queue

- **PR:** [#736](https://github.com/reddb-io/red-skills/pull/736)
- **Author:** @filipeforattini
- **Merge SHA:** `bcd3c7fb39b62094376b1f730c62c52335359503`
- **Format:** merged pull request

## Summary

Closes #627

## Summary

- `core/claim-staleness.ts` (new): `classifyClaim(record, nowS, config) → fresh|stale`; staleness window `cadence × (tolerance + 1)` comfortably exceeds the refresh cadence and tolerates N missed refreshes. Plus `makeStaleClaimPredicate` (the reconciler's `isStale` seam), `classifyIssueClaims`, `planStaleClaimSweep`, audit renderers, and `RED_AFK_CLAIM_REFRESH_S` / `RED_AFK_CLAIM_STALE_TOLERANCE` env resolver.
- `core/claim.ts`: reconciler reports `recovered` stale claimants; `acquireClaim` posts exactly one audit comment on a recovered win.
- `core/boot.ts` (step 6a) + `runtime/wire.ts`: boot sweep lists `running` issues, releases any held only by a dead cross-host claim → restore `ready-for-agent`, strip `running`, post one audit comment. No-op when the lookup is absent.
- `commands/run.ts`: injects the staleness predicate + audit method so a simultaneous claim race also drops a stale cross-host winner.

## Acceptance criteria

- ✅ cross-host stale release via boot sweep
- ✅ live-slow worker never robbed (window math + "no live owner" release rule)
- ✅ restore-to-pool + one audit comment
- ✅ pure classifier unit-tested with injected clock
- ✅ returning owner concedes via the reconciler (`isStale` drops it before id-ordering)

## Test plan

- [ ] pnpm -C apps/dev test — 1482 tests pass
- [ ] pnpm typecheck — clean

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/736"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783871483&installation_id=129708444&pr_number=736&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F736&signature=026bd536c6f9e31253881e45931b5ea27a8efb830fbe99700d4e0a8b5b63fbee"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

## Commits

- feat(afk): pure cross-host stale-claim classification + sweep planner
- test(afk): cross-host stale-claim classification + sweep planner
- feat(afk): claim reconciler reports recovered stale claims + audit co…
- test(afk): claim recovery reporting, returning-owner concede, audit
- feat(afk): boot cross-host stale-claim sweep step (#627)
- test(afk): boot cross-host stale-claim sweep step (#627)
- feat(afk): wire claimedIssues lookup into boot deps (#627)
- feat(afk): wire claim staleness predicate + recovery audit (#627)

## Files changed

- `apps/dev/src/commands/run.ts`
- `apps/dev/src/core/boot.ts`
- `apps/dev/src/core/claim-staleness.ts`
- `apps/dev/src/core/claim.ts`
- `apps/dev/src/runtime/wire.ts`
- `apps/dev/tests/boot.test.ts`
- `apps/dev/tests/claim-staleness.test.ts`
- `apps/dev/tests/claim.test.ts`

