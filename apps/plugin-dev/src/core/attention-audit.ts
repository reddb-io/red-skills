// attention-audit — the pure assembly half of the drain-end Attention audit
// (Spec #4164, Ticket #4171).
//
// A **Decision trail** (#4167) gives every Worker a place to record the forks it
// took, the pivots, the reverts, the blockers and the units it called verified.
// Nothing read them. A trail nobody reads is narration with a schema: the night
// still has to be re-read in the morning, which is the cost the trail was
// supposed to remove.
//
// The Attention audit is that reader. At drain end it takes the drain's decision
// rows and the drain's OUTCOMES — what actually landed, parked or was abandoned —
// and emits one **Attention** section the operator reads before anything else.
//
// ## What is computable is computed, and only the rest is judged
//
// Three of the section's questions need no model at all, because each is a
// disagreement between two records the drain already holds:
//
//   - **weak evidence** — the trail declares `evidence` a POINTER; the writer
//     only enforces non-empty, so prose passes validation. Prose is a claim
//     citing itself.
//   - **unproven claim** — a `verified-unit` row for an issue the drain never
//     landed. The Worker said "verified"; the outcome says otherwise.
//   - **unlogged pivot** — the drain re-entered an issue more times than the
//     trail has `pivot`/`revert` rows for it. A course change nobody wrote down.
//
// Those are set differences, so they are a PURE function over fixed inputs and
// they are testable without a model, a network or a clock. The model call is the
// judgment step ONLY — the reading a diff cannot do — and it enters through the
// `AttentionJudge` seam below. An audit with no judge attached is still a real
// audit; it just carries no judgment notes.

import type { DecisionTrailKind } from "@reddb-io/worker/engine";
import type { AttentionAuditIdentity } from "./attention-audit-identity.js";

/** One Decision-trail row as the audit reads it: the Worker's payload plus the
 * attribution the lane record carries around it (which Worker, which issue). */
export interface AttentionTrailRow {
  /** The Worker that wrote the row. */
  readonly worker: string;
  /** The issue the Worker held, or `null` when the row names none. */
  readonly issue: number | null;
  /** The row's stamp, or `null` when the lane record carried none. */
  readonly at: string | null;
  readonly type: DecisionTrailKind;
  readonly decision: string;
  readonly why: string;
  /** A pointer — URL, SHA, path, `#123`. Prose here is the weak-evidence finding. */
  readonly evidence: string;
  readonly result: string;
}

/** Terminal state the drain reached for one issue it worked. */
export type AttentionOutcomeState = "landed" | "parked" | "abandoned" | "open";

/**
 * What the drain OBSERVED for one issue, independent of what its Workers said.
 * This is the second record the audit reads the trail against — the trail alone
 * can only be internally consistent, and internal consistency is what an
 * unreviewed night already has.
 */
export interface AttentionDrainOutcome {
  readonly issue: number;
  readonly state: AttentionOutcomeState;
  /**
   * How many times the drain re-entered the issue — a retry, a recycle, a
   * second Worker on the same claim. Each re-entry is a course change that
   * either has a `pivot`/`revert` row explaining it or does not.
   */
  readonly reentries: number;
}

export type AttentionFindingKind = "weak-evidence" | "unproven-claim" | "unlogged-pivot";

/** One thing the operator should look at, with the row or issue it came from. */
export interface AttentionFinding {
  readonly kind: AttentionFindingKind;
  /** The Worker responsible, or `"-"` when the finding is issue-level. */
  readonly worker: string;
  readonly issue: number | null;
  /** One line naming what disagrees with what. */
  readonly detail: string;
  /** The evidence string as written, so the operator judges the cite itself. */
  readonly evidence: string;
}

/** A note the judgment step added. Empty until a judge is attached. */
export interface AttentionJudgmentNote {
  /** The identity that wrote it — never the drain's own model family. */
  readonly identity: string;
  readonly note: string;
}

export interface AttentionAuditInput {
  /** The drain the audit is for. */
  readonly drain: string;
  readonly generatedAt: string;
  /** The identity that judges, or `null` when none could be pinned. */
  readonly identity: AttentionAuditIdentity | null;
  readonly rows: readonly AttentionTrailRow[];
  readonly outcomes: readonly AttentionDrainOutcome[];
  /** Notes from the judgment seam, when it ran. Assembly never invents them. */
  readonly judgment?: readonly AttentionJudgmentNote[];
}

export interface AttentionAudit {
  readonly schema_version: "red.dev.attention_audit.v1";
  readonly drain: string;
  readonly generated_at: string;
  /** `runner/model (family)`, or `"unpinned"` when no cross-family identity exists. */
  readonly identity: string;
  readonly rows_read: number;
  readonly findings: readonly AttentionFinding[];
  readonly judgment: readonly AttentionJudgmentNote[];
  readonly warnings: readonly string[];
}

/**
 * The judgment step, declared as a seam rather than called. The daemon fills it
 * at drain end with an agent on the identity `resolveAttentionAuditIdentity`
 * pinned; nothing in this package makes a model call, so every test here runs
 * offline and deterministic.
 */
export interface AttentionJudge {
  judge(audit: AttentionAudit): Promise<readonly AttentionJudgmentNote[]>;
}

