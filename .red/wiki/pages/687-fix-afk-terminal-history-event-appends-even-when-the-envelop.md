---
title: fix(afk): terminal history event appends even when the envelope POST fails (closes #625)
type: source
tags: [pr, merged]
created: 2026-06-11
updated: 2026-06-11
sources: [pr-687]
pr: 687
merge_sha: d1ff97fa819337f22862776df90d42aa294b296a
---

# fix(afk): terminal history event appends even when the envelope POST fails (closes #625)

- **PR:** [#687](https://github.com/reddb-io/red-skills/pull/687)
- **Author:** @filipeforattini
- **Merge SHA:** `d1ff97fa819337f22862776df90d42aa294b296a`
- **Format:** merged pull request

## Summary

Parent PRD #614.

**Root cause:** in `emitEnvelope` the history-ledger append was gated inside the `else if (posted)` branch — a transient `gh issue comment` failure (`posted === false`) silently dropped the `done`/`blocked` record. The 2026-06-09 gap: three issues landed but produced no `done` records, freezing the sparkline + drain-promotion counters.

**Fix:** the local ledger is independent of the GitHub comment — append the terminal event unconditionally (when `historyPath`+`historyClock` are set); the `!posted` warning + `envelope.posted` signal stay separate. flock append + truncation unchanged.

**Tests:** new regression for the post-fails path; the stale test that *encoded the bug* (`historyAppend).not.toHaveBeenCalled()`) flipped to assert the fix. envelope-emit + history green (37/37), typecheck clean.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/687"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783746230&installation_id=129708444&pr_number=687&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F687&signature=a95956535cbff7123d4a788346986d3bf8dcc3fe3c1dbb2a1f7f0bee16455907"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

* **Bug Fixes**
  * Improved history record reliability. Records are now properly saved even when background operations fail, ensuring data integrity and preventing information loss.

* **Tests**
  * Added test coverage for history persistence under various operational conditions.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- fix(afk): terminal history event appends even when the envelope POST …

## Files changed

- `apps/dev/src/core/envelope-emit.ts`
- `apps/dev/tests/envelope-emit.test.ts`

