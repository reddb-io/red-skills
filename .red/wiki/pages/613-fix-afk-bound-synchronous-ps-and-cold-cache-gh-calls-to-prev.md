---
title: fix(afk): bound synchronous ps and cold-cache gh calls to prevent event-loop stalls
type: source
tags: [pr, merged]
created: 2026-06-09
updated: 2026-06-09
sources: [pr-613]
pr: 613
merge_sha: 5624bdfe5be33329643615178ddbc16cd0d181e8
---

# fix(afk): bound synchronous ps and cold-cache gh calls to prevent event-loop stalls

- **PR:** [#613](https://github.com/reddb-io/red-skills/pull/613)
- **Author:** @filipeforattini
- **Merge SHA:** `5624bdfe5be33329643615178ddbc16cd0d181e8`
- **Format:** merged pull request

## Summary

## Summary

Closes #575

- **proc-tree**: refactored `inspectProcessTreeNative` into `inspectProcessTree(pid, run)` + wrapper (matching the `callerProcessTree` / `callerProcessTreeNative` pattern), added `timeout: 5000` to `execFileSync`; a hung `ps` now falls through to the existing catch → `CONSERVATIVE_BUSY_SNAPSHOT` rather than blocking the supervisor tick indefinitely
- **caller-process**: catch inspector throws inside `callerProcessTree` so a transient `ETIMEDOUT` or vanished-ancestor error degrades to a partial (or empty) tree instead of propagating; added `timeout: 3000` to the native `execFileSync` call
- **wire**: exported `withTimeout<T>` helper and `STATUSLINE_GH_COLD_TIMEOUT_MS`; cold-cache gh refresh now races against a 5 s deadline, swallowing errors (`.catch(()=>undefined)` mirrors stale-cache path); a stalled gh CLI cannot hang the statusline render
- **tests**: injected ps-runner tests for `inspectProcessTree` timeout/degrade paths; `withTimeout` timeout/rejection cases in `wire.test.ts`; throwing-inspector degrade cases in `caller-process.test.ts`

## Acceptance criteria

- [x] The `ps` stall probe cannot block the event loop indefinitely (bounded timeout → conservative-busy snapshot)
- [x] The caller-process probe degrades instead of throwing on a transient ps failure
- [x] The statusline render cannot hang/blank on a cold cache (bounded/async fetch)
- [x] Tests cover the timeout/degrade paths

## Test plan

- [x] All 1148 tests pass (`pnpm test` — 79 test files)
- [x] `caller-process.test.ts` — degrades to partial/empty tree on throwing inspector
- [x] `proc-tree.test.ts` — ETIMEDOUT/ENOENT → `CONSERVATIVE_BUSY_SNAPSHOT`; verified via `deriveSnapshot` (reaper must not kill on ps failure)
- [x] `wire.test.ts` — `withTimeout` races; cold-cache errors swallowed; falls back to 0/0 counts

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/613"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783640861&installation_id=129708444&pr_number=613&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F613&signature=8e0331104c9db5bb285391c22f1024c3b109f7b40ba06b76a8a638f7d03f7edc"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

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

