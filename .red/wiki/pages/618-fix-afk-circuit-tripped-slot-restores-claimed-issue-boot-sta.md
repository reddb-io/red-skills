---
title: fix(afk): circuit-tripped slot restores claimed issue + boot-stamp makes sweep reliable (#577)
type: source
tags: [pr, merged]
created: 2026-06-10
updated: 2026-06-10
sources: [pr-618]
pr: 618
merge_sha: 1ed8d2bd3d6189a42b6943d4c3cc2711104f9640
---

# fix(afk): circuit-tripped slot restores claimed issue + boot-stamp makes sweep reliable (#577)

- **PR:** [#618](https://github.com/reddb-io/red-skills/pull/618)
- **Author:** @filipeforattini
- **Merge SHA:** `1ed8d2bd3d6189a42b6943d4c3cc2711104f9640`
- **Format:** merged pull request

## Summary

## Summary

- **Root cause**: The circuit-trip sweep (`sweepParkedSlot`) resolved parked-slot workers from `parseWorkerIdsFromLog`, but the native fleet worker never emitted the `[afk] worker: wXXXX` boot-stamp to stdout — so the log parse always returned `[]` and the sweep always early-returned, stranding any claimed issue in `running` forever with no label restore and no discard envelope.
- **Fix**: Emit `[afk] worker: ${workerId}` to stdout immediately after generating the worker ID in `run.ts` (before any I/O that could fail). The supervisor routes the child's stdout/stderr to the per-slot log, so the stamp is captured even when the worker fast-dies before writing `worker.pid`.
- **Integration test**: Added a real-FS integration describe block that drives the full path `handleDeadSlot → sweepParkedSlot → parkedSlotWorkFor` against a real temp directory, verifying the claimed issue is restored with correct labels AND the discard envelope carries the true fast-death count (5, not 0).

## Acceptance criteria

- [x] When a slot's circuit breaker trips, the claimed issue is restored to the queue, never left stranded in `running`
- [x] The parked-slot work resolution is exercised by an integration test over the REAL path (current coverage injected a fake and never ran it)
- [x] The trip-sweep discard envelope reports the true fast-death count

## Test plan

- [x] `pnpm test` in `src/apps/dev` — 1207/1207 pass
- [x] New integration tests in `supervisor.test.ts` exercise the real `parkedSlotWorkFor` FS path end-to-end
- [x] New unit tests in `supervisor-fs.test.ts` cover slot-log parse, PID fallback, empty log, and multi-slot isolation

Closes #577

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/618"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783650820&installation_id=129708444&pr_number=618&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F618&signature=e75f06ea29b230dae0efccfae7da4e9a6b2e6dbb48536bf18a7a2431d7b91e5a"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

* **Bug Fixes**
  * Improved sweep reliability for AFK worker management through enhanced worker identification and logging mechanisms

* **Tests**
  * Added comprehensive integration test coverage validating worker state management, identification, and behavioral scenarios
  * Expanded test coverage for label restoration and worker lifecycle handling

* **Documentation**
  * Updated CHANGES.md with detailed documentation of engineering improvements and reliability enhancements

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- chore(afk): add CHANGES.md entry for #577 circuit-trip sweep fix

## Files changed

- `CHANGES.md`

