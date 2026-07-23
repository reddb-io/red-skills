import { isRefused, planTransition } from "./state-transition.js";

/**
 * hitl_resolve core (#2369, Spec #2329 E7): one human decision on a parked
 * issue becomes ONE atomic mutation sequence — claims conceded, labels
 * transitioned through the ADR 0122 API, rationale posted for the audit trail.
 * Collapses the 10-round-trip unpark sequences observed in live operation into
 * a single verb.
 */

export type HitlDecision = "requeue" | "retake" | "park" | "close";

export interface HitlResolveDeps {
  comment(issue: number, body: string): Promise<void>;
  closeIssue(issue: number): Promise<void>;
  viewLabels(issue: number): Promise<string[]>;
  editLabels(issue: number, remove: string[], add: string[]): Promise<void>;
  /** Concede every dangling claim holder; returns the conceded worker ids. */
  releaseClaims(issue: number): Promise<string[]>;
}

export interface HitlResolveResult {
  issue: number;
  decision: HitlDecision;
  actions: string[];
  refused?: string;
}

export async function resolveHitlDecision(
  deps: HitlResolveDeps,
  input: { issue: number; decision: HitlDecision; rationale: string },
): Promise<HitlResolveResult> {
  const actions: string[] = [];
  const rationaleComment =
    "> *This was recorded by the maintainer's session agent.*\n\n" +
    `🤖 HITL decision **${input.decision}** on #${input.issue}: ${input.rationale}`;
  // Every decision leaves the rationale on the issue — the audit trail is not optional.
  await deps.comment(input.issue, rationaleComment);
  actions.push("rationale comment posted");

  if (input.decision === "close") {
    await deps.closeIssue(input.issue);
    actions.push("issue closed");
    return { issue: input.issue, decision: input.decision, actions };
  }

  const labels = await deps.viewLabels(input.issue);

  if (input.decision === "park") {
    const plan = planTransition(labels, { kind: "human" });
    if (!isRefused(plan) && (plan.add.length > 0 || plan.remove.length > 0)) {
      await deps.editLabels(input.issue, [...plan.remove], [...plan.add]);
      actions.push(`park labels reconciled (+${plan.add.join(",") || "∅"} -${plan.remove.join(",") || "∅"})`);
    }
    return { issue: input.issue, decision: input.decision, actions };
  }

  // requeue / retake both free the issue: concede dangling claims first, then
  // one atomic transition. A HUMAN decision consumes dangling req:* edges
  // (promote) instead of refusing the way the automated queue path must.
  const conceded = await deps.releaseClaims(input.issue);
  if (conceded.length > 0) actions.push(`claims conceded: ${conceded.join(", ")}`);
  const hasReqEdges = labels.some((label) => label.startsWith("req:"));
  const plan = planTransition(labels, { kind: hasReqEdges ? "promote" : "queue" });
  if (isRefused(plan)) {
    return { issue: input.issue, decision: input.decision, actions, refused: plan.reason };
  }
  await deps.editLabels(input.issue, [...plan.remove], [...plan.add]);
  actions.push(`labels transitioned (+${plan.add.join(",") || "∅"} -${plan.remove.join(",") || "∅"})`);
  if (input.decision === "retake") {
    actions.push(
      "routed to the no-agent landing lane (ADR 0055): the reconcile dispatcher adopts the existing branch",
    );
  }
  return { issue: input.issue, decision: input.decision, actions };
}
