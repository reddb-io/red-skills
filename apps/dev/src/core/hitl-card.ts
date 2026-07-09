// hitl-card — pure logic for actionable decision cards (issue #927).
//
// Renders and updates the "decision card" comment that turns a ready-for-human
// issue into an IssueOps UI: the human posts /approve, /approve-ci, /reject, or
// /requeue (or plain English), and the red-hitl-card Action executes the action.
//
// Injection safety: parseCardCommand only reads the FIRST non-blank line of the
// comment body. The issue body and PR diff are NEVER parsed for commands — they
// appear in the card render only as display data, not as instruction input.

import { renderIssueReference } from "./issue-reference.js";

export const CARD_OPEN = "<!-- red:hitl-card v1 -->";
export const CARD_CLOSE = "<!-- /red:hitl-card -->";
export const CARD_STATUS_OPEN = "<!-- red:hitl-card:status -->";
export const CARD_STATUS_CLOSE = "<!-- /red:hitl-card:status -->";

/** The four human-actionable decisions on a ready-for-human issue. */
export type CardAction = "approve" | "approve-ci" | "reject" | "requeue";

/** A parsed card command extracted from a human comment. */
export interface CardCommand {
  action: CardAction;
  /** For /reject: optional reason; for /requeue: required guidance text. */
  args: string;
}

/** Live PR status used in the card's status section. */
export interface PrStatus {
  /** Linked PR number; undefined when no PR was found. */
  number?: number;
  /** Aggregated CI check result. */
  ci: "pass" | "fail" | "pending" | "none";
  ciPassed: number;
  ciTotal: number;
  /** GitHub mergeability state. */
  mergeability: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  /** Short head commit SHA. */
  headSha?: string;
}

/** Options for rendering the full decision card. */
export interface RenderCardOpts {
  issueNumber: number;
  issueTitle?: string;
  issueUrl?: string;
  pendingDecision: string;
  prStatus: PrStatus;
  /** ISO-8601 or human-readable refresh timestamp shown in the status section. */
  updatedAt: string;
}

function ciEmoji(ci: PrStatus["ci"]): string {
  if (ci === "pass") return "✅";
  if (ci === "fail") return "❌";
  if (ci === "pending") return "⏳";
  return "—";
}

function ciCell(s: PrStatus): string {
  if (s.ci === "none") return "—";
  return `${ciEmoji(s.ci)} ${s.ciPassed}/${s.ciTotal}`;
}

function mergeCell(s: PrStatus): string {
  if (s.mergeability === "MERGEABLE") return "✅ MERGEABLE";
  if (s.mergeability === "CONFLICTING") return "❌ CONFLICTING";
  return "⏳ UNKNOWN";
}

function renderStatusSection(prStatus: PrStatus, updatedAt: string): string {
  const prCell = prStatus.number ? `#${prStatus.number}` : "—";
  const headCell = prStatus.headSha ? `\`${prStatus.headSha}\`` : "—";
  return [
    CARD_STATUS_OPEN,
    "| PR | CI | Mergeability | Head |",
    "|----|----|----|------|",
    `| ${prCell} | ${ciCell(prStatus)} | ${mergeCell(prStatus)} | ${headCell} |`,
    "",
    `_Refreshed: ${updatedAt}_`,
    CARD_STATUS_CLOSE,
  ].join("\n");
}

/** Render the full decision card markdown for posting as an issue comment. */
export function renderCard(opts: RenderCardOpts): string {
  const { issueNumber, issueTitle, issueUrl, pendingDecision, prStatus, updatedAt } = opts;
  const issueRef = renderIssueReference({ number: issueNumber, title: issueTitle, url: issueUrl });
  return [
    CARD_OPEN,
    `## Decision card — ${issueRef}`,
    "",
    `> **Pending decision:** ${pendingDecision}`,
    "",
    "### Status",
    "",
    renderStatusSection(prStatus, updatedAt),
    "",
    "### Available actions",
    "",
    "Post a comment with one of:",
    "",
    "- `/approve` — merge the linked PR and close this issue",
    "- `/approve-ci` — merge when all CI checks pass (waits if pending)",
    "- `/reject [reason]` — close the PR without merging; reopen for rework",
    "- `/requeue <guidance>` — send back to agent with guidance",
    "",
    "**Or reply in plain English** — the bot maps your intent to an action.",
    "Your instructions are processed securely; issue and PR content is treated as untrusted data.",
    CARD_CLOSE,
  ].join("\n");
}

/**
 * Update the status section inside an existing card comment body, leaving all
 * other content unchanged. Idempotent — calling with the same status produces
 * the same output.
 */
