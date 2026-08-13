import { execTool, type ExecFn, type ExecOutput } from "../runtime/exec.js";
import { join, dirname } from "node:path";
import { tmpDir } from "@reddb-io/shared/red-paths.js";
import { readAllWorkerStates } from "../core/worker-state-reader.js";
import {
  branchMatchesIssue,
  normalizeBranchName,
  parseIssueSpecifier,
  planRetakeApply,
  pullRequestMatchesIssue,
  recommendRetake,
  summarizeChecks,
  type RetakeApplyPlan,
  type RetakeBranch,
  type RetakeFacts,
  type RetakeIssue,
  type RetakePullRequest,
  type RetakeWorktree,
  type RetakeWorkerState,
} from "../core/retake.js";

interface RetakeFlags {
  issue: number;
  apply: boolean;
  json: boolean;
  repo?: string;
  prLimit: number;
}

interface WorktreeRecord {
  path: string;
  branch?: string;
}

function parseRetakeFlags(args: readonly string[]): RetakeFlags {
  let issue: number | undefined;
  let apply = false;
  let json = false;
  let repo: string | undefined;
  let prLimit = 200;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--apply") {
      apply = true;
      continue;
    }
    if (arg === "--repo" || arg === "-R") {
      const value = args[++i];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      repo = value;
      continue;
    }
    if (arg === "--pr-limit") {
      const value = args[++i];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      prLimit = parseLimit(value);
      continue;
    }
    if (arg.startsWith("--repo=")) {
      repo = arg.slice("--repo=".length);
      continue;
    }
    if (arg.startsWith("--pr-limit=")) {
      prLimit = parseLimit(arg.slice("--pr-limit=".length));
      continue;
    }
    if (arg.startsWith("-")) throw new Error(`unknown retake argument: ${arg}`);
    if (issue !== undefined) throw new Error(`/retake accepts one issue number; got extra argument ${arg}`);
    issue = parseIssueSpecifier(arg);
  }

  if (issue === undefined) throw new Error("/retake requires an issue number like #123");
  return { issue, apply, json, repo, prLimit };
}

function parseLimit(raw: string): number {
  const limit = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error(`invalid --pr-limit: ${raw}`);
  }
  return limit;
}

function parseJson<T>(stdout: string, fallback: T): T {
  try {
    return JSON.parse(stdout || "") as T;
  } catch {
    return fallback;
  }
}

async function required(exec: ExecFn, cmd: string, args: readonly string[], cwd: string, label: string): Promise<ExecOutput> {
  const out = await exec(cmd, args, { cwd, maxBuffer: 32 * 1024 * 1024 });
  if (out.code !== 0) {
    throw new Error(`${label} failed: ${out.stderr.trim() || out.stdout.trim() || `${cmd} ${args.join(" ")}`}`);
  }
  return out;
}

