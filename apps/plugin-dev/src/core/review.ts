// core/review.ts — the advisory cloud PR-review engine (PRD #745, issue #746).
//
// The tracer-bullet spine: a maintainer applies `ready-for-review` to a PR, a
// thin workflow invokes `dev review --pr N`, and this module owns all logic —
// fetch the PR, run the (vendored sandcastle) review engine through an injected
// extraction seam, post inline comments + a summary back, and transition the PR
// through the EXISTING issue-lifecycle labels (`running` / `ready-for-human` /
// `blocked:*`). PRs are a first-class object type that REUSES that vocabulary;
// no bespoke PR labels are minted (see .red/agents/triage-labels.md).
//
// The review is ADVISORY: it never pushes code and the workflow requests no
// `contents: write`. Every side effect is an injected port (`ReviewGh`) so the
// subcommand seam is exercised with a fake `gh` and a stubbed extraction (prior
// art: process-issue.test.ts). The pure mapping (verdict → label transition,
// diff-line filtering, retry-budget resolution) is unit-testable here.

import {
  LABEL_READY_FOR_REVIEW,
  LABEL_RUNNING,
  LABEL_HUMAN,
  LABEL_VALIDATION,
} from "./triage-labels.js";
import type { AgentRunner } from "./execution.js";
import type { SourceTrustLevel } from "./source-trust.js";

/**
 * The minimal subset of the Standard Schema v1 interface that sandcastle's
 * `Output.object({ schema })` requires. Declared structurally here rather than
 * importing `@standard-schema/spec` (a transitive red-castle dep that is not a
 * direct dependency of this app); the shape is assignment-compatible with the
 * real `StandardSchemaV1` so it passes through `Output.object` unchanged.
 */
export interface StandardSchemaLike<Output> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown,
    ) =>
      | { readonly value: Output; readonly issues?: undefined }
      | { readonly issues: ReadonlyArray<{ readonly message: string }> };
  };
}

// ---------------------------------------------------------------------------
// Findings shape (mirrors the vendored review-output.ts ReviewOutput, plus a
// `blocking` flag so the advisory pass can route to the existing blocked:* /
// ready-for-human labels).
// ---------------------------------------------------------------------------

export interface InlineComment {
  readonly path: string;
  readonly line: number;
  readonly body: string;
  readonly blocking?: boolean;
}

export interface ReviewFindings {
  readonly summary: string;
  readonly inlineComments: InlineComment[];
  /** True when the review found blocking problems (→ blocked:* + ready-for-human). */
  readonly blocking: boolean;
}

/** The gate review's structured output. Appraisal rides the existing reviewer
 * pass, while the standalone PR-review flow keeps its original contract. */
export interface ScoredReviewFindings extends ReviewFindings {
  readonly score: number;
}

export interface PrContext {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  /** Source-trust level of the PR author. PR title/body stay untrusted payload
   * even when this is `trusted`; the value is audit metadata for prompt framing. */
  readonly sourceTrust?: SourceTrustLevel;
  /** Unified `git diff` of the PR against its base, for diff-line filtering. */
  readonly diff: string;
}

// ---------------------------------------------------------------------------
// Injected ports
// ---------------------------------------------------------------------------

/**
 * The `gh` write-back surface the review needs. Every method is a side effect
 * routed through our own `gh` runtime in production and a recording fake in
 * tests. Note: it carries NO push / merge primitive — the advisory review never
 * mutates code, and the event-router workflow requests no `contents: write`.
 */
export interface ReviewGh {
  /** Read PR title/body + the unified diff against base. */
  fetchPr(pr: number): Promise<PrContext>;
  /** Post a single review: a summary body + path+line inline comments. */
  postReview(pr: number, payload: { summary: string; comments: InlineComment[] }): Promise<void>;
  /** Top-level PR comment (used by the degraded advisory path). */
  comment(pr: number, body: string): Promise<void>;
  /** Idempotently create a label so a missing typed label never fails the run. */
  ensureLabel(name: string): Promise<void>;
  /** `gh pr edit --remove-label … --add-label …`. */
  editLabels(pr: number, remove: string[], add: string[]): Promise<boolean>;
}

