// state-transition.ts — the HOST shim over the castle engine's transition API
// (ADR 0122 rule 5, Spec #2523, slices #2524 + #2661 + #2666).
//
// The planner itself crossed to `@reddb-io/worker`'s
// `engine/state-transition.ts` in #2666, so the castle's own writers (the
// quarantine curator, the dependency cascade) prove the same one-state-role
// invariant this host has enforced since #2524. Nothing about the rules moved:
// callers declare the TRANSITION they want, the planner computes the atomic
// add/remove set, refuses any request that would leave zero or two state roles,
// and the apply step performs the whole mutation as ONE tracker call.
//
// What stays HERE is the vocabulary binding. The engine owns no label
// spellings; this module wires this repo's `triage-labels.ts` constants so
// every existing caller keeps the two-argument `planTransition(current,
// transition)` signature it already uses. The raw-edit lint (#2528) enforces
// that engine code routes through this API.

import {
  hitlTypesIn,
  isRefused,
  planTransition as planTransitionWithLabels,
  stateRoleLabels,
  stateRolesOf as stateRolesOfWithLabels,
  type StateTransition,
  type StateTransitionLabels,
  type RefusedTransition,
  type TransitionPlan,
} from "@reddb-io/worker/engine";
import {
  LABEL_BASE_STALE,
  LABEL_BUDGET,
  LABEL_CI,
  LABEL_CRASHED,
  LABEL_GO_LANE,
  LABEL_HOST_CONFIG,
  LABEL_INFRA,
  LABEL_MERGE_CONFLICT,
  LABEL_POLICY,
  LABEL_QUOTA,
  LABEL_READY,
  LABEL_HUMAN,
  LABEL_NEEDS_TRIAGE,
  LABEL_NEEDS_INFO,
  LABEL_RUNNING,
  LABEL_DEPENDENCY,
  LABEL_QUARANTINE,
  LABEL_RUNNER_TRANSIENT,
  LABEL_RUNNER,
  LABEL_SCOUT_LANE,
  LABEL_SIGNAL_KILLED,
  LABEL_SPEC,
  LABEL_STALLED,
  LABEL_SPIN,
  LABEL_TRUNK_DIVERGED,
  LABEL_VALIDATION,
  LABEL_VALIDATION_INFRA,
  LABEL_WALL_CLOCK_CAPPED,
} from "./triage-labels.js";

export {
  applyTransition,
  isRefused,
  type ApplyTransitionDeps,
  type ApplyTransitionResult,
  type IssueEdit,
  type RefusedTransition,
  type StateTransition,
  type StateTransitionLabels,
  type TransitionPlan,
} from "@reddb-io/worker/engine";

/** This host's transition vocabulary, wired into every engine call below. */
export const HOST_STATE_TRANSITION_LABELS: StateTransitionLabels = {
  ready: LABEL_READY,
  running: LABEL_RUNNING,
  human: LABEL_HUMAN,
  needsTriage: LABEL_NEEDS_TRIAGE,
  needsInfo: LABEL_NEEDS_INFO,
  quarantine: LABEL_QUARANTINE,
  dependencyBlocked: LABEL_DEPENDENCY,
  blockedPrefix: "blocked:",
  reqPrefix: "req:",
};

/** The complete host census of typed Park labels. Keep this declaration beside
 * the transition vocabulary so every reader shares the planner's spellings. */
export const BLOCKED_LABELS = [
  LABEL_VALIDATION,
  LABEL_VALIDATION_INFRA,
  LABEL_STALLED,
  LABEL_SPIN,
  LABEL_WALL_CLOCK_CAPPED,
  LABEL_CRASHED,
  LABEL_RUNNER,
  LABEL_SIGNAL_KILLED,
  LABEL_DEPENDENCY,
  LABEL_SPEC,
  LABEL_QUOTA,
  LABEL_RUNNER_TRANSIENT,
  LABEL_HOST_CONFIG,
  LABEL_MERGE_CONFLICT,
  LABEL_CI,
  LABEL_POLICY,
  LABEL_INFRA,
  LABEL_TRUNK_DIVERGED,
  LABEL_BASE_STALE,
  LABEL_BUDGET,
] as const;

/** Blocker kinds a machine may treat as mechanically recoverable. */
export const MECHANICAL_BLOCKER_KINDS: ReadonlySet<string> = new Set([
  "stalled",
  "crashed",
  "merge-conflict",
]);

/** Return a typed Park label's kind, including kinds supplied by another repo. */
export function blockedKindOf(label: string): string | null {
  const prefix = HOST_STATE_TRANSITION_LABELS.blockedPrefix;
  return label.startsWith(prefix) ? label.slice(prefix.length) : null;
}

/** The typed Park labels present in a label set (order preserved). */
export function blockedLabelsIn(labels: readonly string[]): string[] {
  return labels.filter((label) => blockedKindOf(label) !== null);
}

