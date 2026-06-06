import { issueNumberFromBranch } from "./ship.js";

export interface RetakeIssue {
  number: number;
  title: string;
  state: string;
  labels: readonly string[];
  url?: string;
}

export interface RetakePullRequest {
  number: number;
  title: string;
  state: string;
  url?: string;
  body?: string;
  headRefName?: string;
  baseRefName?: string;
  reviewDecision?: string;
  checksState?: RetakeChecksState;
}

export interface RetakeBranch {
  name: string;
  remote: boolean;
}

export interface RetakeWorktree {
  path: string;
  branch?: string;
  dirty: boolean;
}

export type RetakeChecksState = "green" | "pending" | "failing" | "unknown";

export type RetakeRecommendationKind =
  | "resolve-hitl"
  | "ship-pr"
  | "fix-pr"
  | "continue-worktree"
  | "create-worktree"
  | "create-branch"
  | "already-closed";

export interface RetakeRecommendation {
  kind: RetakeRecommendationKind;
  summary: string;
  command?: string;
}

export interface RetakeFacts {
  issue: RetakeIssue;
  pullRequests: readonly RetakePullRequest[];
  branches: readonly RetakeBranch[];
  worktrees: readonly RetakeWorktree[];
}

const FAILURE_CHECK_VALUES = new Set(["FAILURE", "FAILED", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED"]);
const GREEN_CHECK_VALUES = new Set(["SUCCESS", "PASS", "PASSED", "NEUTRAL", "SKIPPED", "SKIPPING"]);

export function parseIssueSpecifier(raw: string): number {
  const trimmed = raw.trim();
  const match = /(?:^|[#/])([1-9][0-9]*)(?:$|[/?#])/.exec(trimmed);
  if (!match?.[1]) throw new Error(`/retake requires an issue number like #123; got ${raw}`);
  const issue = Number.parseInt(match[1], 10);
  if (!Number.isSafeInteger(issue) || issue <= 0) {
    throw new Error(`/retake requires a positive issue number; got ${raw}`);
  }
  return issue;
}

export function normalizeBranchName(branch: string): string {
  return branch.replace(/^refs\/heads\//, "").replace(/^refs\/remotes\//, "").replace(/^origin\//, "");
}

export function branchMatchesIssue(branch: string, issue: number): boolean {
  const normalized = normalizeBranchName(branch);
  if (issueNumberFromBranch(normalized) === issue) return true;
  return new RegExp(`(?:^|[^0-9])${issue}(?:[^0-9]|$)`).test(normalized);
}

export function worktreeMatchesIssue(worktree: RetakeWorktree, issue: number): boolean {
  return (worktree.branch !== undefined && branchMatchesIssue(worktree.branch, issue)) ||
    new RegExp(`(?:^|[/._-])${issue}(?:[/._-]|$)`).test(worktree.path);
}

export function pullRequestMatchesIssue(pr: RetakePullRequest, issue: number): boolean {
  return (pr.headRefName !== undefined && branchMatchesIssue(pr.headRefName, issue)) ||
    new RegExp(`(?:^|[^0-9#])#?${issue}(?:[^0-9]|$)`).test(`${pr.title}\n${pr.body ?? ""}`);
}

export function summarizeChecks(rawChecks: readonly unknown[]): RetakeChecksState {
  if (rawChecks.length === 0) return "unknown";
  let sawPending = false;
  let sawGreen = false;
  for (const raw of rawChecks) {
    const rec = raw as { conclusion?: unknown; state?: unknown; status?: unknown; bucket?: unknown };
    const values = [rec.conclusion, rec.state, rec.status, rec.bucket]
      .map((value) => String(value ?? "").trim().toUpperCase())
      .filter(Boolean);
    if (values.some((value) => FAILURE_CHECK_VALUES.has(value))) return "failing";
    if (values.some((value) => GREEN_CHECK_VALUES.has(value))) {
      sawGreen = true;
      continue;
    }
    sawPending = true;
  }
  if (sawPending) return "pending";
  return sawGreen ? "green" : "unknown";
}

function worktreeCommandForBranch(issue: number, branch: RetakeBranch): string {
  if (!branch.remote) return `git worktree add .red/tmp/work-ship-${issue} ${branch.name}`;
  return `git worktree add .red/tmp/work-ship-${issue} -b ${normalizeBranchName(branch.name)} ${branch.name}`;
}

function worktreeCommandForPr(issue: number, pr: RetakePullRequest): string {
  if (pr.headRefName === undefined || pr.headRefName.trim() === "") {
    return `gh pr checkout ${pr.number}`;
  }
  const branch = normalizeBranchName(pr.headRefName);
  return `git fetch origin ${branch}:${branch} && git worktree add .red/tmp/work-ship-${issue} ${branch}`;
}

export function recommendRetake(facts: RetakeFacts): RetakeRecommendation {
  const labels = new Set(facts.issue.labels);
  const openPrs = facts.pullRequests.filter((pr) => pr.state.toUpperCase() === "OPEN");
  const matchingWorktrees = facts.worktrees.filter((worktree) => worktreeMatchesIssue(worktree, facts.issue.number));
  const dirtyWorktree = matchingWorktrees.find((worktree) => worktree.dirty);

  if (labels.has("ready-for-human")) {
    return {
      kind: "resolve-hitl",
      summary: "Issue is waiting for a human decision before agents can continue.",
      command: `/hitl #${facts.issue.number}`,
    };
  }

  const blockedPr = openPrs.find((pr) =>
    pr.reviewDecision?.toUpperCase() === "CHANGES_REQUESTED" ||
    pr.checksState === "failing" ||
    pr.checksState === "pending"
  );
  if (blockedPr !== undefined) {
    const worktree = matchingWorktrees.find((candidate) =>
      candidate.branch !== undefined &&
      blockedPr.headRefName !== undefined &&
      normalizeBranchName(candidate.branch) === normalizeBranchName(blockedPr.headRefName)
    );
    return {
      kind: "fix-pr",
      summary: `PR #${blockedPr.number} is open but not ready to ship.`,
      command: worktree !== undefined
        ? `cd ${worktree.path}`
        : worktreeCommandForPr(facts.issue.number, blockedPr),
    };
  }

  if (dirtyWorktree !== undefined) {
    return {
      kind: "continue-worktree",
      summary: "A matching local worktree has uncommitted work.",
      command: `cd ${dirtyWorktree.path}`,
    };
  }

  const shippablePr = openPrs.find((pr) => pr.checksState === "green" || pr.checksState === "unknown") ?? openPrs[0];
  if (shippablePr !== undefined) {
    const worktree = matchingWorktrees.find((candidate) =>
      candidate.branch !== undefined &&
      shippablePr.headRefName !== undefined &&
      normalizeBranchName(candidate.branch) === normalizeBranchName(shippablePr.headRefName)
    );
    return {
      kind: "ship-pr",
      summary: `PR #${shippablePr.number} is open; hand it to /ship once the branch worktree is clean.`,
      command: worktree !== undefined
        ? `cd ${worktree.path} && /ship --issue ${facts.issue.number}`
        : `${worktreeCommandForPr(facts.issue.number, shippablePr)} && cd .red/tmp/work-ship-${facts.issue.number} && /ship --issue ${facts.issue.number}`,
    };
  }

  if (facts.issue.state.toUpperCase() === "CLOSED") {
    return {
      kind: "already-closed",
      summary: "Issue is already closed and has no open PR.",
    };
  }

  const branch = facts.branches.find((candidate) => !candidate.remote) ?? facts.branches[0];
  if (branch !== undefined) {
    return {
      kind: "create-worktree",
      summary: `A matching ${branch.remote ? "remote" : "local"} branch exists; recreate a ship worktree around it.`,
      command: worktreeCommandForBranch(facts.issue.number, branch),
    };
  }

  return {
    kind: "create-branch",
    summary: "No matching local state was found; start a fresh ship worktree for this issue.",
    command: `git worktree add .red/tmp/work-ship-${facts.issue.number} -b codex/${facts.issue.number}-retake origin/main`,
  };
}
