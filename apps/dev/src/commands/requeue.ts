// commands/requeue.ts — the IO half of `dev requeue` (issue #850).
//
// The SAFE requeue path for an issue parked behind an active `## Current
// blocker`. A maintainer who only flips labels back to `ready-for-agent`
// creates a silent no-op loop: AFK preflight re-reads the active non-mechanical
// blocker and re-parks the issue. This command applies the WHOLE transition as
// one operation — clear/archive the active blocker in the body, drop the stale
// `ready-for-human` + `blocked:*` labels, add `ready-for-agent`, and record the
// human guidance as a directive comment. The pure planner lives in
// `core/requeue.ts`; `/hitl` is the interactive sibling for when the human
// decision still has to be extracted.
//
// ADR 0081 adds an `--adopt-branch BRANCH` mode: when a maintainer has done the
// work by hand on an existing branch, requeue adopts that branch and routes it
// through the no-agent landing lane (ADR 0055 reconcile) — gate-only, no agent
// re-run. The real adopt runner is built here; `RequeueAdoptRunner` is injectable
// for tests (mirrors how `RequeueGh` is injected).

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { Writable } from "node:stream";
import { LIVENESS_LANE_FILENAME } from "@reddb-io/red-castle";
import { encodeLines } from "@reddb-io/toon";
import { parseFlags, type FlagSchema } from "@reddb-io/shared/args.js";
import { execTool, type ExecFn } from "../runtime/exec.js";
import { scrubOutbound } from "../runtime/outbound-redaction.js";
import { planRequeue, type RequeuePlan } from "../core/requeue.js";
import {
  applyTransition,
  isRefused,
  planTransition,
} from "../core/state-transition.js";
import { parseClaimRecords, renderClaimComment, type RawClaimComment } from "../core/claim.js";
import { LABEL_READY } from "../core/triage-labels.js";
import { reconcile, type ReconcileDeps, type ReconcileInput } from "../core/reconcile.js";
import { HOST_RECONCILE_PORTS } from "../core/reconcile-ports.js";
import {
  REQUEUE_ORIGIN,
  withAdoptPresence,
  type AdoptPresenceIo,
} from "../core/adopt-presence.js";
import { initStateSync, readPidStartTime, updateState, writeIdentitySync } from "../core/state.js";
import { makeFeedbackWorktree } from "../runtime/feedback-worktree.js";
import { pathExists, removeDir } from "../runtime/fs.js";
import { afkPaths, editLabelsWithStatuslineCache, resolveRepoSlug, statuslineCountCachePath } from "../runtime/wire.js";
import { branchLockPath, isLocked, readLockedBranch } from "../runtime/lock.js";
import { resolveBase } from "../core/base-resolver.js";
import { getConfig, loadConfig, readHitlTypeLabels, readSetupCommands, readValidationResourceBudget } from "../core/config.js";
import * as ghx from "../runtime/gh.js";
import * as gitx from "../runtime/git.js";
import type { GhContext } from "../runtime/gh.js";
import type { GitContext } from "../runtime/git.js";
import type { Runner } from "../types/runner.js";

export interface RequeueGh {
  view(issue: number): Promise<{ state: string; body: string; labels: string[] }>;
  editBody(issue: number, body: string): Promise<void>;
  editLabels(issue: number, remove: string[], add: string[]): Promise<void>;
  comment(issue: number, body: string): Promise<void>;
  listClaims?(issue: number): Promise<RawClaimComment[]>;
  postClaim?(issue: number, body: string): Promise<void>;
}

/** Metadata passed to the adopt runner after the requeue transition is applied. */
export interface RequeueAdoptData {
  title: string;
  body: string;
  labels: readonly string[];
}

/**
 * Injectable adopt runner — builds the reconcile deps and calls reconcile()
 * (ADR 0055 no-agent landing lane) for a hand-done branch. The real runner is
 * built by `runAdoptLanding`; tests inject a stub. Returns the reconcile outcome.
 */
export type RequeueAdoptRunner = (
  issue: number,
  branch: string,
  issueData: RequeueAdoptData,
) => Promise<"landed" | "parked" | "skipped">;

export interface RequeueExecutionInput {
  issue: number;
  guidance: string;
  repo?: string;
  dryRun?: boolean;
  adoptBranch?: string;
}

export type RequeueExecutionOutcome =
  | "requeued"
  | "no-op"
  | "dry-run"
  | "closed"
  | "refused"
  | "landed"
  | "parked"
  | "skipped";

