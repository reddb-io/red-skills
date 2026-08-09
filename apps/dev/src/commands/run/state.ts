import type { Runner } from "../../types/runner.js";
import { workerDir as workerDirPath } from "../../core/worker-paths.js";
import * as fsx from "../../runtime/fs.js";
import { createCastleLaneWriters, createEnginePaths } from "@reddb-io/red-castle/engine";
import { parseHistoryLines, requeueOrdinal } from "../../core/history.js";
import { existsSync, readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { initStateSync, workerStatePath, writeIdentitySync } from "../../core/state.js";
import { decodeDevSnapshotSniff, encodeDevSnapshotToon } from "../../core/toon-snapshot.js";
import type { LocMemo } from "../../core/loc-memo.js";
import { LivenessLane, LIVENESS_LANE_FILENAME } from "@reddb-io/red-castle";
import { DIAGNOSTICS_TTL_S } from "../../core/tmp-janitor.js";

const DEFAULT_RUNNER_TRANSIENT_COOLDOWN_S = 300;

export interface BootWorkerStateInput {
  tmpDir: string;
  workerId: string;
  pid: number;
  pidStartTime?: string;
  runner: Runner;
  origin: string;
  kind: string;
  model?: string;
  effort?: string;
  nowMs?: () => number;
}

/**
 * Publish the pre-claim worker row before boot discovery or sweeps begin.
 * The synthetic `boot` attempt is replaced by the real issue attempt at pick.
 */
export async function initBootWorkerState(input: BootWorkerStateInput): Promise<string> {
  const attemptDir = join(workerDirPath(input.tmpDir, input.workerId), "boot");
  const statePath = workerStatePath(attemptDir);
  const nowMs = input.nowMs ?? (() => Date.now());
  const startedAt = new Date(nowMs()).toISOString();
  initStateSync(statePath, {
    worker_id: input.workerId,
    pid: input.pid,
    pid_start_time: input.pidStartTime ?? "",
    runner: input.runner,
    origin: input.origin,
    started_at: startedAt,
    "current.kind": input.kind,
    "current.number": "",
    "current.started_at": startedAt,
    "current.runner": input.runner,
    "current.model": input.model ?? "",
    "current.effort": input.effort ?? "",
    "current.activity": "boot",
    "current.phase": "boot",
  });
  writeIdentitySync(attemptDir, {
    worker_id: input.workerId,
    runner: input.runner,
    origin: input.origin,
    number: "",
    started_at: startedAt,
  });
  await new LivenessLane({
    path: join(attemptDir, LIVENESS_LANE_FILENAME),
    clock: nowMs,
  }).record("iteration-start");
  return statePath;
}

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

export interface RetainedBootDiagnostic {
  /** Repository-relative path safe to publish in a Ticket comment. */
  path: string;
  retentionDays: number;
}

export async function recordBootError(
  workerDir: string,
  type: "boot-error" | "session-error",
  err: unknown,
): Promise<RetainedBootDiagnostic> {
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
  const encoded = encodeBootErrorPayload(payload);
  await fsx.ensureDir(workerDir);
  await writeFile(join(workerDir, `${type}.log`), encoded, "utf8");
  const workerId = basename(workerDir);
  const redRoot = dirname(dirname(dirname(workerDir)));
  const retainedName = `${workerId}-${type}.log`;
  await createCastleLaneWriters(createEnginePaths(redRoot)).worker(workerId).append({
    kind: `worker.${type}`,
    worker_id: workerId,
    payload: { type, at: payload.at, message },
  });
  const retainedDir = join(redRoot, "tmp", "diagnostics");
  await fsx.ensureDir(retainedDir);
  await writeFile(join(retainedDir, retainedName), encoded, "utf8");
  process.stderr.write(`[afk] ${type}: ${message}\n`);
  return {
    path: `.red/tmp/diagnostics/${retainedName}`,
    retentionDays: DIAGNOSTICS_TTL_S / 86400,
  };
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
 * Resolve the current worker worktree from its conventional direct-child path.
 * Castle-branded nested paths are intentionally excluded from this reader;
 * only hygiene sweeps retain compatibility with that retired grammar.
 */
export function castleWorktreeUnder(attemptDir: string): string | undefined {
  const candidate = join(attemptDir, "worktree");
  return existsSync(join(candidate, ".git")) ? candidate : undefined;
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
    return recorded === join(attemptDir, "worktree") ? recorded : undefined;
  } catch {
    return undefined;
  }
}

/** Synchronous re-queue-ordinal resolver over the history ledger's pure core, so
 * it can run inside the synchronous `buildProcessInput`. The ledger holds one
 * durable, lane-blind row per terminal exit, which is what the bounded retry
 * caps count now that the attempt ledger is gone (ADR 0103). An unreadable or
 * absent ledger degrades to `1` — a missing history must never inflate a
 * Ticket's ordinal into an instant escalation. */
export function requeueOrdinalSync(historyPath: string | undefined, issue: number): number {
  if (!historyPath) return 1;
  try {
    return requeueOrdinal(parseHistoryLines(readFileSync(historyPath, "utf8")), issue);
  } catch {
    return 1;
  }
}
