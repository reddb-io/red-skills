// blocker-state - machine-readable issue-body state for the active HITL/AFK
// blocker. This is the durable handoff between `/afk` and `/hitl`: labels route
// the issue, comments preserve audit history, and this block says what still
// needs to be resolved before an agent can continue.

import { readAnchoredRegion, replaceAnchoredRegion } from "./anchored-edit.js";

export const BLOCKER_HEADING = "Current blocker";
export const RESOLVED_BLOCKERS_HEADING = "Resolved blockers";
export const BLOCKER_OPEN = "<!-- red:blocker-state v1 -->";
export const BLOCKER_CLOSE = "<!-- /red:blocker-state -->";

export interface CurrentBlocker {
  status: "blocked";
  kind: string;
  ref?: string;
  summary: string;
  next: string;
}

export interface ResolvedBlocker {
  summary: string;
  resolution: string;
}

// ---------- self-consistency (#2811) ----------
//
// A blocker whose `summary` refutes its own `kind` is a self-inconsistent
// record, and the tracker had one: `kind: merge-conflict` under a summary
// stating "the true cause is the push, not a merge conflict", with a `next:`
// telling a human to resolve a conflict that does not exist. Correcting the one
// site that wrote it would leave every other site free to write the next one,
// so consistency is enforced HERE, by construction: `makeBlocker` is the only
// supported way to build a `CurrentBlocker`, and it re-derives the kind from
// the evidence in the summary and the next-action from the final kind.

/** A cause the summary text can NAME outright. When a summary names one, that
 * cause — not the kind the call site guessed — is the recorded kind. */
interface BlockerCauseRule {
  kind: string;
  /** Summary evidence that positively identifies this cause. */
  names: RegExp;
  next: string;
}

const BLOCKER_CAUSE_RULES: readonly BlockerCauseRule[] = [
  {
    kind: "push-failed",
    names: /\bpush (?:failed|did not run|was rejected)\b|\bfailed to push\b|the true cause is the push/i,
    next: "Restore push access to the worker branch's remote, then requeue — there is no merge conflict to resolve.",
  },
];

/** Evidence that REFUTES a kind, without naming a replacement. A summary that
 * denies its own kind loses the kind rather than keeping a contradiction. */
const BLOCKER_KIND_REFUTED_BY: Readonly<Record<string, RegExp>> = {
  "merge-conflict": /\bnot a merge conflict\b|\bmerges cleanly\b|\bno merge conflict\b/i,
};

/** The next-action each kind licenses. A `next:` is only ever as good as the
 * cause it is derived from, so it is derived from the cause — never written
 * beside it. Kinds absent here keep the call site's own next-action. */
const BLOCKER_NEXT_BY_KIND: Readonly<Record<string, string>> = {
  "push-failed": BLOCKER_CAUSE_RULES[0]!.next,
  unclassified: "Read the summary and classify the real cause before choosing a recovery route.",
};

/** The kind the summary's own evidence supports, given the kind a call site
 * proposed. Returns the proposal unchanged when nothing contradicts it. */
export function reconcileBlockerKind(proposedKind: string, summary: string): string {
  const named = BLOCKER_CAUSE_RULES.find((rule) => rule.names.test(summary));
  if (named && named.kind !== proposedKind) return named.kind;
  if (BLOCKER_KIND_REFUTED_BY[proposedKind]?.test(summary)) return "unclassified";
  return proposedKind;
}

/** True when the summary refutes the kind, or the next-action prescribes work
 * the kind does not license. The invariant `makeBlocker` guarantees. */
export function blockerIsSelfConsistent(blocker: CurrentBlocker): boolean {
  if (reconcileBlockerKind(blocker.kind, blocker.summary) !== blocker.kind) return false;
  const required = BLOCKER_NEXT_BY_KIND[blocker.kind];
  if (required !== undefined && blocker.next !== required) return false;
  // A next-action may never send anyone after a conflict on a non-conflict kind.
  return blocker.kind === "merge-conflict" || !/resolve the merge conflict/i.test(blocker.next);
}

/**
 * Build a `CurrentBlocker` that cannot contradict itself: the kind is
 * reconciled against the summary's evidence, and the next-action is re-derived
 * from the reconciled kind whenever that kind prescribes one.
 */
export function makeBlocker(fields: {
  kind: string;
  summary: string;
  next: string;
  ref?: string;
}): CurrentBlocker {
  const kind = reconcileBlockerKind(fields.kind, fields.summary);
  let next = BLOCKER_NEXT_BY_KIND[kind] ?? fields.next;
  if (kind !== "merge-conflict" && /resolve the merge conflict/i.test(next)) {
    next = BLOCKER_NEXT_BY_KIND[kind] ?? BLOCKER_NEXT_BY_KIND.unclassified!;
  }
  return {
    status: "blocked",
    kind,
    ...(fields.ref !== undefined ? { ref: fields.ref } : {}),
    summary: fields.summary,
    next,
  };
}

function normalizeLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function firstLine(value: string): string {
  return normalizeLine(value.split("\n").find((line) => normalizeLine(line).length > 0) ?? "");
}

function safeField(value: string | undefined, fallback = ""): string {
  const line = normalizeLine(value ?? "");
  return line.length > 0 ? line : fallback;
}

function parseFields(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of block.split("\n")) {
    const m = /^([a-z_]+):\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    out[m[1]!] = m[2]!.trim();
  }
  return out;
}

export function parseCurrentBlocker(markdown: string): CurrentBlocker | null {
  const inner = readAnchoredRegion(markdown, BLOCKER_OPEN, BLOCKER_CLOSE);
  if (inner === null) return null;
  const fields = parseFields(inner);
  if (fields.status !== "blocked") return null;
  const summary = safeField(fields.summary);
  const next = safeField(fields.next);
  if (!summary || !next) return null;
  return {
    status: "blocked",
    kind: safeField(fields.kind, "unknown"),
    ...(fields.ref ? { ref: safeField(fields.ref) } : {}),
    summary,
    next,
  };
}

