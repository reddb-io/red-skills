// commands/ship.ts — PR-facts collection for the landing gate.
//
// The `/ship` command and its backwards-compat `dev ship` alias are gone.
// Manual adoption of a hand-done branch routes through `/retake` and its
// `requeue --adopt-branch BRANCH` action into the no-agent landing lane
// (ADR 0055). `collectShipFacts` survives as the PR-facts reader.

import { execTool, type ExecOutput } from "../runtime/exec.js";
import {
  advisoryReviewPending,
  normalizeRollupEntry,
  shipChecksAreGreen,
  type ShipCheck,
} from "../core/ship.js";

async function run(cmd: string, args: readonly string[], cwd: string): Promise<ExecOutput> {
  return execTool(cmd, args, { cwd });
}

function parseJson<T>(stdout: string, fallback: T): T {
  try {
    return JSON.parse(stdout || "") as T;
  } catch {
    return fallback;
  }
}

async function required(cmd: string, args: readonly string[], cwd: string, label: string): Promise<ExecOutput> {
  const r = await run(cmd, args, cwd);
  if (r.code !== 0) {
    throw new Error(`${label} failed: ${r.stderr.trim() || r.stdout.trim() || `${cmd} ${args.join(" ")}`}`);
  }
  return r;
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
  const checksRes = await run("gh", ["pr", "checks", String(pr), "--repo", repo, "--json", "name,state,conclusion,bucket"], cwd);
  let checksGreen = false;
  let checkSummary = "checks unavailable";
  let reviewPending = false;
  if (checksRes.code === 0) {
    const checks = parseJson<ShipCheck[]>(checksRes.stdout, []);
    checksGreen = shipChecksAreGreen(checks);
    reviewPending = advisoryReviewPending(checks, reviewCheck);
    checkSummary = checks.length === 0 ? "no checks configured" : `${checks.filter((c) => shipChecksAreGreen([c])).length}/${checks.length} green`;
  } else if (/no checks/i.test(`${checksRes.stdout}\n${checksRes.stderr}`)) {
    checksGreen = true;
    checkSummary = "no checks configured";
  }

  const viewRes = await required(
    "gh",
    ["pr", "view", String(pr), "--repo", repo, "--json", "reviewDecision,reviews,statusCheckRollup"],
    cwd,
    "read PR reviews",
  );
  const view = parseJson<PrView>(viewRes.stdout, {});

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
