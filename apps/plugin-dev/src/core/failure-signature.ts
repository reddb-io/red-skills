// failure-signature — the stable dedupe key for a Re-seed round (issue #2724,
// Spec #2723, ADR 0129).
//
// A Re-seed re-instructs the implementer in place after a gate stage blocked
// the work. Two things need to know whether round N failed the same way as
// round N-1: the dedupe rule (do not spend a round repeating a round) and the
// tier-escalation trigger (a repeated signature buys a different model tier
// rather than the same tier again). Both consume ONE key, derived here.
//
// The key is a SET identity, not a transcript identity. It is order-independent
// over the failing check names, the named test identities inside their
// summaries, and the review findings, because the same failures reported in a
// different order are the same failure. It deliberately excludes everything
// volatile — durations, exit codes, the captured output tail — so a rerun of an
// unchanged branch keys the same, while it includes everything identifying, so
// a subset of the previous failures is NOT a repeat and gets its own round.
//
// IO-free and total: every input is data the caller already observed, malformed
// sidecar lines are skipped rather than thrown on, and degenerate input yields
// {@link EMPTY_FAILURE_SIGNATURE} instead of an exception.

import { createHash } from "node:crypto";

import { VALIDATION_SCHEMA, type ValidationRecord } from "./feedback.js";

/**
 * One review finding as the signature sees it. Structurally the intersection of
 * `InlineComment` (review.ts) and `AdversarialReviewFinding`
 * (adversarial-review.ts), so either shape passes without adaptation. Every
 * field is optional because a signature must never be the thing that throws.
 */
export interface FailureSignatureFinding {
  /** Repo-relative path the finding is anchored to. */
  readonly path?: string;
  /** 1-indexed line the finding is anchored to. */
  readonly line?: number;
  /** The finding text. Whitespace-normalised and capped before it enters the key. */
  readonly body?: string;
  /** True when the finding blocks the round. Absent reads as advisory. */
  readonly blocking?: boolean;
}

/** Everything one Re-seed round observed that could define a failure. */
export interface FailureSignatureInput {
  /** Raw `red.afk.validation.v1` sidecar lines, exactly as the gate emitted them. */
  readonly sidecar?: readonly string[];
  /** The round's review findings, blocking and advisory alike. */
  readonly findings?: readonly FailureSignatureFinding[];
}

/**
 * The key for a round with nothing failing. A stable sentinel rather than an
 * empty string, so a caller comparing two clean rounds gets a meaningful equal
 * and a caller logging the key never prints nothing at all.
 */
export const EMPTY_FAILURE_SIGNATURE = "v1:none";

/** Key version prefix — bump when the term vocabulary changes meaning. */
const SIGNATURE_VERSION = "v1";

/** Hex digits of the digest kept. 16 is collision-safe for a per-Worker ledger
 * and short enough to read in a log line. */
const DIGEST_LENGTH = 16;

/** Cap on one finding body inside the key. A finding is identified by its
 * location and its opening claim; a long tail adds churn, not identity. */
const MAX_BODY_CHARS = 240;

/** The `outputSummary` identity prefix: `failing: a | b — <tail>`. Only the part
 * before the em-dash names checks; the tail is volatile and dropped. */
const NAMED_FAILURE_PREFIX = /^failing:\s*(.*?)(?:\s+—\s|$)/;

/** Collapse all whitespace runs to single spaces and trim. */
function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** Parse one sidecar line into a record, or `undefined` when it is blank,
 * malformed, not an object, or not a `red.afk.validation.v1` record. */
function parseRecord(raw: string): ValidationRecord | undefined {
  if (normalizeWhitespace(raw) === "") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const record = parsed as Partial<ValidationRecord>;
  if (record.schema !== VALIDATION_SCHEMA) return undefined;
  if (typeof record.name !== "string" || record.name === "") return undefined;
  return record as ValidationRecord;
}

/** The named check identities inside a failing check's summary, if it carries
 * the `failing: …` prefix. Returns `[]` for a summary that only holds a tail. */
function namedTestIdentities(summary: string | undefined): string[] {
  if (typeof summary !== "string") return [];
  const match = NAMED_FAILURE_PREFIX.exec(normalizeWhitespace(summary));
  if (!match) return [];
  return match[1]
    .split("|")
    .map((identity) => normalizeWhitespace(identity))
    .filter((identity) => identity !== "");
}

/** The key term for one review finding. */
function findingTerm(finding: FailureSignatureFinding): string {
  const kind = finding.blocking === true ? "blocking" : "advisory";
  const path = typeof finding.path === "string" ? normalizeWhitespace(finding.path) : "";
  const line = typeof finding.line === "number" && Number.isFinite(finding.line) ? String(finding.line) : "";
  const body = typeof finding.body === "string" ? normalizeWhitespace(finding.body).slice(0, MAX_BODY_CHARS) : "";
  return `review:${kind}:${path}:${line}:${body}`;
}

/**
 * The canonical, deduped, sorted terms behind {@link failureSignature}. Exported
 * because a term list is what a human debugging a dedupe decision actually wants
 * to read — the digest tells you two rounds differ, the terms tell you how.
 *
 * Three term families:
 * - `check:<name>` — one failing validation check (`test:root`, `lint:apps/plugin-dev`).
 * - `test:<identity>` — one named failure inside a failing check's summary.
 * - `review:<blocking|advisory>:<path>:<line>:<body>` — one review finding.
 */
export function failureSignatureTerms(input: FailureSignatureInput): string[] {
  const terms = new Set<string>();

  for (const raw of input.sidecar ?? []) {
    const record = parseRecord(raw);
    if (!record || record.status !== "failed") continue;
    terms.add(`check:${normalizeWhitespace(record.name)}`);
    for (const identity of namedTestIdentities(record.summary)) {
      terms.add(`test:${identity}`);
    }
  }

  for (const finding of input.findings ?? []) {
    if (finding === null || typeof finding !== "object") continue;
    terms.add(findingTerm(finding));
  }

  return [...terms].sort();
}

/**
 * The stable failure signature for one Re-seed round: `v1:<16 hex digits>`, or
 * {@link EMPTY_FAILURE_SIGNATURE} when nothing failed. Equal keys mean the round
 * failed the same way; unequal keys mean the failure set moved, including when
 * it merely shrank.
 */
export function failureSignature(input: FailureSignatureInput): string {
  const terms = failureSignatureTerms(input);
  if (terms.length === 0) return EMPTY_FAILURE_SIGNATURE;
  const digest = createHash("sha256").update(terms.join("\n")).digest("hex");
  return `${SIGNATURE_VERSION}:${digest.slice(0, DIGEST_LENGTH)}`;
}

/** Stable terminal-marker vocabulary used to compare validation infra across Workers. */
export const VALIDATION_FAILURE_SIGNATURE_MARKER = "validation-signature:";

/** Compose the compact failure reason persisted for the next AFK claim. */
export function validationFailureMarker(outcome: string, signature: string): string {
  return `${outcome} ${VALIDATION_FAILURE_SIGNATURE_MARKER}${signature}`;
}

/** Read a carried v1 validation signature without interpreting surrounding text. */
export function parseValidationFailureSignature(text: string | undefined): string | undefined {
  if (!text) return undefined;
  return /\bvalidation-signature:(v1:[0-9a-f]{16})\b/.exec(text)?.[1];
}