/** Prefixes and shapes that make an evidence string a POINTER rather than prose. */
const POINTER_PATTERNS: readonly RegExp[] = [
  /^https?:\/\/\S+$/,
  /^[0-9a-f]{7,40}$/i,
  /^#\d+$/,
  /^[\w.-]+\/[\w.-]+#\d+$/,
  /^(?:\.\/|\/)?[\w.-]+(?:\/[\w.-]+)*\.[A-Za-z0-9]+(?::\d+(?:-\d+)?)?$/,
];

/**
 * Whether an evidence field cites something a reader can open. **A pointer is
 * one token.** Prose describing evidence ("the tests passed locally") is the
 * thing this refuses, and the giveaway is whitespace: no pointer we accept
 * contains any. PURE.
 */
export function isEvidencePointer(evidence: string): boolean {
  const value = evidence.trim();
  if (value.length === 0 || /\s/.test(value)) return false;
  return POINTER_PATTERNS.some((pattern) => pattern.test(value));
}

function loggedCourseChanges(rows: readonly AttentionTrailRow[], issue: number): number {
  return rows.filter(
    (row) => row.issue === issue && (row.type === "pivot" || row.type === "revert"),
  ).length;
}

/**
 * Assemble the Attention audit: the three computable findings over the drain's
 * decision rows and outcomes, in a stable order (weak evidence, then unproven
 * claims, then unlogged pivots) so two runs over one drain read identically.
 *
 * An EMPTY trail is a legal drain, not an error — it assembles to an audit with
 * no findings and a warning naming the silence, because a drain that logged no
 * decisions is itself something the operator should see. PURE.
 */
export function assembleAttentionAudit(input: AttentionAuditInput): AttentionAudit {
  const findings: AttentionFinding[] = [];
  const warnings: string[] = [];

  for (const row of input.rows) {
    if (!isEvidencePointer(row.evidence)) {
      findings.push({
        kind: "weak-evidence",
        worker: row.worker,
        issue: row.issue,
        detail: `${row.type} row cites prose, not a pointer: ${row.decision}`,
        evidence: row.evidence,
      });
    }
  }

  const outcomeByIssue = new Map(input.outcomes.map((outcome) => [outcome.issue, outcome]));
  for (const row of input.rows) {
    if (row.type !== "verified-unit") continue;
    const outcome = row.issue === null ? undefined : outcomeByIssue.get(row.issue);
    if (outcome !== undefined && outcome.state === "landed") continue;
    const observed = outcome === undefined ? "no outcome recorded" : `outcome ${outcome.state}`;
    findings.push({
      kind: "unproven-claim",
      worker: row.worker,
      issue: row.issue,
      detail: `verified unit claimed (${row.result}) but ${observed}`,
      evidence: row.evidence,
    });
  }

  for (const outcome of input.outcomes) {
    const logged = loggedCourseChanges(input.rows, outcome.issue);
    if (outcome.reentries <= logged) continue;
    findings.push({
      kind: "unlogged-pivot",
      worker: "-",
      issue: outcome.issue,
      detail: `${outcome.reentries} re-entries against ${logged} logged pivot/revert rows`,
      evidence: "-",
    });
  }

  if (input.rows.length === 0) {
    warnings.push("drain logged no decision rows — the trail cannot be audited");
  }
  if (input.identity === null) {
    warnings.push("no audit identity on a different model family than the drain's Workers");
  }

  return {
    schema_version: "red.dev.attention_audit.v1",
    drain: input.drain,
    generated_at: input.generatedAt,
    identity:
      input.identity === null
        ? "unpinned"
        : `${input.identity.runner}/${input.identity.model} (${input.identity.family})`,
    rows_read: input.rows.length,
    findings,
    judgment: input.judgment ?? [],
    warnings,
  };
}

const FINDING_HEADINGS: Readonly<Record<AttentionFindingKind, string>> = {
  "weak-evidence": "weak evidence",
  "unproven-claim": "unproven claims",
  "unlogged-pivot": "unlogged pivots",
};

/**
 * The **Attention** section, grouped by finding kind. It is rendered FIRST in
 * the review — the morning read starts here, not at the raw log — and it states
 * its own silence, because an absent section reads as "nothing to see" whether
 * the drain was clean or the audit never ran. PURE.
 */
export function renderAttentionSection(audit: AttentionAudit | null): string[] {
  if (audit === null) return ["", "Attention", "  (no drain-end audit for this window)"];
  const lines = ["", `Attention — ${audit.drain}`, `  audited by: ${audit.identity}`];
  if (audit.findings.length === 0) {
    lines.push(`  (nothing flagged across ${audit.rows_read} decision rows)`);
  }
  for (const kind of ["weak-evidence", "unproven-claim", "unlogged-pivot"] as const) {
    const group = audit.findings.filter((finding) => finding.kind === kind);
    if (group.length === 0) continue;
    lines.push(`  ${FINDING_HEADINGS[kind]} (${group.length})`);
    for (const finding of group) {
      const issue = finding.issue === null ? "-" : `#${finding.issue}`;
      lines.push(`    ${issue} ${finding.worker}: ${finding.detail}`);
    }
  }
  for (const note of audit.judgment) lines.push(`  judgment (${note.identity}): ${note.note}`);
  for (const warning of audit.warnings) lines.push(`  warning: ${warning}`);
  return lines;
}
