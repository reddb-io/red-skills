---
title: feat(afk): externalize proof-of-life — heartbeat record, state field, on_heartbeat hook (ADR 0045)
type: source
tags: [pr, merged]
created: 2026-06-02
updated: 2026-06-06
sources: [pr-401]
pr: 401
merge_sha: 21b4e53683a0b12cde2b574916f6e6ee3c39c770
---

# feat(afk): externalize proof-of-life — heartbeat record, state field, on_heartbeat hook (ADR 0045)

- **PR:** [#401](https://github.com/reddb-io/red-skills/pull/401)
- **Author:** @filipeforattini
- **Merge SHA:** `21b4e53683a0b12cde2b574916f6e6ee3c39c770`
- **Format:** merged pull request

## Summary

Follow-up to #400 (ADR 0044's attempt progress guard). Externalizes the proof-of-life signal for any external integration that wants to consume it.

## Two findings that shaped it
- The ported periodic `emitHeartbeatTick` was **never wired** in the native runtime — no periodic heartbeat fired during a run.
- A periodic `on_heartbeat` hook needs `fireHook`, which lives in `processIssue` — **not** in the guard (execution.ts is the sandcastle seam, must stay hook-ignorant).

## Decision (ADR 0045): one signal, three surfaces, on the guard's ~60s poll
- **Guard** exposes an opaque `onTick(info)` callback; `runAgent` forwards `onHeartbeat` as it. execution.ts stays decoupled.
- **`processIssue`** builds the closure (owns `fireHook`): fires `on_heartbeat` (fire-and-forget) + calls `deps.emitHeartbeat`.
- **Surfaces:**
  - **tail** → enriched `type=heartbeat` firehose record (`secs_since_progress`/`last_progress_at`/`head`)
  - **read** → `current.last_progress_at` in `afk.state.json`
  - **push** → `on_heartbeat` user-shell hook (new canonical hook, `continue` policy; the first **periodic** one, ADR 0026 model)

Armed where the guard is armed (no-sandbox); under docker/podman neither fires (commits not host-visible mid-run). No second loop — the guard poll is the single cadence.

## Current ADR record (2026-06-06)

ADR 0045 is accepted as the externalized proof-of-life layer for ADR 0044. ADR
0026 now records `on_heartbeat` as the first periodic lifecycle hook with a
`continue` policy, distinct from once-per-point interceptors. ADR 0042 locates
the hook config under `plugins.dev.afk`.

## Tests
dev suite **855 pass** (+ `startAttemptGuard` onTick, `runAgent` onHeartbeat forwarding; updated hook-dispatcher policy table). typecheck clean.

drift-guard: `Memory-NoIngest` (ADR 0027).

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/401"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783013708&installation_id=129708444&pr_number=401&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F401&signature=4b8959c5ac47357845418112b5f4a3115272e4a9fdbf896b2b137ddfbbdba6ee"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

## Commits

- feat(afk): externalize proof-of-life — heartbeat record, state field,…

## Files changed

- `.red/adr/0045-afk-externalized-proof-of-life.md`
- `src/apps/dev/src/commands/run.ts`
- `src/apps/dev/src/core/execution.ts`
- `src/apps/dev/src/core/hook-config.ts`
- `src/apps/dev/src/core/hook-dispatcher.ts`
- `src/apps/dev/src/core/process-issue.ts`
- `src/apps/dev/src/types/state.ts`
- `src/apps/dev/tests/execution.test.ts`
- `src/apps/dev/tests/hook-dispatcher.test.ts`
