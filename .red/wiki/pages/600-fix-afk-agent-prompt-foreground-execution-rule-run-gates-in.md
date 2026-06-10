---
title: fix(afk): AGENT-PROMPT foreground-execution rule — run gates in foreground and read the output
type: source
tags: [pr, merged]
created: 2026-06-09
updated: 2026-06-09
sources: [pr-600]
pr: 600
merge_sha: f55968d9d4d07a6032d9f77ba13629ee55e96aa0
---

# fix(afk): AGENT-PROMPT foreground-execution rule — run gates in foreground and read the output

- **PR:** [#600](https://github.com/reddb-io/red-skills/pull/600)
- **Author:** @filipeforattini
- **Merge SHA:** `f55968d9d4d07a6032d9f77ba13629ee55e96aa0`
- **Format:** merged pull request

## Summary

## What
Hardens the AFK inner-agent contract (`AGENT-PROMPT.md`) so agents stop **backgrounding commands and polling a log** for completion — the pattern that makes them blind to what actually happened.

## Why
Reported live during an AFK run: inner agents run tests/commands in the background and do `until grep "…" log` to detect completion, so they **never read the real exit code/output**. Crashes, panics, OOMs, and stderr land in a stream they never read → they proceed as if it passed and **commit broken work on a false belief**. *"não conseguir ler gera muito bug por não entender o que está acontecendo."*

## What changed
Rewrote the *Background Tasks and Polling* section around one cardinal rule:
- **Run every result-bearing command in the foreground, wait for it to return, and read its actual output.** A slow command → a longer `timeout`, never polling.
- **Never `run_in_background` a command whose output you then need** (tests/typecheck/build/compile/lint/scripts).
- **Never write an `until grep` / `tail -f` loop to detect completion** — it's blind to crashes/stderr/panics.
- Kept the genuine background-server case (captured-PID / bracket-trick + hard deadline).

Also dropped the **stale pre-sandcastle machinery** the section still claimed as live — the 30s post-sentinel pipe watchdog and the `pnpm` PATH `timeout` shim (neither exists under sandcastle, ADR 0033) — and re-pointed the safety-net language at the real bounds (idle-timeout, max-iterations, commit-anchored attempt guard).

Subsumes the `AGENT-PROMPT.md` portion of #592 (that issue retains its `SAFETY.md` scope).

Docs/contract only — no runtime code. Takes effect for AFK workers on the next bundle release.

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/600"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783608052&installation_id=129708444&pr_number=600&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F600&signature=a31c01cee2b387138ac784570b45175c1108000ad82ddc613342532dd16e6a91"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

* **Documentation**
  * Clarified internal engineering guidance for command execution best practices, emphasizing foreground operation and proper timeout handling.
  * Strengthened safety constraints for automated system operations.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- fix(afk): AGENT-PROMPT foreground-execution rule — run gates in foreg…

## Files changed

- `CHANGES.md`
- `plugins/dev/skills/engineering/afk/AGENT-PROMPT.md`

