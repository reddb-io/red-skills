import type { HitlDecisionExtraction } from "./hitl-decision-extraction.js";
import { clearCurrentBlocker, parseCurrentBlocker, upsertCurrentBlocker } from "./blocker-state.js";

export interface HitlResolutionIssue {
  number: number;
  title: string;
  body: string;
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

function upsertMarkdownSection(markdown: string, heading: string, body: string): string {
  const lines = markdown.split("\n");
  const headingRe = new RegExp(`^##\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i");
  const start = lines.findIndex((line) => headingRe.test(line));
  const replacement = [`## ${heading}`, "", trimBlock(body)];

  if (start === -1) {
    const prefix = markdown.trimEnd();
    return `${prefix}${prefix.length > 0 ? "\n\n" : ""}${replacement.join("\n")}\n`;
  }

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s+/.test(lines[i]!)) {
      end = i;
      break;
    }
  }

  const next = [...lines.slice(0, start), ...replacement, ...lines.slice(end)];
  return `${next.join("\n").trimEnd()}\n`;
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
      bodyUpdate: upsertMarkdownSection(cleared, "Agent brief", input.disposition.agentBrief),
      addLabels: ["ready-for-agent"],
      removeLabels: ["ready-for-human"],
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
    addLabels: ["ready-for-human"],
    removeLabels: [],
  };
}
