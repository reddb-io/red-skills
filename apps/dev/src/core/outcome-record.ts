// outcome-record — the PURE vocabulary the brain outcome-event seam is built
// from: which `type:*` bucket a Ticket belongs to, and which coarse result one
// terminal exit represents.
//
// This is deliberately NOT an attempt payload. ADR 0103 removed the attempt
// model and, with it, ADR 0017's AFK→Memory attempt recording; what survives is
// the `OutcomeEvent` the routing policy reads, which needs exactly these two
// derivations and nothing else.

import type { ProcessOutcome } from "./process-issue.js";

/** Coarse result of one terminal exit, for routing-policy queries. */
export type OutcomeRecordKind = "success" | "failure" | "escalated";

/** The canonical `type:*` bucket for a Ticket, or `unknown` when it carries none. */
export function deriveIssueType(labels: readonly string[] | undefined): string {
  for (const label of labels ?? []) {
    const match = /^type:([a-z0-9][a-z0-9-]*)$/i.exec(label.trim());
    if (match) return match[1]!.toLowerCase();
  }
  return "unknown";
}

/** Bucket a terminal outcome. A human-escalating exit is neither a success nor
 * a plain failure — it is `escalated`, so policy can tell "the agent could not
 * finish" apart from "the agent handed off deliberately". */
export function deriveOutcomeRecord(outcome: ProcessOutcome | string): OutcomeRecordKind {
  switch (outcome) {
    case "done":
      return "success";
    case "review-requested":
      return "escalated";
    default:
      return "failure";
  }
}