/** The field block that sits between the anchors (exclusive of the anchors). */
function formatBlockerFields(blocker: CurrentBlocker): string {
  const lines = [
    `status: ${blocker.status}`,
    `kind: ${safeField(blocker.kind, "unknown")}`,
  ];
  if (blocker.ref) lines.push(`ref: ${safeField(blocker.ref)}`);
  lines.push(`summary: ${safeField(blocker.summary, "Unspecified blocker.")}`);
  lines.push(`next: ${safeField(blocker.next, "Human guidance required.")}`);
  return `\n${lines.join("\n")}\n`;
}

export function formatCurrentBlocker(blocker: CurrentBlocker): string {
  return `${BLOCKER_OPEN}${formatBlockerFields(blocker)}${BLOCKER_CLOSE}`;
}

function currentBlockerSectionRange(markdown: string): { start: number; end: number } | null {
  const lines = markdown.split("\n");
  let offset = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (new RegExp(`^##\\s+${BLOCKER_HEADING}\\s*$`, "i").test(line.trim())) {
      const start = offset;
      let end = markdown.length;
      let innerOffset = offset + line.length + 1;
      for (let j = i + 1; j < lines.length; j += 1) {
        const next = lines[j]!;
        if (/^##\s+/.test(next)) {
          end = innerOffset;
          break;
        }
        innerOffset += next.length + 1;
      }
      return { start, end };
    }
    offset += line.length + 1;
  }
  return null;
}

export function upsertCurrentBlocker(markdown: string, blocker: CurrentBlocker): string {
  // Fast path: when the state anchors already exist, edit only the field block
  // between them and leave every other byte (heading, surrounding sections,
  // trailing whitespace) untouched. This avoids regenerating the whole section.
  const anchored = replaceAnchoredRegion(
    markdown,
    BLOCKER_OPEN,
    BLOCKER_CLOSE,
    formatBlockerFields(blocker),
  );
  if (anchored !== null) return anchored;

  const replacement = `## ${BLOCKER_HEADING}\n\n${formatCurrentBlocker(blocker)}\n`;
  const range = currentBlockerSectionRange(markdown);
  if (range) {
    return `${markdown.slice(0, range.start)}${replacement}\n${markdown.slice(range.end).trimStart()}`.trimEnd() + "\n";
  }
  const prefix = markdown.trimEnd();
  return `${prefix}${prefix.length > 0 ? "\n\n" : ""}${replacement}`;
}

export interface CurrentBlockerEditResult {
  /** The body after the surgical edit (unchanged if already correct). */
  body: string;
  /** True when the body differs from the input — a no-op is signaled by false. */
  changed: boolean;
  /** True when parsing the result body yields the expected blocker state (round-trip integrity). */
  valid: boolean;
}

/**
 * Byte-exact round-trip edit: compute the new body surgically, detect whether it
 * changed, and confirm the parse-back yields the intended blocker state. Callers
 * can skip the remote write when `changed` is false and trust the edit was
 * correctly formed when `valid` is true.
 */
export function applyCurrentBlockerEdit(markdown: string, blocker: CurrentBlocker): CurrentBlockerEditResult {
  const body = upsertCurrentBlocker(markdown, blocker);
  const changed = body !== markdown;
  const parsed = parseCurrentBlocker(body);
  const valid =
    parsed !== null &&
    parsed.status === blocker.status &&
    parsed.kind === blocker.kind &&
    parsed.summary === blocker.summary &&
    parsed.next === blocker.next &&
    parsed.ref === blocker.ref;
  return { body, changed, valid };
}

function appendResolvedBlocker(markdown: string, resolved: ResolvedBlocker): string {
  const entry = `- [x] ${safeField(resolved.summary, "Resolved blocker.")} - ${safeField(
    firstLine(resolved.resolution),
    "resolved",
  )}`;
  const lines = markdown.split("\n");
  const headingRe = new RegExp(`^##\\s+${RESOLVED_BLOCKERS_HEADING}\\s*$`, "i");
  const idx = lines.findIndex((line) => headingRe.test(line.trim()));
  if (idx === -1) {
    const prefix = markdown.trimEnd();
    return `${prefix}${prefix.length > 0 ? "\n\n" : ""}## ${RESOLVED_BLOCKERS_HEADING}\n\n${entry}\n`;
  }
  const existing = lines.slice(idx + 1).filter((line, i) => i !== 0 || line.trim() !== "");
  const next = [...lines.slice(0, idx + 1), "", entry, ...existing];
  return `${next.join("\n").trimEnd()}\n`;
}

export function clearCurrentBlocker(markdown: string, resolved?: ResolvedBlocker): string {
  const active = parseCurrentBlocker(markdown);
  const replacement = `## ${BLOCKER_HEADING}\n\nNone\n`;
  const range = currentBlockerSectionRange(markdown);
  let next = markdown;
  if (range) {
    next = `${markdown.slice(0, range.start)}${replacement}\n${markdown.slice(range.end).trimStart()}`.trimEnd() + "\n";
  } else {
    const start = markdown.indexOf(BLOCKER_OPEN);
    const end = start === -1 ? -1 : markdown.indexOf(BLOCKER_CLOSE, start + BLOCKER_OPEN.length);
    if (start !== -1 && end !== -1) {
      next = `${markdown.slice(0, start)}${markdown.slice(end + BLOCKER_CLOSE.length)}`.trimEnd() + "\n";
    }
  }
  if (!resolved || !active) return next;
  return appendResolvedBlocker(next, resolved);
}