export interface ReviewDeps {
  readonly gh: ReviewGh;
  /**
   * Extraction seam: run the review engine for `context` under `runner` and
   * return structured findings. Throws when extraction/validation could not be
   * recovered (e.g. a non-resumable provider exhausted its single attempt). The
   * real implementation drives sandcastle `run()` with `Output.object` +
   * `maxRetries`; tests stub it.
   */
  extractReview(context: PrContext, runner: AgentRunner): Promise<ReviewFindings>;
  log?: (message: string) => void;
}

export interface ReviewInput {
  readonly pr: number;
  readonly runner: AgentRunner;
}

export type ReviewVerdict = "clean" | "blocking" | "needs-human";

export interface ReviewResult {
  readonly verdict: ReviewVerdict;
  readonly postedComments: number;
  /** Whether a review/summary was posted back to the PR. */
  readonly posted: boolean;
}

export const REVIEW_EXTRACTION_FAILED_BODY =
  "🤖 Automated review could not extract structured findings " +
  "(the provider produced no valid review payload). Routing to a human reviewer.";

// ---------------------------------------------------------------------------
// Retry-budget resolution (sandcastle 0.11.0 structured-output `maxRetries`).
// ---------------------------------------------------------------------------

/**
 * Providers whose sessions sandcastle can resume — the precondition for
 * `Output.object({ maxRetries })` re-prompting the same session. Of the AFK
 * runner union (`claude | codex | opencode`), only claude and codex are
 * resumable (sandcastle also lists `pi`, which AFK does not drive). Under the
 * OpenCode/MiniMax lane `maxRetries` is a no-op, so it must resolve to 0 — and
 * the advisory path must still work without it.
 */
const RESUMABLE_RUNNERS: readonly AgentRunner[] = ["claude", "codex"];

/**
 * The structured-output retry budget for `runner`. Resumable providers get
 * `requested` (default 2 ≥ the required minimum); non-resumable providers get 0
 * because `run()` rejects `maxRetries > 0` against them at entry.
 */
export function resolveMaxRetries(runner: AgentRunner, requested = 2): number {
  return RESUMABLE_RUNNERS.includes(runner) ? requested : 0;
}

// ---------------------------------------------------------------------------
// Diff-line parsing + inline-comment filtering (ported from the vendored
// sandcastle review engine: shared/diff-lines.ts + shared/review-output.ts).
// ---------------------------------------------------------------------------

/** Map of changed file → set of line numbers present on the new (RIGHT) side. */
export function parseDiffLines(diff: string): Map<string, Set<number>> {
  const files = new Map<string, Set<number>>();
  let currentFile: string | undefined;
  let newLine = 0;

  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ b/")) {
      currentFile = line.slice("+++ b/".length);
      if (!files.has(currentFile)) files.set(currentFile, new Set());
      continue;
    }
    if (!currentFile) continue;

    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      files.get(currentFile)?.add(newLine);
      newLine++;
      continue;
    }
    if (line.startsWith(" ") || line === "") {
      files.get(currentFile)?.add(newLine);
      newLine++;
    }
  }
  return files;
}

/** Drop inline comments whose path/line is not in the PR's diff hunks. */
export function filterInlineComments(
  comments: readonly InlineComment[],
  diffLines: Map<string, Set<number>>,
  warn: (message: string) => void = () => {},
): InlineComment[] {
  return comments.filter((comment) => {
    const fileLines = diffLines.get(comment.path);
    if (!fileLines) {
      warn(`Dropping inline comment for ${comment.path}:${comment.line}; file is not in the diff.`);
      return false;
    }
    if (!fileLines.has(comment.line)) {
      warn(`Dropping inline comment for ${comment.path}:${comment.line}; line is not in the diff hunks.`);
      return false;
    }
    return true;
  });
}

// ---------------------------------------------------------------------------
// Structured-output schema (StandardSchemaV1) for `Output.object`. A local
// adapter (mirrors the vendored shared/common.ts `standardSchema`) avoids
// depending on a zod version that ships the Standard Schema interface.
// ---------------------------------------------------------------------------