async function resolveRepo(exec: ExecFn, cwd: string, explicit?: string): Promise<string> {
  if (explicit?.trim()) return explicit.trim();
  const out = await required(exec, "gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], cwd, "resolve repo");
  return out.stdout.trim();
}

async function collectIssue(exec: ExecFn, cwd: string, repo: string, issue: number): Promise<RetakeIssue> {
  const out = await required(
    exec,
    "gh",
    ["issue", "view", String(issue), "--repo", repo, "--json", "number,title,state,labels,url"],
    cwd,
    "read issue",
  );
  const raw = parseJson<{
    number?: unknown;
    title?: unknown;
    state?: unknown;
    labels?: Array<{ name?: unknown }>;
    url?: unknown;
  }>(out.stdout, {});
  return {
    number: Number(raw.number ?? issue),
    title: typeof raw.title === "string" ? raw.title : "",
    state: typeof raw.state === "string" ? raw.state : "",
    labels: Array.isArray(raw.labels)
      ? raw.labels.map((label) => typeof label.name === "string" ? label.name : "").filter(Boolean)
      : [],
    url: typeof raw.url === "string" ? raw.url : undefined,
  };
}

function prFrom(raw: unknown): RetakePullRequest {
  const rec = raw as {
    number?: unknown;
    title?: unknown;
    state?: unknown;
    url?: unknown;
    body?: unknown;
    headRefName?: unknown;
    baseRefName?: unknown;
    reviewDecision?: unknown;
    statusCheckRollup?: unknown[];
  };
  return {
    number: Number(rec.number ?? 0),
    title: typeof rec.title === "string" ? rec.title : "",
    state: typeof rec.state === "string" ? rec.state : "",
    url: typeof rec.url === "string" ? rec.url : undefined,
    body: typeof rec.body === "string" ? rec.body : undefined,
    headRefName: typeof rec.headRefName === "string" ? rec.headRefName : undefined,
    baseRefName: typeof rec.baseRefName === "string" ? rec.baseRefName : undefined,
    reviewDecision: typeof rec.reviewDecision === "string" ? rec.reviewDecision : undefined,
    checksState: summarizeChecks(Array.isArray(rec.statusCheckRollup) ? rec.statusCheckRollup : []),
  };
}

async function readPullRequests(exec: ExecFn, cwd: string, repo: string, args: readonly string[]): Promise<RetakePullRequest[]> {
  const out = await exec("gh", args, { cwd, maxBuffer: 32 * 1024 * 1024 });
  if (out.code !== 0) return [];
  const rows = parseJson<unknown[]>(out.stdout, []);
  return Array.isArray(rows) ? rows.map(prFrom).filter((pr) => pr.number > 0) : [];
}

async function collectPullRequests(exec: ExecFn, cwd: string, repo: string, issue: number, limit: number): Promise<RetakePullRequest[]> {
  const fields = "number,title,body,state,url,headRefName,baseRefName,reviewDecision,statusCheckRollup";
  const recent = await readPullRequests(exec, cwd, repo, [
    "pr",
    "list",
    "--repo",
    repo,
    "--state",
    "all",
    "--limit",
    String(limit),
    "--json",
    fields,
  ]);
  const searched = await readPullRequests(exec, cwd, repo, [
    "pr",
    "list",
    "--repo",
    repo,
    "--state",
    "all",
    "--limit",
    "100",
    "--search",
    `#${issue}`,
    "--json",
    fields,
  ]);
  const byNumber = new Map<number, RetakePullRequest>();
  for (const pr of [...recent, ...searched]) {
    if (pullRequestMatchesIssue(pr, issue)) byNumber.set(pr.number, pr);
  }
  return [...byNumber.values()].sort((a, b) => b.number - a.number);
}

async function collectBranches(exec: ExecFn, cwd: string, issue: number): Promise<RetakeBranch[]> {
  const local = await required(exec, "git", ["branch", "--format=%(refname:short)"], cwd, "list local branches");
  const remote = await required(exec, "git", ["for-each-ref", "--format=%(refname:short)", "refs/remotes"], cwd, "list remote branches");
  const branches: RetakeBranch[] = [];
  for (const line of local.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
    if (branchMatchesIssue(line, issue)) branches.push({ name: line, remote: false });
  }
  for (const line of remote.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
    if (line.endsWith("/HEAD")) continue;
    if (branchMatchesIssue(line, issue)) branches.push({ name: line, remote: true });
  }
  return branches;
}

function parseWorktreeList(stdout: string): WorktreeRecord[] {
  const records: WorktreeRecord[] = [];
  let current: WorktreeRecord | undefined;
  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      if (current !== undefined) records.push(current);
      current = { path: line.slice("worktree ".length).trim() };
      continue;
    }
    if (current !== undefined && line.startsWith("branch ")) {
      current.branch = normalizeBranchName(line.slice("branch ".length).trim());
    }
  }
  if (current !== undefined) records.push(current);
  return records;
}