export interface RequeueExecutionResult {
  issue: number;
  plan: RequeuePlan | null;
  applied: boolean;
  outcome: RequeueExecutionOutcome;
  exitCode: number;
  reason?: string;
  adoptBranch?: string;
  removeLabels?: string[];
  addLabels?: string[];
}

export interface RequeueBaseFreshnessResult {
  ok: boolean;
  evidence: string;
}

export type RequeueBaseFreshnessVerifier = (
  issueBody: string,
) => Promise<RequeueBaseFreshnessResult>;

export interface RequeueExecutionOptions {
  cwd?: string;
  gh?: RequeueGh;
  adoptRunner?: RequeueAdoptRunner;
  verifyBaseFreshness?: RequeueBaseFreshnessVerifier;
  /** Optional sink for the adopt gate's live progress. MCP callers omit it. */
  progress?: NodeJS.WritableStream;
}

const REQUEUE_FLAG_SCHEMA = {
  guidance: { kind: "value", coerce: (raw: string): string => raw },
  repo: { kind: "value", aliases: ["R"], coerce: (raw: string): string => raw },
  json: { kind: "boolean" },
  "dry-run": { kind: "boolean" },
  "adopt-branch": { kind: "value", coerce: (raw: string): string => raw },
} satisfies FlagSchema;

