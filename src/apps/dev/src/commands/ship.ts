import { setTimeout as sleep } from "node:timers/promises";
import { parseFlags, type FlagSchema } from "@reddb-io/shared/args.js";
import { execTool, type ExecOutput } from "../runtime/exec.js";
import {
  decideShipMergeGate,
  isShipWorktreePath,
  issueNumberFromBranch,
  shipChecksAreGreen,
  type ShipCheck,
} from "../core/ship.js";

interface ShipFlags {
  base: string;
  remote: string;
  repo?: string;
  issue?: number;
  timeoutS: number;
  pollS: number;
}

interface ShipFacts {
  branchProtectionSatisfied: boolean;
  changesRequested: boolean;
  checksGreen: boolean;
  reviewDecision: string;
  checkSummary: string;
}

const SHIP_FLAG_SCHEMA = {
  base: { kind: "value", aliases: ["b"], coerce: (raw: string): string => raw },
  remote: { kind: "value", coerce: (raw: string): string => raw },
  repo: { kind: "value", aliases: ["R"], coerce: (raw: string): string => raw },
  issue: { kind: "value", aliases: ["i"], coerce: (raw: string): number => Number(raw) },
  "timeout-s": { kind: "value", coerce: (raw: string): number => Number(raw) },
  "poll-s": { kind: "value", coerce: (raw: string): number => Number(raw) },
} satisfies FlagSchema;

function parseShipFlags(args: readonly string[]): ShipFlags {
  const { values } = parseFlags(args, SHIP_FLAG_SCHEMA);
  const timeoutS = Number.isFinite(values["timeout-s"]) && Number(values["timeout-s"]) > 0
    ? Number(values["timeout-s"])
    : 30 * 60;
  const pollS = Number.isFinite(values["poll-s"]) && Number(values["poll-s"]) > 0
    ? Number(values["poll-s"])
    : 30;
  return {
    base: String(values.base ?? "main"),
    remote: String(values.remote ?? "origin"),
    repo: values.repo as string | undefined,
    issue: Number.isFinite(values.issue) ? Number(values.issue) : undefined,
    timeoutS,
    pollS,
  };
}

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

