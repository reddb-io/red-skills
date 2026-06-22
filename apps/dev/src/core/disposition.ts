// disposition — the SINGLE OWNER of "given a terminal outcome, what do we DO
// about it". It composes the pure mappings that already exist (recoveryReasonFor
// / recoveryDecision / recoveryCap / blockedLabelFor / envelopeStatusFor) plus
// the standard escalation comment into ONE descriptor, so the three sites that
// historically re-derived this routing by hand — `routeRecovery` (process-issue),
// the reconcile `park*` functions, and the supervisor stall-reaper — stop
// drifting apart. Each site now calls `dispose()` and applies the returned label
// sets + envelope status, layering only its own context-specific comment.
//
// It owns the TOTAL outcome → policy-key map. The per-issue `recoveryReasonFor`
// view (attempt-outcome.ts) deliberately returns null for `stalled` — that
// recovery key is reached ONLY by the supervisor reaper, which today passes the
// literal string "stalled" to recovery.ts, bypassing the mapping. `policyKeyFor`
// closes that gap: it is the recoveryReasonFor view PLUS the one key it omits, so
// the reaper's bounded retry runs through the composer with no literal-string
// bypass.
//
// PURE — no IO. Decision/mapping only (PRD Human Decision): execution (editLabels,
// comment, the envelope emit) stays at the call sites.

import type { AttemptOutcome } from "./attempt-outcome.js";
import { blockedLabelFor, envelopeStatusFor, recoveryReasonFor } from "./attempt-outcome.js";
import { recoveryCap, recoveryDecision, type RecoveryEnv } from "./recovery.js";
import type { AttemptStatus } from "./envelope.js";
import { LABEL_READY, LABEL_RUNNING, LABEL_HUMAN } from "./triage-labels.js";

/**
 * One composed routing descriptor for a terminal outcome. The label sets follow
 * the (remove, add) convention of `gh.editLabels`:
 *   - retry    → remove [running], add [ready-for-agent]               (CLEAN)
 *   - escalate → remove [running], add [ready-for-human, <typedLabel>]
 * The typed `blocked:<reason>` label rides ONLY the escalation, never a re-queue,
 * so a re-queued issue stays hygienic (no `ready-for-agent` + `blocked:*`).
 */
export interface Disposition {
  decision: "retry" | "escalate";
  /** Labels to shed (the [running] routing label). */
  removeLabels: string[];
  /** Labels to add — retry → [ready-for-agent]; escalate → [ready-for-human, <typedLabel?>]. */
  addLabels: string[];
  /** The DESCRIPTIVE `blocked:<reason>` observability label, or null. */
  typedLabel: string | null;
  /** The terminal `data-attempt-status` facet of the emitted Envelope. */
  envelopeStatus: AttemptStatus;
  /** The standard "retry budget exhausted" page comment, set ONLY when a
   * previously-recoverable reason escalates because its budget ran out. */
  escalationComment: string | null;
  /** The effective retry cap, or null when the outcome is non-recoverable. */
  cap: number | null;
}

/**
 * The TOTAL outcome → bounded-recovery policy-key map. It is the per-issue
 * `recoveryReasonFor` view PLUS the one key that view omits: `stalled` (the
 * supervisor reaper's bounded re-claim cap, #402). Returns null when the outcome
 * carries no retry budget.
 */
export function policyKeyFor(o: AttemptOutcome): string | null {
  if (o === "stalled") return "stalled";
  return recoveryReasonFor(o);
}

/**
 * Compose the single routing descriptor for a terminal outcome at attempt
 * `attemptN`, under the env caps. PURE.
 */
export function dispose(o: AttemptOutcome, attemptN: number, env: RecoveryEnv): Disposition {
  const typedLabel = blockedLabelFor(o);
  const envelopeStatus = envelopeStatusFor(o);
  const policyKey = policyKeyFor(o);
  const cap = policyKey === null ? null : recoveryCap(policyKey, env);
  const decision = policyKey === null ? "escalate" : recoveryDecision(policyKey, attemptN, env);

  if (decision === "retry") {
    // CLEAN re-queue: promote to ready-for-agent with NO blocked:* tag.
    return {
      decision,
      removeLabels: [LABEL_RUNNING],
      addLabels: [LABEL_READY],
      typedLabel,
      envelopeStatus,
      escalationComment: null,
      cap,
    };
  }

  // escalate → page a human, tagging the typed reason alongside the routing label.
  const addLabels = typedLabel !== null ? [LABEL_HUMAN, typedLabel] : [LABEL_HUMAN];
  // Announce the page only when this reason HAD a retry budget that ran out
  // (cap !== null) — a never-recoverable reason escalates silently, as before.
  const escalationComment =
    cap !== null
      ? `🤖 /afk escalating to ready-for-human: ${typedLabel ?? `blocked:${policyKey}`} retry budget exhausted (attempt ${attemptN}/${cap}).`
      : null;

  return {
    decision,
    removeLabels: [LABEL_RUNNING],
    addLabels,
    typedLabel,
    envelopeStatus,
    escalationComment,
    cap,
  };
}
