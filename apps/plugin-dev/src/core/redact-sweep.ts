export type RedactionClass = "claude-session" | "host" | "home-path";

export interface RedactSweepConfig {
  hostPatterns: readonly string[];
}

export interface RedactionHit {
  class: RedactionClass;
  value: string;
}

export interface RedactTarget {
  kind: "issue-body" | "issue-comment" | "review-comment";
  repo: string;
  id: number;
  url: string;
  author: string;
  body: string;
}

export interface RedactPlan {
  target: RedactTarget;
  classes: RedactionClass[];
  redactedBody: string;
  preview: string;
}

export interface SkippedRedactTarget {
  target: RedactTarget;
  classes: RedactionClass[];
  reason: "other-author";
}

const CLAUDE_SESSION_RE = /https?:\/\/claude\.ai\/code\/session_[^\s<>"')\]}]+/g;
const HOME_PATH_RE = /\/home\/([A-Za-z0-9._-]+)(?=\/|\b)/g;

function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hostRegexes(patterns: readonly string[]): RegExp[] {
  return unique(patterns.map((pattern) => pattern.trim()).filter(Boolean))
    .map((pattern) => new RegExp(`${escapeRegExp(pattern)}[A-Za-z0-9._-]*`, "g"));
}

export function findRedactionHits(text: string, config: RedactSweepConfig): RedactionHit[] {
  const hits: RedactionHit[] = [];
  for (const match of text.matchAll(CLAUDE_SESSION_RE)) {
    if (match[0]) hits.push({ class: "claude-session", value: match[0] });
  }
  for (const re of hostRegexes(config.hostPatterns)) {
    for (const match of text.matchAll(re)) {
      if (match[0] && !match[0].startsWith("[REDACTED_")) hits.push({ class: "host", value: match[0] });
    }
  }
  for (const match of text.matchAll(HOME_PATH_RE)) {
    if (match[1] !== "[REDACTED_USER]") hits.push({ class: "home-path", value: match[0] });
  }
  return hits;
}

export function redactText(text: string, config: RedactSweepConfig): { text: string; hits: RedactionHit[] } {
  const hits = findRedactionHits(text, config);
  let redacted = text.replace(CLAUDE_SESSION_RE, "[REDACTED_CLAUDE_SESSION]");
  for (const re of hostRegexes(config.hostPatterns)) {
    redacted = redacted.replace(re, "[REDACTED_HOST]");
  }
  redacted = redacted.replace(HOME_PATH_RE, "/home/[REDACTED_USER]");
  return { text: redacted, hits };
}

export function canEditRedactTarget(target: RedactTarget, authenticatedLogin: string): boolean {
  return target.author === authenticatedLogin;
}

export function redactedPreview(text: string, maxLength = 240): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxLength) return singleLine;
  return `${singleLine.slice(0, Math.max(0, maxLength - 3))}...`;
}

export function planRedactTarget(
  target: RedactTarget,
  config: RedactSweepConfig,
): { classes: RedactionClass[]; redactedBody: string; preview: string } | null {
  const redacted = redactText(target.body, config);
  if (redacted.hits.length === 0) return null;
  return {
    classes: unique(redacted.hits.map((hit) => hit.class)),
    redactedBody: redacted.text,
    preview: redactedPreview(redacted.text),
  };
}

export function scanRedactTargets(
  targets: readonly RedactTarget[],
  authenticatedLogin: string,
  config: RedactSweepConfig,
): { editable: RedactPlan[]; skipped: SkippedRedactTarget[]; clean: RedactTarget[] } {
  const editable: RedactPlan[] = [];
  const skipped: SkippedRedactTarget[] = [];
  const clean: RedactTarget[] = [];

  for (const target of targets) {
    const plan = planRedactTarget(target, config);
    if (!plan) {
      clean.push(target);
      continue;
    }
    if (!canEditRedactTarget(target, authenticatedLogin)) {
      skipped.push({ target, classes: plan.classes, reason: "other-author" });
      continue;
    }
    editable.push({ target, ...plan });
  }

  return { editable, skipped, clean };
}