async function resolveRepo(cwd: string, explicit?: string): Promise<string> {
  if (explicit?.trim()) return explicit.trim();
  const r = await required("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], cwd, "resolve repo");
  return r.stdout.trim();
}

async function currentBranch(cwd: string): Promise<string> {
  const r = await required("git", ["branch", "--show-current"], cwd, "resolve current branch");
  const branch = r.stdout.trim();
  if (!branch) throw new Error("/ship requires a named branch, not detached HEAD");
  return branch;
}

async function gitTopLevel(cwd: string): Promise<string> {
  const r = await required("git", ["rev-parse", "--show-toplevel"], cwd, "resolve git worktree");
  return r.stdout.trim();
}

async function ensureCommittedWork(cwd: string): Promise<void> {
  const r = await required("git", ["status", "--porcelain"], cwd, "check git status");
  if (r.stdout.trim() !== "") {
    throw new Error("/ship requires committed work; commit or stash the remaining changes first");
  }
}

async function issueTitle(cwd: string, repo: string, issue: number): Promise<string> {
  const r = await run("gh", ["issue", "view", String(issue), "--repo", repo, "--json", "title", "-q", ".title"], cwd);
  return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : `Issue #${issue}`;
}

async function pushBranch(cwd: string, remote: string, branch: string): Promise<void> {
  await required("git", ["push", "-u", remote, `HEAD:refs/heads/${branch}`], cwd, "push branch");
}

async function findOpenPr(cwd: string, repo: string, branch: string, base: string): Promise<number | undefined> {
  const r = await required(
    "gh",
    [
      "pr",
      "list",
      "--repo",
      repo,
      "--head",
      branch,
      "--base",
      base,
      "--state",
      "open",
      "--json",
      "number",
      "--jq",
      ".[0].number // empty",
    ],
    cwd,
    "find open PR",
  );
  const n = Number.parseInt(r.stdout.trim(), 10);
  return Number.isInteger(n) ? n : undefined;
}

async function openOrReusePr(
  cwd: string,
  repo: string,
  branch: string,
  base: string,
  issue: number,
  title: string,
): Promise<number> {
  const existing = await findOpenPr(cwd, repo, branch, base);
  if (existing !== undefined) return existing;

  await required(
    "gh",
    [
      "pr",
      "create",
      "--repo",
      repo,
      "--base",
      base,
      "--head",
      branch,
      "--title",
      `ship: #${issue} ${title}`,
      "--body",
      `Interactive /ship landing for #${issue}.\n\nCloses #${issue}`,
    ],
    cwd,
    "create PR",
  );
  const created = await findOpenPr(cwd, repo, branch, base);
  if (created === undefined) throw new Error("created PR but could not resolve its number");
  return created;
}

interface PrView {
  reviewDecision?: string | null;
  reviews?: Array<{ state?: string | null; author?: { login?: string | null } | null }>;
}

async function collectShipFacts(cwd: string, repo: string, pr: number): Promise<ShipFacts> {
  const checksRes = await run("gh", ["pr", "checks", String(pr), "--repo", repo, "--json", "name,state,conclusion,bucket"], cwd);
  let checksGreen = false;
  let checkSummary = "checks unavailable";
  if (checksRes.code === 0) {
    const checks = parseJson<ShipCheck[]>(checksRes.stdout, []);
    checksGreen = shipChecksAreGreen(checks);
    checkSummary = checks.length === 0 ? "no checks configured" : `${checks.filter((c) => shipChecksAreGreen([c])).length}/${checks.length} green`;
  } else if (/no checks/i.test(`${checksRes.stdout}\n${checksRes.stderr}`)) {
    checksGreen = true;
    checkSummary = "no checks configured";
  }

  const viewRes = await required(
    "gh",
    ["pr", "view", String(pr), "--repo", repo, "--json", "reviewDecision,reviews"],
    cwd,
    "read PR reviews",
  );
  const view = parseJson<PrView>(viewRes.stdout, {});
  const reviewDecision = String(view.reviewDecision ?? "").toUpperCase();
  const changesRequested =
    reviewDecision === "CHANGES_REQUESTED" ||
    (view.reviews ?? []).some((review) => String(review.state ?? "").toUpperCase() === "CHANGES_REQUESTED");
  const branchProtectionSatisfied = reviewDecision !== "REVIEW_REQUIRED";

  return { branchProtectionSatisfied, changesRequested, checksGreen, reviewDecision, checkSummary };
}

function hitlBody(pr: number, issue: number, reason: string, facts: ShipFacts): string {
  return [
    "/ship stopped for human review.",
    "",
    `PR: #${pr}`,
    `Issue: #${issue}`,
    `Reason: ${reason}`,
    `Checks: ${facts.checkSummary}`,
    `Review decision: ${facts.reviewDecision || "none"}`,
    "",
    "Next step: run `/dev:hitl` after the human decision is recorded.",
  ].join("\n");
}

async function markHitl(cwd: string, repo: string, pr: number, issue: number, reason: string, facts: ShipFacts): Promise<void> {
  const body = hitlBody(pr, issue, reason, facts);
  await run("gh", ["label", "create", "ready-for-human", "--repo", repo, "--color", "FBCA04", "--description", "Waiting for a human decision"], cwd);
  await run("gh", ["issue", "comment", String(issue), "--repo", repo, "--body", body], cwd);
  await run("gh", ["issue", "edit", String(issue), "--repo", repo, "--add-label", "ready-for-human"], cwd);
  await run("gh", ["pr", "edit", String(pr), "--repo", repo, "--add-label", "ready-for-human"], cwd);
  await run("gh", ["pr", "comment", String(pr), "--repo", repo, "--body", body], cwd);
}

async function approveAndMerge(cwd: string, repo: string, pr: number): Promise<boolean> {
  const approve = await run(
    "gh",
    ["pr", "review", String(pr), "--repo", repo, "--approve", "--body", "Approved by /ship after green checks and review-respecting gate."],
    cwd,
  );
  if (approve.code !== 0) return false;
  const merge = await run("gh", ["pr", "merge", String(pr), "--repo", repo, "--merge"], cwd);
  return merge.code === 0;
}

function reasonForHitl(facts: ShipFacts, timedOut: boolean): string {
  if (timedOut) return "monitor time cap exceeded";
  if (facts.changesRequested) return "review requested changes";
  if (!facts.branchProtectionSatisfied) return "branch protection requires approval";
  if (!facts.checksGreen) return "checks did not become green";
  return "merge gate requested HITL";
}

export async function shipCommand(
  args: string[],
  cwd = process.cwd(),
  stdout: NodeJS.WritableStream = process.stdout,
): Promise<number> {
  const flags = parseShipFlags(args);
  const topLevel = await gitTopLevel(cwd);
  if (!isShipWorktreePath(topLevel)) {
    throw new Error("/ship must run from a .red/tmp/work-ship-*/ worktree");
  }
  await ensureCommittedWork(cwd);

  const repo = await resolveRepo(cwd, flags.repo);
  const branch = await currentBranch(cwd);
  const issue = flags.issue ?? issueNumberFromBranch(branch);
  if (issue === undefined) {
    throw new Error("/ship could not infer the linked issue; pass --issue N");
  }
  const title = await issueTitle(cwd, repo, issue);

  await pushBranch(cwd, flags.remote, branch);
  stdout.write(`/ship: pushed ${branch} to ${flags.remote}\n`);
  const pr = await openOrReusePr(cwd, repo, branch, flags.base, issue, title);
  stdout.write(`/ship: PR #${pr} ready for #${issue}\n`);

  const deadline = Date.now() + flags.timeoutS * 1000;
  let lastFacts = await collectShipFacts(cwd, repo, pr);
  for (;;) {
    const timedOut = Date.now() >= deadline;
    if (
      !timedOut &&
      !lastFacts.changesRequested &&
      lastFacts.branchProtectionSatisfied &&
      !lastFacts.checksGreen
    ) {
      stdout.write(`/ship: waiting (${lastFacts.checkSummary}); next poll in ${flags.pollS}s\n`);
      await sleep(flags.pollS * 1000);
      lastFacts = await collectShipFacts(cwd, repo, pr);
      continue;
    }

    const decision = decideShipMergeGate({
      branchProtectionSatisfied: lastFacts.branchProtectionSatisfied,
      changesRequested: lastFacts.changesRequested,
      checksGreen: lastFacts.checksGreen,
      timedOut,
    });

    if (decision === "merge") {
      if (await approveAndMerge(cwd, repo, pr)) {
        stdout.write(`/ship: approved and merged PR #${pr}\n`);
        return 0;
      }
      await markHitl(cwd, repo, pr, issue, "approve or merge command failed", lastFacts);
      stdout.write(`/ship: approve/merge failed; marked #${issue} and PR #${pr} ready-for-human\n`);
      return 0;
    }

    if (timedOut || lastFacts.changesRequested || !lastFacts.branchProtectionSatisfied) {
      const reason = reasonForHitl(lastFacts, timedOut);
      await markHitl(cwd, repo, pr, issue, reason, lastFacts);
      stdout.write(`/ship: ${reason}; marked #${issue} and PR #${pr} ready-for-human\n`);
      return 0;
    }
  }
}