function parseIssue(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number.parseInt(raw.replace(/^#/, ""), 10);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

function ghFor(cwd: string, repo: string): RequeueGh {
  const repoArgs = repo ? ["--repo", repo] : [];
  const countCachePath = statuslineCountCachePath(cwd);
  const run = (args: readonly string[]): ReturnType<ExecFn> =>
    execTool("gh", args, { cwd, maxBuffer: 32 * 1024 * 1024 });
  return {
    async view(issue) {
      const out = await run(["issue", "view", String(issue), ...repoArgs, "--json", "state,body,labels"]);
      if (out.code !== 0) throw new Error(`read issue #${issue} failed: ${out.stderr.trim() || out.stdout.trim()}`);
      const raw = JSON.parse(out.stdout || "{}") as { state?: string; body?: string; labels?: Array<{ name?: string }> };
      return {
        state: typeof raw.state === "string" ? raw.state : "",
        body: typeof raw.body === "string" ? raw.body : "",
        labels: Array.isArray(raw.labels) ? raw.labels.map((l) => String(l.name ?? "")).filter(Boolean) : [],
      };
    },
    async editBody(issue, body) {
      const out = await run(["issue", "edit", String(issue), ...repoArgs, "--body", scrubOutbound(body)]);
      if (out.code !== 0) throw new Error(`edit body #${issue} failed: ${out.stderr.trim() || out.stdout.trim()}`);
    },
    async editLabels(issue, remove, add) {
      const args = ["issue", "edit", String(issue), ...repoArgs];
      for (const l of remove) args.push("--remove-label", l);
      for (const l of add) args.push("--add-label", l);
      const ok = await editLabelsWithStatuslineCache(
        countCachePath,
        async () => {
          const out = await run(args);
          if (out.code !== 0) throw new Error(`edit labels #${issue} failed: ${out.stderr.trim() || out.stdout.trim()}`);
          return true;
        },
        remove,
        add,
      );
      if (!ok) throw new Error(`edit labels #${issue} failed`);
    },
    async comment(issue, body) {
      await run(["issue", "comment", String(issue), ...repoArgs, "--body", scrubOutbound(body)]);
    },
    listClaims: (issue) => ghx.listClaimComments({ cwd, repo }, issue),
    postClaim: async (issue, body) => {
      await ghx.postClaimComment({ cwd, repo }, issue, body);
    },
  };
}

async function verifyFreshBase(
  cwd: string,
  issueBody: string,
): Promise<RequeueBaseFreshnessResult> {
  const paths = afkPaths(cwd);
  const config = loadConfig(paths.configPath, { warn: () => undefined });
  const base = await resolveBase(
    { issueBody },
    {
      readLockedBranch: () => readLockedBranch(branchLockPath(cwd)),
      configLockedBranch: getConfig(config, "dev.lock.branch") || undefined,
      configTrunk: getConfig(config, "dev.trunk") || undefined,
      fetchIssueBody: async () => undefined,
    },
  );
  const resolved = await gitx.resolveFreshBase({ cwd }, { base });
  if (!resolved.ok) {
    return {
      ok: false,
      evidence: resolved.message ?? `could not refresh base ${base}`,
    };
  }
  return {
    ok: true,
    evidence: `refreshed ${base} from origin/${base}`,
  };
}

function activeClaimOwners(comments: readonly RawClaimComment[]): string[] {
  interface Fold {
    latestId: number;
    latestKind: "claim" | "concede";
  }
  const folds = new Map<string, Fold>();
  for (const r of parseClaimRecords(comments)) {
    const f = folds.get(r.worker);
    if (!f || r.commentId >= f.latestId) {
      folds.set(r.worker, { latestId: r.commentId, latestKind: r.kind });
    }
  }
  return [...folds.entries()]
    .filter(([, f]) => f.latestKind === "claim")
    .map(([worker]) => worker)
    .sort();
}

async function sweepRequeueClaims(gh: RequeueGh, issue: number): Promise<string[]> {
  if (!gh.listClaims || !gh.postClaim) return [];
  const owners = activeClaimOwners(await gh.listClaims(issue));
  for (const owner of owners) {
    await gh.postClaim(issue, renderClaimComment({ worker: owner }, "concede"));
  }
  if (owners.length > 0) {
    const who = owners.map((owner) => `\`${owner}\``).join(", ");
    await gh.comment(
      issue,
      `🤖 /requeue claim sweep: conceded active AFK claim ${owners.length === 1 ? "marker" : "markers"} on behalf of ${who} before requeueing.`,
    );
  }
  return owners;
}

function directiveComment(plan: RequeuePlan, guidance?: string): string {
  const lines = [
    "<details data-kind=\"directive\">",
    "<summary>Requeue</summary>",
    "",
    "Human guidance:",
    guidance?.trim() || "(none recorded)",
    "",
    `Disposition:\nrequeued to ready-for-agent${plan.activeBlocker ? ` (cleared active blocker: ${plan.activeBlocker.kind})` : ""}`,
    "</details>",
  ];
  return lines.join("\n");
}

async function resolveRepo(cwd: string, explicit?: string): Promise<string> {
  if (explicit?.trim()) return explicit.trim();
  const r = await execTool("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], { cwd });
  return r.code === 0 ? r.stdout.trim() : "";
}

/** Append one liveness-lane record so the (un-poisonable) liveness evaluator
 * reads the adopt-landing presence row as fresh/`alive` for the idle window
 * (#1306). Synchronous + best-effort — it mirrors the JSONL shape red-castle's
 * `LivenessLane` writes, so `parseLivenessRecords` reads it back unchanged. */
function appendAdoptLivenessRecord(attemptDir: string): void {
  try {
    mkdirSync(attemptDir, { recursive: true });
    appendFileSync(
      join(attemptDir, LIVENESS_LANE_FILENAME),
      encodeLines().push({ at: Date.now(), kind: "iteration-start" }),
    );
  } catch {
    // best-effort: the presence row still renders on pid liveness alone.
  }
}

/**
 * The real presence IO for the adopt-landing lane (#1306): seeds a live
 * `origin="requeue"` worker-presence state file under the canonical workers
 * root via the SAME `initStateSync`/`writeIdentitySync` helpers the AFK worker
 * uses, advances its stage as reconcile progresses, and marks it not-live
 * (`pid: 0`) + removes the attempt dir in the teardown. Every write is
 * best-effort — presence must never block or fail the adopt landing.
 */
export function makeAdoptPresenceIo(runner: Runner): AdoptPresenceIo {
  return {
    seed(input) {
      try {
        const startedAt = new Date().toISOString();
        initStateSync(input.statePath, {
          worker_id: input.worker,
          pid: process.pid,
          pid_start_time: readPidStartTime(process.pid) ?? "",
          runner,
          // Spawn-time provenance (#1306): the origin-agnostic reader renders
          // this as the row's per-source count, distinct from afk/go.
          origin: REQUEUE_ORIGIN,
          log: join(dirname(input.attemptDir), "worker.log.toonl"),
          started_at: startedAt,
          "current.number": input.issue,
          "current.title": input.title,
          "current.started_at": startedAt,
          "current.runner": runner,
          "current.activity": input.stage,
          "current.phase": "validating",
        });
        writeIdentitySync(input.attemptDir, {
          worker_id: input.worker,
          runner,
          origin: REQUEUE_ORIGIN,
          number: input.issue,
          started_at: startedAt,
        });
        appendAdoptLivenessRecord(input.attemptDir);
      } catch {
        // best-effort — a failed seed must never block the adopt landing.
      }
    },
    async setStage(statePath, stage) {
      try {
        await updateState(statePath, {
          "current.activity": stage,
          "current.phase": stage === "landing" ? "merging" : "validating",
        });
        appendAdoptLivenessRecord(dirname(statePath));
      } catch {
        // best-effort — stage is cosmetic; never fail the reconcile on it.
      }
    },
    async teardown(statePath, attemptDir) {
      // Mark not-live first (so a mid-teardown reader never sees a live ghost),
      // then remove the short-lived attempt dir so no residue is left behind.
      try {
        if (await pathExists(statePath)) {
          await updateState(statePath, { pid: 0 }, { allowPidReset: true });
        }
      } catch {
        // best-effort
      }
      await removeDir(attemptDir).catch(() => {});
    },
  };
}

/**
 * Build the real adopt runner: wires ReconcileDeps and calls reconcile() (ADR
 * 0055) for a hand-done branch. Mirrors makeBootReconcileRunner in commands/run.ts
 * but is scoped to the requeue adopt path — no claim dir, no AFK worker machinery,
 * no envelope history. Gate authority is the same runFeedback (via feedback worktree).
 */
async function runAdoptLanding(
  issue: number,
  branch: string,
  issueData: RequeueAdoptData,
  cwd: string,
  repo: string,
  stdout: NodeJS.WritableStream,
): Promise<"landed" | "parked" | "skipped"> {
  const paths = afkPaths(cwd);
  const countCachePath = statuslineCountCachePath(cwd);
  const ghCtx: GhContext = { cwd, repo };
  const gitCtx: GitContext = { cwd };
  const lockPath = branchLockPath(cwd);
  const feedbackDir = join(paths.adoptWorktreesDir, String(issue));
  const config = loadConfig(paths.configPath, { warn: () => undefined });
  const feedback = makeFeedbackWorktree(cwd, feedbackDir, undefined, {
    resourceBudget: readValidationResourceBudget(config),
    setupCommands: readSetupCommands(config),
  });

  // Bound to the live worker-presence row's stage inside withAdoptPresence
  // below; reconcile's `markStage` calls through it (#1306).
  let presenceStage: ((stage: "validating" | "landing") => Promise<void>) | undefined;

  try {
    const base = await resolveBase(
      { issueBody: issueData.body },
      {
        readLockedBranch: () => readLockedBranch(lockPath),
        configLockedBranch: undefined,
        configTrunk: getConfig(config, "dev.trunk") || undefined,
        fetchIssueBody: async () => undefined,
      },
    );

    // Re-read the issue title for the ReconcileInput — the gh view already gave
    // us body+labels but not the title. The title is used in landing artifacts.
    let title = `Issue #${issue}`;
    try {
      const r = await execTool("gh", ["issue", "view", String(issue), "--repo", repo, "--json", "title", "-q", ".title"], { cwd });
      if (r.code === 0 && r.stdout.trim()) title = r.stdout.trim();
    } catch { /* best-effort */ }

    const reconcileDeps: ReconcileDeps = {
      ...HOST_RECONCILE_PORTS,
      hitlTypes: readHitlTypeLabels(config),
      gh: {
        editLabels: async (n, remove, add) => {
          return editLabelsWithStatuslineCache(
            countCachePath,
            () => ghx.editLabels(ghCtx, n, remove, add),
            remove,
            add,
          );
        },
        ensureLabel: (name) => ghx.ensureLabel(ghCtx, name),
        comment: (n, body) => ghx.comment(ghCtx, n, body),
        close: (n) => ghx.closeIssue(ghCtx, n),
        listByLabel: (label) => ghx.listByLabel(ghCtx, label),
        issueClosed: (n) => ghx.issueClosed(ghCtx, n),
      },
      git: {
        headShortSha: () => gitx.headShortSha(gitCtx),
        deleteLocalBranch: async (b) => {
          await gitx.deleteLocalBranch(gitCtx, b);
        },
      },
      fs: {
        // Adopt landing has no AFK worker dir to sweep — best-effort no-op.
        completionSweep: async () => [],
      },
      lookups: {
        changedFiles: (b, bas) => gitx.changedFiles(gitCtx, b, bas),
        branchPresent: async (b) => {
          if (await gitx.branchExists(gitCtx, b)) return true;
          await gitx.fetchBranch(gitCtx, b);
          return gitx.branchExists(gitCtx, b);
        },
        isLocked: () => isLocked(lockPath),
      },
      mergeExec: gitx.mergeExec(gitCtx),
      remoteGit: gitx.gitExec(gitCtx),
      pnpm: feedback.pnpm,
      feedbackCommandExec: feedback.backpressure,
      layout: feedback.layout,
      // Landing worktree for the locked (DIRECT) land path (#572).
      makeLandingWorktree: async (bas: string) => {
        const slug = bas.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "base";
        const dest = join(paths.landingWorktreesDir, `${slug}-adopt-${issue}`);
        await gitx.worktreeRemove(gitCtx, dest);
        const added = await gitx.worktreeAdd(gitCtx, dest, bas);
        if (!added.ok) gitx.warnWorktreeAdd(dest, bas, added.stderr);
        return added.ok ? dest : null;
      },
      removeLandingWorktree: (dir: string) => gitx.worktreeRemove(gitCtx, dir),
      // Isolated worker-branch worktree for the PR path's pre-merge rebase (#1006).
      makeRebaseWorktree: async (branch: string) => {
        const slug = branch.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "branch";
        const dest = join(paths.rebaseWorktreesDir, `${slug}-adopt-${issue}`);
        await gitx.worktreeRemove(gitCtx, dest);
        const added = await gitx.worktreeAdd(gitCtx, dest, branch);
        if (!added.ok) gitx.warnWorktreeAdd(dest, branch, added.stderr);
        return added.ok ? dest : null;
      },
      removeRebaseWorktree: (dir: string) => gitx.worktreeRemove(gitCtx, dir),
      envelope: {
        git: gitx.gitExec(gitCtx),
        poster: async (n, body) => { await ghx.comment(ghCtx, n, body); return true; },
        // Adopt landing has no attempt marker files — best-effort no-ops.
        writeMarkers: async () => {},
        writePosted: async () => {},
      },
      nowEpoch: () => Math.floor(Date.now() / 1000),
      appendIterLog: (line) => { stdout.write(`${line}\n`); },
      // Presence stage seam (#1306): wired to the live worker-presence row's
      // stage inside the withAdoptPresence body below. Best-effort no-op until
      // the presence handle is bound.
      markStage: (stage) => (presenceStage ? presenceStage(stage) : Promise.resolve()),
      recoveryEnv: process.env,
    };

    const reconcileInput: ReconcileInput = {
      issue,
      title,
      body: issueData.body,
      labels: [...issueData.labels],
      branch,
      base,
      // ADR 0083 landing precondition (#1018): the configured Trunk the primary
      // checkout tracks, for doLanding's local-trunk-divergence guard.
      trunk: getConfig(config, "dev.trunk") || "main",
      repo,
      repoDir: cwd,
      remote: "origin",
      // Synthetic worker identity for logging/envelope — no real AFK worker ran.
      workerId: "requeue-adopt",
      attempt: 0,
      attemptDir: join(paths.adoptWorktreesDir, String(issue)),
      runner: "claude" as Runner,
    };

    // Seed a short-lived `origin="requeue"` worker-presence row so the
    // adopt-landing run is visible on the statusline / `/afk monitor` while its
    // gate runs, marked not-live + torn down on EVERY exit path (#1306).
    return await withAdoptPresence(
      makeAdoptPresenceIo(reconcileInput.runner),
      { tmpDir: paths.tmpDir, issue, title, runner: reconcileInput.runner },
      async (handle) => {
        presenceStage = handle.markStage;
        const result = await reconcile(reconcileDeps, reconcileInput);
        return result.outcome;
      },
    );
  } finally {
    await feedback.cleanup();
  }
}

/**
 * `requeue <issue> [--guidance text] [--repo owner/repo] [--json] [--dry-run]`
 *    `[--adopt-branch BRANCH]`
 * — apply the one-shot requeue transition. A non-parked issue is a no-op (exit
 * 0). `--dry-run` prints the plan without mutating. The `gh` dependency is
 * injectable for tests; production wires the gh CLI. When `--adopt-branch` is
 * given for a non-parked issue, the branch is adopted via the no-agent landing
 * lane (ADR 0055 reconcile); `adoptRunnerOverride` is injectable for tests. A
 * requeueable parked issue applies its queue transition directly so the
 * no-agent landing result cannot overwrite the requested requeue.
 */
export async function executeRequeue(
  input: RequeueExecutionInput,
  options: RequeueExecutionOptions = {},
): Promise<RequeueExecutionResult> {
  const cwd = options.cwd ?? process.cwd();
  const guidance = input.guidance.trim();
  const adoptBranch = input.adoptBranch?.trim() || undefined;
  if (!Number.isSafeInteger(input.issue) || input.issue <= 0) {
    throw new Error("requeue requires a positive issue number");
  }
  if (!guidance) {
    throw new Error("requeue requires guidance with the retry decision");
  }

  const repo = options.gh ? "" : await resolveRepo(cwd, input.repo);
  const gh = options.gh ?? ghFor(cwd, repo);
  const issueState = await gh.view(input.issue);
  if (issueState.state.toUpperCase() !== "OPEN") {
    return {
      issue: input.issue,
      plan: null,
      applied: false,
      outcome: "closed",
      exitCode: 1,
      reason: `issue is ${issueState.state || "unknown"}, not OPEN`,
      ...(adoptBranch ? { adoptBranch } : {}),
    };
  }

  const plan = planRequeue({
    body: issueState.body,
    labels: issueState.labels,
    guidance,
    adoptBranch: adoptBranch !== undefined,
  });
  if (!plan.requeueable) {
    if (plan.refuseForHitl) {
      return {
        issue: input.issue,
        plan,
        applied: false,
        outcome: "refused",
        exitCode: 1,
        reason: plan.reason,
        ...(adoptBranch ? { adoptBranch } : {}),
      };
    }
    if (!adoptBranch) {
      return {
        issue: input.issue,
        plan,
        applied: false,
        outcome: "no-op",
        exitCode: 0,
        reason: plan.reason,
      };
    }
  }

  const isBaseStale =
    plan.activeBlocker?.kind === "base-stale" ||
    plan.removeLabels.includes("blocked:base-stale");
  if (plan.requeueable && isBaseStale) {
    const freshness = await (
      options.verifyBaseFreshness ?? ((body) => verifyFreshBase(cwd, body))
    )(issueState.body);
    if (!freshness.ok) {
      return {
        issue: input.issue,
        plan,
        applied: false,
        outcome: "refused",
        exitCode: 1,
        reason: `base freshness verification failed: ${freshness.evidence}`,
        ...(adoptBranch ? { adoptBranch } : {}),
      };
    }
  }

  if (input.dryRun) {
    return {
      issue: input.issue,
      plan,
      applied: false,
      outcome: "dry-run",
      exitCode: 0,
      ...(adoptBranch ? { adoptBranch } : {}),
    };
  }

  let readyWithheld = false;
  let removeLabels: string[] | undefined;
  let addLabels: string[] | undefined;
  if (plan.requeueable) {
    await sweepRequeueClaims(gh, input.issue);
    if (plan.bodyChanged) await gh.editBody(input.issue, plan.body);
    await gh.comment(input.issue, directiveComment(plan, guidance));
    const lifecyclePlan = planTransition(issueState.labels, { kind: "queue" });
    if (isRefused(lifecyclePlan)) {
      throw new Error(`requeue transition refused: ${lifecyclePlan.reason}`);
    }
    removeLabels = [...plan.removeLabels];
    addLabels = [...plan.addLabels];
    await applyTransition(
      {
        editIssue: async (issue, edit) => {
          await gh.editLabels(issue, [...edit.remove], [...edit.add]);
          return true;
        },
        readBody: async () => plan.body,
      },
      input.issue,
      { remove: removeLabels, add: addLabels },
    );
    return {
      issue: input.issue,
      plan,
      applied: true,
      removeLabels,
      addLabels,
      outcome: "requeued",
      exitCode: 0,
      ...(adoptBranch ? { adoptBranch } : {}),
    };
  }

  if (adoptBranch && issueState.labels.includes(LABEL_READY)) {
    await gh.editLabels(input.issue, [LABEL_READY], []);
    readyWithheld = true;
  }

  const baseResult = {
    issue: input.issue,
    plan,
    applied: plan.requeueable,
    ...(removeLabels ? { removeLabels } : {}),
    ...(addLabels ? { addLabels } : {}),
  };
  if (!adoptBranch) return { ...baseResult, outcome: "no-op", exitCode: 0 };

  const restoreQueueLabel = async (): Promise<void> => {
    if (readyWithheld) await gh.editLabels(input.issue, [], [LABEL_READY]);
  };
  const postLabels = issueState.labels.filter((label) => label !== LABEL_READY);
  const adoptData: RequeueAdoptData = {
    title: "",
    body: issueState.body,
    labels: postLabels,
  };

  const silent = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const runner =
    options.adoptRunner ??
    ((issue, branch, data) =>
      runAdoptLanding(
        issue,
        branch,
        data,
        cwd,
        repo,
        options.progress ?? silent,
      ));
  let outcome: "landed" | "parked" | "skipped";
  try {
    outcome = await runner(input.issue, adoptBranch, adoptData);
  } catch (error) {
    await restoreQueueLabel().catch(() => {});
    throw error;
  }
  if (outcome === "skipped") await restoreQueueLabel();
  return {
    ...baseResult,
    outcome,
    exitCode: outcome === "parked" ? 1 : 0,
    adoptBranch,
  };
}

function renderRequeueResult(
  result: RequeueExecutionResult,
  json: boolean,
  stdout: NodeJS.WritableStream,
): void {
  if (json) {
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  const issue = result.issue;
  if (result.outcome === "closed") {
    process.stderr.write(`[afk] requeue #${issue}: ${result.reason}\n`);
  } else if (result.outcome === "refused") {
    process.stderr.write(`[afk] requeue #${issue}: refused — ${result.reason}\n`);
  } else if (result.outcome === "no-op") {
    stdout.write(`Requeue #${issue}: no-op — ${result.reason}\n`);
  } else if (result.outcome === "dry-run") {
    stdout.write(
      `Requeue #${issue} (dry-run): clear blocker=${result.plan?.bodyChanged ?? false} ` +
        `remove=[${result.plan?.removeLabels.join(",") ?? ""}] ` +
        `add=[${result.plan?.addLabels.join(",") ?? ""}]` +
        `${result.adoptBranch ? ` adopt-branch=${result.adoptBranch}` : ""}\n`,
    );
  } else if (result.outcome === "requeued") {
    stdout.write(
      `Requeue #${issue}: cleared blocker=${result.plan?.bodyChanged ?? false}, ` +
        `removed [${result.removeLabels?.join(",") ?? ""}], ` +
        `added [${result.addLabels?.join(",") ?? ""}].\n`,
    );
  } else if (result.outcome === "landed") {
    stdout.write(
      `Requeue #${issue}: \`${result.adoptBranch}\` validated and landed.\n`,
    );
  } else if (result.outcome === "parked") {
    process.stderr.write(
      `[afk] requeue #${issue}: gate failed — \`${result.adoptBranch}\` was parked to ready-for-human.\n`,
    );
  } else {
    stdout.write(
      `Requeue #${issue}: adopt skipped (branch carries no work vs base or branch absent).\n`,
    );
  }
}

export async function requeueCommand(
  args: readonly string[],
  cwd = process.cwd(),
  stdout: NodeJS.WritableStream = process.stdout,
  ghOverride?: RequeueGh,
  adoptRunnerOverride?: RequeueAdoptRunner,
  baseFreshnessVerifierOverride?: RequeueBaseFreshnessVerifier,
): Promise<number> {
  const { values, positionals } = parseFlags(args, REQUEUE_FLAG_SCHEMA);
  const issue = parseIssue(positionals[0]);
  if (issue === undefined) {
    process.stderr.write("[afk] requeue requires an issue number like #123\n");
    return 2;
  }
  const guidance = (values.guidance as string | undefined)?.trim();
  if (!guidance) {
    process.stderr.write(
      "[afk] requeue requires --guidance with the retry decision so it can be recorded as Human guidance\n",
    );
    return 2;
  }
  const adoptBranch =
    (values["adopt-branch"] as string | undefined)?.trim() || undefined;
  const result = await executeRequeue(
    {
      issue,
      guidance,
      repo: values.repo as string | undefined,
      dryRun: values["dry-run"] === true,
      adoptBranch,
    },
    {
      cwd,
      gh: ghOverride,
      adoptRunner: adoptRunnerOverride,
      verifyBaseFreshness: baseFreshnessVerifierOverride,
      progress: stdout,
    },
  );
  renderRequeueResult(result, values.json === true, stdout);
  return result.exitCode;
}
