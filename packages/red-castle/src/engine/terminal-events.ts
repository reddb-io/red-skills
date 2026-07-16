import type {
  CastleAttemptStatus,
  CastleEnvelope,
  CastleEnvelopeSection,
  CastleHitlCard,
  CastleHitlCardAction,
  CastleHitlCardPrStatus,
} from "./contracts/index.js";
import type { TrackerIssueReference, TrackerPort } from "./tracker/port.js";

export type AttemptStatus = CastleAttemptStatus;
export type EnvelopeInput = CastleEnvelope;
export type EnvelopeSection = CastleEnvelopeSection;

export type CardAction = CastleHitlCardAction;
export type PrStatus = CastleHitlCardPrStatus;
export type RenderCardOpts = CastleHitlCard;

export interface CardCommand {
  action: CardAction;
  /** For /reject: optional reason; for /requeue: required guidance text. */
  args: string;
}

export const CARD_OPEN = "<!-- red:hitl-card v1 -->";
export const CARD_CLOSE = "<!-- /red:hitl-card -->";
export const CARD_STATUS_OPEN = "<!-- red:hitl-card:status -->";
export const CARD_STATUS_CLOSE = "<!-- /red:hitl-card:status -->";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeMarkdownLinkText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\]/g, "\\]");
}

function escapeMarkdownUrl(value: string): string {
  return value.replace(/\)/g, "%29");
}

export function renderIssueReference(ref: TrackerIssueReference): string {
  const title = ref.title?.trim();
  const url = ref.url?.trim();
  if (!title || !url) return `#${ref.number}`;
  return `[${escapeMarkdownLinkText(title)} (#${ref.number})](${escapeMarkdownUrl(url)})`;
}

export function buildEnvelope(input: EnvelopeInput): string {
  const merge = input.mergeSha ? ` · merge: ${input.mergeSha}` : "";
  const summary = `worker \`${input.worker}\` · status: ${input.status} · duration: ${input.duration} · diff: ${input.diff} · attempt: ${input.attempt}${merge}`;
  const body = (input.sections ?? [])
    .map((section) => {
      const fence = section.fenced ? `\`\`\`${section.fenceLang ?? ""}` : "";
      const content = section.fenced
        ? `\n${fence}\n${section.body}\n\`\`\`\n`
        : `\n${section.body}\n`;
      return `<details data-section="${escapeHtml(section.name)}"><summary>${escapeHtml(section.name)}</summary>\n${content}\n</details>`;
    })
    .join("\n\n");
  return `<details data-attempt-status="${input.status}"><summary>${summary}</summary>\n\n${body}\n\n</details>\n`;
}

export async function postEnvelope(
  tracker: Pick<TrackerPort, "commentOnIssue">,
  issue: number,
  input: EnvelopeInput,
): Promise<string> {
  const body = buildEnvelope(input);
  await tracker.commentOnIssue(issue, body);
  return body;
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

export function renderCard(opts: RenderCardOpts): string {
  const {
    issueNumber,
    issueTitle,
    issueUrl,
    pendingDecision,
    prStatus,
    updatedAt,
  } = opts;
  const issueRef = renderIssueReference({
    number: issueNumber,
    title: issueTitle,
    url: issueUrl,
  });
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

export async function postHitlCard(
  tracker: Pick<TrackerPort, "commentOnIssue">,
  issue: number,
  input: RenderCardOpts,
): Promise<string> {
  const body = renderCard(input);
  await tracker.commentOnIssue(issue, body);
  return body;
}

export function updateCardStatus(
  cardBody: string,
  prStatus: PrStatus,
  updatedAt: string,
): string {
  const open = cardBody.indexOf(CARD_STATUS_OPEN);
  const close = cardBody.indexOf(CARD_STATUS_CLOSE);
  if (open === -1 || close === -1 || close < open) return cardBody;
  const before = cardBody.slice(0, open);
  const after = cardBody.slice(close + CARD_STATUS_CLOSE.length);
  return before + renderStatusSection(prStatus, updatedAt) + after;
}

export function isHitlCard(body: string): boolean {
  return body.includes(CARD_OPEN);
}

export function parseCardCommand(body: string): CardCommand | undefined {
  const firstLine = body
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) return undefined;

  const lower = firstLine.toLowerCase();

  if (lower.startsWith("/approve-ci")) {
    return {
      action: "approve-ci",
      args: firstLine.slice("/approve-ci".length).trim(),
    };
  }
  if (lower.startsWith("/approve")) {
    return {
      action: "approve",
      args: firstLine.slice("/approve".length).trim(),
    };
  }
  if (lower.startsWith("/reject")) {
    return {
      action: "reject",
      args: firstLine.slice("/reject".length).trim(),
    };
  }
  if (lower.startsWith("/requeue")) {
    return {
      action: "requeue",
      args: firstLine.slice("/requeue".length).trim(),
    };
  }
  return undefined;
}

export function classifyNaturalLanguage(body: string): CardCommand | undefined {
  const lower = body.toLowerCase();
  const approve =
    /\b(approve|merge|lgtm|ship\s*it|looks?\s*good|yes\b|go\s*ahead)\b/.test(
      lower,
    );
  const reject =
    /\b(reject|close|no\b|cancel|abort|don.t\s+merge|do\s+not\s+merge)\b/.test(
      lower,
    );
  const requeue =
    /\b(requeue|try\s+again|another\s+pass|rework|redo|retry|send\s+back)\b/.test(
      lower,
    );

  const matches = [approve, reject, requeue].filter(Boolean).length;
  if (matches !== 1) return undefined;

  if (requeue) return { action: "requeue", args: body.trim() };
  if (reject) return { action: "reject", args: body.trim() };
  if (approve) return { action: "approve", args: "" };
  return undefined;
}

export function parseCiChecks(
  checks: ReadonlyArray<{ conclusion?: string | null; state?: string | null }>,
): Pick<PrStatus, "ci" | "ciPassed" | "ciTotal"> {
  if (checks.length === 0) return { ci: "none", ciPassed: 0, ciTotal: 0 };

  const passConclusions = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
  const failConclusions = new Set([
    "FAILURE",
    "ACTION_REQUIRED",
    "CANCELLED",
    "TIMED_OUT",
  ]);

  let passed = 0;
  let failed = 0;
  let pending = 0;

  for (const check of checks) {
    const conclusion = (check.conclusion ?? "").toUpperCase();
    if (passConclusions.has(conclusion)) passed += 1;
    else if (failConclusions.has(conclusion)) failed += 1;
    else pending += 1;
  }

  const total = checks.length;
  if (failed > 0) return { ci: "fail", ciPassed: passed, ciTotal: total };
  if (pending > 0) return { ci: "pending", ciPassed: passed, ciTotal: total };
  return { ci: "pass", ciPassed: passed, ciTotal: total };
}
