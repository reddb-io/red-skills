import { applyRequeue, type RequeueFreshnessResult } from "./requeue.js";
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
  /** Read the raw issue body markdown. */
  viewBody(issue: number): Promise<string>;
  /** Overwrite the issue body with the new markdown. */
  editBody(issue: number, body: string): Promise<void>;
  verifyBaseFreshness(body: string): Promise<RequeueFreshnessResult>;
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
  if (input.decision === "close") {
    await deps.comment(input.issue, rationaleComment);
    actions.push("rationale comment posted");
    // Closing is a TRANSITION, not just a tracker verb (#2749): the park role
    // that brought the issue to HITL must not outlive the decision that ends
    // it, or the audit reads a resolved issue as still human-escalated. The
    // labels go first — a close that fails leaves an open, coherent issue,
    // where the reverse would leave a closed one nobody re-reconciles.
    const closing = await deps.viewLabels(input.issue);
    const plan = planTransition(closing, { kind: "close" });
    if (!isRefused(plan) && (plan.add.length > 0 || plan.remove.length > 0)) {
      await deps.editLabels(input.issue, [...plan.remove], [...plan.add]);
      actions.push(`close labels reconciled (-${plan.remove.join(",") || "∅"})`);
    }
    await deps.closeIssue(input.issue);
    actions.push("issue closed");
    return { issue: input.issue, decision: input.decision, actions };
  }

  const labels = await deps.viewLabels(input.issue);

  if (input.decision === "park") {
    await deps.comment(input.issue, rationaleComment);
    actions.push("rationale comment posted");
    const plan = planTransition(labels, { kind: "human" });
    if (!isRefused(plan) && (plan.add.length > 0 || plan.remove.length > 0)) {
      await deps.editLabels(input.issue, [...plan.remove], [...plan.add]);
      actions.push(`park labels reconciled (+${plan.add.join(",") || "∅"} -${plan.remove.join(",") || "∅"})`);
    }
    return { issue: input.issue, decision: input.decision, actions };
  }

  // Requeue / retake use the same complete transition as every machine caller;
  // human authority is the only difference and permits every blocker kind.
  const body = await deps.viewBody(input.issue);
  const applied = await applyRequeue(deps, {
    issue: input.issue,
    authority: "human",
    body,
    labels,
    guidance: input.rationale,
  });
  if (!applied.applied) {
    return { issue: input.issue, decision: input.decision, actions, refused: applied.reason };
  }
  actions.push("requeue directive posted");
  if (applied.releasedClaims.length > 0) {
    actions.push(`claims conceded: ${applied.releasedClaims.join(", ")}`);
  }
  if (applied.plan.activeBlocker) {
    actions.push(`body blocker cleared (kind=${applied.plan.activeBlocker.kind})`);
  }
  actions.push(`labels transitioned (+${applied.plan.addLabels.join(",") || "∅"} -${applied.plan.removeLabels.join(",") || "∅"})`);
  if (input.decision === "retake") {
    actions.push(
      "routed to the no-agent landing lane (ADR 0055): the reconcile dispatcher adopts the existing branch",
    );
  }
  return { issue: input.issue, decision: input.decision, actions };
}
