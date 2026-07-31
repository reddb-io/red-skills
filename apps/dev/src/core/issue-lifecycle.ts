import {
  LABEL_CI,
  LABEL_CONTESTED,
  LABEL_CRASHED,
  LABEL_DEPENDENCY,
  LABEL_GO_LANE,
  LABEL_HUMAN,
  LABEL_INFRA,
  LABEL_LANDING_MANUAL,
  LABEL_MERGE_CONFLICT,
  LABEL_POLICY,
  LABEL_QUOTA,
  LABEL_READY,
  LABEL_RUNNING,
  LABEL_RUNNER_TRANSIENT,
  LABEL_SCOUT_LANE,
  LABEL_SPEC,
  LABEL_STALLED,
  LABEL_TRUNK_DIVERGED,
  LABEL_VALIDATION,
  LABEL_VALIDATION_INFRA,
} from "./triage-labels.js";

export type IssueLifecycleState =
  | "ready-for-agent"
  | "claimed/active"
  | "contested"
  | "blocked:dependency"
  | "blocked:validation"
  | "ready-for-human"
  | "landing:manual"
  | "closed";

export type IssueLifecycleEdge =
  | "claim"
  | "contest"
  | "contest-expired"
  | "contest-reclaimed"
  | "retry"
  | "dependency-unblocked"
  | "dependency-blocked"
  | "preflight-blocked"
  | "validation-blocked"
  | "human-blocked"
  | "human-delegable"
  | "manual-landing"
  | "close"
  | "requeue"
  | "requeue-mixed-blocked-refusal";

export interface IssueLifecycleTransition {
  edge: IssueLifecycleEdge;
  from: IssueLifecycleState | "*";
  to: IssueLifecycleState | "illegal";
}

export const BLOCKED_LABELS = [
  LABEL_VALIDATION,
  LABEL_VALIDATION_INFRA,
  LABEL_STALLED,
  LABEL_CRASHED,
  LABEL_DEPENDENCY,
  LABEL_SPEC,
  LABEL_QUOTA,
  LABEL_RUNNER_TRANSIENT,
  LABEL_MERGE_CONFLICT,
  LABEL_CI,
  LABEL_POLICY,
  LABEL_INFRA,
  LABEL_TRUNK_DIVERGED,
] as const;

export const ISSUE_LIFECYCLE_TRANSITIONS: readonly IssueLifecycleTransition[] = [
  // `claim` normalizes any pre-active state into claimed/active: it sheds the
  // conflicting labels (blocked:*/ready-for-human) in the SAME edit as it adds
  // `running`. It is legal from ready-for-agent (normal), ready-for-human (a
  // lane:go issue claimed past preflight, #1045), and an illegal mixed-blocked
  // set that the claim edit cleans up (#402). The `to` still has to be
  // claimed/active — a claim that lands anywhere else finds no row and throws.
  { edge: "claim", from: "*", to: "claimed/active" },
  { edge: "contest", from: "claimed/active", to: "contested" },
  { edge: "contest-reclaimed", from: "contested", to: "claimed/active" },
  { edge: "contest-expired", from: "contested", to: "ready-for-agent" },
  { edge: "retry", from: "claimed/active", to: "ready-for-agent" },
  { edge: "dependency-unblocked", from: "blocked:dependency", to: "ready-for-agent" },
  { edge: "dependency-blocked", from: "ready-for-agent", to: "blocked:dependency" },
  // `preflight-blocked` parks a queued issue to a human gate when preflight
  // refuses to run it (an active `## Current blocker`, an untrusted author with no
  // sandbox). Like `claim` and `human-delegable` it must tolerate an illegal
  // mixed-blocked start set (`ready-for-agent`/`running` + a stale `blocked:*`),
  // shedding the conflicting labels in the SAME park edit — hence `from: "*"`.
  // Before #1481 this was `from: "ready-for-agent"` only, so a mixed-blocked issue
  // classified as `illegal` found no row and killed the worker mid-setup with an
  // uncaught session-error, stranding the issue.
  { edge: "preflight-blocked", from: "*", to: "ready-for-human" },
  { edge: "validation-blocked", from: "claimed/active", to: "blocked:validation" },
  { edge: "human-blocked", from: "*", to: "ready-for-human" },
  { edge: "human-blocked", from: "*", to: "blocked:validation" },
  // `human-delegable` (a HITL "delegable" disposition) clears a human park back
  // to ready-for-agent. It is legal from ready-for-human and blocked:validation,
  // and also from an illegal mixed-blocked set that the delegable resolution
  // sheds on the way out (the "sheds stale blocked:* labels" case) — hence `*`.
  { edge: "human-delegable", from: "*", to: "ready-for-agent" },
  { edge: "manual-landing", from: "claimed/active", to: "landing:manual" },
  { edge: "close", from: "claimed/active", to: "closed" },
  { edge: "close", from: "landing:manual", to: "closed" },
  { edge: "requeue", from: "ready-for-human", to: "ready-for-agent" },
  { edge: "requeue", from: "blocked:validation", to: "ready-for-agent" },
  { edge: "requeue-mixed-blocked-refusal", from: "*", to: "illegal" },
];

