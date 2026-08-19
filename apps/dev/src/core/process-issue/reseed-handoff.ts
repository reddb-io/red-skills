// reseed-handoff — the re-seeded prompt carries CURRENT OUTSTANDING STATE, not a
// log of rounds (ADR 0129 decision 7, Spec #2723, issue #2728).
//
// Earlier rounds are not independent facts; they are stale versions of the same
// state. So one section carries what is outstanding RIGHT NOW — the current gate
// tail and the current review findings TOGETHER, deduped — plus one history line
// (round n/N, current tier, repeat count) standing in for the narrative.
//
// This replaces three appenders that each rebuilt from the ORIGINAL handoff and
// therefore discarded every previous correction block: a gate round that
// followed a blocking review re-instructed the implementer with the gate tail
// alone, leaving round N blind to the findings rounds 1..N-1 already confirmed.
// Composing from the original handoff is the right move — it is what keeps the
// prompt bounded as rounds accumulate — but only once the state it carries
// survives across rounds instead of being rebuilt from the last trigger.

import { EMPTY_FAILURE_SIGNATURE } from "../failure-signature.js";
import type { SpinPattern } from "@reddb-io/worker/engine";
import type { ReseedBudget, ReseedSpend, ReseedTrigger } from "./reseed-budget.js";

/** The section tag naming WHAT ASKED for this round. The outstanding state
 * inside it is identical whichever one wraps it; the tag exists so a reader (and
 * the trigger's own directives) can tell which stage blocked. */
export type ReseedSectionTag =
  | "afk-gate-correction"
  | "go-machine-gate-retry"
  | "spin-correction"
  | "tier-escalation"
  | "adversarial-review-correction";

/** The gate tail bound, unchanged from the appenders this replaces. It bounds
 * the COMPOSED section, not a per-round append, which is what keeps the prompt
 * flat as rounds accumulate. */
export const RESEED_TAIL_LINES = 80;

/** The review-findings bound. Same ruler as the gate tail: outstanding state is
 * outstanding state, whichever stage observed it. */
export const RESEED_FINDINGS_LINES = 80;

/** The reviewed-diff bound, unchanged from the adversarial appender. The diff is
 * the WORKTREE against the merge base (#2730), not a pull request's. */
export const RESEED_DIFF_LINES = 200;

/** One outstanding review finding. Structurally a subset of
 * `AdversarialReviewFinding`, so findings pass through without adaptation. */
export interface ReseedFinding {
  readonly path?: string;
  readonly line?: number;
  readonly body: string;
  readonly blocking?: boolean;
}

/** The gate stage that is currently red, with its captured tail. */
export interface ReseedGateState {
  readonly gate: "feedback" | "backpressure";
  readonly validation: string;
}

/** The review findings that are currently unfixed, with the diff they were
 * raised against. */
export interface ReseedReviewState {
  readonly summary: string;
  readonly findings: readonly ReseedFinding[];
  readonly diff?: string;
}

/** Everything still outstanding for this Worker. Both halves may be present at
 * once: a gate that reddens on the round after a blocking review leaves the
 * findings outstanding and adds its tail beside them. */
export interface ReseedOutstanding {
  readonly gate?: ReseedGateState;
  readonly review?: ReseedReviewState;
  /** The last observed failure signature (#2724), for the repeat count. */
  readonly signature: string;
  /** How many CONSECUTIVE rounds have now failed the same way. */
  readonly repeats: number;
}

export const EMPTY_RESEED_OUTSTANDING: ReseedOutstanding = {
  signature: EMPTY_FAILURE_SIGNATURE,
  repeats: 0,
};

/** Record the round's gate failure, replacing any previous one: a gate tail is
 * a snapshot of one stage, so the newest reading is the only true one. */
export function withGateOutstanding(state: ReseedOutstanding, gate: ReseedGateState): ReseedOutstanding {
  return { ...state, gate };
}

/** Drop the gate half once the gate is green. What passed is no longer
 * outstanding, and carrying it would re-instruct the implementer to fix a stage
 * that already fixed. */
export function withoutGateOutstanding(state: ReseedOutstanding): ReseedOutstanding {
  const { gate: _gate, ...rest } = state;
  return rest;
}

/** Merge the round's review findings into what is already outstanding, keeping
 * each distinct finding ONCE. A reviewer that re-raises a finding a previous
 * round already carried is reporting the same outstanding state, not a second
 * defect, and duplicating it spends prompt on nothing. */
