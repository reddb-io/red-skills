# ADR 0047 — AFK salvages a no-sentinel branch that already passes feedback

## Status

accepted. Complements ADR 0028 (`<promise>` is the canonical attempt-exit). Supersedes the runtime half of the stale PR #335 (`fix/332-afk-salvage-no-sentinel`, ~169 commits behind on the pre-`src/apps` tree); re-implemented here on the current `src/apps/dev/src/core/process-issue.ts`.

## Context

ADR 0028 makes the `<promise>` sentinel the canonical "attempt is over" signal and demotes EOF-without-sentinel to a **crash** detector. That is correct for a true crash, but it has a costly failure mode observed repeatedly (#332, #334, and live on #300):

The inner agent **finishes the work and commits it**, then exits **without** re-emitting `<promise>DONE</promise>` — often because it re-opened a branch a prior iteration already completed and concluded "already done, nothing to do." The runtime read that EOF as a crash, abandoned the (complete, green) branch, and re-invoked the agent. Each re-invocation re-discovered the finished commit and again exited without a sentinel — burning iterations up to `max_iterations` (#300: done at iteration 1, looped to 4/20 over ~50 min, never closed) and finally landing the issue in `ready-for-human` despite the work being mergeable the whole time. This is the dominant cause of AFK appearing "slow" / "adrift."

The preventive half (the agent must emit `DONE` even when work is already complete) shipped in `AGENT-PROMPT.md`. This ADR is the **runtime safety net**.

## Decision

On `run.outcome === "no-sentinel"`, the runtime branches on whether the worker branch carries work:

- **Empty branch** (no diff vs base, or branch absent on host) → unchanged: fire `on_attempt_error`, terminal `no-sentinel` → `ready-for-human`. A genuine crash with nothing to salvage keeps today's behaviour (and its crash-retry budget).
- **Branch ahead of base AND present** → **salvage**: do NOT fire `on_attempt_error`. Fire `post_attempt` with `success` and route the attempt through the **same feedback gate + landing + close tail the DONE path uses**. The feedback gate (typecheck/tests, ADR 0008) is load-bearing — it is the only thing distinguishing "complete prior work" from a half-baked crash-edit. If feedback fails, the attempt terminates as `feedback-failed` (the accurate reason), never `no-sentinel`.

A salvaged attempt lands, closes, and reports its terminal envelope **exactly like a DONE attempt** — the sentinel was the only thing missing, and the work itself already passed the gate.

## Consequences

- AFK converges on the common "finished-but-forgot-the-sentinel" case instead of looping to `max_iterations` — directly fixes the #300-class slowness.
- The merge gate is never bypassed: salvage only lands work that passes feedback. No-work / failing-work branches keep the terminal failure path.
- Pairs with the `AGENT-PROMPT` "already done still requires the sentinel" rule: the prompt is the prevention, this is the cure. Both are needed — a runner that crashes mid-write still hits the empty-branch / failing-feedback path safely.

Memory-NoIngest: ADR + runtime fix; the canonical graph claim for the no-sentinel contract stays with ADR 0028.
