// requeue - the SAFE requeue transition for an issue parked behind an active
// `## Current blocker` (issue #850).
//
// Flipping labels back to `ready-for-agent` is not enough: AFK preflight
// (process-issue.ts) reads the active NON-mechanical `## Current blocker` and
// re-parks the issue before any work starts, so a maintainer who only edits
// labels creates a silent no-op retry loop. A requeue is only complete when the
// active blocker is cleared from the BODY in the same transition that flips the
// labels. This module is the pure planner for that transition; `/requeue` (the
// command) and `/hitl` (the interactive decision path) are its IO callers.

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

export interface RequeueInput {
  /** The current issue body markdown. */
  body: string;
  /** The labels the issue currently carries. */
  labels: readonly string[];
  /** Human guidance recorded before requeueing; archived into `## Resolved blockers`. */
  guidance?: string;
}

export interface RequeuePlan {
  /** Whether the issue is in a parked state this helper can requeue. */
  requeueable: boolean;
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
 */
export function planRequeue(input: RequeueInput): RequeuePlan {
  const activeBlocker = parseCurrentBlocker(input.body);
  const blocked = blockedLabelsIn(input.labels);
  const hasHuman = input.labels.includes(LABEL_HUMAN);

  // "Parked" = something marks this issue as needing the human lane. Without an
  // active blocker, a blocked:* label, or ready-for-human there is nothing to
  // requeue and the helper refuses rather than gratuitously editing the issue.
  const requeueable = activeBlocker !== null || blocked.length > 0 || hasHuman;
  if (!requeueable) {
    return {
      requeueable: false,
      reason: "issue is not parked: no active Current blocker, blocked:* label, or ready-for-human",
      activeBlocker: null,
      body: input.body,
      bodyChanged: false,
      addLabels: [],
      removeLabels: [],
    };
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
