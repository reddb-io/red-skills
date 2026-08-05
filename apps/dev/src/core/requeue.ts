// requeue - the SAFE requeue transition for an issue parked behind an active
// `## Current blocker` (issues #850, #860).
//
// Flipping labels back to `ready-for-agent` is not enough: AFK preflight
// (process-issue.ts) reads the active NON-mechanical `## Current blocker` and
// re-parks the issue before any work starts, so a maintainer who only edits
// labels creates a silent no-op retry loop. A requeue is only complete when the
// active blocker is cleared from the BODY in the same transition that flips the
// labels. This module is the pure planner for that transition; the `requeue`
// command (reached from `/retake`) and `/hitl` (the interactive decision path)
// are its IO callers.
//
// #860 narrows the scope to explicitly supported transient parks. Alongside
// `blocked:validation` and `blocked:spec`, `blocked:infra` and
// `blocked:base-stale` are requeueable because a recovered mechanical fault
// needs no new human decision. The IO caller freshness-gates `base-stale`
// before applying this pure plan. Mixed
// `blocked:*` states and label/body kind mismatches are refused without mutation
// and direct the maintainer to `/hitl`.

import {
  clearCurrentBlocker,
  parseCurrentBlocker,
  type CurrentBlocker,
} from "./blocker-state.js";
import {
  blockedKindOf,
  blockedLabelsIn,
  isRefused,
  MECHANICAL_BLOCKER_KINDS,
  planTransition,
} from "./state-transition.js";
import { LABEL_READY } from "./triage-labels.js";

/**
 * Blocker kinds AFK preflight treats as mechanical (auto-recoverable) and so
 * never blocks a fresh claim on. Mirrors the set in process-issue.ts /
 * reconcile.ts — a requeue helper only has to clear a NON-mechanical active
 * blocker (the human-input kinds: validation, spec, decision, …).
 */
/**
 * The only blocker kinds this operator path accepts. A `blocked:decision` or
 * any other human-input kind still requires `/hitl` (the interactive decision
 * path); those must not be auto-cleared without the full HITL interview.
 */
export const REQUEUE_SUPPORTED_KINDS = new Set([
  "validation",
  "spec",
  "infra",
  "base-stale",
]);

export interface RequeueInput {
  /** Machine callers are restricted to the mechanical allowlist; human callers may resolve any blocker kind. */
  authority?: RequeueAuthority;
  /** The current issue body markdown. */
  body: string;
  /** The labels the issue currently carries. */
  labels: readonly string[];
  /** Human guidance recorded before requeueing; archived into `## Resolved blockers`. Required to apply the transition. */
  guidance?: string;
  /** True when paired with `--adopt-branch`: a maintainer has reviewed a hand-done branch and is landing it through the ADR-0055 no-agent lane. */
  adoptBranch?: boolean;
}

export type RequeueAuthority = "machine" | "human";

/**
 * Is `kind` requeueable? The supported set is
 * `{validation, spec, infra, base-stale}`.
 */
