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

import { join } from "node:path";
import { parseFlags, type FlagSchema } from "@reddb-io/shared/args.js";
import { execTool, type ExecFn } from "../runtime/exec.js";
import { planRequeue, type RequeuePlan } from "../core/requeue.js";
import { parseCurrentBlocker } from "../core/blocker-state.js";
import { LABEL_SENSITIVE_PATH } from "../core/triage-labels.js";
import { reconcile, type ReconcileDeps, type ReconcileInput } from "../core/reconcile.js";
import { makeFeedbackWorktree } from "../runtime/feedback-worktree.js";
import { afkPaths, resolveRepoSlug } from "../runtime/wire.js";
import { branchLockPath, isLocked, readLockedBranch } from "../runtime/lock.js";
import { resolveBase } from "../core/base-resolver.js";
import { getConfig, loadConfig } from "../core/config.js";
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
}

/** Metadata passed to the adopt runner after the requeue transition is applied. */
export interface RequeueAdoptData {
  title: string;
  body: string;
  labels: readonly string[];
  /**
   * #1171: the park being adopted was `blocked:sensitive-path`, so the maintainer
   * running `--adopt-branch` has reviewed the protected diff. Threaded into the
   * ADR-0055 reconcile as `sensitivePathApproved`, which skips doLanding's
   * sensitive-path guard for THIS human land only. Defaults false.
   */
  sensitivePathApproved?: boolean;
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
      const out = await run(["issue", "edit", String(issue), ...repoArgs, "--body", body]);
      if (out.code !== 0) throw new Error(`edit body #${issue} failed: ${out.stderr.trim() || out.stdout.trim()}`);
    },
    async editLabels(issue, remove, add) {
      const args = ["issue", "edit", String(issue), ...repoArgs];
      for (const l of remove) args.push("--remove-label", l);
      for (const l of add) args.push("--add-label", l);
      const out = await run(args);
      if (out.code !== 0) throw new Error(`edit labels #${issue} failed: ${out.stderr.trim() || out.stdout.trim()}`);
    },
    async comment(issue, body) {
      await run(["issue", "comment", String(issue), ...repoArgs, "--body", body]);
    },
  };
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

/**
 * #1171 audit comment for a `blocked:sensitive-path` adopt: a human explicitly
 * approved a protected diff and is landing it through `--adopt-branch`, bypassing
 * doLanding's sensitive-path guard. Records WHO (the gh authenticated login,
 * best-effort) and WHEN (UTC), plus the recorded guidance, so the bypass is never
 * silent.
 */
async function sensitivePathAdoptAudit(cwd: string, branch: string, guidance?: string): Promise<string> {
  let who = "a maintainer";
  try {
    const r = await execTool("gh", ["api", "user", "-q", ".login"], { cwd });
    if (r.code === 0 && r.stdout.trim()) who = `@${r.stdout.trim()}`;
  } catch {
    /* best-effort: the audit is still posted with the generic actor. */
  }
  const when = new Date().toISOString();
  return [
    "<details data-kind=\"sensitive-path-adopt\">",
    "<summary>Sensitive-path adopt approved</summary>",
    "",
    `${who} approved the sensitive-path diff and landed \`${branch}\` via \`/requeue --adopt-branch\` at ${when}.`,
    "The landing sensitive-path guard (#1102) was bypassed for this human-reviewed land only; every autonomous attempt keeps the guard armed (#1171).",
    "",
    "Human guidance:",
    guidance?.trim() || "(none recorded)",
    "</details>",
  ].join("\n");
}

