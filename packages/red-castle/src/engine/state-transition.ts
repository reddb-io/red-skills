// state-transition.ts — the single owner of issue state-label mutations
// (red-skills ADR 0122 rule 5, Spec #2523, slices #2524 + #2661 + #2666).
//
// An issue carries exactly ONE state role at any time. On 2026-07-22 three
// issues accumulated contradictory role sets (park labels stacked on the
// executable-queue label, an active blocker on a queued issue) because every
// code path wrote labels directly; each contradiction became a red boot probe
// and froze the fleet. This module makes those sets unconstructible: callers
// declare the TRANSITION they want, the planner computes the atomic add/remove
// set, refuses any request that would leave zero or two state roles, and the
// apply step performs the whole mutation as ONE tracker call.
//
// The engine owns no label spellings. Every caller injects its
// {@link StateTransitionLabels} vocabulary — the castle resident wires
// `readEngineLabelVocabulary()`, the red-skills host wires its own
// `triage-labels.ts` constants through the `core/state-transition.ts` shim.

/**
 * The label vocabulary a transition reads as INJECTED CONFIG. The engine never
 * value-imports a host's label constants; the construction site supplies them.
 */
export interface StateTransitionLabels {
  /** The executable-queue routing label (`ready-for-agent`). */
  readonly ready: string;
  /** The observability projection of an active claim (`running`). */
  readonly running: string;
  /** The HITL park routing label (`ready-for-human`). */
  readonly human: string;
  /** The un-triaged intake state (`needs-triage`). */
  readonly needsTriage: string;
  /** The awaiting-answer intake state (`needs-info`). */
  readonly needsInfo: string;
  /** The judgment-required safety hold (`quarantine`). */
  readonly quarantine: string;
  /** The dependency-wait state role (`blocked:dependency`). */
  readonly dependencyBlocked: string;
  /** The prefix every blocked-reason label shares (`blocked:`). */
  readonly blockedPrefix: string;
  /** The prefix of a dependency edge label (`req:{issue}`). */
  readonly reqPrefix: string;
  /**
   * The TYPE labels this repo's vocabulary declares HUMAN-ONLY (red-skills
   * #2966). A ticket carrying one resolves only through a live exchange with a
   * human, so a `promote` routes it to {@link human} instead of the executable
   * queue — the blockers closing means the human may now act, never that an
   * agent may act for them. A vocabulary that declares none (the default) leaves
   * every promotion in the autonomous lane, exactly as before.
   */
  readonly hitlTypes?: readonly string[];
}

/**
 * The declared HUMAN-ONLY type labels `current` carries, in vocabulary order.
 * Empty when the repo declares no HITL type — the reason a repo that never
 * opted in keeps its previous behaviour. Pure.
 */
export function hitlTypesIn(
  current: readonly string[],
  labels: StateTransitionLabels,
): string[] {
  return (labels.hitlTypes ?? []).filter((type) => current.includes(type));
}

/** Every label that counts as a STATE ROLE, in the deterministic order the
 * planner emits removals. The invariant this module enforces: a
 * post-transition label set contains exactly one of these. */
export function stateRoleLabels(labels: StateTransitionLabels): readonly string[] {
  return [
    labels.ready,
    labels.human,
    labels.needsTriage,
    labels.needsInfo,
    labels.quarantine,
    labels.dependencyBlocked,
  ];
}

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
  /** Awaiting an answer from the reporter (the `/triage` `needs-info` outcome). */
  | { kind: "needs-info" }
  /** Back to the triage queue — the state a fresh or bounced issue sits in. */
  | { kind: "triage" }
  /** Close-cascade promotion: consume the `req:*` edges and re-queue. */
  | { kind: "promote" }
  /** Terminal: the issue is closed, so it carries NO state role at all. Every
   * role, the `running` projection, the blocked-reason modifiers, and the
   * `req:*` edges go; permanent markers (`spec:N`, `type:*`, `priority:*`)
   * stay. A park is not terminal — parked work still lands, by a human merge,
   * a retake, or an adopt-branch landing — and the state the park left behind
   * must not outlive the close (#2749). */
  | { kind: "close" };

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

/** The state roles present in a label set (planner order preserved). */
export function stateRolesOf(
  current: readonly string[],
  labels: StateTransitionLabels,
): string[] {
  return stateRoleLabels(labels).filter((role) => current.includes(role));
}

