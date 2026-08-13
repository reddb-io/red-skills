import { makeBlocker, type CurrentBlocker } from "../blocker-state.js";
import type { SectionBodies } from "../envelope-emit.js";
import { isSpinOutcome } from "../worker-outcome.js";
import type { ProcessOutcome } from "./types.js";
import { validationBlockerSummary } from "./validation-park.js";

export function oneLine(value: string | undefined, fallback: string): string {
  const line = (value ?? "")
    .split("\n")
    .map((part) => part.replace(/^[-*]\s*(?:\[[^\]]+\]\s*)?/, "").replace(/\s+/g, " ").trim())
    .find((part) => part.length > 0);
  return line ?? fallback;
}

export function blockerForFailure(outcome: ProcessOutcome, sections: SectionBodies): CurrentBlocker | null {
  if (isSpinOutcome(outcome)) {
    return makeBlocker({
      kind: "spin",
      summary: oneLine(sections.notes, `Persistent Worker Spin ended as ${outcome}.`),
      next: "Review the named Spin pattern and the pushed branch, then add guidance or re-scope before requeueing.",
    });
  }
  switch (outcome) {
    case "blocked":
      return makeBlocker({
        kind: "spec",
        summary: oneLine(sections.notes, "Inner agent emitted BLOCKED."),
        next: "Review the blocker envelope and add human guidance.",
      });
    case "feedback-failed":
      return makeBlocker({
        kind: "validation",
        summary: validationBlockerSummary(sections.validation) ?? oneLine(sections.validation ?? sections.log, "Validation failed after implementation."),
        next: "Decide whether to fix forward, change scope, or adjust the acceptance criteria.",
      });
    case "no-sentinel":
      return makeBlocker({
        kind: "runner",
        summary: oneLine(sections.log, "Inner agent exited without an AFK completion sentinel."),
        next: "Review the attempt log and decide whether to retry or revise the issue brief.",
      });
    case "host-config":
      return makeBlocker({
        kind: "host-config",
        summary: oneLine(sections.log ?? sections.notes, "Required runner host configuration is unavailable."),
        next: "Install or restore the required shell/workspace on the host, then requeue this issue.",
      });
    case "stalled":
      return makeBlocker({
        kind: "stalled",
        summary: oneLine(sections.log, "Inner agent made no progress (no new commit) within the attempt wall-clock."),
        next: "Review the work already pushed (branch/PR) and decide whether to continue, re-scope, or stop.",
      });
    case "budget-exceeded":
      return makeBlocker({
        kind: "budget",
        summary: oneLine(sections.log, "Attempt aborted — per-attempt resource budget exceeded (#908)."),
        next: "Review the salvaged partial work (branch/PR) and decide whether to continue with a larger budget, re-scope, or stop.",
      });
    case "merge-conflict":
      return makeBlocker({
        kind: "merge-conflict",
        summary: oneLine(sections.log, "Worker branch could not be merged cleanly."),
        next: "Resolve the merge conflict or add guidance for the next agent attempt.",
      });
    case "ci-failed":
      return makeBlocker({
        kind: "ci",
        summary: oneLine(sections.log, "A required status check failed on the completed, mergeable PR."),
        next: "Fix the failing required check on the open PR, then merge it (no full agent re-run needed).",
      });
    case "ci-pending":
      return makeBlocker({
        kind: "ci",
        summary: oneLine(sections.log, "Required status checks were still pending on the completed, mergeable PR."),
        next: "Wait for the required checks to go green, then merge the open PR (no full agent re-run needed).",
      });
    case "trunk-diverged":
      return makeBlocker({
        kind: "trunk-diverged",
        summary: oneLine(sections.log, "Local trunk diverged from origin; landing aborted (ADR 0083)."),
        next: "Reconcile the primary checkout's local trunk with origin (no reset/stash/force-push), then requeue.",
      });
    case "base-stale":
      return makeBlocker({
        kind: "base-stale",
        summary: oneLine(sections.log, "Remote base was unreachable and the local base is stale."),
        next: "Refresh the local base from origin, or restore remote access, then requeue.",
      });
    case "infra":
      return makeBlocker({
        kind: "infra",
        summary: oneLine(sections.log, "Landing infrastructure precondition failed."),
        next: "Fix the landing infrastructure failure, then requeue.",
      });
    case "manual-landing":
      return makeBlocker({
        kind: "manual-landing",
        summary: oneLine(sections.log, "Manual-landing hold: the full pipeline ran and the PR is open, awaiting a human merge."),
        next: "Merge the open PR to land the work (it auto-closes this issue); no full agent re-run is needed.",
      });
    default:
      return null;
  }
}
