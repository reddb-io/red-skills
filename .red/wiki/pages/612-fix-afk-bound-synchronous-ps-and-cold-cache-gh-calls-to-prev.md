---
title: fix(afk): bound synchronous ps and cold-cache gh calls to prevent event-loop stalls
type: source
tags: [pr, merged]
created: 2026-06-09
updated: 2026-06-09
sources: [pr-612]
pr: 612
merge_sha: 2b7245fab35a526cb450f680b8cd563fdd3efbc8
---

# fix(afk): bound synchronous ps and cold-cache gh calls to prevent event-loop stalls

- **PR:** [#612](https://github.com/reddb-io/red-skills/pull/612)
- **Author:** @filipeforattini
- **Merge SHA:** `2b7245fab35a526cb450f680b8cd563fdd3efbc8`
- **Format:** merged pull request

## Summary

## Summary
- `proc-tree`: adds `timeout:5000` to `execFileSync` so a hung `ps` falls through to the existing `catch → CONSERVATIVE_BUSY_SNAPSHOT` rather than blocking the supervisor tick
- `caller-process`: catches inspector throws inside `callerProcessTree` so a transient ETIMEDOUT or vanished-ancestor degrades to a partial/empty tree; adds `timeout:3000` to the native `execFileSync` call
- `wire`: exports `withTimeout<T>` helper and `STATUSLINE_GH_COLD_TIMEOUT_MS`; cold-cache `gh` refresh now races against a 5 s deadline so a stalled `gh` CLI cannot hang the statusline render (queue/human fall back to 0/0)

## Test plan
- [ ] `pnpm -C src/apps/dev test --run` passes (1142 tests, 79 test files)
- [ ] New `withTimeout` cases in `wire.test.ts` cover timeout + happy-path
- [ ] New throwing-inspector degrade cases in `caller-process.test.ts` cover partial tree and empty tree on error

Closes #575

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/612"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783639264&installation_id=129708444&pr_number=612&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F612&signature=bf71dcaa6a9b7981eb84d2d2a78601393259df6141d9ef7f239643c5cc5d19d1"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->
## Summary by CodeRabbit

* **Bug Fixes**
  * Statusline and background refreshes no longer hang: GitHub-derived counts use a bounded cold-cache timeout so UI stays responsive.
  * Process inspection failures degrade safely: transient errors or timeouts return partial or conservative fallback snapshots instead of crashing.

* **Tests**
  * New and expanded tests cover timeout, degradation, and partial-result behaviors for process inspection and bounded refreshes.
<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- fix(afk): bound synchronous ps and cold-cache gh calls to prevent eve…
- test(afk): inject ps runner into inspectProcessTree to cover timeout …
- fix(afk): swallow refresh() errors in cold-cache statusline path

## Files changed

- `src/apps/dev/src/runtime/caller-process.ts`
- `src/apps/dev/src/runtime/proc-tree.ts`
- `src/apps/dev/src/runtime/wire.ts`
- `src/apps/dev/tests/caller-process.test.ts`
- `src/apps/dev/tests/proc-tree.test.ts`
- `src/apps/dev/tests/wire.test.ts`