async function resolveRepo(cwd: string, explicit?: string): Promise<string> {
  if (explicit?.trim()) return explicit.trim();
  const r = await execTool("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], { cwd });
  return r.code === 0 ? r.stdout.trim() : "";
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
  const ghCtx: GhContext = { cwd, repo };
  const gitCtx: GitContext = { cwd };
  const lockPath = branchLockPath(cwd);
  const feedbackDir = join(paths.tmpDir, "adopt-landing", String(issue));
  const feedback = makeFeedbackWorktree(cwd, feedbackDir, undefined, {});

  try {
    const base = await resolveBase(
      { issueBody: issueData.body },
      {
        readLockedBranch: () => readLockedBranch(lockPath),
        configLockedBranch: undefined,
        configTrunk:
          getConfig(loadConfig(paths.configPath, { warn: () => undefined }), "dev.trunk") ||
          undefined,
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
      gh: {
        editLabels: async (n, remove, add) => {
          await ghx.editLabels(ghCtx, n, remove, add);
          return true;
        },
        ensureLabel: (name) => ghx.ensureLabel(ghCtx, name),
        comment: (n, body) => ghx.comment(ghCtx, n, body),
        close: (n) => ghx.closeIssue(ghCtx, n),
        listByLabel: (label) => ghx.listByLabel(ghCtx, label),
        issueClosed: (n) => ghx.issueClosed(ghCtx, n),
      },
      git: {
        headShortSha: () => gitx.headShortSha(gitCtx),
        deleteLocalBranch: (b) => gitx.deleteLocalBranch(gitCtx, b),
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
      layout: feedback.layout,
      // Landing worktree for the locked (DIRECT) land path (#572).
      makeLandingWorktree: async (bas: string) => {
        const slug = bas.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "base";
        const dest = join(paths.tmpDir, "landing", `${slug}-adopt-${issue}`);
        await gitx.worktreeRemove(gitCtx, dest);
        const ok = await gitx.worktreeAdd(gitCtx, dest, bas);
        return ok ? dest : null;
      },
      removeLandingWorktree: (dir: string) => gitx.worktreeRemove(gitCtx, dir),
      // Isolated worker-branch worktree for the PR path's pre-merge rebase (#1006).
      makeRebaseWorktree: async (branch: string) => {
        const slug = branch.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "branch";
        const dest = join(paths.tmpDir, "rebase", `${slug}-adopt-${issue}`);
        await gitx.worktreeRemove(gitCtx, dest);
        const ok = await gitx.worktreeAdd(gitCtx, dest, branch);
        return ok ? dest : null;
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
      trunk: getConfig(loadConfig(paths.configPath, { warn: () => undefined }), "dev.trunk") || "main",
      repo,
      repoDir: cwd,
      remote: "origin",
      // Synthetic worker identity for logging/envelope — no real AFK worker ran.
      workerId: "requeue-adopt",
      attempt: 0,
      attemptDir: join(paths.tmpDir, "adopt-landing", String(issue)),
      runner: "claude" as Runner,
      // #1171: bypass doLanding's sensitive-path guard ONLY for a maintainer-
      // reviewed adopt of a `blocked:sensitive-path` park. Defaults false — a
      // normal adopt keeps the guard armed.
      sensitivePathApproved: issueData.sensitivePathApproved === true,
    };

    const result = await reconcile(reconcileDeps, reconcileInput);
    return result.outcome;
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
 * given, the branch is adopted via the no-agent landing lane (ADR 0055
 * reconcile) after the requeue transition; `adoptRunnerOverride` is injectable
 * for tests.
 */
export async function requeueCommand(
  args: readonly string[],
  cwd = process.cwd(),
  stdout: NodeJS.WritableStream = process.stdout,
  ghOverride?: RequeueGh,
  adoptRunnerOverride?: RequeueAdoptRunner,
): Promise<number> {
  const { values, positionals } = parseFlags(args, REQUEUE_FLAG_SCHEMA);
  const issue = parseIssue(positionals[0]);
  if (issue === undefined) {
    process.stderr.write("[afk] requeue requires an issue number like #123\n");
    return 2;
  }
  const guidance = (values.guidance as string | undefined)?.trim();
  const json = values.json === true;
  const dryRun = values["dry-run"] === true;
  const adoptBranch = (values["adopt-branch"] as string | undefined)?.trim() || undefined;

  if (!guidance) {
    process.stderr.write("[afk] requeue requires --guidance with the retry decision so it can be recorded as Human guidance\n");
    return 2;
  }

  const repo = ghOverride ? "" : await resolveRepo(cwd, values.repo as string | undefined);
  const gh = ghOverride ?? ghFor(cwd, repo);

  const issueState = await gh.view(issue);
  if (issueState.state.toUpperCase() !== "OPEN") {
    process.stderr.write(`[afk] requeue #${issue}: issue is ${issueState.state || "unknown"}, not OPEN\n`);
    return 1;
  }

  // #1171: an active `blocked:sensitive-path` park is requeueable ONLY when the
  // maintainer is adopting a reviewed branch (`--adopt-branch`). Detect it from
  // the PRE-transition state so the audit comment + guard bypass fire only here.
  const wasSensitivePathPark =
    issueState.labels.includes(LABEL_SENSITIVE_PATH) ||
    parseCurrentBlocker(issueState.body)?.kind === "sensitive-path";

  const plan = planRequeue({
    body: issueState.body,
    labels: issueState.labels,
    guidance,
    adoptBranch: adoptBranch !== undefined,
  });
  if (!plan.requeueable) {
    if (plan.refuseForHitl) {
      process.stderr.write(`[afk] requeue #${issue}: refused — ${plan.reason}\n`);
      return 1;
    }
    // Not parked — no-op for the requeue transition (may still adopt below).
    if (!adoptBranch) {
      stdout.write(`Requeue #${issue}: no-op — ${plan.reason}\n`);
      return 0;
    }
  }

  if (dryRun) {
    stdout.write(
      json
        ? `${JSON.stringify({ issue, plan, adoptBranch }, null, 2)}\n`
        : `Requeue #${issue} (dry-run): clear blocker=${plan.bodyChanged} remove=[${plan.removeLabels.join(",")}] add=[${plan.addLabels.join(",")}]${adoptBranch ? ` adopt-branch=${adoptBranch}` : ""}\n`,
    );
    return 0;
  }

  // Apply the requeue transition when the issue is parked and requeueable.
  if (plan.requeueable) {
    if (plan.bodyChanged) await gh.editBody(issue, plan.body);
    await gh.comment(issue, directiveComment(plan, guidance));
    await gh.editLabels(issue, plan.removeLabels, plan.addLabels);
    stdout.write(
      json
        ? `${JSON.stringify({ issue, plan, applied: true }, null, 2)}\n`
        : `Requeue #${issue}: cleared blocker=${plan.bodyChanged}, removed [${plan.removeLabels.join(",")}], added [${plan.addLabels.join(",")}].\n`,
    );
  } else if (!adoptBranch) {
    stdout.write(`Requeue #${issue}: no-op — ${plan.reason}\n`);
    return 0;
  }

  // Adopt mode (ADR 0081): route the branch through the no-agent landing lane.
  if (adoptBranch) {
    // Post-transition labels/body — pass the reconcile guard the state AFTER
    // the requeue cleared any blocked:* labels + active blocker.
    const postLabels = plan.requeueable
      ? [...issueState.labels.filter((l) => !plan.removeLabels.includes(l)), ...plan.addLabels]
      : [...issueState.labels];
    const postBody = plan.requeueable ? plan.body : issueState.body;
    const adoptData: RequeueAdoptData = {
      title: "",
      body: postBody,
      labels: postLabels,
      sensitivePathApproved: wasSensitivePathPark,
    };

    // #1171 audit trail: a sensitive-path adopt is a human bypass of the landing
    // guard — never silent. Record who approved + when, and the guidance, BEFORE
    // the land so the approval is on the thread even if the land later parks.
    if (wasSensitivePathPark) {
      await gh.comment(issue, await sensitivePathAdoptAudit(cwd, adoptBranch, guidance));
    }

    stdout.write(`Requeue #${issue}: adopting branch \`${adoptBranch}\` through the no-agent landing lane (ADR 0055)…\n`);

    const runner = adoptRunnerOverride
      ?? ((n, b, d) => runAdoptLanding(n, b, d, cwd, repo, stdout));

    const outcome = await runner(issue, adoptBranch, adoptData);

    if (outcome === "landed") {
      stdout.write(`Requeue #${issue}: \`${adoptBranch}\` validated and landed.\n`);
      return 0;
    }
    if (outcome === "parked") {
      process.stderr.write(`[afk] requeue #${issue}: gate failed — \`${adoptBranch}\` was parked to ready-for-human.\n`);
      return 1;
    }
    // skipped (no-commits, branch-absent, etc.) — not a failure but worth noting.
    stdout.write(`Requeue #${issue}: adopt skipped (branch carries no work vs base or branch absent).\n`);
    return 0;
  }

  return 0;
}
