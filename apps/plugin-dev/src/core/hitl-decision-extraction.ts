import {
  classifyComment,
  extractDirectives,
  envelopeStatus,
  type Comment,
} from "./comment-classification.js";
import type { HandoffComment } from "./handoff.js";
import { parseCurrentBlocker } from "./blocker-state.js";
import { isTrustedSource } from "./source-trust.js";

export interface HitlDecisionIssue {
  number: number;
  title: string;
  body: string;
  comments: HandoffComment[];
}

export type HitlDecisionSource =
  | "current-blocker"
  | "issue-body"
  | "agent-brief"
  | "human-guidance"
  | "envelope"
  | "thread-discussion";

export type HitlDecisionExtraction =
  | {
      kind: "pending-decision";
      source: HitlDecisionSource;
      prompt: string;
      evidence: string;
    }
  | {
      kind: "ambiguous";
      prompt: string;
      reasons: string[];
      evidence: string[];
    };

interface DecisionSignal {
  source: HitlDecisionSource;
  prompt: string;
  evidence: string;
  authoritative: boolean;
}

const DECISION_HEADINGS = [
  "human decision needed",
  "decision needed",
  "pending decision",
  "hitl decision",
  "human decision",
];

function normalizeLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function firstUsefulLine(value: string): string {
  const line = value
    .split("\n")
    .filter((part) => !/^<summary>.*<\/summary>\s*$/.test(part.trim()))
    .map((part) => part.replace(/^[-*]\s*(?:\[[ xX]\]\s*)?/, ""))
    .map(normalizeLine)
    .find((part) => part.length > 0);
  return line ?? "";
}

function excerpt(value: string, max = 260): string {
  const text = normalizeLine(value);
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3).trimEnd()}...`;
}

function sectionBody(markdown: string, headings: readonly string[]): string | null {
  const lines = markdown.split("\n");
  let capture = false;
  const out: string[] = [];

  for (const line of lines) {
    const heading = /^(#{2,6})\s+(.+?)\s*$/.exec(line);
    if (heading) {
      const title = heading[2]!.replace(/`/g, "").trim().toLowerCase();
      if (capture) break;
      if (headings.includes(title)) {
        capture = true;
        continue;
      }
    }
    if (capture) out.push(line);
  }

  const body = out.join("\n").trim();
  return body.length > 0 ? body : null;
}

function issueBodySignal(issue: HitlDecisionIssue): DecisionSignal | null {
  const body = sectionBody(issue.body, DECISION_HEADINGS);
  if (!body) return null;
  const line = firstUsefulLine(body);
  if (!line) return null;
  return {
    source: "issue-body",
    prompt: line,
    evidence: body,
    authoritative: true,
  };
}

function currentBlockerSignal(issue: HitlDecisionIssue): DecisionSignal | null {
  const blocker = parseCurrentBlocker(issue.body);
  if (!blocker) return null;
  const evidence = [
    `kind: ${blocker.kind}`,
    blocker.ref ? `ref: ${blocker.ref}` : "",
    `summary: ${blocker.summary}`,
    `next: ${blocker.next}`,
  ]
    .filter((line) => line.length > 0)
    .join("\n");
  return {
    source: "current-blocker",
    prompt: blocker.next,
    evidence,
    authoritative: true,
  };
}

