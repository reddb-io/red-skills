import {
  LABEL_CI,
  LABEL_CONTESTED,
  LABEL_CRASHED,
  LABEL_DEPENDENCY,
  LABEL_HUMAN,
  LABEL_INFRA,
  LABEL_LANDING_MANUAL,
  LABEL_MERGE_CONFLICT,
  LABEL_POLICY,
  LABEL_QUOTA,
  LABEL_READY,
  LABEL_RUNNING,
  LABEL_RUNNER_TRANSIENT,
  LABEL_SENSITIVE_PATH,
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
  LABEL_SENSITIVE_PATH,
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
  // or human-parked. Alone it is illegal.
  if (hasManualLanding && !hasHuman && !hasReady && !hasRunning) return "illegal";

  if (hasContested) return "contested";
  if (hasManualLanding && hasHuman) return "landing:manual";
  if (hasRunning) return "claimed/active";
  if (hasReady) return "ready-for-agent";
  if (blocked[0] === LABEL_DEPENDENCY) return "blocked:dependency";
  if (blocked[0] === LABEL_VALIDATION || blocked[0] === LABEL_VALIDATION_INFRA) return "blocked:validation";
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
    !labels.includes(LABEL_RUNNING)
  ) {
    return `${LABEL_LANDING_MANUAL} must ride a queued, active, or human-parked issue`;
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
