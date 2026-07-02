import { Writable } from "node:stream";
import { readFile } from "node:fs/promises";
import { isValidWorkerId, workerPidFile } from "../core/worker-paths.js";
import { isLivePid, killTreeAndWait } from "../runtime/kill-tree.js";
import { listStaleClaimDirs, removeDir } from "../runtime/fs.js";
import { afkPaths } from "../runtime/wire.js";
import { stopFleet, type FleetStopResult } from "./fleet.js";
import { encodeToon } from "../core/toon.js";

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
  listStaleClaimDirs(tmpDir: string): Promise<Array<{ path: string }>>;
  removeDir(path: string): Promise<void>;
  readWorkerPid(pidFile: string): Promise<number | null>;
  isLivePid(pid: number): boolean;
  killTreeAndWait(pid: number): Promise<boolean>;
}

const defaultIO: StopIO = {
  stopFleet,
  listStaleClaimDirs,
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
  for (const dir of stale) {
    await io.removeDir(dir.path).catch(() => {});
    claimsReleased += 1;
  }

  stdout.write(
    encodeToon({
      op: "stop",
      supervisor_pid: fleetResult.pid ?? null,
      supervisor_status: fleetResult.status,
      claims_released: claimsReleased,
    }) + "\n",
  );

  return fleetResult.status === "timeout" ? 1 : 0;
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

  const pidFile = workerPidFile(tmpDir, workerId);
  const pid = await io.readWorkerPid(pidFile);

  if (pid === null) {
    stdout.write(
      encodeToon({ op: "stop-worker", worker: workerId, worker_pid: null, worker_status: "none" }) + "\n",
    );
    return 0;
  }

  if (!io.isLivePid(pid)) {
    stdout.write(
      encodeToon({ op: "stop-worker", worker: workerId, worker_pid: pid, worker_status: "stale" }) + "\n",
    );
    return 0;
  }

  const dead = await io.killTreeAndWait(pid);
  stdout.write(
    encodeToon({
      op: "stop-worker",
      worker: workerId,
      worker_pid: pid,
      worker_status: dead ? "stopped" : "timeout",
    }) + "\n",
  );
  return dead ? 0 : 1;
}
