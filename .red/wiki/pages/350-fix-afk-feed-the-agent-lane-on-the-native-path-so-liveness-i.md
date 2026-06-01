---
title: fix(afk): feed the agent lane on the native path so liveness isn't blind
type: source
tags: [pr, merged]
created: 2026-06-01
updated: 2026-06-01
sources: [pr-350]
pr: 350
merge_sha: 087c21a7b3455eb4ecb6e1d98de2f66dc5477c21
---

# fix(afk): feed the agent lane on the native path so liveness isn't blind

- **PR:** [#350](https://github.com/reddb-io/red-skills/pull/350)
- **Author:** @filipeforattini
- **Merge SHA:** `087c21a7b3455eb4ecb6e1d98de2f66dc5477c21`
- **Format:** merged pull request

## Summary

## What

On the sandcastle (native) execution path, sandcastle captures the inner agent's output stream itself — so nothing advanced AFK's `agent.log.jsonl` lane, and its mtime froze at iteration start. The hard-stall detector (`reaper-signal`) and the `monitor` board both read that frozen lane as a **silent agent**, risking a false-positive stall on a live worker and a blind status board. Observed live while supervising #334.

## Fix

Wire sandcastle's `logging.onAgentStreamEvent` (the only stream callback it exposes, available in file-logging mode only) through to the lanes:

- **execution.ts** — `buildRunOptions` now drains sandcastle's file-log to the attempt dir's `sandcastle.log` and, when an `onAgentEvent` sink is supplied, forwards each text / tool-call event to it via `logging.onAgentStreamEvent`. `AgentStreamEvent` is re-exported (execution.ts is the single sandcastle seam, ADR 0033).
- **process-issue.ts** — passes `logPath` + `onAgentEvent: deps.recordAgentEvent` at both `runAgent` call sites (primary + fallback runner).
- **run.ts** — implements `recordAgentEvent` as `appendAgentRecord(agent.log.jsonl)` (the clean liveness lane) + a firehose mirror into `afk.log`.

Best-effort throughout: a lane-write failure can never break a run, and sandcastle already swallows any throw from the callback.

## Tests

5 new `buildRunOptions` cases (logging unset without `logPath`; file-log drained to `logPath`; `onAgentEvent` wired into `onAgentStreamEvent` and invoked; `onAgentEvent` ignored without `logPath`). Full dev suite green (769 passed). `bin/afk.mjs` rebuilt.

Refs #284.

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/350"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1782870944&installation_id=129708444&pr_number=350&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F350&signature=e976ce4b637d57a21007fffde0707b13850b3d4a866ef6dcc7e7df79073475a7"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>@codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

## Commits

- fix(afk): feed the agent lane on the native path so liveness isn't bl…

## Files changed

- `plugins/dev/skills/engineering/afk/bin/afk.mjs`
- `src/domains/dev/src/commands/run.ts`
- `src/domains/dev/src/core/execution.ts`
- `src/domains/dev/src/core/process-issue.ts`
- `src/domains/dev/tests/execution.test.ts`

