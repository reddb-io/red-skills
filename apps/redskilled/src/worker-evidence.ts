/**
 * worker-evidence — the cheap, irreplaceable bytes a dead Worker leaves behind.
 *
 * ADR 0149 §2 splits what a Worker produces by COST, not by tidiness. The
 * workspace is expensive and regenerable, so it lives in OS temporary storage
 * and the daemon deletes it the moment the Worker dies (`worker-workspace.ts`).
 * What this module keeps is the other half: the Worker's log, the runner's
 * session artifact and the verdict — a few kilobytes that no rerun reproduces,
 * because they describe a run that already happened. They go to
 * `~/.red/tmp/workers/<id>/`, which is what a human reads after a reboot has
 * taken the workspace with it.
 *
 * **The lane is not the daemon's home, and that separation is the point.**
 * `~/.red/redskilled/` holds what must survive indefinitely — the daemon's own
 * log, its registrations, its credentials, its incidents. Evidence is
 * irreplaceable but not eternal: a Worker that died five weeks ago explains
 * nothing anybody is still asking about, so the lane carries a TTL and the
 * durable home does not. Putting evidence under the durable home would have
 * meant either pruning the daemon's own records or never pruning evidence.
 *
 * **Pruning is a prefix scan, and that is why the id is a timestamp.** A Worker
 * id is fixed-width base62 of its birth instant (ADR 0149 §3), so the cutoff is
 * an id too: encode `now - ttl`, and every lexicographically smaller directory
 * name is expired. No stat, no mtime — and mtime is exactly the anchor inversion
 * the Worker reclaim rule forbids, because touching a file would resurrect a
 * lane the operator meant to lose.
 *
 * **A live Worker's lane is never pruned, whatever its age says.** The daemon
 * owns birth and death by construction, so the live set it hands in is the
 * authority; an id absent from it is only then judged by age. A directory whose
 * name is not a Worker id at all is RETAINED and reported, never guessed at.
 */
import { copyFile, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { encode as encodeToon } from "@reddb-io/toon";
import { encodeHostWorkerId, isHostWorkerId } from "./worker-launch.js";

/** The segments below the operator's home. `~/.red/tmp/workers` (ADR 0149 §2). */
export const WORKER_EVIDENCE_SEGMENTS = [".red", "tmp", "workers"] as const;

/** Owner-only: a Worker's log quotes somebody's private repository back at them. */
export const WORKER_EVIDENCE_MODE = 0o700;

/** The Worker's own narrative lane, copied under the name it already has. */
export const WORKER_EVIDENCE_LOG_FILE = "worker.log.toonl";

/** The daemon's account of how this Worker ended. Always written, even when nothing else is. */
export const WORKER_EVIDENCE_VERDICT_FILE = "verdict.toon";

/** The runner's own session artifact, under a stable name plus its native extension. */
export const WORKER_EVIDENCE_SESSION_STEM = "session-artifact";

/** ADR 0149 §2's default: thirty days. Host-tunable, never per repository. */
export const DEFAULT_WORKER_EVIDENCE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Raised when a lane cannot be named. Fail closed: never guess a path to delete. */
export class WorkerEvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerEvidenceError";
  }
}

/** The evidence lane for one operator. PURE. */
export function workerEvidenceRoot(homeDir: string): string {
  return join(homeDir, ...WORKER_EVIDENCE_SEGMENTS);
}

/** One Worker's lane inside it. PURE, and refuses an id that would escape. */
export function workerEvidenceDir(root: string, workerId: string): string {
  const segment = workerId.trim();
  if (segment === "" || segment === "." || segment === ".." || /[/\\]/.test(segment)) {
    throw new WorkerEvidenceError(
      `invalid Worker id ${JSON.stringify(workerId)}: it would escape the host's evidence lane.`,
    );
  }
  return join(root, segment);
}

