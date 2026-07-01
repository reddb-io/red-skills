import type { HitlDecisionExtraction } from "./hitl-decision-extraction.js";
import { clearCurrentBlocker, parseCurrentBlocker, upsertCurrentBlocker } from "./blocker-state.js";
import { upsertAgentBrief } from "./agent-brief.js";
import { LABEL_READY, LABEL_HUMAN } from "./triage-labels.js";

export interface HitlResolutionIssue {
  number: number;
  title: string;
  body: string;
  /** The issue's current labels, used to shed stale `blocked:*` reasons when the
   * issue becomes delegable. Optional; when absent no blocker labels are shed. */
  labels?: string[];
}

export type HitlResolutionDisposition =
  | {
      kind: "delegable";
      agentBrief: string;
    }
  | {
      kind: "non-delegable";
      nextPendingDecision: string;
    };

export interface HitlResolutionInput {
  issue: HitlResolutionIssue;
  decision: HitlDecisionExtraction;
  answer: string;
  disposition: HitlResolutionDisposition;
}

export interface HitlResolutionPlan {
  commentBody: string;
  bodyUpdate?: string;
  addLabels: string[];
  removeLabels: string[];
}

function trimBlock(value: string): string {
  return value.trim().replace(/\n{3,}/g, "\n\n");
}

/** The stale `blocked:*` reason labels carried by the issue. When it becomes
 * delegable the blocker is resolved, so these must be shed alongside
 * `ready-for-human` — otherwise the issue returns to `ready-for-agent` still
 * wearing the reason that parked it. */
function staleBlockerLabels(labels: readonly string[] | undefined): string[] {
  return (labels ?? []).filter((label) => label.startsWith("blocked:"));
}

function directiveComment(input: HitlResolutionInput): string {
  const pendingDecision =
    input.decision.kind === "pending-decision"
      ? input.decision.prompt
      : `${input.decision.prompt}\n\nAmbiguity: ${input.decision.reasons.join("; ")}`;
  const next =
    input.disposition.kind === "non-delegable"
      ? `\n\nNext pending decision:\n${trimBlock(input.disposition.nextPendingDecision)}`
      : "";

  return `<details data-kind="directive">
<summary>HITL resolution</summary>

Pending decision:
${trimBlock(pendingDecision)}

Human answer:
${trimBlock(input.answer)}

Disposition:
${input.disposition.kind}${next}
</details>`;
}

export function planHitlResolution(input: HitlResolutionInput): HitlResolutionPlan {
  if (input.disposition.kind === "delegable") {
    const cleared = clearCurrentBlocker(input.issue.body, {
      summary:
        parseCurrentBlocker(input.issue.body)?.summary ??
        (input.decision.kind === "pending-decision" ? input.decision.prompt : input.decision.prompt),
      resolution: input.answer,
    });
    return {
      commentBody: directiveComment(input),
      bodyUpdate: upsertAgentBrief(cleared, input.disposition.agentBrief),
      addLabels: [LABEL_READY],
      removeLabels: [LABEL_HUMAN, ...staleBlockerLabels(input.issue.labels)],
    };
  }

  return {
    commentBody: directiveComment(input),
    bodyUpdate: upsertCurrentBlocker(input.issue.body, {
      status: "blocked",
      kind: "decision",
      summary: input.decision.kind === "pending-decision" ? input.decision.prompt : input.decision.prompt,
      next: input.disposition.nextPendingDecision,
    }),
    addLabels: [LABEL_HUMAN],
    removeLabels: [],
  };
}