export function withReviewOutstanding(
  state: ReseedOutstanding,
  review: { summary: string; findings: readonly ReseedFinding[]; diff?: string },
): ReseedOutstanding {
  const merged = dedupeReseedFindings([...(state.review?.findings ?? []), ...review.findings]);
  return {
    ...state,
    review: {
      summary: review.summary || (state.review?.summary ?? ""),
      findings: merged,
      diff: review.diff || state.review?.diff,
    },
  };
}

/** Drop the review half once a review comes back clean. */
export function withoutReviewOutstanding(state: ReseedOutstanding): ReseedOutstanding {
  const { review: _review, ...rest } = state;
  return rest;
}

/** Fold the round's failure signature in, yielding the repeat count the history
 * line reports: a signature equal to the previous round's is a repeat, anything
 * else starts the count over. */
export function noteReseedSignature(state: ReseedOutstanding, signature: string): ReseedOutstanding {
  const key = signature || EMPTY_FAILURE_SIGNATURE;
  return { ...state, signature: key, repeats: key === state.signature ? state.repeats + 1 : 0 };
}

/** The dedupe identity of a finding: where it is anchored and what it claims.
 * Whitespace and case are noise — two reviewers wording the same finding with
 * different capitalisation raised one finding. */
function findingKey(finding: ReseedFinding): string {
  const body = finding.body.replace(/\s+/g, " ").trim().toLowerCase();
  return `${finding.path ?? ""}:${finding.line ?? ""}:${body}`;
}

/** Keep the FIRST occurrence of each distinct finding, preserving order. */
export function dedupeReseedFindings(findings: readonly ReseedFinding[]): readonly ReseedFinding[] {
  const seen = new Set<string>();
  const kept: ReseedFinding[] = [];
  for (const finding of findings) {
    const key = findingKey(finding);
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(finding);
  }
  return kept;
}

/** The one history line that replaces the narrative of rounds. */
export interface ReseedHistory {
  readonly round: number;
  readonly ceiling: number;
  readonly tier: string;
  readonly repeats: number;
}

export function reseedHistoryLine(history: ReseedHistory): string {
  return (
    `Re-seed round ${history.round}/${history.ceiling} · tier \`${history.tier}\` · ` +
    `repeated failure ${history.repeats}.`
  );
}

export interface ComposeReseedHandoffInput {
  readonly tag: ReseedSectionTag;
  /** What this round must do, in the trigger's own words. */
  readonly directives: readonly string[];
  readonly history: ReseedHistory;
  readonly outstanding: ReseedOutstanding;
}

export function tailLines(text: string, maxLines: number): string {
  const lines = text.split("\n");
  return lines.slice(Math.max(0, lines.length - maxLines)).join("\n");
}

/** Render the outstanding findings, bounded by the same tail ruler as the gate
 * tail so a long review cannot crowd the prompt out. */
function renderFindings(review: ReseedReviewState): string[] {
  const rendered = review.findings.flatMap((finding, idx) => [
    `${idx + 1}. ${finding.path ?? "(unanchored)"}:${finding.line ?? 0}`,
    finding.body,
    "",
  ]);
  const body = tailLines(rendered.join("\n").replace(/\n+$/, ""), RESEED_FINDINGS_LINES);
  return body ? [review.summary, "", body] : [review.summary];
}

/** Compose the re-seeded prompt: the ORIGINAL handoff plus one section carrying
 * everything still outstanding. Always composed from the original — never from
 * the previous round's composition — so the prompt stays flat while the state
 * inside it accumulates. */
export function composeReseedHandoff(handoff: string, input: ComposeReseedHandoffInput): string {
  const { outstanding } = input;
  const gate = outstanding.gate;
  const review = outstanding.review;
  const lines: string[] = [
    handoff.replace(/\n+$/, ""),
    "",
    `<${input.tag}>`,
    ...input.directives,
    "",
    "<reseed-history>",
    reseedHistoryLine(input.history),
    "</reseed-history>",
    "",
    "<outstanding-state>",
  ];
  if (gate) {
    lines.push("<validation-tail>", tailLines(gate.validation, RESEED_TAIL_LINES), "</validation-tail>");
  }
  if (review) {
    lines.push("<review-critiques>", ...renderFindings(review), "</review-critiques>");
    if (review.diff) {
      lines.push(
        '<worktree-diff data-untrusted="true">',
        "```diff",
        tailLines(review.diff, RESEED_DIFF_LINES),
        "```",
        "</worktree-diff>",
      );
    }
  }
  if (!gate && !review) lines.push("Nothing is outstanding beyond the original task.");
  lines.push("</outstanding-state>", `</${input.tag}>`, "");
  return lines.join("\n");
}

