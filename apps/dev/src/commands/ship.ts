// commands/ship.ts — PR-facts collection for the landing gate.
//
// The `/ship` command and its backwards-compat `dev ship` alias are gone.
// Manual adoption of a hand-done branch routes through `/retake` and its
// `requeue --adopt-branch BRANCH` action into the no-agent landing lane
// (ADR 0055). `collectShipFacts` survives as the PR-facts reader.

import { createDevGithubMergeRead } from "../runtime/github-merge-read.js";
import {
  advisoryReviewPending,
  normalizeRollupEntry,
  shipChecksAreGreen,
  type ShipCheck,
} from "../core/ship.js";

function parseJson<T>(stdout: string, fallback: T): T {
  try {
    return JSON.parse(stdout || "") as T;
  } catch {
    return fallback;
  }
}

interface ShipFacts {
  branchProtectionSatisfied: boolean;
  changesRequested: boolean;
  checksGreen: boolean;
  advisoryReviewPending: boolean;
  reviewDecision: string;
  checkSummary: string;
}

interface PrView {
  reviewDecision?: string | null;
  reviews?: Array<{ state?: string | null; author?: { login?: string | null } | null }>;
  statusCheckRollup?: Array<Record<string, unknown>> | null;
}

export async function collectShipFacts(cwd: string, repo: string, pr: number, reviewCheck: string): Promise<ShipFacts> {
  const github = createDevGithubMergeRead(cwd, "ship-facts");
  let checksGreen = false;
  let checkSummary = "checks unavailable";
  let reviewPending = false;
  try {
    const checks = parseJson<ShipCheck[]>(await github.reviewChecks(repo, pr), []);
    checksGreen = shipChecksAreGreen(checks);
    reviewPending = advisoryReviewPending(checks, reviewCheck);
    checkSummary = checks.length === 0 ? "no checks configured" : `${checks.filter((c) => shipChecksAreGreen([c])).length}/${checks.length} green`;
  } catch (error) {
    if (/no checks/i.test(error instanceof Error ? error.message : String(error))) {
      checksGreen = true;
      checkSummary = "no checks configured";
    }
  }

  const view = parseJson<PrView>(await github.shipPr(repo, pr), {});

  // When gh pr checks failed but gh pr view returned a populated statusCheckRollup,
  // use that rollup as the check source.
  if (checkSummary === "checks unavailable") {
    const rollup = view.statusCheckRollup ?? [];
    if (rollup.length > 0) {
      const normalized = rollup.map(normalizeRollupEntry);
      checksGreen = shipChecksAreGreen(normalized);
      reviewPending = advisoryReviewPending(normalized, reviewCheck);
      checkSummary = `${normalized.filter((c) => shipChecksAreGreen([c])).length}/${normalized.length} green`;
    }
  }

  const reviewDecision = String(view.reviewDecision ?? "").toUpperCase();
  const changesRequested =
    reviewDecision === "CHANGES_REQUESTED" ||
    (view.reviews ?? []).some((review) => String(review.state ?? "").toUpperCase() === "CHANGES_REQUESTED");
  const branchProtectionSatisfied = reviewDecision !== "REVIEW_REQUIRED";

  return { branchProtectionSatisfied, changesRequested, checksGreen, advisoryReviewPending: reviewPending, reviewDecision, checkSummary };
}
