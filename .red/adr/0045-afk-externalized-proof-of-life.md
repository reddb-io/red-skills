# AFK externalized proof-of-life: a periodic heartbeat record, state field, and `on_heartbeat` hook

## Context

ADR 0044 added the attempt **progress guard** (abort a stalled-but-busy agent), and noted that externalizing the proof-of-life signal — so an outside system can integrate — was a follow-up. Two facts shaped that follow-up:

- The ported `emitHeartbeatTick` existed but was **never wired** in the native (sandcastle) runtime: no periodic `heartbeat` record was emitted during a run. The only live liveness signal was `recordAgentEvent` (per agent stream event → the agent lane).
- A periodic `on_heartbeat` **user hook** needs the hook dispatcher (`fireHook`), which lives in `processIssue` — not in `runAgent`/the guard (execution.ts is the sandcastle seam and must stay ignorant of AFK lifecycle hooks).

## Decision

Externalize proof-of-life on the attempt guard's existing **~60s poll cadence** — one signal, three consumer surfaces — without a second loop and without leaking hook knowledge into execution.ts:

1. **The guard exposes an opaque `onTick(info)` callback.** `startAttemptGuard` already polls the worker-branch HEAD; it now invokes an injected `onTick` each poll with `{ head, lastProgressMs, nowMs }`. execution.ts stays ignorant of what the callback does. `runAgent` forwards `RunAgentInput.onHeartbeat` as that `onTick`.

2. **`processIssue` builds the `onHeartbeat` closure** (it owns `fireHook`): each tick it (a) fires the `on_heartbeat` user hook fire-and-forget, and (b) calls a CLI-wired `deps.emitHeartbeat(info)` sink.

3. **Three externalized surfaces:**
   - **Firehose record** — an enriched `type=heartbeat` line in `log.jsonl` carrying `secs_since_progress`, `last_progress_at`, `head` (integrators *tail* it).
   - **State field** — `current.last_progress_at` mirrored into `afk.state.json` (integrators/monitors *read* it).
   - **`on_heartbeat` hook** — a new canonical lifecycle hook (user shell, ADR 0026 model; `continue` exit policy). Unlike the once-per-point lifecycle hooks it fires **periodically** during a run; a user command receives the heartbeat context so an external monitor can be *pushed* to. No built-in default; absent config → no-op.

4. **Armed where the guard is armed** (no-sandbox): the heartbeat rides the guard's tick, so under docker/podman (where the guard is skipped — commits not host-visible mid-run) no periodic heartbeat fires either. Liveness there remains the agent lane + `idleTimeoutSeconds`. **(Superseded by ADR 0054, issue #405: the guard now arms under docker/podman via the attempt-dir bind mount, so the heartbeat rides its tick under isolation too.)**

## Consequences

- Proof-of-life is now consumable three ways (tail / read-state / push-hook) without a dedicated loop — the guard's poll is the single cadence.
- `on_heartbeat` is the first **periodic** entry in `CANONICAL_HOOK_NAMES`; it carries a `continue` exit policy (a failing heartbeat hook never aborts the run).
- execution.ts stays decoupled from the AFK hook system (the callback is opaque); the hook + IO wiring live in `processIssue` / `run.ts` where they belong.
- The periodic heartbeat only exists under no-sandbox for now — a documented limit, consistent with the guard.

## Status

Accepted; implemented (PR-B, follow-up to ADR 0044).

## Related

- ADR 0044 — the attempt progress guard (this externalizes its signal).
- ADR 0026 — AFK lifecycle hooks (the `on_heartbeat` hook extends the model with a periodic point).
- ADR 0042 — config under `plugins.dev.afk` (where `afk.hooks.on_heartbeat` lives).
