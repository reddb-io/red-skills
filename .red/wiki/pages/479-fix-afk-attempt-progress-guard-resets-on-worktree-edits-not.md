---
title: fix(afk): attempt-progress guard resets on worktree edits, not just commits (ADR 0051)
type: source
tags: [pr, merged]
created: 2026-06-03
updated: 2026-06-03
sources: [pr-479]
pr: 479
merge_sha: d8a3d9640194838b885f650936d35313d651a168
---

# fix(afk): attempt-progress guard resets on worktree edits, not just commits (ADR 0051)

- **PR:** [#479](https://github.com/reddb-io/red-skills/pull/479)
- **Author:** @filipeforattini
- **Merge SHA:** `d8a3d9640194838b885f650936d35313d651a168`
- **Format:** merged pull request

## Summary

## Problem (observed live on reddb, twice in one run)

The attempt-progress guard (ADR 0044) aborts an attempt when **no new commit** lands within the wall-clock cap (~45 min). The **codex runner does not commit mid-run**, so on any issue slower than the cap it false-stalls a fully productive agent:

- **#894** (WAL fdatasync): +228 lines → aborted `blocked:stalled` at 45 min.
- **#895** (skip DWB on CoW): **+497 lines**, `cargo check` + `cargo fmt` green, on the **final** focused test → aborted at 46m20s.

Both were parked `ready-for-human`, and because a `timeout` abort skips the ADR 0050 salvage, ~725 lines of green work were stranded. The guard meant to catch stuck agents was killing the most productive ones.

## Fix

Add an optional `progressProbe` — the worker worktree's changed-line **volume** (added+removed vs merge-base, committed+uncommitted, the same real-worktree diff the heartbeat reads after #469). Each poll, the deadline resets when **either**:
- a new commit landed (HEAD changed — the ADR 0044 signal), **or**
- the line-volume **changed** since the last poll (the agent edited).

The guard fires only when **neither** happened within the cap — the real "stalled" condition. Absent/rejecting `progressProbe` → degrades to the prior commit-anchored behaviour (no regression; a probe failure can never cause a false *reset*).

## Why this is the right cut
- A chatty agent producing no edits, or a hung process, still leaves both signals flat → aborts at the cap. ADR 0044's intent ("catch the stuck agent") is preserved, just made precise: no progress = no commit **and** no edit.
- Completes the trio vs codex-doesn't-commit: AGENT-PROMPT step 5 (prevent) → ADR 0050 salvage (cure DONE-without-commit) → this (stop killing it before it finishes).

## Files
- `execution.ts` — `RunAgentInput.progressProbe` + `startAttemptGuard` edit-signal reset
- `wire.ts` — `makeRunAgent` supplies the worktree line-volume probe (guard-armed only)
- `.red/adr/0051-*` — the decision record

## Tests
- 4 new guard tests: diff-growth resets (the #895 case) / frozen-volume still aborts / change-in-either-direction / probe-reject degrades to commit-anchored.
- Full `src/apps/dev` suite: **942/942**, typecheck clean.

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/479"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783120591&installation_id=129708444&pr_number=479&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F479&signature=a4aca6a28aa44810ff40b94d7b89d637a6dc5e3ecc2c8acd6c736a73c92161ca"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

## Commits

- fix(afk): attempt-progress guard resets on worktree edits, not just c…

## Files changed

- `.red/adr/0051-afk-attempt-guard-resets-on-worktree-edits-not-just-commits.md`
- `.red/adr/INDEX.md`
- `src/apps/dev/src/core/execution.ts`
- `src/apps/dev/src/runtime/wire.ts`
- `src/apps/dev/tests/execution.test.ts`

