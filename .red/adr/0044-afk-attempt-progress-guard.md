# AFK attempt progress guard: a commit-anchored wall-clock that parks a stalled agent

## Context

An `/afk` inner-agent iteration could run forever. Observed: a single iteration ran 1h41m — the agent declared its work "complete", then kept re-exploring and re-running tests without ever emitting the `<promise>DONE|BLOCKED</promise>` sentinel, burning cycle (and the cargo guard) indefinitely. The branch had a finished PR; the orchestrator never reached merge because there was no sentinel.

Every existing guard misses this failure, because the agent is **alive and busy**, just not *progressing*:

- **`idleTimeoutSeconds`** (sandcastle, 600s) fails an iteration only on *no output*; a re-exploring agent keeps producing output, so it never fires.
- **`maxIterations`** (12) caps *re-invocations*; this is a single non-terminating iteration, so it never fires.
- **The supervisor stall-reaper** keys off the agent lane's mtime (liveness); the lane stays fresh because the agent is genuinely emitting tool calls — so it sees a healthy worker.

Liveness ("is something executing?") is not progress ("is it producing work?"). The missing guard is a wall-clock bound on *progress*.

Sandcastle (`@ai-hero/sandcastle` ≥ 0.6.6) exposes `RunOptions.signal?: AbortSignal`: aborting mid-iteration kills the in-flight agent subprocess and **preserves the worktree on disk**.

## Decision

1. **Add an attempt progress guard.** While the inner agent runs, poll the worker branch's HEAD (`git rev-parse refs/heads/<branch>` — the ref lives in the shared `.git`, so commits made in sandcastle's worktree are visible). If **no new commit lands within the cap**, abort via the sandcastle `AbortSignal`. The deadline **resets on every new commit**, so a steadily-committing agent is never killed — only one that spins without producing work. Commits are the proof of *productive* life; the existing agent lane + `idleTimeoutSeconds` remain the proof of *liveness*.

2. **Cap = `RED_AFK_ATTEMPT_TIMEOUT_S` / `plugins.dev.afk.attempt_timeout`, default 2700s (45min).** Typo-safe parse (non-numeric / zero / negative → default); never silently disabled.

3. **On fire → park, never retry.** The guard surfaces a `timeout` agent-outcome which `processIssue` maps to the existing `stalled` terminal outcome: `recoveryReasonFor("stalled")` is `null` → always escalate → `ready-for-human` + the typed `blocked:stalled` label, a failure envelope, and the attempt dir/branch/PR preserved. No auto-retry — the work is there for a human to review (the maintainer's "review first, don't merge" disposition).

4. **Armed only under no-sandbox isolation.** Under docker/podman the agent commits in an isolated copy not host-visible until final sync, so a commit-anchored probe would false-fire; the guard is skipped there (idle timeout + maxIterations still apply). Default mode is no-sandbox.

## Consequences

- The "productive infinite loop" class is bounded without killing legitimately-long, steadily-committing agents.
- `ProcessOutcome` widens to include `stalled` (was supervisor-only); `attempt-outcome.ts` already owns the `stalled` → `blocked:stalled` / escalate / `blocked` mappings, so no vocabulary drift.
- The guard logic (`startAttemptGuard`) is pure over an injected clock / scheduler / headProbe / abort — fully unit-tested with no real timers or git.
- Liveness signal externalization (a richer heartbeat record + `on_heartbeat` integration hook) is a **follow-up** (PR-B); this ADR is the guard + routing only.

## Status

Accepted; implemented (PR-A). Externalized proof-of-life (heartbeat enrichment + `on_heartbeat` hook) tracked separately.

## Related

- ADR 0026 — AFK lifecycle hooks (the `on_heartbeat` follow-up extends this).
- ADR 0042 — config under `plugins.dev.afk` (the `attempt_timeout` knob lives here).
- `attempt-outcome.ts` — the single owner of the outcome vocabulary (`stalled` → `blocked:stalled`).