function standardSchema<T>(validate: (value: unknown) => T): StandardSchemaLike<T> {
  return {
    "~standard": {
      version: 1,
      vendor: "red-dev-review",
      validate: (value: unknown) => {
        try {
          return { value: validate(value) };
        } catch (error) {
          return {
            issues: [{ message: error instanceof Error ? error.message : "Validation failed" }],
          };
        }
      },
    },
  };
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function parseInlineComment(value: unknown): InlineComment {
  const record = asRecord(value, "inline comment");
  const rawLine = record.line;
  if (typeof rawLine !== "number" || !Number.isInteger(rawLine) || rawLine <= 0) {
    throw new Error("inline comment line must be a positive integer");
  }
  return {
    path: asString(record.path ?? record.file, "inline comment path"),
    line: rawLine,
    body: asString(record.body ?? record.comment, "inline comment body"),
    blocking: record.blocking === true,
  };
}

function parseReviewFindings(value: unknown): ReviewFindings {
  const record = asRecord(value, "review output");
  const rawComments = record.inlineComments ?? [];
  if (!Array.isArray(rawComments)) throw new Error("inlineComments must be an array");
  return {
    summary: asString(record.summary, "summary"),
    inlineComments: rawComments.map(parseInlineComment),
    blocking: record.blocking === true,
  };
}

/** Standard Schema validator for {@link ReviewFindings}, used by `Output.object`. */
export const reviewFindingsSchema = standardSchema<ReviewFindings>(parseReviewFindings);

/** Standard Schema validator for the gate review, whose Appraisal score is
 * required so malformed output enters structured-output retry. */
export const scoredReviewFindingsSchema = standardSchema<ScoredReviewFindings>((value) => {
  const record = asRecord(value, "review output");
  const score = record.score;
  if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 1) {
    throw new Error("score must be a number from 0 to 1");
  }
  return { ...parseReviewFindings(record), score };
});

// ---------------------------------------------------------------------------
// The advisory review run.
// ---------------------------------------------------------------------------

/**
 * Run the advisory review for one PR. Reuses the issue-lifecycle labels:
 *  - on entry: drop `ready-for-review`, add `running` (review in flight);
 *  - clean pass: drop `running` (PR transitions out of review);
 *  - blocking findings: `running` → `blocked:validation` + `ready-for-human`;
 *  - extraction failure (advisory degrade): `running` → `ready-for-human`.
 *
 * Never pushes code; the only writes are the review comment(s) and label edits.
 */
export async function runReview(deps: ReviewDeps, input: ReviewInput): Promise<ReviewResult> {
  const { gh } = deps;
  const log = deps.log ?? (() => {});
  const { pr } = input;

  const context = await gh.fetchPr(pr);

  // Mark the PR as actively under review, reusing the `running` lifecycle label.
  await gh.editLabels(pr, [LABEL_READY_FOR_REVIEW], [LABEL_RUNNING]);

  let findings: ReviewFindings | null = null;
  try {
    findings = await deps.extractReview(context, input.runner);
  } catch (error) {
    log(`[review] extraction failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!findings) {
    // Advisory degrade: no structured findings (e.g. a non-resumable provider
    // exhausted its single attempt). Route to a human rather than abort.
    await gh.comment(pr, REVIEW_EXTRACTION_FAILED_BODY);
    await gh.ensureLabel(LABEL_HUMAN);
    await gh.editLabels(pr, [LABEL_RUNNING], [LABEL_HUMAN]);
    return { verdict: "needs-human", postedComments: 0, posted: true };
  }

  const diffLines = parseDiffLines(context.diff);
  const validComments = filterInlineComments(findings.inlineComments, diffLines, log);

  await gh.postReview(pr, { summary: findings.summary, comments: validComments });

  if (findings.blocking) {
    // Reuse the existing blocked:* / ready-for-human vocabulary — no bespoke labels.
    await gh.ensureLabel(LABEL_VALIDATION);
    await gh.ensureLabel(LABEL_HUMAN);
    await gh.editLabels(pr, [LABEL_RUNNING], [LABEL_VALIDATION, LABEL_HUMAN]);
    return { verdict: "blocking", postedComments: validComments.length, posted: true };
  }

  // Clean pass: transition the PR out of review (drop the `running` marker).
  await gh.editLabels(pr, [LABEL_RUNNING], []);
  return { verdict: "clean", postedComments: validComments.length, posted: true };
}
