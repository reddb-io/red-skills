// requeue - the SAFE requeue transition for an issue parked behind an active
// `## Current blocker` (issues #850, #860).
//
// Flipping labels back to `ready-for-agent` is not enough: AFK preflight
// (process-issue.ts) reads the active NON-mechanical `## Current blocker` and
// re-parks the issue before any work starts, so a maintainer who only edits
// labels creates a silent no-op retry loop. A requeue is only complete when the
// active blocker is cleared from the BODY in the same transition that flips the
// labels. This module is the pure planner for that transition; `/requeue` (the
// command) and `/hitl` (the interactive decision path) are its IO callers.
//
// #860 narrows the scope: only `blocked:validation` and `blocked:spec` issues
// are accepted. Mixed `blocked:*` states and label/body kind mismatches are
// refused without mutation and direct the maintainer to `/hitl`.

import {
  clearCurrentBlocker,
  parseCurrentBlocker,
  type CurrentBlocker,
} from "./blocker-state.js";
import { LABEL_HUMAN, LABEL_READY } from "./triage-labels.js";

/**
 * Blocker kinds AFK preflight treats as mechanical (auto-recoverable) and so
 * never blocks a fresh claim on. Mirrors the set in process-issue.ts /
 * reconcile.ts — a requeue helper only has to clear a NON-mechanical active
 * blocker (the human-input kinds: validation, spec, decision, …).
 */
export const MECHANICAL_BLOCKER_KINDS = new Set(["stalled", "crashed", "merge-conflict"]);

/**
 * The only blocker kinds this operator path accepts. A `blocked:decision` or
 * any other human-input kind still requires `/hitl` (the interactive decision
 * path); those must not be auto-cleared without the full HITL interview.
 */
export const REQUEUE_SUPPORTED_KINDS = new Set(["validation", "spec"]);

export interface RequeueInput {
  /** The current issue body markdown. */
  body: string;
  /** The labels the issue currently carries. */
  labels: readonly string[];
  /** Human guidance recorded before requeueing; archived into `## Resolved blockers`. Required to apply the transition. */
  guidance?: string;
}

export interface RequeuePlan {
  /** Whether the issue is in a parked state this helper can requeue. */
  requeueable: boolean;
  /**
   * When false AND refuseForHitl is true, the caller should treat this as an
   * error and direct the maintainer to /hitl rather than silently exiting 0.
   */
  refuseForHitl: boolean;
  /** Human-readable reason when not requeueable. */
  reason?: string;
  /** The active non-mechanical blocker that must be cleared, if any. */
  activeBlocker: CurrentBlocker | null;
  /** The rewritten issue body with the active blocker cleared/archived. */
  body: string;
  /** True when `body` differs from the input — i.e. an active blocker was cleared. */
  bodyChanged: boolean;
  /** Labels to add in the requeue transition. */
  addLabels: string[];
  /** Labels to remove: stale `ready-for-human` plus every `blocked:*` present. */
  removeLabels: string[];
}

function blockedLabelsIn(labels: readonly string[]): string[] {
  return labels.filter((l) => l.startsWith("blocked:"));
}

function refuse(
  reason: string,
  refuseForHitl: boolean,
  activeBlocker: CurrentBlocker | null,
  body: string,
): RequeuePlan {
  return {
    requeueable: false,
    refuseForHitl,
    reason,
    activeBlocker,
    body,
    bodyChanged: false,
    addLabels: [],
    removeLabels: [],
  };
}

/**
 * Is the issue executable by AFK as far as the blocker gate is concerned? This
 * mirrors the preflight predicate in process-issue.ts: an issue marked
 * `ready-for-agent` is NOT actually requeued while its body still carries an
 * active non-mechanical `## Current blocker`. A label flip alone therefore
 * fails this check — the canonical "label flip is not a successful requeue"
 * invariant.
 */