async function collectWorktrees(exec: ExecFn, cwd: string, issue: number): Promise<RetakeWorktree[]> {
  const out = await required(exec, "git", ["worktree", "list", "--porcelain"], cwd, "list worktrees");
  const records = parseWorktreeList(out.stdout)
    .filter((record) =>
      (record.branch !== undefined && branchMatchesIssue(record.branch, issue)) ||
      new RegExp(`(?:^|[/._-])${issue}(?:[/._-]|$)`).test(record.path)
    );
  const worktrees: RetakeWorktree[] = [];
  for (const record of records) {
    const status = await exec("git", ["-C", record.path, "status", "--porcelain"], { cwd });
    worktrees.push({
      path: record.path,
      branch: record.branch,
      dirty: status.code === 0 && status.stdout.trim() !== "",
    });
  }
  return worktrees;
}

async function collectWorkerState(cwd: string, issue: number): Promise<RetakeWorkerState | undefined> {
  const records = await readAllWorkerStates(tmpDir(cwd)).catch(() => []);
  const matches = records
    .filter((record) => Number(record.state.current.number) === issue)
    .sort((a, b) => String(b.state.current.last_event_at ?? "").localeCompare(String(a.state.current.last_event_at ?? "")));
  const rec = matches[0];
  if (rec === undefined) return undefined;
  const current = rec.state.current;
  const lastExitCode = Number((current as Record<string, unknown>).last_exit_code);
  return {
    path: rec.path,
    attemptDir: dirname(rec.path),
    issue,
    // Attempt ordinals are retired (ADR 0103); a resumable issue has one attempt.
    attempt: undefined,
    sessionArtifact: rec.state.session_artifact || undefined,
    phase: typeof current.phase === "string" ? current.phase : undefined,
    outcome: typeof (current as Record<string, unknown>).outcome === "string"
      ? String((current as Record<string, unknown>).outcome)
      : undefined,
    lastExitCode: Number.isFinite(lastExitCode) ? lastExitCode : undefined,
  };
}

async function collectRetakeFacts(exec: ExecFn, cwd: string, flags: RetakeFlags): Promise<RetakeFacts> {
  const repo = await resolveRepo(exec, cwd, flags.repo);
  const [issue, pullRequests, branches, worktrees, workerState] = await Promise.all([
    collectIssue(exec, cwd, repo, flags.issue),
    collectPullRequests(exec, cwd, repo, flags.issue, flags.prLimit),
    collectBranches(exec, cwd, flags.issue),
    collectWorktrees(exec, cwd, flags.issue),
    collectWorkerState(cwd, flags.issue),
  ]);
  return { issue, pullRequests, branches, worktrees, workerState };
}

export function renderRetakeReport(facts: RetakeFacts): string {
  const recommendation = recommendRetake(facts);
  const lines: string[] = [];
  lines.push(`/retake #${facts.issue.number}: ${facts.issue.title || "(untitled)"}`);
  lines.push(`issue: ${facts.issue.state || "unknown"}${facts.issue.labels.length > 0 ? ` labels=${facts.issue.labels.join(",")}` : ""}${facts.issue.url ? ` ${facts.issue.url}` : ""}`);
  lines.push("");
  lines.push("pull requests:");
  if (facts.pullRequests.length === 0) lines.push("  none found");
  for (const pr of facts.pullRequests) {
    lines.push(`  #${pr.number} ${pr.state || "unknown"} ${pr.headRefName ?? "(no-head)"} checks=${pr.checksState ?? "unknown"} review=${pr.reviewDecision || "none"}${pr.url ? ` ${pr.url}` : ""}`);
  }
  lines.push("");
  lines.push("branches:");
  if (facts.branches.length === 0) lines.push("  none found");
  for (const branch of facts.branches) {
    lines.push(`  ${branch.remote ? "remote" : "local"} ${branch.name}`);
  }
  lines.push("");
  lines.push("worktrees:");
  if (facts.worktrees.length === 0) lines.push("  none found");
  for (const worktree of facts.worktrees) {
    lines.push(`  ${worktree.path} ${worktree.branch ?? "(detached)"} ${worktree.dirty ? "dirty" : "clean"}`);
  }
  lines.push("");
  lines.push("worker state:");
  if (facts.workerState === undefined) {
    lines.push("  none found");
  } else {
    const s = facts.workerState;
    lines.push(
      `  ${s.attemptDir} phase=${s.phase ?? "unknown"} outcome=${s.outcome ?? "unknown"} exit=${s.lastExitCode ?? "unknown"}`,
    );
    if (s.sessionArtifact) lines.push(`  session evidence: ${s.sessionArtifact}`);
  }
  lines.push("");
  lines.push(`next: ${recommendation.summary}`);
  if (recommendation.command !== undefined) lines.push(`cmd: ${recommendation.command}`);
  return lines.join("\n");
}