export function updateCardStatus(cardBody: string, prStatus: PrStatus, updatedAt: string): string {
  const open = cardBody.indexOf(CARD_STATUS_OPEN);
  const close = cardBody.indexOf(CARD_STATUS_CLOSE);
  if (open === -1 || close === -1 || close < open) return cardBody;
  const before = cardBody.slice(0, open);
  const after = cardBody.slice(close + CARD_STATUS_CLOSE.length);
  return before + renderStatusSection(prStatus, updatedAt) + after;
}

/** True when a comment body is the hitl-card (contains the card open marker). */
export function isHitlCard(body: string): boolean {
  return body.includes(CARD_OPEN);
}

/**
 * Parse a slash-command from a comment body. Only the FIRST non-blank line is
 * examined — this is the injection safety boundary: text in later lines (which
 * might come from quoted issue content) is never interpreted as instructions.
 *
 * Recognised commands:
 *   /approve          → { action: 'approve',    args: '' }
 *   /approve-ci       → { action: 'approve-ci', args: '' }
 *   /reject [reason]  → { action: 'reject',     args: reason }
 *   /requeue <text>   → { action: 'requeue',    args: text }
 *
 * Returns undefined when no recognised command is present on the first line.
 */
export function parseCardCommand(body: string): CardCommand | undefined {
  const firstLine = body
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!firstLine) return undefined;

  const lower = firstLine.toLowerCase();

  // /approve-ci must be checked before /approve (prefix match).
  if (lower.startsWith("/approve-ci")) {
    return { action: "approve-ci", args: firstLine.slice("/approve-ci".length).trim() };
  }
  if (lower.startsWith("/approve")) {
    return { action: "approve", args: firstLine.slice("/approve".length).trim() };
  }
  if (lower.startsWith("/reject")) {
    return { action: "reject", args: firstLine.slice("/reject".length).trim() };
  }
  if (lower.startsWith("/requeue")) {
    return { action: "requeue", args: firstLine.slice("/requeue".length).trim() };
  }
  return undefined;
}

/**
 * Classify a plain-English comment body as a card command via keyword matching.
 * Only called when {@link parseCardCommand} returns undefined (no slash-command).
 * Returns undefined when the intent is ambiguous or unrecognisable.
 *
 * Injection-safe: only the comment body is read, never the issue body or PR diff.
 * When intent is ambiguous (multiple keywords match), the caller should ask for
 * clarification rather than guessing.
 */
export function classifyNaturalLanguage(body: string): CardCommand | undefined {
  const lower = body.toLowerCase();
  const approve = /\b(approve|merge|lgtm|ship\s*it|looks?\s*good|yes\b|go\s*ahead)\b/.test(lower);
  const reject = /\b(reject|close|no\b|cancel|abort|don.t\s+merge|do\s+not\s+merge)\b/.test(lower);
  const requeue = /\b(requeue|try\s+again|another\s+pass|rework|redo|retry|send\s+back)\b/.test(lower);

  const matches = [approve, reject, requeue].filter(Boolean).length;
  if (matches !== 1) return undefined;

  if (requeue) return { action: "requeue", args: body.trim() };
  if (reject) return { action: "reject", args: body.trim() };
  if (approve) return { action: "approve", args: "" };
  return undefined;
}

/**
 * Parse CI check results from the GitHub API's `statusCheckRollup` array into a
 * normalised {@link PrStatus} ci/ciPassed/ciTotal triple.
 *
 * GitHub check conclusions: SUCCESS, NEUTRAL, SKIPPED → pass bucket;
 * FAILURE, ACTION_REQUIRED, CANCELLED, TIMED_OUT → fail bucket;
 * everything else (IN_PROGRESS, QUEUED, WAITING, PENDING, undefined) → pending.
 */
export function parseCiChecks(checks: ReadonlyArray<{ conclusion?: string | null; state?: string | null }>): Pick<PrStatus, "ci" | "ciPassed" | "ciTotal"> {
  if (checks.length === 0) return { ci: "none", ciPassed: 0, ciTotal: 0 };

  const PASS_CONCLUSIONS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
  const FAIL_CONCLUSIONS = new Set(["FAILURE", "ACTION_REQUIRED", "CANCELLED", "TIMED_OUT"]);

  let passed = 0;
  let failed = 0;
  let pending = 0;

  for (const c of checks) {
    const conclusion = (c.conclusion ?? "").toUpperCase();
    if (PASS_CONCLUSIONS.has(conclusion)) passed += 1;
    else if (FAIL_CONCLUSIONS.has(conclusion)) failed += 1;
    else pending += 1;
  }

  const total = checks.length;
  if (failed > 0) return { ci: "fail", ciPassed: passed, ciTotal: total };
  if (pending > 0) return { ci: "pending", ciPassed: passed, ciTotal: total };
  return { ci: "pass", ciPassed: passed, ciTotal: total };
}