/** What the runner said about its own session artifact, verbatim. */
export interface WorkerEvidenceSessionArtifact {
  readonly provider: string;
  readonly availability: "available" | "absent" | "inaccessible";
  /** The runner's own path or handle; copied only when it names a readable file. */
  readonly reference?: string;
}

/** The daemon's account of one Worker's death, written whatever else is missing. */
export interface WorkerEvidenceVerdict {
  readonly workerId: string;
  /** Why the Worker ended, in the daemon's own words — `idle-policy`, `completion`, … */
  readonly outcome: string;
  readonly diedAt: string;
  /** The workspace that went with it, so the verdict says what is no longer there. */
  readonly workspacePath?: string;
  readonly publicSessionId?: string;
  readonly sessionArtifact?: WorkerEvidenceSessionArtifact;
}

export interface RetainWorkerEvidenceInput {
  readonly root: string;
  readonly verdict: WorkerEvidenceVerdict;
  /** The Worker's narrative log, wherever the daemon told it to write one. */
  readonly logPath?: string;
}

/** Whether one artifact reached the lane, and why it did not when it did not. */
export type WorkerEvidenceCapture = "copied" | "absent" | "unreadable";

export interface RetainedWorkerEvidence {
  readonly evidenceDir: string;
  readonly verdictPath: string;
  readonly log: WorkerEvidenceCapture;
  readonly sessionArtifact: WorkerEvidenceCapture;
}

/**
 * Copy a dead Worker's evidence into its lane, and say what arrived.
 *
 * **The verdict is written last and unconditionally.** A lane holding only a
 * verdict is a complete answer — "this Worker died this way and left nothing
 * else" — while a lane holding only bytes is a puzzle. Writing it after the
 * copies also means the verdict can report what the copies actually did, so a
 * human reading the lane never has to infer a missing file's meaning.
 *
 * Nothing here throws for a source that is not there: a Worker that died before
 * it logged a line is the ordinary early-death case, not an error, and losing
 * the verdict too would delete the only record of it.
 */
export async function retainWorkerEvidence(
  input: RetainWorkerEvidenceInput,
): Promise<RetainedWorkerEvidence> {
  const evidenceDir = workerEvidenceDir(input.root, input.verdict.workerId);
  await mkdir(evidenceDir, { recursive: true, mode: WORKER_EVIDENCE_MODE });

  const log = await capture(input.logPath, join(evidenceDir, WORKER_EVIDENCE_LOG_FILE));
  const artifact = input.verdict.sessionArtifact;
  const sessionArtifact = artifact == null || artifact.availability !== "available"
    ? "absent"
    : await capture(
      artifact.reference,
      join(evidenceDir, `${WORKER_EVIDENCE_SESSION_STEM}${extname(artifact.reference ?? "")}`),
    );

  const verdictPath = join(evidenceDir, WORKER_EVIDENCE_VERDICT_FILE);
  await writeFile(verdictPath, `${encodeToon({
    version: 1,
    worker_id: input.verdict.workerId,
    outcome: input.verdict.outcome,
    died_at: input.verdict.diedAt,
    ...(input.verdict.publicSessionId == null ? {} : { public_session_id: input.verdict.publicSessionId }),
    ...(input.verdict.workspacePath == null ? {} : { released_workspace_path: input.verdict.workspacePath }),
    log,
    session_artifact: sessionArtifact,
    ...(artifact == null ? {} : {
      session_artifact_report: {
        provider: artifact.provider,
        availability: artifact.availability,
        ...(artifact.reference == null ? {} : { reference: artifact.reference }),
      },
    }),
  })}\n`, { mode: 0o600 });

  return { evidenceDir, verdictPath, log, sessionArtifact };
}

/** What the prune decided about one directory in the lane. */
export type WorkerEvidenceDisposition = "pruned" | "live" | "retained" | "unrecognized" | "failed";

export interface WorkerEvidencePruneEntry {
  readonly workerId: string;
  readonly dir: string;
  readonly disposition: WorkerEvidenceDisposition;
  /** Why, in operator words — a sweep that cannot explain itself is a sweep nobody trusts. */
  readonly reason: string;
}

