---
title: feat(afk): attempt progress guard — abort a stalled agent, park to ready-for-human (ADR 0044)
type: source
tags: [pr, merged]
created: 2026-06-02
updated: 2026-06-06
sources: [pr-400]
pr: 400
merge_sha: 55a2819935d8acea6425d78aa654b1af3f45fb9b
---

# feat(afk): attempt progress guard — abort a stalled agent, park to ready-for-human (ADR 0044)

- **PR:** [#400](https://github.com/reddb-io/red-skills/pull/400)
- **Author:** @filipeforattini
- **Merge SHA:** `55a2819935d8acea6425d78aa654b1af3f45fb9b`
- **Format:** merged pull request

## Summary

## The bug

An `/afk` iteration can run **forever**. Observed (#834): a single 1h41m iteration where the agent declared its work "complete", then kept re-exploring / re-running tests **without ever committing or emitting the `<promise>` sentinel** — burning cycle, never reaching merge.

Every existing guard misses it because the agent is **alive and busy, just not progressing**:
| Guard | Why it misses |
|---|---|
| `idleTimeoutSeconds` (600s) | wants *silence*; the agent keeps producing output |
| `maxIterations` (12) | counts *re-invocations*; this is one non-terminating iteration |
| stall reaper (agent-lane mtime) | lane is fresh — the agent IS emitting tool calls |

Liveness ≠ progress. The missing guard is a wall-clock bound on **progress**.

## Fix (ADR 0044)

- **Commit-anchored guard** (`startAttemptGuard`): poll the worker branch HEAD; if **no new commit** lands within the cap, abort via sandcastle's `AbortSignal` (kills the in-flight agent, **preserves the worktree/PR**). The deadline **resets on every commit** — a steadily-committing agent is never killed; only one that spins is. Commits = proof of *productive* life.
- **On fire → park, never retry**: new `timeout` outcome maps to the existing `stalled` terminal → **`ready-for-human` + `blocked:stalled`**, PR intact (the "review first, don't merge" disposition). `attempt-outcome.ts` already owns the stalled label/recovery/envelope maps — no vocab drift.
- **Cap**: `RED_AFK_ATTEMPT_TIMEOUT_S` / `plugins.dev.afk.attempt_timeout`, default **2700s (45min)**, typo-safe.
- **Armed only under no-sandbox** (commits aren't host-visible under docker/podman mid-run; idle timeout + maxIterations still apply there).

## Current ADR record (2026-06-06)

ADR 0044 is accepted as the attempt-progress guard. ADR 0028 now scopes
`<promise>` canonicality to agent-authored happy-path exits; the guard's timeout
is a runtime-initiated terminal path that emits no promise and parks as
`blocked:stalled`. ADR 0051 later refines the progress signal so productive
Codex work can reset the guard on worktree edits, not only commits.

## Tests

dev suite **853 pass** (+9): guard cap / commit-reset / unborn-branch, `runAgent` timeout wiring + signal pass-through, `parseAttemptTimeout`, and `processIssue` timeout→stalled routing (→ ready-for-human + blocked:stalled, envelope, no post_attempt). typecheck clean. Guard logic is pure over an injected clock/scheduler/headProbe — no real timers.

## Follow-up (PR-B)

Externalize proof-of-life: enrich the firehose heartbeat record with progress/liveness fields + a `state.last_progress_at` + an `on_heartbeat` integration hook for external integrations that want a push signal.

drift-guard: `Memory-NoIngest` trailer (ADR 0027).

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/400"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783011802&installation_id=129708444&pr_number=400&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F400&signature=730e3bd0fa789bce1cc5d8ffc35e1bafd9f73d273b62e0ae73ca03b579e99e40"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

## Release Notes

* **New Features**
  * Added progress monitoring that detects stalled operations and escalates them for human review with a `blocked:stalled` label instead of automatic retry.
  * Configurable timeout for detecting operations with no commit progress (default 45 minutes via `RED_AFK_ATTEMPT_TIMEOUT_S`).

* **Documentation**
  * Added architecture decision record documenting the attempt progress guard design.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- feat(afk): attempt progress guard — abort a stalled agent, park to re…

## Files changed

- `.red/adr/0044-afk-attempt-progress-guard.md`
- `src/apps/dev/src/commands/run.ts`
- `src/apps/dev/src/core/execution.ts`
- `src/apps/dev/src/core/process-issue.ts`
- `src/apps/dev/src/runtime/git.ts`
- `src/apps/dev/src/runtime/wire.ts`
- `src/apps/dev/tests/execution.test.ts`
- `src/apps/dev/tests/process-issue.test.ts`
