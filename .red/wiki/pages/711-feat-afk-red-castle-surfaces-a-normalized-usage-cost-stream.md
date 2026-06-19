---
title: feat(afk): red-castle surfaces a normalized usage/cost stream event (S2 #707)
type: source
tags: [pr, merged]
created: 2026-06-11
updated: 2026-06-11
sources: [pr-711]
pr: 711
merge_sha: 880da0983eef39d8c787f9035ab83e5adfc7fede
---

# feat(afk): red-castle surfaces a normalized usage/cost stream event (S2 #707)

- **PR:** [#711](https://github.com/reddb-io/red-skills/pull/711)
- **Author:** @filipeforattini
- **Merge SHA:** `880da0983eef39d8c787f9035ab83e5adfc7fede`
- **Format:** merged pull request

## Summary

Closes #707. Slice S2 of PRD #706 (WorkerVitals canonical vocabulary, ADR 0065).

## What this does
Bumps the vendored red-castle submodule (`bb1b1445` → `ad76396e`) to surface per-turn/step token usage as a **public `usage` `AgentStreamEvent`**, mirroring the existing reasoning-event wiring, so consumers can track running token spend per worker.

red-castle changes (landed on red-castle `main`, vendored — no npm/tag per ADR 0061):
- `IterationUsage` gains optional `reasoningTokens` (codex `reasoning_output_tokens`, opencode `tokens.reasoning`) and `costUsd`.
- `parseCodexUsage` captures `reasoning_output_tokens`.
- opencode `step_finish` now emits a `usage` event alongside its reasoning event (full input/output/reasoning/cache token breakdown).
- New public `AgentStreamEvent` `usage` variant.
- The pipe: parse loop → `onUsage` callback → `streamEmitter`, threaded through `invokeAgent` (appended last, positional callers unaffected).

## Scope
Substrate surfacing **only** — no `apps/dev` change. Consuming the event to persist the `WorkerVitals` cost group (`input_tokens`/`output_tokens`/`reasoning_tokens`/`cost_usd` on `current.*`) and rendering it is **S3 (#709)**, which is blocked on this.

## Per-runner liveness
- **codex** — emits `usage` live from `turn.completed` (now with `reasoningTokens`).
- **opencode** — emits `usage` live from `step_finish`.
- **claude** — usage flows at iteration boundary via `IterationResult.usage` (session-parsed); the live-stream `usage` event for claude is a follow-up (needs a fresh stream capture to avoid guessing the shape).

## Tests
red-castle `AgentProvider.test.ts` updated for the new opencode usage emission (+1 new case for "no token fields → nothing"); full red-castle suite green (`npm test`: 51 files, all pass after `build:dist`).

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/711"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783783449&installation_id=129708444&pr_number=711&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F711&signature=0d948ac6dfc1dcbc23600ad954540ca5d3ff4cd60dbbd5e2003f2e9b8730e2a2"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

## Commits

- feat(afk): bump red-castle — normalized usage/cost stream event (S2 #…

## Files changed

- `packages/red-castle`

