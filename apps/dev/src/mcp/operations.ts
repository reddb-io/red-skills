import { loadConfig, getConfig } from "../core/config.js";
import { afkPaths } from "../runtime/wire.js";
import { requestWorkerBirth, type DispatchedWorkerBirth } from "../runtime/mcp-worker-birth.js";
import { checkDispatchEngineFloor } from "../runtime/engine-floor-check.js";
import type { EngineFloorVerdict } from "../core/engine-floor.js";
import { launchDetachedRspWait } from "../runtime/rsp-wait-launch.js";
import * as ghx from "../runtime/gh.js";
import { resolveRepoContext } from "../runtime/wire.js";
import { executeRequeue } from "../commands/requeue.js";
import type { HookExec } from "../core/hook-dispatcher.js";
import type { ClaimRecord } from "../core/claim.js";
import type {
  CascadeStatusInput,
  ClaimIssueInput,
  GateRunInput,
  HitlResolveInput,
  DailyReviewInput,
  LandBranchInput,
  RequeueToolInput,
  RespondToolInput,
  RetakeToolInput,
  TriageToolInput,
  WaitStartInput,
  WeeklyReviewInput,
  WorkerDispatchInput,
  WorkerStopInput,
} from "@reddb-io/red-castle/mcp-server";
import type { DisposableIssueSpec } from "../core/go.js";

export interface DispatchOperationInput extends WorkerDispatchInput {
  request?: string;
}

export interface DevAfkMcpOperations {
  dispatchIssue(root: string, input: DispatchOperationInput & { issue: number }): Promise<unknown>;
  dispatchDemand(root: string, input: DispatchOperationInput & { demand: string }): Promise<unknown>;
  dispatchScout(root: string, input: { demand: string; runner?: string }): Promise<unknown>;
  stopWorker(root: string, input: WorkerStopInput): Promise<unknown>;
  requeue(input: RequeueToolInput): Promise<unknown>;
  retake(input: RetakeToolInput): Promise<unknown>;
  reap(): Promise<unknown>;
  unblockSweep(): Promise<unknown>;
  gateRun(input: GateRunInput): Promise<unknown>;
  landBranch(input: LandBranchInput): Promise<unknown>;
  cascadeStatus(input: CascadeStatusInput): Promise<unknown>;
  claimStatus(input: ClaimIssueInput): Promise<unknown>;
  claimRelease(input: ClaimIssueInput): Promise<unknown>;
  hitlResolve(input: HitlResolveInput): Promise<unknown>;
  mergeArm(input: { pr: number }): Promise<unknown>;
  mergeStatus(): Promise<unknown>;
  mergeRelease(input: { pr: number }): Promise<unknown>;
  waitStart(input: WaitStartInput): Promise<unknown>;
  dailyReview(input: DailyReviewInput): Promise<unknown>;
  weeklyReview(input: WeeklyReviewInput): Promise<unknown>;
  triage(input: TriageToolInput): Promise<unknown>;
  respond(input: RespondToolInput): Promise<unknown>;
  deadendAudit(): Promise<unknown>;
}

export interface DevAfkMcpRuntime {
  birthWorker(
    root: string,
    args: readonly string[],
    options?: { readonly reservation?: "interactive" },
  ): Promise<DispatchedWorkerBirth>;
  checkEngineFloor(root: string): Promise<EngineFloorVerdict>;
  launchRspWait(args: readonly string[], cwd: string): Promise<number>;
  ensureLabel(root: string, name: string): Promise<void>;
  createIssue(root: string, spec: DisposableIssueSpec): Promise<number>;
  commentIssue(root: string, issue: number, body: string): Promise<void>;
  closeIssue(root: string, issue: number): Promise<void>;
  executeRequeue(root: string, input: RequeueToolInput): Promise<unknown>;
  hookExec?: HookExec;
}

export function dispatchArgs(input: DispatchOperationInput): string[] {
  const args: string[] = [];
  if (input.runner) args.push("--runner", input.runner);
  if (input.request) args.push("--request", input.request);
  return args;
}

export { resolveRspCliBundle } from "../runtime/rsp-wait-launch.js";

export function buildWaitArgs(
  kind: WaitStartInput["kind"],
  target: string,
  resultFile: string,
  opts: { timeout_ms?: number; reason?: string },
): string[] {
  const args: string[] = ["wait", kind];
  if (kind !== "cmd" && kind !== "release") {
    args.push(target);
  }
  if (kind === "release" && target !== "*") {
    args.push("--tag", target);
  }
  if (opts.timeout_ms !== undefined) args.push("--timeout", String(opts.timeout_ms));
  if (opts.reason) args.push("--reason", opts.reason);
  args.push("--result-file", resultFile);
  if (kind === "cmd") {
    args.push("--", target);
  }
  return args;
}

export const defaultMcpRuntime: DevAfkMcpRuntime = {
  birthWorker: (root, args, options) => requestWorkerBirth(root, args, options),
  checkEngineFloor: (root) => checkDispatchEngineFloor(root),
  launchRspWait: launchDetachedRspWait,
  async ensureLabel(root, name) {
    const context = await resolveRepoContext(root);
    await ghx.ensureLabel({ cwd: context.root, repo: context.repo }, name);
  },
  async createIssue(root, spec) {
    const context = await resolveRepoContext(root);
    return ghx.createIssue({ cwd: context.root, repo: context.repo }, spec);
  },
  async commentIssue(root, issue, body) {
    const context = await resolveRepoContext(root);
    await ghx.comment({ cwd: context.root, repo: context.repo }, issue, body);
  },
  async closeIssue(root, issue) {
    const context = await resolveRepoContext(root);
    await ghx.closeIssue({ cwd: context.root, repo: context.repo }, issue);
  },
  executeRequeue: (root, input) => executeRequeue(input, { cwd: root }),
};

export function resolveConfiguredBase(root: string, base?: string): string {
  if (base) return base;
  const config = loadConfig(afkPaths(root).configPath, { warn: () => undefined });
  return getConfig(config, "dev.trunk") || "main";
}

export function latestClaimPerWorker(records: readonly ClaimRecord[]): Map<string, ClaimRecord> {
  const latest = new Map<string, ClaimRecord>();
  for (const record of records) {
    const seen = latest.get(record.worker);
    if (!seen || record.commentId > seen.commentId) latest.set(record.worker, record);
  }
  return latest;
}