function kindRequeueable(kind: string): boolean {
  return REQUEUE_SUPPORTED_KINDS.has(kind);
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

export interface RequeueFreshnessResult {
  ok: boolean;
  evidence: string;
}

export interface RequeueApplierDeps {
  verifyBaseFreshness(body: string): Promise<RequeueFreshnessResult>;
  releaseClaims(issue: number): Promise<string[]>;
  editBody(issue: number, body: string): Promise<void>;
  comment(issue: number, body: string): Promise<void>;
  editLabels(issue: number, remove: string[], add: string[]): Promise<void>;
}

export interface ApplyRequeueInput extends RequeueInput {
  issue: number;
  authority: RequeueAuthority;
}

export interface ApplyRequeueResult {
  plan: RequeuePlan;
  applied: boolean;
  reason?: string;
  releasedClaims: string[];
  freshness?: RequeueFreshnessResult;
}

/** The audit directive emitted by every successful requeue, regardless of caller. */
export function formatRequeueDirective(plan: RequeuePlan, guidance: string): string {
  return [
    '<details data-kind="directive">',
    "<summary>Requeue</summary>",
    "",
    "Human guidance:",
    guidance.trim() || "(none recorded)",
    "",
    `Disposition:\nrequeued to ready-for-agent${plan.activeBlocker ? ` (cleared active blocker: ${plan.activeBlocker.kind})` : ""}`,
    "</details>",
  ].join("\n");
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
 * Narrowed to explicit transient parks: `blocked:validation`, `blocked:spec`,
 * `blocked:infra`, and freshness-gated `blocked:base-stale`. Mixed `blocked:*`
 * states and label/body kind mismatches set `refuseForHitl: true` and direct
 * the caller to `/hitl` instead.
 */
export function planRequeue(input: RequeueInput): RequeuePlan {
  const authority = input.authority ?? "machine";
  const activeBlocker = parseCurrentBlocker(input.body);
  const blocked = blockedLabelsIn(input.labels);
  const hasHuman = input.labels.includes("ready-for-human");

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

  // Mixed blocked:* labels are an ambiguous Park, not a transition request.
  // Refuse them before planning so /hitl can reconcile the competing reasons.
  if (blocked.length > 1) {
    return refuse(
      `mixed blocked:* labels [${blocked.join(", ")}]: label state is ambiguous — use /hitl to reconcile`,
      true,
      activeBlocker,
      input.body,
    );
  }

  // Derive the expected kind from the single blocked:* label, if present.
  const labelKind = blocked.length === 1 ? blockedKindOf(blocked[0]) : null;

  // Unsupported label kind → /hitl handles other human-input blocker types.
  if (authority === "machine" && labelKind !== null && !kindRequeueable(labelKind)) {
    return refuse(
      `blocked:${labelKind} is not in the supported set for machine authority (validation, spec, infra, base-stale): use /hitl for human authority`,
      true,
      activeBlocker,
      input.body,
    );
  }

  // Active body blocker with an unsupported kind (no matching label to catch it above).
  if (
    activeBlocker !== null &&
    authority === "machine" &&
    !MECHANICAL_BLOCKER_KINDS.has(activeBlocker.kind) &&
    !kindRequeueable(activeBlocker.kind)
  ) {
    return refuse(
      `active blocker kind "${activeBlocker.kind}" is not in the supported set for machine authority (validation, spec, infra, base-stale): use /hitl for human authority`,
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

  const hasReqEdges = input.labels.some((label) => label.startsWith("req:"));
  const transition = planTransition(
    input.labels,
    { kind: authority === "human" && hasReqEdges ? "promote" : "queue" },
  );
  if (isRefused(transition)) {
    return refuse(transition.reason, authority === "machine", activeBlocker, input.body);
  }
  const removeLabels = [...transition.remove];
  const addLabels = [...transition.add];

  return {
    requeueable: true,
    refuseForHitl: false,
    activeBlocker,
    body,
    bodyChanged: body !== input.body,
    // `ready-for-agent` is always applied — a gh add of a label the issue
    // already carries is idempotent, so the transition is the same whether the
    // maintainer pre-flipped labels or not.
    addLabels,
    removeLabels,
  };
}

/**
 * Apply the complete requeue transition through the Park's single door. The
 * authority matrix lives in {@link planRequeue}; every accepted caller then
 * crosses the same freshness guard, claim sweep, body clear, directive audit,
 * and label transition in that order.
 */
export async function applyRequeue(
  deps: RequeueApplierDeps,
  input: ApplyRequeueInput,
): Promise<ApplyRequeueResult> {
  const plan = planRequeue(input);
  if (!plan.requeueable) {
    return {
      plan,
      applied: false,
      reason: plan.reason,
      releasedClaims: [],
    };
  }

  const freshness = await deps.verifyBaseFreshness(input.body);
  if (!freshness.ok) {
    return {
      plan,
      applied: false,
      reason: `base freshness verification failed: ${freshness.evidence}`,
      releasedClaims: [],
      freshness,
    };
  }

  const releasedClaims = await deps.releaseClaims(input.issue);
  if (plan.bodyChanged) await deps.editBody(input.issue, plan.body);
  await deps.comment(input.issue, formatRequeueDirective(plan, input.guidance ?? ""));
  await deps.editLabels(input.issue, [...plan.removeLabels], [...plan.addLabels]);
  return { plan, applied: true, releasedClaims, freshness };
}
