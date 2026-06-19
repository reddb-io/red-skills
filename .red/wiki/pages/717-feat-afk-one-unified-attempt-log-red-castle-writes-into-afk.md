---
title: feat(afk): one unified attempt log (red-castle writes into afk.log, not sandcastle.log)
type: source
tags: [pr, merged]
created: 2026-06-11
updated: 2026-06-11
sources: [pr-717]
pr: 717
merge_sha: 1d0547a556fddccdc5cf1b7f8e1113d52418186f
---

# feat(afk): one unified attempt log (red-castle writes into afk.log, not sandcastle.log)

- **PR:** [#717](https://github.com/reddb-io/red-skills/pull/717)
- **Author:** @filipeforattini
- **Merge SHA:** `1d0547a556fddccdc5cf1b7f8e1113d52418186f`
- **Format:** merged pull request

## Summary

## Why
A live run showed the attempt log is **empty during setup**. red-castle narrates the setup phase richly (worktree, sandbox, deps — 23+13+7 `display.status` calls in createSandbox/createWorktree/SandboxFactory), but it drains them to a **separate `sandcastle.log`**, while the operator/monitor watch `afk.log`. So `tail -f afk.log` is blank until the agent starts streaming — the setup black hole.

## What
Point red-castle's `logging.path` at the attempt's **`afk.log`** (our canonical log — `state.log` and the `tail -f afk.log` docs already reference it) instead of `sandcastle.log`. Now setup narration + agent turns + heartbeats land in **one file** — no empty window.

Drop the plaintext `[agent] …` mirror in the event sink: red-castle's file-log now renders agent text + tool calls into the same `afk.log`, so re-appending would double every turn. The **structured** per-event lanes (`agent.log.jsonl` + `log.jsonl` firehose) are untouched and still carry the rich `💰 usage` / `🧠 reasoning` records.

**No red-castle change** — it already accepts the log path as a parameter; we just hand it ours.

## Scope
- `process-issue.ts`: both `logPath` → `afk.log`.
- `run.ts`: remove the `[agent]` afk.log dupe (structured lanes unchanged).
- `execution.ts`: doc comments.
- `afk-e2e-smoke.sh` + `LIVENESS.md`: reference the unified file.

## Validation
- typecheck clean; `execution.test.ts` (88) + `heartbeat.test.ts` (23) green.
- Live tail-confirm follows once released.

## Not in this PR (the other half)
This unifies the **log file**. The **monitor/statusline** read `afk.state.json`, not the log, so setup still won't render there until we also stamp `current.last_event_at`/`stage` during setup (a small dev-plugin watcher) — next step. And the setup-`[stale]` badge has a second cause (`pid=0` until boot).

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/717"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783807338&installation_id=129708444&pr_number=717&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F717&signature=f3aa8664d22630da5d61cc50c518ea243008a043c02f8c68c175ce0d12d84b2f"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

* **Documentation**
  * Updated logging documentation to reflect consolidated log file structure and removal of duplicate plaintext agent messages.

* **Tests**
  * Updated validation scripts to check the unified log file for container execution markers.

* **Chores**
  * Consolidated agent event logging into a single log file, eliminating duplicate plaintext message entries and streamlining the logging output.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- feat(afk): one unified attempt log — red-castle writes into our afk.l…

## Files changed

- `apps/dev/src/commands/run.ts`
- `apps/dev/src/core/execution.ts`
- `apps/dev/src/core/process-issue.ts`
- `plugins/dev/skills/engineering/afk/docs/LIVENESS.md`
- `scripts/afk-e2e-smoke.sh`