function agentBriefSignal(issue: HitlDecisionIssue): DecisionSignal | null {
  const brief = sectionBody(issue.body, ["agent brief"]);
  if (!brief) return null;
  const line = brief
    .split("\n")
    .map((part) => part.replace(/^[-*]\s*/, ""))
    .find((part) => /\b(decision|decide|human|cannot be delegated|can't be delegated|blocked)\b/i.test(part));
  if (!line) return null;
  return {
    source: "agent-brief",
    prompt: normalizeLine(line),
    evidence: brief,
    authoritative: true,
  };
}

/** Bare placeholder labels the loop's own HITL-resolution directive starts with.
 * They are field headers, not decisions, so a directive whose first useful line
 * is one of these is the loop re-reading its own prior resolution. */
const SELF_RESOLUTION_LABELS = ["pending decision:", "human answer:", "disposition:", "next pending decision:"];

/** True when a directive body is one of the loop's own `<summary>HITL resolution</summary>`
 * blocks (or otherwise opens with a bare resolution field label). Such directives
 * echo the literal "Pending decision:" header instead of a real decision and must
 * not be re-extracted on a HITL re-loop. */
function isSelfHitlResolution(directive: string): boolean {
  const summary = /<summary>\s*(.*?)\s*<\/summary>/i.exec(directive);
  if (summary && summary[1]!.replace(/\s+/g, " ").trim().toLowerCase() === "hitl resolution") return true;
  const first = firstUsefulLine(directive).toLowerCase();
  return SELF_RESOLUTION_LABELS.includes(first);
}

function directiveSignals(comments: readonly HandoffComment[]): DecisionSignal[] {
  const out: DecisionSignal[] = [];
  for (const comment of comments) {
    if (classifyComment({ body: comment.body }) !== "directive") continue;
    if (!isTrustedSource(comment.sourceTrust)) continue;
    for (const directive of extractDirectives(comment.body)) {
      if (isSelfHitlResolution(directive)) continue;
      const line = firstUsefulLine(directive);
      if (!line) continue;
      out.push({
        source: "human-guidance",
        prompt: line,
        evidence: directive,
        authoritative: true,
      });
    }
  }
  return out;
}

function envelopeSection(body: string, name: string): string | null {
  const open = `<details data-section="${name}">`;
  const lines = body.split("\n");
  const captured: string[] = [];
  let capture = false;
  let found = false;

  for (const line of lines) {
    if (capture) {
      if (/^<\/details>\s*$/.test(line)) break;
      if (/^<summary>.*<\/summary>\s*$/.test(line)) continue;
      captured.push(line);
      continue;
    }
    if (line.includes(open)) {
      capture = true;
      found = true;
    }
  }

  if (!found) return null;
  return captured.join("\n").replace(/^```[^\n]*\n/, "").replace(/\n```\s*$/, "").trim();
}

function latestEnvelopeSignal(comments: readonly HandoffComment[]): DecisionSignal | null {
  for (let i = comments.length - 1; i >= 0; i -= 1) {
    const comment = comments[i]!;
    if (classifyComment({ body: comment.body }) !== "envelope") continue;
    const status = envelopeStatus(comment.body);
    if (status !== "blocked" && status !== "no-sentinel" && status !== "merge-conflict") return null;
    const notes = envelopeSection(comment.body, "notes") ?? envelopeSection(comment.body, "log") ?? "";
    const detail = firstUsefulLine(notes) || `Latest AFK attempt ended with ${status}.`;
    return {
      source: "envelope",
      prompt: `Resolve latest AFK ${status}: ${excerpt(detail, 180)}`,
      evidence: notes || comment.body,
      authoritative: false,
    };
  }
  return null;
}

function discussionSignals(comments: readonly HandoffComment[]): DecisionSignal[] {
  const out: DecisionSignal[] = [];
  for (const comment of comments) {
    if (classifyComment({ body: comment.body } as Comment) !== "discussion") continue;
    if (!/\b(decision|decide|should we|which|choose|human|blocked)\b|\?/.test(comment.body.toLowerCase())) continue;
    const line = firstUsefulLine(comment.body);
    if (!line) continue;
    out.push({
      source: "thread-discussion",
      prompt: line,
      evidence: comment.body,
      authoritative: false,
    });
  }
  return out;
}

function ambiguity(issue: HitlDecisionIssue, reasons: string[], signals: readonly DecisionSignal[]): HitlDecisionExtraction {
  return {
    kind: "ambiguous",
    prompt: `State the pending human decision for #${issue.number}: ${issue.title}`,
    reasons,
    evidence: signals.map((signal) => `${signal.source}: ${excerpt(signal.evidence)}`),
  };
}

function pending(signal: DecisionSignal): HitlDecisionExtraction {
  return {
    kind: "pending-decision",
    source: signal.source,
    prompt: signal.prompt,
    evidence: signal.evidence,
  };
}

/** Extract the decision point for a HITL Issue. The function is conservative:
 * authoritative channels win; multiple non-authoritative hints become an
 * ambiguity instead of a guessed decision. */
export function extractPendingHitlDecision(issue: HitlDecisionIssue): HitlDecisionExtraction {
  const signals: DecisionSignal[] = [];
  const currentBlocker = currentBlockerSignal(issue);
  if (currentBlocker) signals.push(currentBlocker);
  const body = issueBodySignal(issue);
  if (body) signals.push(body);
  const brief = agentBriefSignal(issue);
  if (brief) signals.push(brief);
  const directives = directiveSignals(issue.comments);
  signals.push(...directives);

  if (directives.length > 0) return pending(directives[directives.length - 1]!);
  if (currentBlocker) return pending(currentBlocker);
  if (body) return pending(body);
  if (brief) return pending(brief);

  const envelope = latestEnvelopeSignal(issue.comments);
  if (envelope) signals.push(envelope);
  signals.push(...discussionSignals(issue.comments));

  if (signals.length === 1) return pending(signals[0]!);
  if (signals.length > 1) {
    return ambiguity(issue, ["Multiple non-authoritative decision hints were found."], signals);
  }
  return ambiguity(issue, ["No explicit pending decision was found in the issue body, comments, or latest envelope."], []);
}