export function isRequeueComplete(body: string, labels: readonly string[]): boolean {
  if (!labels.includes(LABEL_READY)) return false;
  const active = parseCurrentBlocker(body);
  if (active && !MECHANICAL_BLOCKER_KINDS.has(active.kind)) return false;
  return true;
}

/**
 * Plan the one-shot requeue transition for a parked issue: clear/archive the
 * active `## Current blocker`, drop the stale `ready-for-human` and `blocked:*`
 * labels, and add `ready-for-agent`. The body is always rewritten when a blocker
 * is active so the transition can never degrade into a label-only flip.
 *
 * Narrowed to `blocked:validation` and `blocked:spec` only (#860). Mixed
 * `blocked:*` states and label/body kind mismatches set `refuseForHitl: true`
 * and direct the caller to `/hitl` instead.
 */
export function planRequeue(input: RequeueInput): RequeuePlan {
  const activeBlocker = parseCurrentBlocker(input.body);
  const blocked = blockedLabelsIn(input.labels);
  const hasHuman = input.labels.includes(LABEL_HUMAN);

  // "Parked" = something marks this issue as needing the human lane. Without an
  // active blocker, a blocked:* label, or ready-for-human there is nothing to
  // requeue and the helper refuses rather than gratuitously editing the issue.
  const isParked = activeBlocker !== null || blocked.length > 0 || hasHuman;
  if (!isParked) {
    return refuse(
      "issue is not parked: no active Current blocker, blocked:* label, or ready-for-human",
      false,
      null,
      input.body,
    );
  }

  // Mixed blocked:* labels → label state is ambiguous; /hitl must reconcile.
  if (blocked.length > 1) {
    return refuse(
      `mixed blocked:* labels [${blocked.join(", ")}]: label state is ambiguous — use /hitl to reconcile`,
      true,
      activeBlocker,
      input.body,
    );
  }

  // Derive the expected kind from the single blocked:* label, if present.
  const labelKind = blocked.length === 1 ? blocked[0].slice("blocked:".length) : null;

  // Unsupported label kind → /hitl handles other human-input blocker types.
  if (labelKind !== null && !REQUEUE_SUPPORTED_KINDS.has(labelKind)) {
    return refuse(
      `blocked:${labelKind} is not in the supported set (validation, spec): use /hitl`,
      true,
      activeBlocker,
      input.body,
    );
  }

  // Active body blocker with an unsupported kind (no matching label to catch it above).
  if (
    activeBlocker !== null &&
    !MECHANICAL_BLOCKER_KINDS.has(activeBlocker.kind) &&
    !REQUEUE_SUPPORTED_KINDS.has(activeBlocker.kind)
  ) {
    return refuse(
      `active blocker kind "${activeBlocker.kind}" is not in the supported set (validation, spec): use /hitl`,
      true,
      activeBlocker,
      input.body,
    );
  }

  // Label/body kind mismatch → inconsistent state; /hitl must reconcile.
  if (activeBlocker !== null && labelKind !== null && activeBlocker.kind !== labelKind) {
    return refuse(
      `label/body kind mismatch: label says blocked:${labelKind} but body blocker kind is "${activeBlocker.kind}" — use /hitl to reconcile`,
      true,
      activeBlocker,
      input.body,
    );
  }

  const body = activeBlocker
    ? clearCurrentBlocker(input.body, {
        summary: activeBlocker.summary,
        resolution: input.guidance?.trim() || "Requeued after human guidance.",
      })
    : input.body;

  const removeLabels = [...(hasHuman ? [LABEL_HUMAN] : []), ...blocked];

  return {
    requeueable: true,
    refuseForHitl: false,
    activeBlocker,
    body,
    bodyChanged: body !== input.body,
    // `ready-for-agent` is always applied — a gh add of a label the issue
    // already carries is idempotent, so the transition is the same whether the
    // maintainer pre-flipped labels or not.
    addLabels: [LABEL_READY],
    removeLabels,
  };
}
