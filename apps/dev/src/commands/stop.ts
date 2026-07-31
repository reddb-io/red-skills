import { readFile } from "node:fs/promises";
import { encode as encodeToon } from "@reddb-io/toon";
import { isValidWorkerId, workerPidFile } from "../core/worker-paths.js";
import { isLivePid, killTreeAndWait } from "../runtime/kill-tree.js";
import { listStaleClaimDirs, removeDir } from "../runtime/fs.js";
import { afkPaths, resolveRepoContext } from "../runtime/wire.js";
import * as ghx from "../runtime/gh.js";
import { createRedskilledBirthPort } from "../runtime/redskilled-birth.js";
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

/** What giving this project's registration back accomplished. */
export interface ProjectStopResult {
  /** False when the host held no registration — an answer, not a fault. */
  deregistered: boolean;
  /** The Workers the host ended on our behalf, as the host names them. */
  workersStopped: readonly string[];
  /** Why the host could not be reached; absent when it answered. */
  refusal?: string;
}

/**
 * Give this project's registration back and ask the host to end its Workers.
 *
 * The whole of stopping, since ADR 0130 Amendment 4 removed the per-project
 * process: there is nothing of the project's own left to kill, and the Workers
 * go through the daemon that birthed them. A Worker the host no longer names is
 * the outcome asked for, not a failure — between the read and the stop it may
 * have finished.
 */
export async function releaseProject(root: string): Promise<ProjectStopResult> {
  const port = createRedskilledBirthPort({ root });
  try {
    const workersStopped: string[] = [];
    for (const workerId of await port.workerIds()) {
      try {
        if (await port.stop(workerId, "afk stop gave this project's registration back")) {
          workersStopped.push(workerId);
        }
      } catch {
        // Already gone. The next read is the daemon's, and it agrees.
      }
    }
    return { deregistered: await port.deregister(), workersStopped };
  } catch (error) {
    return {
      deregistered: false,
      workersStopped: [],
      refusal: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Injectable IO for deterministic testing. */
export interface StopIO {
  releaseProject(root: string): Promise<ProjectStopResult>;
  listStaleClaimDirs(tmpDir: string): Promise<Array<{ path: string; issue?: number }>>;
  restoreClaimLabels(root: string, issue: number): Promise<boolean>;
  removeDir(path: string): Promise<void>;
  readWorkerPid(pidFile: string): Promise<number | null>;
  isLivePid(pid: number): boolean;
  killTreeAndWait(pid: number): Promise<boolean>;
}

const defaultIO: StopIO = {
  releaseProject,
  listStaleClaimDirs,
  restoreClaimLabels,
  removeDir,
  readWorkerPid,
  isLivePid,
  killTreeAndWait,
};

export interface ParsedStopArgs {
  /** Worker id from --worker <wid>; null means project-level stop. */
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

/**
 * `afk stop` — safe project shutdown verb.
 *
 * Without --worker: give this project's registration back, ask the host to end
 * the Workers it holds for us, reconcile stale claim-lock dirs, then emit a TOON
 * summary.
 *
 * With --worker <wid>: SIGTERM exactly one worker's process tree — the
 * sanctioned recycle path.
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
    return await stopProjectWithReconcile(cwd, paths.tmpDir, stdout, io);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[afk stop] ✗ ${message}\n`);
    return 1;
  }
}

async function stopProjectWithReconcile(
  cwd: string,
  tmpDir: string,
  stdout: NodeJS.WritableStream,
  io: StopIO,
): Promise<number> {
  const released = await io.releaseProject(cwd);

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
      deregistered: released.deregistered,
      workers_stopped: released.workersStopped.length,
      claims_released: claimsReleased,
      labels_restored: labelsRestored,
      ...(released.refusal === undefined ? {} : { refusal: released.refusal }),
    }) + "\n",
  );

  return released.refusal === undefined ? 0 : 1;
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
