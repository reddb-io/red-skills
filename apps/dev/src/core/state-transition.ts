// state-transition.ts — the single owner of issue state-label mutations
// (ADR 0122 rule 5, Spec #2523, slice #2524 — the EXPAND half).
//
// An issue carries exactly ONE state role at any time. On 2026-07-22 three
// issues accumulated contradictory role sets (park labels stacked on
// `ready-for-agent`, an active blocker on a queued issue) because every code
// path wrote labels directly; each contradiction became a red boot probe and
// froze the fleet. This module makes those sets unconstructible: callers
// declare the TRANSITION they want, the planner computes the atomic add/remove
// set, refuses any request that would leave zero or two state roles, and the
// apply step performs the whole mutation as ONE tracker call.
//
// This slice lands the API alongside the existing writers, fully tested and
// deliberately uncalled. Call-site migration + the raw-edit lint is the
// CONTRACT half (#2528).

import {
  LABEL_READY,
  LABEL_HUMAN,
  LABEL_NEEDS_TRIAGE,
  LABEL_NEEDS_INFO,
  LABEL_RUNNING,
  LABEL_DEPENDENCY,
} from "./triage-labels.js";

/** The quarantine state role (ADR 0122 rule 2). Kept local until the curator
 * slice's vocabulary lands; #2528 unifies the constant into triage-labels. */
export const LABEL_QUARANTINE = "quarantine";

/** Every label that counts as a STATE ROLE. The invariant this module
 * enforces: a post-transition label set contains exactly one of these. */
export const STATE_ROLE_LABELS: readonly string[] = [
  LABEL_READY,
  LABEL_HUMAN,
  LABEL_NEEDS_TRIAGE,
  LABEL_NEEDS_INFO,
  LABEL_QUARANTINE,
  LABEL_DEPENDENCY,
];

const BLOCKED_PREFIX = "blocked:";
const REQ_PREFIX = "req:";

/** The canonical transitions. Anything the engine wants to do to an issue's
 * state is one of these — there is no "just add a label" escape hatch. */
export type StateTransition =
  /** Back into the executable queue. Refused while `req:*` edges remain —
   * use `promote` (which consumes them) or clear the edges first. */
  | { kind: "queue" }
  /** Park for a human with a machine-readable reason (`blocked:<reason>`). */
  | { kind: "park"; reason: string }
  /** Plain human gate with no blocked-reason modifier. */
  | { kind: "human" }
  /** Healthy dependency wait: `blocked:dependency` + one `req:N` per blocker. */
  | { kind: "dependency-block"; reqs: readonly number[] }
  /** ADR 0122 quarantine: judgment-requiring incoherence, one issue at a time. */
  | { kind: "quarantine"; diagnosis: string }
  /** Close-cascade promotion: consume the `req:*` edges and re-queue. */
  | { kind: "promote" };

export interface TransitionPlan {
  readonly add: readonly string[];
  readonly remove: readonly string[];
  /** Markdown appended to the issue body in the SAME tracker call (quarantine
   * diagnoses ride the label mutation — never a second write). */
  readonly appendBody?: string;
}

export interface RefusedTransition {
  readonly refused: true;
  readonly reason: string;
}

export function isRefused(
  value: TransitionPlan | RefusedTransition,
): value is RefusedTransition {
  return (value as RefusedTransition).refused === true;
}

/** The state roles present in a label set (order preserved). */
export function stateRolesOf(labels: readonly string[]): string[] {
  return STATE_ROLE_LABELS.filter((role) => labels.includes(role));
}

function targetRole(t: StateTransition): string {
  switch (t.kind) {
    case "queue":
    case "promote":
      return LABEL_READY;
    case "park":
    case "human":
      return LABEL_HUMAN;
    case "dependency-block":
      return LABEL_DEPENDENCY;
    case "quarantine":
      return LABEL_QUARANTINE;
  }
}

/**
 * Compute the atomic label mutation for `transition` against the issue's
 * `current` labels. Pure — the tracker is not consulted. Refusals name the
 * violated rule so the caller (or its operator) can fix the REQUEST, never
 * hand-edit around the invariant.
 */
