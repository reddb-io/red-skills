---
title: fix(afk): circuit-tripped slot restores claimed issue; boot-stamp ensures sweep resolves fast-dying workers
type: source
tags: [pr, merged]
created: 2026-06-10
updated: 2026-06-10
sources: [pr-619]
pr: 619
merge_sha: e4631c757348cfad45a694a47145af0c22f3c8f4
---

# fix(afk): circuit-tripped slot restores claimed issue; boot-stamp ensures sweep resolves fast-dying workers

- **PR:** [#619](https://github.com/reddb-io/red-skills/pull/619)
- **Author:** @filipeforattini
- **Merge SHA:** `e4631c757348cfad45a694a47145af0c22f3c8f4`
- **Format:** merged pull request

## Summary

## Summary

Fixes three related bugs in the circuit-trip sweep (`sweepParkedSlot`) identified in #567 and tracked in #577:

- **Sweep early-return**: The native supervisor never wrote to the per-slot log file, so `parkedSlotWork` always returned an empty workers list → claimed issues were stranded in `running` forever. Fixed by wiring per-slot log files in `spawnSlot` (each slot routes stdout/stderr to `afk-supervisor-slot-{slot}.log`).
- **Boot-stamp missing**: Workers that fast-died before writing `worker.pid` were invisible to the sweep. Fixed by emitting `[afk] worker: ${workerId}` to stdout immediately after generating the worker ID in `run.ts`, before any I/O that could fail.
- **Fast-death count always 0**: The discard envelope hardcoded `fastDeaths: 0` from the FS layer. Fixed by deriving the count from `state.deaths.length` (the circuit ring at trip time) in `sweepParkedSlot`.

## Test plan

- [ ] `pnpm test` in `src/apps/dev/` — all 1207 tests pass
- [ ] New `describe("circuit trip — real FS integration (slot-log boot-stamp path)")` block in `supervisor.test.ts` exercises the **real** `parkedSlotWorkFor` (not a mock) end-to-end: slot log → worker ID → claimed issue → label restore + discard envelope with correct fast-death count
- [ ] `supervisor-fs.test.ts` covers `parkedSlotWorkFor` slot-log path and PID fallback path over real filesystem

Closes #577

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/619"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783651187&installation_id=129708444&pr_number=619&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F619&signature=cc146b246a452e28ea22d8bde9bc4d1b1b3d83779148fcb46f5b8c23afb74659"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

* **Documentation**
  * Changelog updated to document improvements in sweep resolution reliability and fixes for circuit-tripped slot restoration issues.
* **Tests**
  * Added comprehensive test coverage for sweep operations, including validation of parked slot handling and related scenarios.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- chore(afk): add CHANGES.md entry for #577 circuit-trip sweep fix

## Files changed

- `CHANGES.md`

