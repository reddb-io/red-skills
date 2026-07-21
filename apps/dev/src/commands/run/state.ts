import { parseRunnerFlag, detectRunner } from "../../core/runner-detection.js";
import { callerProcessTreeNative } from "../../runtime/caller-process.js";
import {
  runModeForCandidate,
  type SessionContext,
  type SessionIssueTemplate,
  type SelectionFilter,
  type IssueCandidate,
} from "../../core/session.js";
import { genWorkerId } from "../../core/session.js";
import { runBoot, type BootDeps, type BootOptions, type BootResult, type BootstrapInput, type ReconcileBootRunner } from "../../core/boot.js";
import { reconcile, type ReconcileDeps, type ReconcileInput } from "../../core/reconcile.js";
import { resolveBase } from "../../core/base-resolver.js";
import { findOwnedBranch, type ReconcileSweepPlan } from "../../core/boot-sweep.js";
import {
  classifyConflictedFileKind,
  partitionConflicts,
  type ConflictFinding,
} from "../../core/merge-conflict-reconcile.js";
import { processIssue, type ProcessIssueDeps, type ProcessIssueInput, type ProcessIssueResult } from "../../core/process-issue.js";
import {
  toMemoryPayload,
  resolveMemoryCli,
  type AttemptRecordPayload,
} from "../../core/attempt-record.js";
import { isRunner, type Runner } from "../../types/runner.js";
import {
  afkPaths,
  collectPrecheckFacts,
  collectBootOptions,
  collectMonitorInputs,
  buildBootDeps,
  buildMinimalBootDeps,
  makeRunAgent,
  resolveRepoContext,
  resolveRunSettings,
  type RepoContext,
  type AfkPaths,
} from "../../runtime/wire.js";
import type { LaneIdleStallConfig } from "../../core/lane-idle-reaper.js";
import { workerDir as workerDirPath, workerPidFile } from "../../core/worker-paths.js";
import { parseFlags, type FlagSchema } from "@reddb-io/shared/args.js";
import { pluginEnabledInConfig } from "@reddb-io/shared/plugin-gate.js";
import type { OutcomeEvent } from "@reddb-io/shared/outcome-event.js";
import * as ghx from "../../runtime/gh.js";
import * as gitx from "../../runtime/git.js";
import * as fsx from "../../runtime/fs.js";
import { migrateLegacyDevPaths } from "../../runtime/red-path-migration.js";
import { configFile } from "@reddb-io/shared/red-paths.js";
import type { GhContext } from "../../runtime/gh.js";
import { buildReviewGh } from "../../runtime/review-gh.js";
import type { GitContext } from "../../runtime/git.js";
import { execTool, type ExecFn } from "../../runtime/exec.js";
import { getConfig, loadConfig, readBackpressure, readPostAttemptFormat, readValidationResourceBudget, resolveTier, resolveCiTimeoutSeconds } from "../../core/config.js";
import { parseTrustPolicy, resolveActorTrust } from "../../core/trust-gate.js";
import { resolveNotesLoopConfig } from "../../core/notes-loop.js";
import { resolveOutputShapingConfig } from "../../core/output-shaping.js";
import {
  classifyIssue,
  resolveReviewGate,
  type IssueClassificationMetadata,
} from "../../core/issue-classifier.js";
import { LABEL_READY_FOR_REVIEW, LABEL_GO_LANE, LABEL_SCOUT_LANE, LABEL_MERGE_CONFLICT } from "../../core/triage-labels.js";
import { GO_KIND, GO_ORIGIN } from "../../core/go.js";
import { SCOUT_ORIGIN, SCOUT_WORKERS_SEGMENT } from "../../core/scout.js";
import { resolveHooks, type HookName } from "../../core/hook-config.js";
import { dispatchHooks } from "../../core/hook-dispatcher.js";
import { runCastleWorkerDrain, type CastleSessionHookName, type CastleWorkerDrainDeps } from "@reddb-io/red-castle/engine";
import { attemptLedgerContext, formatAttemptContext, highestAttempt, type AttemptDirEntry } from "../../core/attempt-ledger.js";
import { isValidWorkerId, WORKER_NAMESPACES } from "../../core/worker-paths.js";
import { readdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { isLivePid } from "../../runtime/kill-tree.js";
import { specialUserRequestBlock, claudeSpawnArgs, codexSpawnArgs } from "../../core/runner-spawn.js";
import { buildWorkerAttemptPath } from "../../core/worker-paths.js";
import { createLandLock } from "../../runtime/land-lock.js";
import { branchLockPath, readLockedBranch, isLocked } from "../../runtime/lock.js";
import { makeHookExec, makeHookResolveOptions, hookEnv } from "../../runtime/hooks.js";
import { makeFeedbackWorktree, type FeedbackWorktree } from "../../runtime/feedback-worktree.js";
import {
  installProcessSafety,
  fileSafetyLogger,
  safetyLogPath,
  deathCauseForRecoveredWorker,
} from "../../core/process-safety.js";
import { join } from "node:path";
import { hostFingerprintPrefix, workerIdentity } from "../../core/host-identity.js";
import { appendAgentRecord, appendRecordToonlTaggedRow } from "../../core/jsonl-log.js";
import { initStateSync, readPidStartTime, updateState, writeIdentitySync } from "../../core/state.js";
import { decodeDevSnapshotSniff, encodeDevSnapshotToon } from "../../core/toon-snapshot.js";
import { buildProgressHeartbeat, formatIterationMarker } from "../../core/heartbeat.js";
import { resolveAttemptLoc, locMemoPath, type LocMemo } from "../../core/loc-memo.js";
import { createActivityMeter } from "../../core/activity-meter.js";
import { createCastleWorkerLaneBridge } from "../../core/castle-worker-lane-bridge.js";
import { DEFAULT_MAX_ITERATIONS } from "../../core/execution.js";
import type { AgentStreamEvent } from "../../core/execution.js";
import { makeStaleClaimPredicate, resolveClaimStalenessConfig } from "../../core/claim-staleness.js";
import { renderClaimComment } from "../../core/claim.js";

const DEFAULT_RUNNER_TRANSIENT_COOLDOWN_S = 300;

export function decodeLocMemoSnapshot(text: string): LocMemo | null {
  try {
    const m = decodeDevSnapshotSniff(text) as Partial<LocMemo>;
    return { sha: String(m.sha ?? ""), added: Number(m.added ?? 0), removed: Number(m.removed ?? 0) };
  } catch {
    return null;
  }
}

export function encodeLocMemoSnapshot(memo: LocMemo): string {
  return encodeDevSnapshotToon(memo as unknown as Parameters<typeof encodeDevSnapshotToon>[0]);
}

export function encodeRunnerCircuitSnapshot(state: {
  runner: Runner;
  opened_at: number;
  expires_at: number;
  reason: "runner-transient";
}): string {
  return encodeDevSnapshotToon(state);
}

export function decodeRunnerCircuitSnapshot(text: string): { expires_at?: unknown } {
  return decodeDevSnapshotSniff(text) as { expires_at?: unknown };
}

export function encodeBootErrorPayload(payload: {
  type: "boot-error" | "session-error";
  at: string;
  message: string;
  stack?: string;
}): string {
  return encodeDevSnapshotToon(payload);
}

export async function recordBootError(workerDir: string, type: "boot-error" | "session-error", err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  const payload: {
    type: "boot-error" | "session-error";
    at: string;
    message: string;
    stack?: string;
  } = {
    type,
    at: new Date().toISOString(),
    message,
    stack,
  };
  await fsx.ensureDir(workerDir);
  await writeFile(join(workerDir, `${type}.log`), encodeBootErrorPayload(payload), "utf8");
  process.stderr.write(`[afk] ${type}: ${message}\n`);
}

function runnerCircuitPath(circuitDir: string, runner: Runner): string {
  return join(circuitDir, `${runner}.json`);
}

function runnerTransientCooldownS(env: Record<string, string | undefined>): number {
  const raw = env.RED_AFK_RUNNER_TRANSIENT_COOLDOWN_S;
  if (raw !== undefined) {
    const parsed = Number(raw);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_RUNNER_TRANSIENT_COOLDOWN_S;
}

export async function openRunnerCircuit(
  circuitDir: string,
  runner: Runner,
  nowS: number,
  env: Record<string, string | undefined>,
): Promise<void> {
  const cooldownS = runnerTransientCooldownS(env);
  await fsx.ensureDir(circuitDir);
  await writeFile(
    runnerCircuitPath(circuitDir, runner),
    encodeRunnerCircuitSnapshot({
      runner,
      opened_at: nowS,
      expires_at: nowS + cooldownS,
      reason: "runner-transient",
    }),
    "utf8",
  );
}

export async function runnerCircuitOpen(
  circuitDir: string,
  runner: Runner,
  nowS: number,
): Promise<boolean> {
  try {
    const raw = await readFile(runnerCircuitPath(circuitDir, runner), "utf8");
    const parsed = decodeRunnerCircuitSnapshot(raw);
    return typeof parsed.expires_at === "number" && parsed.expires_at > nowS;
  } catch {
    return false;
  }
}

/**
 * Resolve the red-castle worktree from the filesystem. Red-castle creates the
 * agent's worktree at `{attemptDir}/.red-castle/worktrees/{slug}` as a worktree
 * of the red-trunk MIRROR, not the primary checkout, so it never appears in the
 * primary's `git worktree list` — {@link worktreePathUnder} (which lists the
 * primary via `gitCtx`) returns undefined for it, and the heartbeat then fell
 * back to the non-existent legacy `{attemptDir}/worktree` and read a permanent
 * `+0 -0` diff (blank `loc` on the statusline for every red-castle worker). This
 * reads the real layout directly: the single `.git`-bearing subdirectory of
 * `{attemptDir}/.red-castle/worktrees/`.
 */
export function castleWorktreeUnder(attemptDir: string): string | undefined {
  const dir = join(attemptDir, ".red-castle", "worktrees");
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return undefined; // no castle worktree tree yet (attempt not started / cleaned)
  }
  for (const name of entries) {
    const candidate = join(dir, name);
    // A git worktree carries a `.git` gitdir pointer (a file for a linked
    // worktree). Its presence distinguishes the real worktree from stray dirs.
    if (existsSync(join(candidate, ".git"))) return candidate;
  }
  return undefined;
}

/**
 * Read the worktree path the castle recorded from its `onWorktreeReady` hook.
 *
 * That hook runs ON THE HOST with cwd = the real worktree, so its `pwd` is the
 * ground-truth absolute path; it writes it to `{attemptDir}/.worktree-path`
 * (buildWorktreePathCaptureHook). This is the single source of truth for the
 * heartbeat loc diff — no reconstruction from `attemptDir`, which returned the
 * dead legacy `{attemptDir}/worktree` at runtime and read a permanent `+0 -0`.
 * Returns undefined until the hook has run (falls back to the probe chain).
 */
export function readCapturedWorktreePath(attemptDir: string): string | undefined {
  try {
    const recorded = readFileSync(join(attemptDir, ".worktree-path"), "utf8").trim();
    return recorded || undefined;
  } catch {
    return undefined;
  }
}

/** Synchronous next-attempt resolver over the attempt-ledger's pure core, so it
 * can run inside the synchronous `buildProcessInput`. Namespace-blind: walks
 * every worker-lane namespace (`workers`, `go-workers`, `scout-workers`) with
 * readdirSync and feeds the pure `highestAttempt`, so the same issue retried
 * across lanes never reuses an attempt number. The next attempt is the highest
 * existing attempt for the issue + 1 (1 when none). Junk dirs never bump the
 * counter; a missing namespace tree contributes nothing. */
export function nextAttemptSync(tmpDir: string, issue: number): number {
  const entries: AttemptDirEntry[] = [];
  for (const namespace of WORKER_NAMESPACES) {
    let workers: string[];
    try {
      workers = readdirSync(join(tmpDir, namespace));
    } catch {
      continue; // namespace dir absent → no attempts from this lane
    }
    for (const worker of workers) {
      if (!isValidWorkerId(worker)) continue;
      try {
        entries.push({ worker, basenames: readdirSync(join(tmpDir, namespace, worker)) });
      } catch {
        // not a directory / unreadable
      }
    }
  }
  const best = highestAttempt(tmpDir, issue, entries);
  return best ? best.attempt + 1 : 1;
}
