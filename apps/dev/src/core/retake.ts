import { issueNumberFromBranch } from "./ship.js";
import { LABEL_HUMAN } from "./triage-labels.js";

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

export interface RetakeWorkerState {
  path: string;
  attemptDir: string;
  issue: number;
  sessionArtifact?: string;
  attempt?: number;
  phase?: string;
  outcome?: string;
  lastExitCode?: number;
}

export type RetakeChecksState = "green" | "pending" | "failing" | "unknown";

export type RetakeRecommendationKind =
  | "resolve-hitl"
  | "continue-state"
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

export interface RetakeApplyOperation {
  cmd: "git";
  args: readonly string[];
  cwd?: string;
  label: string;
}

export interface RetakeApplyPlan {
  summary: string;
  operations: readonly RetakeApplyOperation[];
  nextCommand?: string;
}

export interface RetakeFacts {
  issue: RetakeIssue;
  pullRequests: readonly RetakePullRequest[];
  branches: readonly RetakeBranch[];
  worktrees: readonly RetakeWorktree[];
  workerState?: RetakeWorkerState;
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
  if (pr.headRefName !== undefined && branchMatchesIssue(pr.headRefName, issue)) return true;
  if (new RegExp(`(?:^|[^0-9#])#?${issue}(?:[^0-9]|$)`).test(pr.title)) return true;
  return new RegExp(`(?:^|[^0-9])#${issue}(?:[^0-9]|$)|/issues/${issue}(?:[^0-9]|$)`).test(pr.body ?? "");
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

/**
 * The tail command for a finished branch: adopt it through the ADR-0055
 * no-agent landing lane. `/ship` is retired, so retake never suggests it.
 */
function adoptCommand(issue: number, pr: RetakePullRequest): string {
  const guidance = "Hand-done work adopted via /retake; run the gate.";
  if (pr.headRefName === undefined || pr.headRefName.trim() === "") {
    return `red-skills-dev requeue ${issue} --guidance '${guidance}'`;
  }
  return `red-skills-dev requeue ${issue} --adopt-branch ${normalizeBranchName(pr.headRefName)} --guidance '${guidance}'`;
}

function worktreeCommandForPr(issue: number, pr: RetakePullRequest): string {
  if (pr.headRefName === undefined || pr.headRefName.trim() === "") {
    return `gh pr checkout ${pr.number}`;
  }
  const branch = normalizeBranchName(pr.headRefName);
  return `git fetch origin ${branch}:${branch} && git worktree add .red/tmp/work-ship-${issue} ${branch}`;
}

function matchingWorktreeForPr(
  worktrees: readonly RetakeWorktree[],
  issue: number,
  pr: RetakePullRequest,
): RetakeWorktree | undefined {
  const matchingWorktrees = worktrees.filter((worktree) => worktreeMatchesIssue(worktree, issue));
  return matchingWorktrees.find((candidate) =>
    candidate.branch !== undefined &&
    pr.headRefName !== undefined &&
    normalizeBranchName(candidate.branch) === normalizeBranchName(pr.headRefName)
  );
}

export function recommendRetake(facts: RetakeFacts): RetakeRecommendation {
  const labels = new Set(facts.issue.labels);
  const openPrs = facts.pullRequests.filter((pr) => pr.state.toUpperCase() === "OPEN");
  const matchingWorktrees = facts.worktrees.filter((worktree) => worktreeMatchesIssue(worktree, facts.issue.number));
  const dirtyWorktree = matchingWorktrees.find((worktree) => worktree.dirty);

  if (labels.has(LABEL_HUMAN)) {
    return {
      kind: "resolve-hitl",
      summary: "Issue is waiting for a human decision before agents can continue.",
      command: `/hitl #${facts.issue.number}`,
    };
  }

  if (facts.workerState !== undefined && facts.workerState.issue === facts.issue.number) {
    const suffix =
      facts.workerState.outcome !== undefined
        ? ` Last recorded outcome: ${facts.workerState.outcome}.`
        : "";
    return {
      kind: "continue-state",
      summary: `Worker state file anchors attempt ${facts.workerState.attempt ?? "?"}.${suffix}`,
      command: `cd ${facts.workerState.attemptDir}`,
    };
  }

  const blockedPr = openPrs.find((pr) =>
    pr.reviewDecision?.toUpperCase() === "CHANGES_REQUESTED" ||
    pr.checksState === "failing" ||
    pr.checksState === "pending"
  );
  if (blockedPr !== undefined) {
    const worktree = matchingWorktreeForPr(facts.worktrees, facts.issue.number, blockedPr);
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
    const worktree = matchingWorktreeForPr(facts.worktrees, facts.issue.number, shippablePr);
    return {
      kind: "ship-pr",
      summary: `PR #${shippablePr.number} is open; adopt its branch through the no-agent landing lane once the worktree is clean.`,
      command: worktree !== undefined
        ? `cd ${worktree.path} && ${adoptCommand(facts.issue.number, shippablePr)}`
        : `${worktreeCommandForPr(facts.issue.number, shippablePr)} && cd .red/tmp/work-ship-${facts.issue.number} && ${adoptCommand(facts.issue.number, shippablePr)}`,
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

export function planRetakeApply(facts: RetakeFacts): RetakeApplyPlan {
  const recommendation = recommendRetake(facts);
  const issue = facts.issue.number;
  const worktreePath = `.red/tmp/work-ship-${issue}`;

  if (recommendation.kind === "continue-state") {
    return {
      summary: recommendation.summary,
      operations: [],
      nextCommand: recommendation.command,
    };
  }

  if (recommendation.kind === "create-branch") {
    const branch = `codex/${issue}-retake`;
    return {
      summary: `Create ${worktreePath} on ${branch}.`,
      operations: [{
        cmd: "git",
        args: ["worktree", "add", worktreePath, "-b", branch, "origin/main"],
        label: "create fresh ship worktree",
      }],
      nextCommand: `cd ${worktreePath}`,
    };
  }

  if (recommendation.kind === "create-worktree") {
    const branch = facts.branches.find((candidate) => !candidate.remote) ?? facts.branches[0];
    if (branch === undefined) {
      return { summary: "No matching branch is available to recreate a worktree.", operations: [] };
    }
    const args = branch.remote
      ? ["worktree", "add", worktreePath, "-b", normalizeBranchName(branch.name), branch.name]
      : ["worktree", "add", worktreePath, branch.name];
    return {
      summary: `Create ${worktreePath} from ${branch.name}.`,
      operations: [{ cmd: "git", args, label: "create ship worktree from matching branch" }],
      nextCommand: `cd ${worktreePath}`,
    };
  }

  if (recommendation.kind === "fix-pr" || recommendation.kind === "ship-pr") {
    const openPrs = facts.pullRequests.filter((pr) => pr.state.toUpperCase() === "OPEN");
    const pr = recommendation.kind === "fix-pr"
      ? openPrs.find((candidate) =>
        candidate.reviewDecision?.toUpperCase() === "CHANGES_REQUESTED" ||
        candidate.checksState === "failing" ||
        candidate.checksState === "pending"
      )
      : openPrs.find((candidate) => candidate.checksState === "green" || candidate.checksState === "unknown") ?? openPrs[0];
    if (pr === undefined) return { summary: "No open PR is available to apply.", operations: [] };
    const worktree = matchingWorktreeForPr(facts.worktrees, issue, pr);
    if (worktree !== undefined) {
      return {
        summary: `Matching worktree already exists for PR #${pr.number}.`,
        operations: [],
        nextCommand: recommendation.kind === "ship-pr"
          ? `cd ${worktree.path} && ${adoptCommand(issue, pr)}`
          : `cd ${worktree.path}`,
      };
    }
    if (pr.headRefName === undefined || pr.headRefName.trim() === "") {
      return { summary: `PR #${pr.number} has no head branch name; cannot apply safely.`, operations: [] };
    }
    const branch = normalizeBranchName(pr.headRefName);
    return {
      summary: `Create ${worktreePath} for PR #${pr.number}.`,
      operations: [
        { cmd: "git", args: ["fetch", "origin", `${branch}:${branch}`], label: "fetch PR head branch" },
        { cmd: "git", args: ["worktree", "add", worktreePath, branch], label: "create ship worktree for PR" },
      ],
      nextCommand: recommendation.kind === "ship-pr"
        ? `cd ${worktreePath} && ${adoptCommand(issue, pr)}`
        : `cd ${worktreePath}`,
    };
  }

  return {
    summary: `Nothing safe to apply automatically for ${recommendation.kind}.`,
    operations: [],
    nextCommand: recommendation.command,
  };
}