export interface WorkerEvidencePruneReport {
  readonly root: string;
  readonly ttlMs: number;
  /** The prefix-scan boundary: every smaller id was born before the cutoff. */
  readonly cutoffWorkerId: string;
  readonly scanned: number;
  readonly pruned: number;
  readonly entries: readonly WorkerEvidencePruneEntry[];
}

export interface PruneWorkerEvidenceOptions {
  readonly root: string;
  readonly ttlMs?: number;
  readonly now?: () => number;
  /** The Workers the daemon currently holds. Their lanes go untouched at any age. */
  readonly live?: Iterable<string>;
}

/**
 * Remove the lanes whose Worker died longer ago than the TTL allows.
 *
 * Never throws on an entry it cannot remove: a lane behind a bad permission is
 * reported `failed` and the sweep continues, because one unreadable directory
 * must not leave every other expired one on disk.
 */
export async function pruneWorkerEvidence(
  options: PruneWorkerEvidenceOptions,
): Promise<WorkerEvidencePruneReport> {
  const ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs! >= 0
    ? options.ttlMs!
    : DEFAULT_WORKER_EVIDENCE_TTL_MS;
  const live = new Set(options.live ?? []);
  const cutoffMs = Math.max(0, (options.now ?? Date.now)() - ttlMs);
  const cutoffWorkerId = encodeHostWorkerId(cutoffMs);

  let names: string[];
  try {
    names = (await readdir(options.root, { withFileTypes: true }))
      .filter((child) => child.isDirectory())
      .map((child) => child.name)
      .sort();
  } catch {
    // A lane that was never written is a host that has lost no Worker, not a fault.
    return { root: options.root, ttlMs, cutoffWorkerId, scanned: 0, pruned: 0, entries: [] };
  }

  const entries: WorkerEvidencePruneEntry[] = [];
  for (const name of names) {
    const dir = join(options.root, name);
    if (live.has(name)) {
      entries.push({ workerId: name, dir, disposition: "live", reason: "the daemon still holds this Worker" });
      continue;
    }
    if (!isHostWorkerId(name)) {
      entries.push({
        workerId: name,
        dir,
        disposition: "unrecognized",
        reason: "the directory name is not a host Worker id, so its age is unknown",
      });
      continue;
    }
    if (name >= cutoffWorkerId) {
      entries.push({ workerId: name, dir, disposition: "retained", reason: `born at or after ${cutoffWorkerId}` });
      continue;
    }
    try {
      await rm(dir, { recursive: true, force: true });
      entries.push({ workerId: name, dir, disposition: "pruned", reason: `born before ${cutoffWorkerId}` });
    } catch (error) {
      entries.push({
        workerId: name,
        dir,
        disposition: "failed",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    root: options.root,
    ttlMs,
    cutoffWorkerId,
    scanned: entries.length,
    pruned: entries.filter((entry) => entry.disposition === "pruned").length,
    entries,
  };
}

/** Copy one source into the lane, reporting rather than throwing. */
async function capture(source: string | undefined, target: string): Promise<WorkerEvidenceCapture> {
  if (source == null || source.trim() === "") return "absent";
  try {
    await copyFile(source, target);
    return "copied";
  } catch {
    return "unreadable";
  }
}

/**
 * Everything a live Worker must already hold to leave evidence when it dies.
 *
 * Carried on the Worker handle rather than looked up at death, for the same
 * reason its workspace is: at cleanup the process is already gone, the runner
 * has already reported its artifact, and the only thing that ever knew where
 * those bytes were is the handle about to be dropped.
 */
export interface WorkerEvidencePlan {
  readonly root: string;
  readonly ttlMs: number;
  /** The Worker's narrative log; absent when the client asked for none. */
  readonly logPath?: string;
  readonly sessionArtifact?: WorkerEvidenceSessionArtifact;
}
