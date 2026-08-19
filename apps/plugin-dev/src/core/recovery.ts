// recovery — the BOUNDED auto-recovery policy for AFK terminal failures.
//
// A terminal failure is either RECOVERABLE (a transient class that often clears
// on a fresh attempt — a merge conflict, a crash, a quota wall, a transient
// runner transport/setup failure, a policy-hook abort) or NON-RECOVERABLE (a
// class that needs a human to change something — a spec block, a validation
// failure). This module is PURE: it maps a failure reason + the current attempt
// number + the env to a single decision —
//
//   "retry"    → re-queue the issue (route back to ready-for-agent)
//   "escalate" → page a human (route to ready-for-human)
//
// Recoverable reasons retry while `attemptN < cap` and escalate once the cap is
// reached, so a transient failure can self-heal but a STUCK issue can never loop
// forever. Each recoverable reason has its own cap, defaulted here and overridable
// via a RED_AFK_RETRY_* env knob (a missing / non-numeric / non-positive value
// falls back to the default). Non-recoverable reasons always escalate.
//
// `attemptN` is the caller's re-queue ordinal (1-based, counted off the history
// ledger by `requeueOrdinal`), so a cap bounds how many times ONE Ticket is
// automatically re-queued — not retries within a single run (ADR 0103).
//
// The supervisor stall-reaper (core/supervisor.ts) is ALSO bounded by this same
// policy now (#402): it sources the same re-queue ordinal for the reaped Ticket
// and asks `recoveryDecision("stalled", …)`, so a worker that keeps stalling
// can no longer be re-claimed forever — once the `stalled` cap is exhausted it
// escalates to ready-for-human like every other terminal class. Time-based
// backoff (vs the immediate re-queue) is still future work — the cap is what
// prevents the runaway loop today.

import type { RecoveryReason } from "./worker-outcome.js";

// `RecoveryReason` (the recoverable policy keys) is now owned by attempt-outcome,
// the single owner of the outcome vocabulary. recovery.ts CONSUMES it: its cap
// table is keyed on those policy names. The lookup functions accept any string
// so a non-recoverable name (absent from RECOVERABLE) resolves to null/escalate
// exactly as before — this is what keeps the policy "exactly as-is".
export type { RecoveryReason };

export type RecoveryDecision = "retry" | "escalate";

interface RecoverableSpec {
  /** Env knob that overrides the default cap. */
  knob: string;
  /** Default cap when the knob is unset / non-numeric / non-positive. */
  defaultCap: number;
}

/** The recoverable reasons and their cap configuration. A reason absent from
 * this table is NON-recoverable (always escalate). */
const RECOVERABLE: Record<string, RecoverableSpec> = {
  "merge-conflict": { knob: "RED_AFK_RETRY_MERGE", defaultCap: 3 },
  crashed: { knob: "RED_AFK_RETRY_CRASH", defaultCap: 1 },
  quota: { knob: "RED_AFK_RETRY_QUOTA", defaultCap: 3 },
  "runner-transient": { knob: "RED_AFK_RETRY_RUNNER_TRANSIENT", defaultCap: 3 },
  policy: { knob: "RED_AFK_RETRY_POLICY", defaultCap: 1 },
  // The supervisor stall-reaper's bounded re-claim cap (#402). A stall is a
  // transient class (a wedged worker that usually clears on a fresh attempt), so
  // it sits with the other transient defaults at 3. It is NOT in the per-issue
  // `RecoveryReason` subset (recoveryReasonFor never returns "stalled"); only the
  // reaper asks for it, by the literal string.
  stalled: { knob: "RED_AFK_RETRY_STALLED", defaultCap: 3 },
  // Companion-monitor drift correction (#921). The active monitor's bounded
  // re-enqueue budget: each detected drift on an attempt injects ONE bounded
  // correction (write-only, idempotent), and once the attempt count reaches this
  // cap the companion ESCALATES to ready-for-human instead of correcting again —
  // so a drifting issue can never loop forever. NOT in the per-issue
  // `RecoveryReason` subset (recoveryReasonFor never returns "drift"); only the
  // companion asks for it, by the literal string, sharing this same bounded
  // policy as every other terminal class.
  drift: { knob: "RED_AFK_RETRY_DRIFT", defaultCap: 2 },
};

/** A loose env view so the policy stays pure and trivially testable. */
export type RecoveryEnv = Record<string, string | undefined>;

/**
 * Resolve the effective retry cap for a reason, or `null` when the reason is
 * non-recoverable. Used both by `recoveryDecision` and by the caller's
 * escalation comment ("attempt N/cap").
 */
export function recoveryCap(reason: RecoveryReason | (string & {}), env: RecoveryEnv): number | null {
  const spec = RECOVERABLE[reason];
  if (!spec) return null;
  const raw = env[spec.knob];
  if (raw !== undefined) {
    const parsed = Number(raw);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return spec.defaultCap;
}

/**
 * The BOUNDED auto-recovery decision. Recoverable reasons retry while
 * `attemptN < cap`, else escalate; non-recoverable reasons always escalate.
 */
export function recoveryDecision(
  reason: RecoveryReason | (string & {}),
  attemptN: number,
  env: RecoveryEnv,
): RecoveryDecision {
  const cap = recoveryCap(reason, env);
  if (cap === null) return "escalate";
  return attemptN < cap ? "retry" : "escalate";
}
