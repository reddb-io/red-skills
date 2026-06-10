---
title: fix(afk): progress probe and heartbeat diffstat compute against resolved base
type: source
tags: [pr, merged]
created: 2026-06-10
updated: 2026-06-10
sources: [pr-655]
pr: 655
merge_sha: 5e729b3436dcbc54eab344bb6cfc0c983d8fb084
---

# fix(afk): progress probe and heartbeat diffstat compute against resolved base

- **PR:** [#655](https://github.com/reddb-io/red-skills/pull/655)
- **Author:** @filipeforattini
- **Merge SHA:** `5e729b3436dcbc54eab344bb6cfc0c983d8fb084`
- **Format:** merged pull request

## Summary

Closes #570

## Summary

Both the attempt-progress probe (edit-signal gate) and the heartbeat `+A/-R` diffstat hardcoded `origin/main` as the comparison ref. On a locked/pinned non-main branch the displayed line-diff and the edit-progress signal were wrong.

**Fix:** derive the comparison ref from the attempt's resolved base (`lock > pin > main`) across all five paths that compute it.

| Path | File | Change |
|------|------|--------|
| Attempt progress probe | `wire.ts` | `input.base → origin/<base>` |
| Heartbeat live diffstat | `run.ts` | `info.base → origin/<base>` |
| processIssue spreads base | `process-issue.ts` | `{ ...info, base }` into emitHeartbeat |
| Monitor fallback diffstat | `wire.ts` | `state.current.base → origin/<base>` |
| Statusline fallback diffstat | `wire.ts` | `state.current.base → origin/<base>` |

Supporting: `AttemptProgressInfo.base?` (`execution.ts`) + `AfkCurrentSchema.base` default `""` (`state.ts`).

## Tests

New describe block `processIssue — emitHeartbeat receives resolved base` (2 cases):
- Pinned `release/v2` body → heartbeat receives `base: "release/v2"`
- No pin/lock → heartbeat receives `base: "main"`

`process-issue.test.ts`: 72 pass / 0 fail. `tsc --noEmit`: no errors in changed files.

## Note

This is a clean cherry-pick of `2dbab1aa` from `afk/wBZWE/570-fix-afk-attempt-progress-guard-and-heart` — the original branch had AFK salvage commits that added local machine symlinks for `node_modules`, which caused `blocked:validation`.

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/655"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783695734&installation_id=129708444&pr_number=655&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F655&signature=17261dcf9fd528f5dc127bd78fdf8402fcc1a9a099216b77c1f369410432a041"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

## Commits

- fix(afk): progress probe and heartbeat diffstat compute against resol…

## Files changed

- `src/apps/dev/src/commands/run.ts`
- `src/apps/dev/src/core/execution.ts`
- `src/apps/dev/src/core/process-issue.ts`
- `src/apps/dev/src/runtime/wire.ts`
- `src/apps/dev/src/types/state.ts`
- `src/apps/dev/tests/process-issue.test.ts`

