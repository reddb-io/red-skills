// runtime/worker-state-reclaim.ts — the IO half of the Worker state record
// reclaim (issue #2978). The decision lives in `core/worker-state-reclaim.ts`;
// this module reads the records, resolves liveness through the single anchor,
// and removes exactly what the plan released.

import { readdir, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  castleStateSnapshotPath,
  createEnginePaths,
  readCastleStateSnapshot,
} from "@reddb-io/worker/engine";
import type {
  WorkerStateRecordEntry,
  WorkerStateRecordReclaimPlan,
} from "../core/worker-state-reclaim.js";
import { isLivePid } from "./kill-tree.js";
import {
  readDaemonWorkerSet,
  resolveWorkerLiveness,
  type DaemonWorkerSet,
  type DaemonWorkerSetReader,
} from "./liveness-anchor.js";

/**
 * The durable Worker state record root for a repo: `.red/state/castle/workers`.
 * Spelled once, so the containment gate and the collector cannot drift into two
 * answers about which directory this sweep is allowed to touch.
 */
export function castleWorkerStateRoot(root: string): string {
  return join(createEnginePaths(join(root, ".red")).castleStateRoot, "workers");
}

/**
 * Whether a path lies strictly inside the Worker state root. A plan may name any
 * path at all — it may have been built by an older bundle, or by hand — so every
 * removal is gated on this: a path outside the lane is REPORTED and refused,
 * never obeyed.
 */
export function pathIsInsideWorkerStateRoot(root: string, path: string): boolean {
  const rel = relative(resolve(castleWorkerStateRoot(root)), resolve(path));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export interface WorkerStateRecordSources {
  /** How this sweep reaches the daemon. Injected so the read is testable at the
   * seam the shipped path uses, and so a caller can hand over an answer it holds. */
  daemon?: DaemonWorkerSetReader;
}

export interface CollectWorkerStateRecordOptions extends WorkerStateRecordSources {
  /** Clock for the collector's own bookkeeping. Defaults to `Date.now()`. */
  nowMs?: number;
}

/** One daemon read, or null when it did not answer. */
async function readDaemon(read: DaemonWorkerSetReader): Promise<DaemonWorkerSet | null> {
  try {
    return await read();
  } catch {
    return null;
  }
}

async function listRecordIds(root: string): Promise<string[]> {
  try {
    return (await readdir(castleWorkerStateRoot(root), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/**
 * The sweep's ONE liveness question, asked of the daemon with the record's own
 * recorded pid folded in as evidence.
 *
 * The evidence is one-way by construction (see the liveness anchor): a live pid
 * WITHHOLDS a death claim, and can never manufacture an `alive` verdict of its
 * own. That is what keeps a record born outside the daemon — a Worker the daemon
 * never birthed and so cannot vouch for — out of reclaim eligibility while the
 * daemon stays the single source of every positive verdict.
 */
function livenessFor(
  hostAnswer: DaemonWorkerSet | null,
  workerId: string,
  recordedPid: number | undefined,
): WorkerStateRecordEntry["liveness"] {
  const evidenceOfLife =
    typeof recordedPid === "number" && recordedPid > 0 && isLivePid(recordedPid);
  return resolveWorkerLiveness(hostAnswer, workerId, { evidenceOfLife }).verdict;
}

/**
 * Read every Worker state record under `.red/state/castle/workers/` and resolve
 * each one's liveness against a SINGLE daemon read, so two records of one sweep
 * cannot be judged against two different answers.
 *
 * A record directory with no readable `state.toon` contributes nothing: it is
 * not a record, and this sweep never removes what it could not read.
 */
export async function collectWorkerStateRecordEntries(
  root: string,
  options: CollectWorkerStateRecordOptions = {},
): Promise<WorkerStateRecordEntry[]> {
  const paths = createEnginePaths(join(root, ".red"));
  const hostAnswer = await readDaemon(options.daemon ?? readDaemonWorkerSet);
  const ids = await listRecordIds(root);
  const entries: WorkerStateRecordEntry[] = [];
  for (const id of ids) {
    const snapshot = await readCastleStateSnapshot(
      castleStateSnapshotPath(paths, "worker", id),
    ).catch(() => undefined);
    if (!snapshot || snapshot.kind !== "worker") continue;
    const workerId = snapshot.worker_id ?? snapshot.id ?? id;
    const updatedAtMs = Date.parse(snapshot.updated_at ?? "");
    const phase = snapshot.current?.phase;
    entries.push({
      worker_id: workerId,
      path: join(castleWorkerStateRoot(root), id),
      liveness: livenessFor(hostAnswer, workerId, snapshot.pid),
      updatedAtMs: Number.isFinite(updatedAtMs) ? updatedAtMs : null,
      outcome: typeof phase === "string" && phase !== "" ? phase : "unknown",
    });
  }
  return entries;
}

export interface WorkerStateRecordReclaimResult {
  /** Record directories removed, in plan order. */
  removed: string[];
  /** Records the apply-time daemon read spared: a Worker was born since the plan. */
  protectedLive: string[];
  /** Paths the plan named outside the Worker state root: reported, never removed. */
  refusedOutsideStateRoot: string[];
  /** What was kept, and why — the plan's retain verdicts, carried through so the
   * sweep reports what it KEPT alongside what it removed. */
  retained: Array<{ path: string; verdict: string; reason: string }>;
}

/**
 * Remove exactly the records the plan released.
 *
 * The daemon is RE-READ here, not carried from the plan: a Worker may have been
 * born between collect and apply, and the plan is history the moment it is
 * built. A removal is authorised by a CURRENT answer or it does not happen.
 */
export async function applyWorkerStateRecordReclaim(
  root: string,
  plan: WorkerStateRecordReclaimPlan,
  options: WorkerStateRecordSources = {},
): Promise<WorkerStateRecordReclaimResult> {
  const hostAnswer = await readDaemon(options.daemon ?? readDaemonWorkerSet);
  const result: WorkerStateRecordReclaimResult = {
    removed: [],
    protectedLive: [],
    refusedOutsideStateRoot: [],
    retained: plan.retain.map((verdict) => ({
      path: verdict.path,
      verdict: verdict.verdict,
      reason: verdict.reason,
    })),
  };
  for (const verdict of plan.reclaim) {
    if (!pathIsInsideWorkerStateRoot(root, verdict.path)) {
      result.refusedOutsideStateRoot.push(verdict.path);
      continue;
    }
    // Fail CLOSED: only a current `dead` releases bytes. `unknown` — including an
    // unreachable daemon — spares the record.
    if (resolveWorkerLiveness(hostAnswer, verdict.worker_id).verdict !== "dead") {
      result.protectedLive.push(verdict.path);
      continue;
    }
    await rm(verdict.path, { recursive: true, force: true });
    result.removed.push(verdict.path);
  }
  return result;
}
