import { Writable } from "node:stream";
import { readFile } from "node:fs/promises";
import { encode as encodeToon } from "@reddb-io/toon";
import { isValidWorkerId, workerPidFile } from "../core/worker-paths.js";
import { isLivePid, killTreeAndWait } from "../runtime/kill-tree.js";
import { listStaleClaimDirs, removeDir } from "../runtime/fs.js";
import { afkPaths, resolveRepoContext } from "../runtime/wire.js";
import * as ghx from "../runtime/gh.js";
import { stopFleet, type FleetStopResult } from "./fleet.js";
import { LABEL_HUMAN, LABEL_READY, LABEL_RUNNING } from "../core/triage-labels.js";

async function readWorkerPid(pidFile: string): Promise<number | null> {
  try {
    const raw = (await readFile(pidFile, "utf8")).trim();
    if (!/^[1-9][0-9]*$/.test(raw)) return null;
    return Number(raw);
  } catch {
    return null;
  }
}

/** Injectable IO for deterministic testing. */
export interface StopIO {
  stopFleet(root: string, out: NodeJS.WritableStream): Promise<FleetStopResult>;
  listStaleClaimDirs(tmpDir: string): Promise<Array<{ path: string; issue?: number }>>;
  restoreClaimLabels(root: string, issue: number): Promise<boolean>;
  removeDir(path: string): Promise<void>;
  readWorkerPid(pidFile: string): Promise<number | null>;
  isLivePid(pid: number): boolean;
  killTreeAndWait(pid: number): Promise<boolean>;
}

const defaultIO: StopIO = {
  stopFleet,
  listStaleClaimDirs,
  restoreClaimLabels,
  removeDir,
  readWorkerPid,
  isLivePid,
  killTreeAndWait,
};

export interface ParsedStopArgs {
  /** Worker id from --worker <wid>; null means fleet-level stop. */
  worker: string | null;
}

export function parseStopArgs(args: readonly string[]): ParsedStopArgs {
  let worker: string | null = null;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--worker" || arg === "-w") {
      worker = args[++i] ?? null;
      continue;
    }
    if (arg.startsWith("--worker=")) {
      worker = arg.slice("--worker=".length);
      continue;
    }
  }
  return { worker };
}

const discardStream = new Writable({ write(_chunk, _enc, cb) { cb(); } });

/**
 * `afk stop` — safe fleet shutdown verb.
 *
 * Without --worker: discover the supervisor via afk-supervisor.pid, SIGTERM it,
 * wait for the tree to exit (escalating to SIGKILL after the grace), reconcile
 * stale claim-lock dirs, then emit a TOON summary.
 *
 * With --worker <wid>: SIGTERM exactly one worker's process tree (supervisor
 * notices the empty slot and respawns it) — the sanctioned recycle path.
 */
export async function stopCommand(
  args: readonly string[],
  cwd = process.cwd(),
  stdout: NodeJS.WritableStream = process.stdout,
  io: StopIO = defaultIO,
): Promise<number> {
  const parsed = parseStopArgs(args);
  const paths = afkPaths(cwd);

  try {
    if (parsed.worker !== null) {
      return await stopWorker(parsed.worker, paths.tmpDir, stdout, io);
    }
    return await stopFleetWithReconcile(cwd, paths.tmpDir, stdout, io);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[afk stop] ✗ ${message}\n`);
    return 1;
  }
}

async function stopFleetWithReconcile(
  cwd: string,
  tmpDir: string,
  stdout: NodeJS.WritableStream,
  io: StopIO,
): Promise<number> {
  // Suppress stopFleet's prose — all output from this verb is TOON.
  const fleetResult = await io.stopFleet(cwd, discardStream);

  const stale = await io.listStaleClaimDirs(tmpDir).catch(() => []);
  let claimsReleased = 0;
  let labelsRestored = 0;
  for (const dir of stale) {
    const issue = dir.issue ?? issueFromClaimDirPath(dir.path);
    if (issue !== null && await io.restoreClaimLabels(cwd, issue).catch(() => false)) {
      labelsRestored += 1;
    }
    await io.removeDir(dir.path).catch(() => {});
    claimsReleased += 1;
  }

  stdout.write(
    encodeToon({
      op: "stop",
      supervisor_pid: fleetResult.pid ?? null,
      supervisor_status: fleetResult.status,
      claims_released: claimsReleased,
      labels_restored: labelsRestored,
    }) + "\n",
  );

  return fleetResult.status === "timeout" ? 1 : 0;
}

function issueFromClaimDirPath(path: string): number | null {
  const name = path.split(/[\\/]/).filter(Boolean).at(-1) ?? "";
  return /^[1-9][0-9]*$/.test(name) ? Number(name) : null;
}

async function restoreClaimLabels(root: string, issue: number): Promise<boolean> {
  const ctx = await resolveRepoContext(root);
  const ghCtx = { cwd: root, repo: ctx.repo };
  const labels = await ghx.viewLabels(ghCtx, issue);
  const parked = labels.includes(LABEL_HUMAN) || labels.some((l) => l.startsWith("blocked:"));
  if (!labels.includes(LABEL_RUNNING) || parked) return false;
  await ghx.editLabels(ghCtx, issue, [LABEL_RUNNING], [LABEL_READY]);
  return true;
}

/** The single-worker stop outcome — the object the CLI encodes to TOON and the MCP op returns. */
export interface StopWorkerResult {
  op: "stop-worker";
  worker: string;
  worker_pid: number | null;
  worker_status: "none" | "stale" | "stopped" | "timeout";
}

/**
 * Value-returning single-worker stop core: read the worker pid, classify it
 * (`none`/`stale`), else SIGTERM its tree and report `stopped`/`timeout`. Returns
 * the structured outcome — the CLI encodes it to TOON, the MCP `worker_stop`/
 * `worker_recycle` ops return it verbatim (TOON-encoded at the transport boundary).
 * Throws on a malformed worker id.
 */
export async function executeStopWorker(
  workerId: string,
  tmpDir: string,
  io: StopIO = defaultIO,
): Promise<StopWorkerResult> {
  if (!isValidWorkerId(workerId)) {
    throw new Error(`invalid worker id: ${JSON.stringify(workerId)}`);
  }
  const pid = await io.readWorkerPid(workerPidFile(tmpDir, workerId));
  if (pid === null) {
    return { op: "stop-worker", worker: workerId, worker_pid: null, worker_status: "none" };
  }
  if (!io.isLivePid(pid)) {
    return { op: "stop-worker", worker: workerId, worker_pid: pid, worker_status: "stale" };
  }
  const dead = await io.killTreeAndWait(pid);
  return {
    op: "stop-worker",
    worker: workerId,
    worker_pid: pid,
    worker_status: dead ? "stopped" : "timeout",
  };
}

async function stopWorker(
  workerId: string,
  tmpDir: string,
  stdout: NodeJS.WritableStream,
  io: StopIO,
): Promise<number> {
  if (!isValidWorkerId(workerId)) {
    process.stderr.write(`[afk stop] invalid worker id: ${JSON.stringify(workerId)}\n`);
    return 1;
  }
  const result = await executeStopWorker(workerId, tmpDir, io);
  stdout.write(encodeToon(result as unknown as Parameters<typeof encodeToon>[0]) + "\n");
  return result.worker_status === "timeout" ? 1 : 0;
}
