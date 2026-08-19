// auto-triage — the PURE trust-gated triage router + canonical transition planner
// (#751, parent PRD #745 "Cloud agent interaction").
//
// Two pure decisions live here; the runtime (`commands/triage.ts`) resolves the
// IO (gh author/labels reads + label edits) and feeds them in:
//
//   1. routeNeedsTriage — given the author's trust and whether a maintainer
//      summon is present, decide whether a `needs-triage` issue may auto-triage
//      now or must be HELD for a maintainer summon. This is the event-router's
//      gate: an issue from a TRUSTED author (or a summoned one) auto-triages; an
//      issue from an untrusted public author waits.
//
//   2. planTriageTransition — given a triage DECISION (the same four outcomes
//      `/triage` produces), emit the canonical label transition that moves the
//      issue out of `needs-triage` into its definitive state.
//
// The trust source is the SAME per-repo allowlist the executable-issue gate uses
// (trust-gate.ts, ADR 0085). Here only the AUTHOR is checked — a `needs-triage`
// issue has no `ready-for-agent` actor yet — so this module exposes its own
// author-only predicate rather than reusing `evaluateTrustGate` (which also
// requires a promoting actor). When no allowlist is configured the gate is
// PERMISSIVE: every issue auto-triages, preserving today's single-maintainer
// behaviour exactly.

import {
  LABEL_READY,
  LABEL_HUMAN,
  LABEL_NEEDS_TRIAGE,
  LABEL_NEEDS_INFO,
  LABEL_WONTFIX,
} from "./triage-labels.js";
import { isRefused, planTransition, type StateTransition } from "./state-transition.js";
import type { TrustPolicy } from "./trust-gate.js";

/** The four triage outcomes `/triage` produces, mapped 1:1 to canonical states. */
export type TriageDecision = "ready-for-agent" | "needs-info" | "ready-for-human" | "wontfix";

/** The ordered set of valid decision strings — used to validate CLI input. */
export const TRIAGE_DECISIONS: readonly TriageDecision[] = [
  "ready-for-agent",
  "needs-info",
  "ready-for-human",
  "wontfix",
];

/** Type guard: is `value` one of the four triage decisions? */
export function isTriageDecision(value: string): value is TriageDecision {
  return (TRIAGE_DECISIONS as readonly string[]).includes(value);
}

/** A canonical label transition: which labels to strip, which to add, and
 * whether the issue closes (only `wontfix`). `needs-triage` is always removed. */
export interface TriageTransition {
  remove: string[];
  add: string[];
  close: boolean;
}

/** The state-machine move each triage decision expresses. `wontfix` is absent
 * on purpose: closing an issue EXITS the state machine, so it is the one
 * decision the one-state-role planner cannot (and must not) express. */
const TRIAGE_STATE_TRANSITIONS: Record<Exclude<TriageDecision, "wontfix">, StateTransition> = {
  "ready-for-agent": { kind: "queue" },
  "needs-info": { kind: "needs-info" },
  "ready-for-human": { kind: "human" },
};

/**
 * Plan the canonical label transition for a triage decision — a DELEGATING
 * WRAPPER over the shared state planner since #2663. Every decision removes
 * `needs-triage` and adds exactly one definitive state label; `wontfix`
 * additionally closes the issue (mirroring `/triage`'s "apply then close").
 *
 * `current` is the issue's label set. Callers that read it (the `dev triage`
 * command does) get the full ADR 0122 delta — every stale state role and
 * `blocked:*` reason sheds in the SAME edit. Callers that do not pass it fall
 * back to the historical minimum, `needs-triage` alone, which reproduces this
 * function's original static table byte for byte.
 *
 * A REFUSED plan (a `ready-for-agent` decision while `req:*` edges survive)
 * falls back to that same static delta: `/triage` is a decision applicator, and
 * refusing to record the maintainer's decision at all is worse than recording
 * it without the dependency-edge cleanup the promote path owns.
 */
export function planTriageTransition(
  decision: TriageDecision,
  current: readonly string[] = [LABEL_NEEDS_TRIAGE],
): TriageTransition {
  if (decision === "wontfix") {
    return { remove: [LABEL_NEEDS_TRIAGE], add: [LABEL_WONTFIX], close: true };
  }
  const plan = planTransition(current, TRIAGE_STATE_TRANSITIONS[decision]);
  if (isRefused(plan)) return staticTriageTransition(decision);
  return { remove: [...plan.remove], add: [...plan.add], close: false };
}

/** The pre-#2663 static table, kept as the refusal fallback. */
function staticTriageTransition(decision: Exclude<TriageDecision, "wontfix">): TriageTransition {
  switch (decision) {
    case "ready-for-agent":
      return { remove: [LABEL_NEEDS_TRIAGE], add: [LABEL_READY], close: false };
    case "needs-info":
      return { remove: [LABEL_NEEDS_TRIAGE], add: [LABEL_NEEDS_INFO], close: false };
    case "ready-for-human":
      return { remove: [LABEL_NEEDS_TRIAGE], add: [LABEL_HUMAN], close: false };
  }
}

/**
 * Is the issue AUTHOR trusted under `policy`? PERMISSIVE (always true) when no
 * allowlist is configured. In strict mode the author login must be non-empty and
 * present in the allowlist — an unknown author (gh read failed) is untrusted.
 */
export function isAuthorTrusted(policy: TrustPolicy, author?: string): boolean {
  if (!policy.enabled) return true;
  const login = (author ?? "").trim();
  return login.length > 0 && policy.allowlist.includes(login);
}

/** The event-router verdict for a `needs-triage` issue. */
export type AutoTriageAction = "auto-triage" | "hold-for-summon";

/** Inputs the router decides over (resolved from gh by the caller). */
export interface AutoTriageRouteInputs {
  /** Is the issue author in the trust allowlist (or is the policy permissive)? */
  authorTrusted: boolean;
  /** Did a maintainer summon this issue (summon label present, or `/dev triage`)? */
  summoned: boolean;
}

/**
 * The trust-gated triage router. A `needs-triage` issue AUTO-TRIAGES when the
 * policy is permissive, when its author is trusted, OR when a maintainer summoned
 * it. Otherwise — an untrusted public author with no summon — it is HELD until a
 * maintainer summons triage (`/dev triage` or the summon label).
 */
export function routeNeedsTriage(
  policy: TrustPolicy,
  inputs: AutoTriageRouteInputs,
): AutoTriageAction {
  if (!policy.enabled) return "auto-triage";
  if (inputs.authorTrusted || inputs.summoned) return "auto-triage";
  return "hold-for-summon";
}
