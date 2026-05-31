// recovery — the BOUNDED auto-recovery policy for AFK terminal failures.
//
// A terminal failure is either RECOVERABLE (a transient class that often clears
// on a fresh attempt — a merge conflict, a crash, a quota wall, a policy-hook
// abort) or NON-RECOVERABLE (a class that needs a human to change something — a
// spec block, a validation failure). This module is PURE: it maps a failure
// reason + the current attempt number + the env to a single decision —
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
// `attemptN` is the caller's `input.attempt` (1-based, sourced from the
// attempt-ledger), so the cap counts REAL attempts, not retries-within-an-attempt.
//
// NOTE (out of scope): the supervisor stall-reaper (core/supervisor.ts,
// blocked:stalled) restores ready-for-agent WITHOUT a cap — it lacks the attempt
// count cheaply. That path is intentionally left uncapped here; capping it is a
// follow-up. Time-based backoff (vs the immediate re-queue) is also future work —
// the cap is what prevents the runaway loop today.

/**
 * The recovery-policy view of a terminal failure reason. These are the *policy*
 * names (what kind of failure happened), distinct from the routing labels and
 * from envelope-emit's `BlockedReason`. Recoverable reasons carry a cap;
 * `spec` / `validation` are terminal-for-a-human.
 */
export type RecoveryReason =
  | "merge-conflict"
  | "crashed"
  | "quota"
  | "policy"
  | "spec"
  | "validation";

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
  policy: { knob: "RED_AFK_RETRY_POLICY", defaultCap: 1 },
};

/** A loose env view so the policy stays pure and trivially testable. */
export type RecoveryEnv = Record<string, string | undefined>;

/**
 * Resolve the effective retry cap for a reason, or `null` when the reason is
 * non-recoverable. Used both by `recoveryDecision` and by the caller's
 * escalation comment ("attempt N/cap").
 */
export function recoveryCap(reason: RecoveryReason, env: RecoveryEnv): number | null {
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
  reason: RecoveryReason,
  attemptN: number,
  env: RecoveryEnv,
): RecoveryDecision {
  const cap = recoveryCap(reason, env);
  if (cap === null) return "escalate";
  return attemptN < cap ? "retry" : "escalate";
}