/** Whether a blocker kind belongs to the planner's mechanical allowlist. */
export function isMechanicalBlockerKind(kind: string): boolean {
  return MECHANICAL_BLOCKER_KINDS.has(kind);
}

/** Lane labels whose issues must never enter the shared executable queue. */
export const LANE_ISOLATION_LABELS: readonly string[] = [LABEL_GO_LANE, LABEL_SCOUT_LANE];

export class LaneIsolationViolationError extends Error {
  constructor(
    readonly origin: string,
    readonly lane: string,
  ) {
    super(
      `lane isolation refused "${origin}": cannot apply ${LABEL_READY} to an issue carrying ${lane} — ` +
        `the ${lane} lane is isolated from the fleet's ${LABEL_READY} pool`,
    );
    this.name = "LaneIsolationViolationError";
  }
}

/** Refuse a transition that would pair an isolated lane with the AFK queue. */
export function laneIsolationRefusal(
  origin: string,
  labels: readonly string[],
): LaneIsolationViolationError | null {
  if (!labels.includes(LABEL_READY)) return null;
  const lane = LANE_ISOLATION_LABELS.find((candidate) => labels.includes(candidate));
  return lane === undefined ? null : new LaneIsolationViolationError(origin, lane);
}

/** Every label that counts as a STATE ROLE in this host's vocabulary. */
export const STATE_ROLE_LABELS: readonly string[] = stateRoleLabels(
  HOST_STATE_TRANSITION_LABELS,
);

/** The state roles present in a label set (order preserved). */
export function stateRolesOf(labels: readonly string[]): string[] {
  return stateRolesOfWithLabels(labels, HOST_STATE_TRANSITION_LABELS);
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
  hitlTypes: readonly string[] = [],
): TransitionPlan | RefusedTransition {
  return planTransitionWithLabels(current, transition, hostLabels(hitlTypes));
}

/** The host vocabulary with this repo's declared HUMAN-ONLY type labels folded
 * in (#2966). The spellings are constants; the HITL types are per-repo config,
 * so they arrive at the call site rather than at module load. */
function hostLabels(hitlTypes: readonly string[]): StateTransitionLabels {
  return hitlTypes.length === 0
    ? HOST_STATE_TRANSITION_LABELS
    : { ...HOST_STATE_TRANSITION_LABELS, hitlTypes };
}

/** The declared HUMAN-ONLY type labels `current` carries (empty when the repo
 * declares none). Callers use it to explain the lane in their audit comment. */
export function hostHitlTypesIn(
  current: readonly string[],
  hitlTypes: readonly string[],
): string[] {
  return hitlTypesIn(current, hostLabels(hitlTypes));
}

/**
 * The escalation shape every terminal site wants: park under the typed
 * `blocked:<reason>` when the outcome HAS one, a plain human gate when it does
 * not (a handoff like `review-requested` carries no typed
 * reason). Callers pass `blockedLabelFor(outcome)` / `disp.typedLabel` straight
 * through instead of re-deriving the two-armed branch per site (#2663).
 */
export function parkOrHuman(reason: string | null | undefined): StateTransition {
  return reason !== null && reason !== undefined ? { kind: "park", reason } : { kind: "human" };
}

/** What {@link transitionLabels} did: the plan it applied, or the refusal that
 * stopped it before any tracker call. */
export type TransitionLabelsResult =
  | { readonly applied: true; readonly ok: boolean; readonly plan: TransitionPlan }
  | ({ readonly applied: false } & RefusedTransition);

/**
 * Plan `transition` against `current` and apply it through a legacy
 * `(remove, add)` label port — the ONE adapter every engine call site uses
 * (#2663). The gh ports disagree on argument ORDER (`process-issue` is
 * `(issue, remove, add)`, the supervisor is `(issue, add, remove)`), so the
 * caller passes a closure that already binds the issue and the right order;
 * this function owns the planning and never lets an unplanned delta through.
 *
 * `current` is the issue's label set as the CALL SITE knows it. Sites that read
 * the issue pass the real set; sites that only know the labels they intend to
 * shed pass those — the plan is then exactly that site's historical delta, with
 * the one-state-role invariant proven on top.
 *
 * A REFUSED plan performs no tracker call: the request itself is malformed, and
 * silently half-applying it is what ADR 0122 rule 5 exists to prevent.
 */
export async function transitionLabels(
  edit: (remove: string[], add: string[]) => Promise<unknown>,
  current: readonly string[],
  transition: StateTransition,
  hitlTypes: readonly string[] = [],
): Promise<TransitionLabelsResult> {
  const plan = planTransition(current, transition, hitlTypes);
  if (isRefused(plan)) return { applied: false, ...plan };
  const result = await edit([...plan.remove], [...plan.add]);
  return { applied: true, ok: result !== false, plan };
}