async function applyRetakePlan(
  exec: ExecFn,
  cwd: string,
  plan: RetakeApplyPlan,
  stdout?: NodeJS.WritableStream,
): Promise<string[]> {
  const applied: string[] = [];
  stdout?.write(`apply: ${plan.summary}\n`);
  if (plan.operations.length === 0) {
    stdout?.write("apply: no operation executed\n");
  }
  for (const operation of plan.operations) {
    stdout?.write(`apply: ${operation.label}: ${operation.cmd} ${operation.args.join(" ")}\n`);
    const out = await exec(operation.cmd, operation.args, { cwd: operation.cwd ?? cwd, maxBuffer: 32 * 1024 * 1024 });
    if (out.code !== 0) {
      throw new Error(`${operation.label} failed: ${out.stderr.trim() || out.stdout.trim() || `${operation.cmd} ${operation.args.join(" ")}`}`);
    }
    applied.push(operation.label);
  }
  if (plan.nextCommand !== undefined) stdout?.write(`next: ${plan.nextCommand}\n`);
  return applied;
}

/** The retake flags the MCP op and the CLI command both feed to the value core. */
export interface RetakeExecInput {
  issue: number;
  repo?: string;
  prLimit?: number;
  /** Execute the recommended apply plan (mutating). Defaults to false. */
  apply?: boolean;
}

/** The structured retake report the JSON command branch prints and the MCP op returns. */
export interface RetakeResult extends RetakeFacts {
  recommendation: ReturnType<typeof recommendRetake>;
  applyPlan: RetakeApplyPlan | undefined;
  appliedOperations: string[] | undefined;
}

/**
 * Value-returning retake core: gather the issue/PR/branch/worktree/worker facts,
 * compute the recommended next action, and (when `apply`) execute the apply plan.
 * Returns the same object the CLI `--json` branch stringifies; the MCP `retake` op
 * returns it verbatim (TOON-encoded at the transport boundary). No stdout.
 */
export async function executeRetake(
  input: RetakeExecInput,
  opts: { cwd?: string; exec?: ExecFn } = {},
): Promise<RetakeResult> {
  const cwd = opts.cwd ?? process.cwd();
  const exec = opts.exec ?? execTool;
  const flags: RetakeFlags = {
    issue: input.issue,
    apply: input.apply ?? false,
    json: true,
    repo: input.repo,
    prLimit: input.prLimit ?? 200,
  };
  const facts = await collectRetakeFacts(exec, cwd, flags);
  const recommendation = recommendRetake(facts);
  const applyPlan = flags.apply ? planRetakeApply(facts) : undefined;
  const appliedOperations =
    flags.apply && applyPlan !== undefined
      ? await applyRetakePlan(exec, cwd, applyPlan)
      : undefined;
  return { ...facts, recommendation, applyPlan, appliedOperations };
}

export async function retakeCommand(
  args: string[],
  cwd = process.cwd(),
  stdout: NodeJS.WritableStream = process.stdout,
  exec: ExecFn = execTool,
): Promise<number> {
  const flags = parseRetakeFlags(args);
  if (flags.json) {
    const result = await executeRetake(flags, { cwd, exec });
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  const facts = await collectRetakeFacts(exec, cwd, flags);
  stdout.write(`${renderRetakeReport(facts)}\n`);
  const applyPlan = flags.apply ? planRetakeApply(facts) : undefined;
  if (applyPlan !== undefined) await applyRetakePlan(exec, cwd, applyPlan, stdout);
  return 0;
}