/** The single role the transition targets, or `null` for the terminal `close`
 * transition — the one state an issue reaches by carrying no role at all.
 *
 * `promote` is the one transition whose target depends on the ISSUE and not
 * only on the request: a dependent carrying a declared HUMAN-ONLY type lands in
 * the human lane. The edges are consumed either way — the dependency wait is
 * genuinely over; only who acts next differs.
 */
function targetRole(
  t: StateTransition,
  labels: StateTransitionLabels,
  current: readonly string[],
): string | null {
  switch (t.kind) {
    case "close":
      return null;
    case "promote":
      return hitlTypesIn(current, labels).length > 0 ? labels.human : labels.ready;
    case "queue":
      return labels.ready;
    case "park":
    case "human":
      return labels.human;
    case "dependency-block":
      return labels.dependencyBlocked;
    case "quarantine":
      return labels.quarantine;
    case "needs-info":
      return labels.needsInfo;
    case "triage":
      return labels.needsTriage;
  }
}

/** Dependency edges in numeric issue order, so the emitted mutation is
 * deterministic regardless of the tracker's label listing order. */
function sortedReqLabels(
  reqLabels: readonly string[],
  labels: StateTransitionLabels,
): string[] {
  const byIssue = (l: string): number => Number(l.slice(labels.reqPrefix.length)) || 0;
  return [...reqLabels].sort((a, b) => byIssue(a) - byIssue(b));
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
  labels: StateTransitionLabels,
): TransitionPlan | RefusedTransition {
  if (transition.kind === "park" && !transition.reason.startsWith(labels.blockedPrefix)) {
    return {
      refused: true,
      reason: `park reason must be a ${labels.blockedPrefix}* label, got "${transition.reason}"`,
    };
  }
  if (transition.kind === "dependency-block" && transition.reqs.length === 0) {
    return { refused: true, reason: "dependency-block requires at least one req issue" };
  }
  const reqLabels = current.filter((l) => l.startsWith(labels.reqPrefix));
  if (transition.kind === "queue" && reqLabels.length > 0) {
    return {
      refused: true,
      reason:
        `queue refused while dependency edges remain (${reqLabels.join(", ")}); ` +
        `use promote to consume them or clear the edges first`,
    };
  }

  const target = targetRole(transition, labels, current);
  const add = new Set<string>();
  const remove = new Set<string>();

  // Every other state role present goes; the target role arrives. `close`
  // targets no role, so every role present goes and nothing arrives.
  for (const role of stateRoleLabels(labels)) {
    if (role === target) continue;
    if (current.includes(role)) remove.add(role);
  }
  if (target !== null && !current.includes(target)) add.add(target);

  // Leaving execution: `running` never survives a state transition.
  if (current.includes(labels.running)) remove.add(labels.running);

  // Blocked-reason modifiers accompany exactly the states that define them.
  const blockedPresent = current.filter(
    (l) => l.startsWith(labels.blockedPrefix) && l !== labels.dependencyBlocked,
  );
  switch (transition.kind) {
    case "park":
      for (const l of blockedPresent) if (l !== transition.reason) remove.add(l);
      if (!current.includes(transition.reason)) add.add(transition.reason);
      break;
    case "dependency-block":
      for (const l of blockedPresent) remove.add(l);
      for (const req of transition.reqs) {
        const label = `${labels.reqPrefix}${req}`;
        if (!current.includes(label)) add.add(label);
      }
      break;
    case "promote":
    case "close":
      // Both consume the dependency edges: `promote` because the blockers
      // closed, `close` because a closed issue holds no engine state at all.
      for (const l of blockedPresent) remove.add(l);
      for (const l of sortedReqLabels(reqLabels, labels)) remove.add(l);
      break;
    default:
      for (const l of blockedPresent) remove.add(l);
      break;
  }

  // Invariant proof: replay the mutation and demand exactly one state role —
  // or, for the terminal `close`, exactly none.
  const expectedRoles = transition.kind === "close" ? 0 : 1;
  const result = new Set(current);
  for (const l of remove) result.delete(l);
  for (const l of add) result.add(l);
  const roles = stateRolesOf([...result], labels);
  if (roles.length !== expectedRoles) {
    return {
      refused: true,
      reason:
        `transition would leave ${roles.length} state roles ` +
        `(${roles.join(", ") || "none"}), expected ${expectedRoles}`,
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
 * and body change in one tracker edit. */
export interface IssueEdit {
  readonly add: readonly string[];
  readonly remove: readonly string[];
  readonly body?: string;
}

export interface ApplyTransitionDeps {
  /** Perform ONE issue edit covering labels (and body when given). */
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