/**
 * The LANE-ISOLATION labels — a lane whose whole purpose is to keep its issue
 * OUT of the fleet's `ready-for-agent` pool (`lane:go`, `lane:scout`). Isolation
 * is what lets a `/go` dispatch run in parallel with any fleet: the disposable
 * issue is worked by exactly one worker because exactly one pool can see it.
 */
export const LANE_ISOLATION_LABELS: readonly string[] = [LABEL_GO_LANE, LABEL_SCOUT_LANE];

/** The lane-isolation labels present in a label set (order of the declaration). */
export function laneIsolationLabelsIn(labels: readonly string[]): string[] {
  return LANE_ISOLATION_LABELS.filter((lane) => labels.includes(lane));
}

/**
 * A refused promotion: the write would have paired `ready-for-agent` with a
 * lane-isolation label, handing one issue to two pools at once. The message
 * names the ORIGIN (the lifecycle edge, or the direct write that carries none)
 * as well as the lane, because "which label is wrong" is never the useful
 * question here — "who tried to write it" is.
 */
export class LaneIsolationViolationError extends Error {
  constructor(
    readonly origin: IssueLifecycleEdge | (string & {}),
    readonly lane: string,
  ) {
    super(
      `lane isolation refused "${origin}": cannot apply ${LABEL_READY} to an issue carrying ${lane} — ` +
        `the ${lane} lane is isolated from the fleet's ${LABEL_READY} pool`,
    );
    this.name = "LaneIsolationViolationError";
  }
}

/**
 * The one-line invariant every label writer asks before promoting: would this
 * label set pair `ready-for-agent` with an isolated lane? Returns the refusal to
 * throw or log, or null when the write is clean. Pure — callers decide whether a
 * violation is fatal (`validateIssueLifecycleTransition` throws) or a refusal
 * that leaves the labels untouched (every applying site).
 */
export function laneIsolationRefusal(
  origin: IssueLifecycleEdge | (string & {}),
  labels: readonly string[],
): LaneIsolationViolationError | null {
  if (!labels.includes(LABEL_READY)) return null;
  const lane = laneIsolationLabelsIn(labels)[0];
  return lane === undefined ? null : new LaneIsolationViolationError(origin, lane);
}

export class IllegalIssueLifecycleTransitionError extends Error {
  constructor(
    readonly edge: IssueLifecycleEdge,
    readonly from: IssueLifecycleState | "illegal",
    readonly to: IssueLifecycleState | "illegal",
    readonly reason: string,
  ) {
    super(`illegal issue lifecycle transition "${edge}": ${from} -> ${to}: ${reason}`);
    this.name = "IllegalIssueLifecycleTransitionError";
  }
}

export function blockedLabelsIn(labels: readonly string[]): string[] {
  return labels.filter((label) => label.startsWith("blocked:"));
}

export function applyLabelMutation(
  labels: readonly string[],
  removeLabels: readonly string[],
  addLabels: readonly string[],
): string[] {
  const next = new Set(labels);
  for (const label of removeLabels) next.delete(label);
  for (const label of addLabels) next.add(label);
  return [...next];
}

