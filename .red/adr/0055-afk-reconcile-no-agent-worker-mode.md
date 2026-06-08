# AFK reconcile — a no-agent worker mode that lands a parked green branch

## Context

An AFK iteration can end `timeout` (the attempt progress guard fired — the agent
was alive but committed nothing within the wall-clock cap, ADR 0044) or
`no-sentinel` (the agent exited without a `<promise>` sentinel, ADR 0028). Both
frequently leave a worker branch that *already carries complete, green work*: the
agent finished the task, then stalled — or exited — before a final non-committing
step (re-emit the sentinel, write a summary). The commits are pushed; only the
ceremony is missing.

Today those endings escalate straight to `ready-for-human`
(`blocked:stalled` / `blocked:crashed`). The `no-sentinel`-with-commits case was
already salvaged through the feedback gate (issue #332), but `timeout` had **no
land attempt at all** — a stalled-but-finished branch was parked for a human even
though re-running the same scoped gate the DONE path trusts would have confirmed
it landable. Re-running the *agent* (recovery.ts) to "finish" already-finished
work is wasteful and can churn a green branch red.

## Decision

Add **reconcile**, a NO-AGENT worker mode (`core/reconcile.ts`): for an issue AFK
*owns* (an `afk/{id}/{N}-*` branch under a **mechanical** failure class), validate
the pushed branch and land it **without re-running the agent**. The agent re-run
stays recovery.ts; reconcile is the cheaper, deterministic path for the common
"finished-but-parked" case.

1. **Mechanical class only.** reconcile acts only when the failure is mechanical —
   a `blocked:stalled` / `blocked:crashed` branch, or, inline, a just-fired
   `timeout`. It NEVER auto-lands `blocked:spec` / `blocked:validation`, nor an
   active `## Current blocker` whose `kind` is non-mechanical (spec / validation /
   dependency). A `stalled` / `crashed` / `merge-conflict` blocker kind IS
   mechanical and allowed — that is exactly the parked state reconcile clears.
   The guard is pure (`mechanicalDisqualifier`).

2. **The scoped gate is the verdict.** reconcile reuses `runFeedback` against the
   materialised worker-branch checkout — the SAME authority and the SAME
   `makeFeedbackWorktree` (which `pnpm install`s, #458) the DONE path uses. No new
   judgment of "is this work good"; the merge gate decides.

3. **Green → land; red → park.** A green gate lands via the existing `doLanding`
   path (ADR 0030/0031) — **no new merge code** — then closes, drops the
   routing/`blocked:*` labels, deletes the remote/local branch, sweeps the attempt
   dir, and runs the same close cascade. A red gate parks to `ready-for-human` with
   `blocked:validation` and a comment carrying the **real failing checks**. A land
   that the drift-guard / integrate-rebase rejects parks as `blocked:merge-conflict`.

4. **Wired as the terminal else-branch.** `processIssue`'s `timeout` path invokes
   `reconcile` **before** `escalate`: landed → a `done` result; parked →
   `feedback-failed`; skipped (not mechanical / no commits / branch absent) → the
   original stalled escalation, unchanged. The `no-sentinel`-with-commits sibling
   keeps its existing salvage-through-feedback path (it already lands an
   ahead-of-base branch through the identical gate).

`ReconcileDeps` is a structural **subset** of `ProcessIssueDeps`, so the terminal
path passes its own `deps` (augmented with the landing `fireHook`) straight
through — zero new wiring in the CLI.

## Consequences

- A stalled-but-finished branch now lands in the same iteration instead of waiting
  for a human, with the agent run exactly once. The land path's `drift-guard` +
  integrate/rebase remain the binding cross-package gates.
- reconcile owns no claim/promotion: the caller owns the claim lock and the
  `running` promotion. Inside `processIssue` the claim is already held, so only the
  lock release remains after a reconcile land.
- The `timeout` terminal is no longer unconditionally `stalled`: it is `done`
  (green land), `feedback-failed` (red), or `stalled` (skip). The
  `blocked:stalled` escalation still fires whenever the branch is empty or absent.
- Mechanical-class boundary is the load-bearing safety rule: a `blocked:spec` block
  or an active non-mechanical `## Current blocker` is never auto-landed, so a
  human-decision issue can never be closed by a re-validation alone.

## Status

Accepted; implemented (issue #558).

## Related

- ADR 0008 — the feedback gate reconcile reuses as its verdict.
- ADR 0030/0031 — the lock-toggled landing reconcile lands through (`doLanding`).
- ADR 0044 — the attempt progress guard whose `timeout` reconcile catches before escalate.
- ADR 0050 — the codex DONE-without-commit salvage (a sibling "land work the agent left" path).
- Issue #332 — the `no-sentinel`-with-commits salvage reconcile sits alongside.
