// commands/ship.ts — DEPRECATED per ADR 0081.
//
// `/ship` is retired. Manual adoption of a hand-done branch now routes through
// `requeue --adopt-branch BRANCH` into the no-agent landing lane (ADR 0055).
// `collectShipFacts` is kept (tested by ship-facts.test.ts; may be reused by
// future callers). `shipCommand` is the backwards-compat alias.

import { execTool, type ExecOutput } from "../runtime/exec.js";
import {
  advisoryReviewPending,
  issueNumberFromBranch,
  normalizeRollupEntry,
  shipChecksAreGreen,
  type ShipCheck,
} from "../core/ship.js";
import { requeueCommand } from "./requeue.js";

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

/** Scan argv for a `--issue N` or `-i N` value (the only ship flag the alias needs). */
function parseIssueFlag(args: readonly string[]): number | undefined {
  for (let i = 0; i < args.length; i += 1) {
    if ((args[i] === "--issue" || args[i] === "-i") && i + 1 < args.length) {
      const n = Number(args[i + 1]);
      return Number.isFinite(n) && n > 0 ? n : undefined;
    }
  }
  return undefined;
}

/**
 * DEPRECATED per ADR 0081. `/ship` is retired; manual branch adoption routes
 * through `requeue --adopt-branch BRANCH`. This alias prints the deprecation
 * notice, infers issue + branch from the current context, and delegates to
 * requeueCommand so callers are redirected rather than broken.
 */
export async function shipCommand(
  args: string[],
  cwd = process.cwd(),
  stdout: NodeJS.WritableStream = process.stdout,
): Promise<number> {
  process.stderr.write(
    "[afk] /ship is deprecated (ADR 0081). Manual adoption routes through requeue:\n" +
    "  red-skills-dev requeue #ISSUE --adopt-branch BRANCH --guidance 'reason'\n\n",
  );

  // Resolve current branch (best-effort).
  let branch: string | undefined;
  try {
    const r = await execTool("git", ["branch", "--show-current"], { cwd });
    branch = r.code === 0 ? r.stdout.trim() || undefined : undefined;
  } catch { /* best-effort */ }

  const issue = parseIssueFlag(args) ?? (branch ? issueNumberFromBranch(branch) : undefined);

  if (!issue || !branch) {
    process.stderr.write(
      "[afk] /ship alias: could not infer issue or branch.\n" +
      "  Run manually: red-skills-dev requeue #ISSUE --adopt-branch BRANCH --guidance 'reason'\n",
    );
    return 1;
  }

  process.stderr.write(`[afk] /ship alias: routing to requeue #${issue} --adopt-branch ${branch}\n`);

  return requeueCommand(
    [String(issue), "--adopt-branch", branch, "--guidance", "Adopted via deprecated /ship alias (ADR 0081). Update guidance if needed."],
    cwd,
    stdout,
  );
}