export function classifyIssueLifecycleState(labels: readonly string[]): IssueLifecycleState | "illegal" {
  const hasReady = labels.includes(LABEL_READY);
  const hasRunning = labels.includes(LABEL_RUNNING);
  const hasHuman = labels.includes(LABEL_HUMAN);
  const hasManualLanding = labels.includes(LABEL_LANDING_MANUAL);
  const hasContested = labels.includes(LABEL_CONTESTED);
  const blocked = blockedLabelsIn(labels);
  const hasBlocked = blocked.length > 0;

  if (blocked.length > 1) return "illegal";
  if (hasContested && (!hasRunning || hasReady || hasHuman || hasBlocked || hasManualLanding)) return "illegal";
  if ((hasReady || hasRunning) && hasBlocked) return "illegal";
  if (hasReady && hasRunning) return "illegal";
  // `landing:manual` is a MODE flag that must ride a real state: queued
  // (ready-for-agent), active (running, #1049 works the issue before parking it),
  // or human-parked/blocked. Alone it is illegal.
  if (hasManualLanding && !hasHuman && !hasReady && !hasRunning && !hasBlocked) return "illegal";

  if (hasContested) return "contested";
  if (hasRunning) return "claimed/active";
  if (hasReady) return "ready-for-agent";
  if (blocked[0] === LABEL_DEPENDENCY) return "blocked:dependency";
  if (blocked[0] === LABEL_VALIDATION || blocked[0] === LABEL_VALIDATION_INFRA) return "blocked:validation";
  if (hasManualLanding && hasHuman) return "landing:manual";
  if (hasHuman) return "ready-for-human";
  if (hasBlocked) return "ready-for-human";
  return "ready-for-human";
}

export function explainIllegalIssueLifecycleLabels(labels: readonly string[]): string | null {
  const blocked = blockedLabelsIn(labels);
  if (blocked.length > 1) return `mixed blocked:* labels [${blocked.join(", ")}]`;
  if (labels.includes(LABEL_CONTESTED)) {
    if (!labels.includes(LABEL_RUNNING)) return `${LABEL_CONTESTED} must ride ${LABEL_RUNNING}`;
    if (
      labels.includes(LABEL_READY) ||
      labels.includes(LABEL_HUMAN) ||
      labels.includes(LABEL_LANDING_MANUAL) ||
      blocked.length > 0
    ) {
      return `${LABEL_CONTESTED} cannot ride queued, human, manual-landing, or blocked state`;
    }
  }
  if ((labels.includes(LABEL_READY) || labels.includes(LABEL_RUNNING)) && blocked.length > 0) {
    return `queued/active issue cannot also carry blocked:* label ${blocked[0]}`;
  }
  if (labels.includes(LABEL_READY) && labels.includes(LABEL_RUNNING)) {
    return `issue cannot carry both ${LABEL_READY} and ${LABEL_RUNNING}`;
  }
  if (
    labels.includes(LABEL_LANDING_MANUAL) &&
    !labels.includes(LABEL_HUMAN) &&
    !labels.includes(LABEL_READY) &&
    !labels.includes(LABEL_RUNNING) &&
    blocked.length === 0
  ) {
    return `${LABEL_LANDING_MANUAL} must ride a queued, active, human-parked, or blocked issue`;
  }
  return null;
}

export function validateIssueLifecycleTransition(input: {
  edge: IssueLifecycleEdge;
  fromLabels: readonly string[];
  removeLabels: readonly string[];
  addLabels: readonly string[];
}): string[] {
  const from = classifyIssueLifecycleState(input.fromLabels);
  const nextLabels = applyLabelMutation(input.fromLabels, input.removeLabels, input.addLabels);
  const to = classifyIssueLifecycleState(nextLabels);
  // Lane isolation is checked FIRST and never reconciled. Every other illegality
  // here is a malformed label set the edge can shed on the way through; this one
  // is a request to put an issue in two pools, and shedding cannot fix that.
  const laneViolation = laneIsolationRefusal(input.edge, nextLabels);
  if (laneViolation !== null) throw laneViolation;
  const illegalReason = explainIllegalIssueLifecycleLabels(nextLabels);
  if (illegalReason !== null) {
    throw new IllegalIssueLifecycleTransitionError(input.edge, from, "illegal", illegalReason);
  }
  const row = ISSUE_LIFECYCLE_TRANSITIONS.find(
    (transition) =>
      transition.edge === input.edge &&
      (transition.from === "*" || transition.from === from) &&
      transition.to === to,
  );
  if (!row) {
    throw new IllegalIssueLifecycleTransitionError(
      input.edge,
      from,
      to,
      `no legal row for edge "${input.edge}" from ${from} to ${to}`,
    );
  }
  return nextLabels;
}