export function planTransition(
  current: readonly string[],
  transition: StateTransition,
): TransitionPlan | RefusedTransition {
  if (transition.kind === "park" && !transition.reason.startsWith(BLOCKED_PREFIX)) {
    return {
      refused: true,
      reason: `park reason must be a ${BLOCKED_PREFIX}* label, got "${transition.reason}"`,
    };
  }
  if (transition.kind === "dependency-block" && transition.reqs.length === 0) {
    return { refused: true, reason: "dependency-block requires at least one req issue" };
  }
  const reqLabels = current.filter((l) => l.startsWith(REQ_PREFIX));
  if (transition.kind === "queue" && reqLabels.length > 0) {
    return {
      refused: true,
      reason:
        `queue refused while dependency edges remain (${reqLabels.join(", ")}); ` +
        `use promote to consume them or clear the edges first`,
    };
  }

  const target = targetRole(transition);
  const add = new Set<string>();
  const remove = new Set<string>();

  // Every other state role present goes; the target role arrives.
  for (const role of STATE_ROLE_LABELS) {
    if (role === target) continue;
    if (current.includes(role)) remove.add(role);
  }
  if (!current.includes(target)) add.add(target);

  // Leaving execution: `running` never survives a state transition.
  if (current.includes(LABEL_RUNNING)) remove.add(LABEL_RUNNING);

  // Blocked-reason modifiers accompany exactly the states that define them.
  const blockedPresent = current.filter(
    (l) => l.startsWith(BLOCKED_PREFIX) && l !== LABEL_DEPENDENCY,
  );
  switch (transition.kind) {
    case "park":
      for (const l of blockedPresent) if (l !== transition.reason) remove.add(l);
      if (!current.includes(transition.reason)) add.add(transition.reason);
      break;
    case "dependency-block":
      for (const l of blockedPresent) remove.add(l);
      for (const req of transition.reqs) {
        const label = `${REQ_PREFIX}${req}`;
        if (!current.includes(label)) add.add(label);
      }
      break;
    case "promote": {
      for (const l of blockedPresent) remove.add(l);
      // Numeric req order keeps the emitted mutation deterministic regardless
      // of the tracker's label listing order.
      const byIssue = (l: string): number => Number(l.slice(REQ_PREFIX.length)) || 0;
      for (const l of [...reqLabels].sort((a, b) => byIssue(a) - byIssue(b))) remove.add(l);
      break;
    }
    default:
      for (const l of blockedPresent) remove.add(l);
      break;
  }

  // Invariant proof: replay the mutation and demand exactly one state role.
  const result = new Set(current);
  for (const l of remove) result.delete(l);
  for (const l of add) result.add(l);
  const roles = stateRolesOf([...result]);
  if (roles.length !== 1) {
    return {
      refused: true,
      reason: `transition would leave ${roles.length} state roles (${roles.join(", ") || "none"})`,
    };
  }

  const plan: TransitionPlan = {
    add: [...add],
    remove: [...remove],
    ...(transition.kind === "quarantine" && transition.diagnosis.trim() !== ""
      ? { appendBody: transition.diagnosis }
      : {}),
  };
  return plan;
}

/** The single tracker mutation the apply step performs. `body`, when present,
 * is the FULL replacement body (current body + appended diagnosis) so labels
 * and body change in one `gh issue edit`. */
export interface IssueEdit {
  readonly add: readonly string[];
  readonly remove: readonly string[];
  readonly body?: string;
}

export interface ApplyTransitionDeps {
  /** Perform ONE `gh issue edit` covering labels (and body when given). */
  editIssue(issue: number, edit: IssueEdit): Promise<boolean>;
  /** Read the current body — needed only when the plan appends a diagnosis. */
  readBody(issue: number): Promise<string>;
}

export interface ApplyTransitionResult {
  readonly ok: boolean;
  readonly plan: TransitionPlan;
}

/**
 * Apply a planned transition as ONE tracker call. Callers pass the plan they
 * already inspected; a refused plan never reaches this function's signature.
 */
export async function applyTransition(
  deps: ApplyTransitionDeps,
  issue: number,
  plan: TransitionPlan,
): Promise<ApplyTransitionResult> {
  let body: string | undefined;
  if (plan.appendBody !== undefined) {
    const current = await deps.readBody(issue);
    body = `${current.replace(/\s+$/, "")}\n\n${plan.appendBody}\n`;
  }
  const ok = await deps.editIssue(issue, {
    add: plan.add,
    remove: plan.remove,
    ...(body !== undefined ? { body } : {}),
  });
  return { ok, plan };
}