/** The branch-owned gate round's bounded-retry directives. */
export function gateReseedDirectives(opts: {
  gate: "feedback" | "backpressure";
  retry: number;
  cap: number;
}): string[] {
  return [
    `The ${opts.gate} machine gate failed after DONE. This is bounded correction retry ${opts.retry}/${opts.cap}.`,
    "Fix the failure on the existing branch, run the relevant gate, commit only the needed changes, then emit the required terminal sentinel.",
  ];
}

/** Persistent Spin spends the existing gate-shaped branch-repair round. The
 * named fault is the actionable evidence; the next agent must not rediscover
 * which futile pattern survived the free in-session steer. */
export function spinReseedDirectives(opts: {
  pattern: SpinPattern;
  retry: number;
  cap: number;
}): string[] {
  return [
    `Spin persisted after the in-session steer as \`spin:${opts.pattern}\`. This is bounded correction retry ${opts.retry}/${opts.cap}.`,
    "Break the named pattern on the existing branch, take a materially different approach, commit only the needed changes, then emit the required terminal sentinel.",
  ];
}

/** The tier-escalation round's directives (ADR 0129 decision 6): the round buys
 * a HIGHER tier rather than another round at the tier that just failed. */
export function tierEscalationDirectives(opts: {
  from: string;
  to: string;
  retry: number;
  cap: number;
}): string[] {
  return [
    `The feedback machine gate failed on the \`${opts.from}\` tier. This Re-seed re-instructs you on the ` +
      `\`${opts.to}\` tier (${opts.retry}/${opts.cap}) rather than spending another round at the tier that just failed.`,
    "Fix the failure on the existing branch, run the relevant gate, commit only the needed changes, then emit the required terminal sentinel.",
  ];
}

/** The review round's directives. */
export function reviewReseedDirectives(opts: { retry: number; cap: number }): string[] {
  return [
    `A blocking adversarial review found confirmed defects or acceptance-criteria gaps. This is bounded correction retry ${opts.retry}/${opts.cap}.`,
    "Fix only the blocking findings below on the existing branch, keep unrelated nits/style/suggestions out of scope, run the relevant gate, commit only the needed changes, then emit the required terminal sentinel.",
  ];
}

export interface ReseedRoundProjectionInput {
  readonly trigger: ReseedTrigger;
  readonly gate: "feedback" | "backpressure";
  readonly spinPattern?: SpinPattern;
  readonly tiers?: { readonly from: string; readonly to: string };
  readonly spend: ReseedSpend;
  readonly budget: ReseedBudget;
  readonly lane: ReseedBudget["lane"];
  readonly goLane: boolean;
  readonly issue: number;
}

export interface ReseedRoundProjection {
  readonly tag: ReseedSectionTag;
  readonly directives: readonly string[];
  readonly tier?: string;
  readonly note: string;
}

/** Select the prompt directives and durable one-line account for one Re-seed. */
export function reseedRoundProjection(input: ReseedRoundProjectionInput): ReseedRoundProjection {
  const gateSpend = input.spend.gate ?? 0;
  if (input.trigger === "spin") {
    const pattern = input.spinPattern ?? "monologue";
    return {
      tag: "spin-correction",
      directives: spinReseedDirectives({ pattern, retry: gateSpend, cap: input.budget.subCaps.gate }),
      note: `🤖 ${input.lane}: spin:${pattern} persisted after the in-session steer; correction retry ${gateSpend}/${input.budget.subCaps.gate}.`,
    };
  }
  if (input.trigger === "review-finding") {
    const retry = input.spend.review ?? 0;
    return {
      tag: "adversarial-review-correction",
      directives: reviewReseedDirectives({ retry, cap: input.budget.subCaps.review }),
      note: `🤖 ${input.lane}: adversarial review found blocking issue(s); correction retry ${retry}/${input.budget.subCaps.review}.`,
    };
  }
  if (input.trigger === "tier-escalation") {
    const from = input.tiers?.from ?? "";
    const to = input.tiers?.to ?? "";
    return {
      tag: "tier-escalation",
      directives: tierEscalationDirectives({ from, to, retry: input.spend.tier ?? 0, cap: input.budget.subCaps.tier }),
      tier: to,
      note: `🤖 ${input.lane}: ${from}-tier feedback failed for #${input.issue}; re-seeding on the ${to} tier before terminal validation routing.`,
    };
  }
  return {
    tag: input.goLane ? "go-machine-gate-retry" : "afk-gate-correction",
    directives: gateReseedDirectives({ gate: input.gate, retry: gateSpend, cap: input.budget.subCaps.gate }),
    note: `🤖 ${input.lane}: ${input.gate} machine gate failed after DONE; correction retry ${gateSpend}/${input.budget.subCaps.gate}.`,
  };
}
