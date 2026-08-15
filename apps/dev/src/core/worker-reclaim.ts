// worker-reclaim.ts — the janitor's reclaim rule, anchored on the DAEMON's
// process truth (Spec #2772 US 46, ADR 0130).
//
// ONE RULE, STATED ONCE: an artifact is reclaimable when the daemon says the
// Worker that owns it is gone, and never because a pid file happens to be
// missing. Nothing in this module reads a pid, a pid file, or an mtime, because
// keying on those produced the exact inversion they were meant to prevent — the
// live supervisor's lane was deleted while the dead ones survived (#2679).
//
// The record that used to answer this question is extinct (Spec #2772). The
// daemon is the stronger authority that replaces it: it owns birth and death by
// construction, so it cannot be out of date about a process it holds.
//
// THREE VERDICTS, NOT TWO, and the third is the load-bearing one:
//
//   alive    — the daemon names this Worker. NOTHING it owns is reclaimable.
//   unknown  — the daemon did not answer, its answer is stale, or something
//              else can still see the Worker running. Retained, because "I could
//              not reach the authority" is not evidence of death.
//   dead     — the daemon answered, its answer is current, and it does not name
//              this Worker. Only here may bytes go.
//
// What a dead Worker leaves behind splits by COST, which is what decides whether
// it is kept:
//
//   workspace — expensive and regenerable (the 2.3 GB that fills a disk). Goes.
//   evidence  — cheap and irreplaceable: the material a human reads to rescue
//               orphaned work (#2701). Stays.
//   pointer   — a branch, PR or commit: named elsewhere, no bytes here.
//   unknown   — an unrecognised kind: retained and REPORTED, never guessed at.
//
// Two artifact-level overrides win over a dead Worker's release: `reclaimable:
// false` pins an artifact the rule would otherwise reclaim, and `reclaim_after`
// holds one until that instant has passed.
//
// And one discipline over all of it: A SILENT TRUNCATION IS A FAILURE. Every
// artifact considered lands in exactly one of `reclaim`, `retain`, or `dropped`,
// and `totals` states the identity so a caller can assert it.

/**
 * The daemon's verdict on one Worker's PROCESS, in the vocabulary the liveness
 * anchor publishes. Restated here so this planner stays pure: it consumes the
 * verdict, it never resolves one.
 */
export type WorkerProcessVerdict = "alive" | "dead" | "unknown";

/** What an artifact costs to keep, which is what decides whether it is kept. */
export type WorkerArtifactClass = "workspace" | "evidence" | "pointer" | "unknown";

/** Expensive and regenerable: the bytes that fill a disk. */
export const WORKER_WORKSPACE_ARTIFACT_KINDS = [
  "worktree",
  "workspace",
  "node_modules",
  "checkout",
  "build-cache",
  "sandbox",
] as const;

/** Cheap and irreplaceable: the material a rescue reads after the Worker died. */
export const WORKER_EVIDENCE_ARTIFACT_KINDS = [
  "log",
  "diagnostic",
  "envelope",
  "session",
  "transcript",
  "patch",
  "handoff",
  "report",
] as const;

/** Named elsewhere, so there are no bytes here to reclaim. */
export const WORKER_POINTER_ARTIFACT_KINDS = [
  "branch",
  "pr",
  "commit",
  "tag",
  "issue",
] as const;

const CLASS_BY_KIND = new Map<string, WorkerArtifactClass>([
  ...WORKER_WORKSPACE_ARTIFACT_KINDS.map((kind) => [kind, "workspace"] as const),
  ...WORKER_EVIDENCE_ARTIFACT_KINDS.map((kind) => [kind, "evidence"] as const),
  ...WORKER_POINTER_ARTIFACT_KINDS.map((kind) => [kind, "pointer"] as const),
]);

/** Classify one artifact kind. An unrecognised kind is `unknown` on purpose:
 * the janitor retains and REPORTS what it cannot classify, never guesses. */
export function classifyWorkerArtifact(kind: string): WorkerArtifactClass {
  return CLASS_BY_KIND.get(kind) ?? "unknown";
}

/** One thing a Worker left on disk, attributed to the Worker that owns it. */
export interface WorkerArtifact {
  /** The Worker whose process liveness releases (or holds) these bytes. */
  worker_id: string;
  /** What the artifact is, which decides its retention class. */
  kind: string;
  /** Absolute path, when the artifact has bytes at all. */
  path?: string;
  /** `false` PINS the artifact: a dead Worker does not release it. */
  reclaimable?: boolean;
  /** An ISO instant before which the artifact is HELD whatever else says. */
  reclaim_after?: string;
  /** Why it is pinned, carried into the retain verdict's reason. */
  reason?: string;
}

export type WorkerReclaimVerdictKind =
  /** The daemon names this Worker — the veto that outranks everything else. */
  | "worker-live"
  /** The daemon did not answer, or its answer is stale. Never a death. */
  | "liveness-unknown"
  /** The artifact pins itself: `reclaimable: false`. */
  | "pinned"
  /** `reclaim_after` has not passed yet (or does not parse). */
  | "grace-period"
  /** A branch, PR, or commit: named elsewhere, no bytes to reclaim. */
  | "pointer-retained"
  /** An unrecognised kind: retained and reported, never guessed at. */
  | "unclassified"
  /** Cheap evidence of a dead Worker — the rescue material. */
  | "evidence-retained"
  /** Expensive, regenerable workspace of a Worker the daemon calls gone. */
  | "workspace-reclaimable";

/** One artifact, one verdict, one reason. */
export interface WorkerArtifactVerdict {
  worker_id: string;
  artifact: WorkerArtifact;
  class: WorkerArtifactClass;
  /** The daemon's verdict on the owning Worker, carried so a reader never
   * re-derives it from a second source. */
  liveness: WorkerProcessVerdict;
  reclaim: boolean;
  verdict: WorkerReclaimVerdictKind;
  reason: string;
}

/** One Worker's share of the plan. */
export interface WorkerRetention {
  worker_id: string;
  liveness: WorkerProcessVerdict;
  reclaim: WorkerArtifactVerdict[];
  retain: WorkerArtifactVerdict[];
}

export const WORKER_RECLAIM_LIMIT_REASON = "limit" as const;

export type WorkerReclaimDropReason = "limit" | "no-worker";

/** Something the planner did NOT plan, and why. Never omitted silently. */
export interface WorkerReclaimDrop {
  reason: WorkerReclaimDropReason;
  detail: string;
  path?: string;
  worker_id?: string;
}

export interface WorkerReclaimTotals {
  considered: number;
  reclaim: number;
  retain: number;
  dropped: number;
}

export interface WorkerReclaimPlan {
  workers: WorkerRetention[];
  reclaim: WorkerArtifactVerdict[];
  retain: WorkerArtifactVerdict[];
  dropped: WorkerReclaimDrop[];
  /** True when a cap held reclaimable artifacts back. They are in `dropped`. */
  truncated: boolean;
  totals: WorkerReclaimTotals;
}

export interface WorkerReclaimOptions {
  /** The daemon's verdict per Worker. Injected, so this planner stays pure and
   * so no fallback source can sneak in behind it. */
  liveness: (workerId: string) => WorkerProcessVerdict;
  /** The instant `reclaim_after` is measured against. Injected, so this is pure. */
  nowIso?: string;
  /** Cap on reclaim actions per sweep. Everything past it is REPORTED, not
   * dropped quietly. */
  limit?: number;
  /** Paths seen on disk. Any the artifacts do not account for is reported and
   * left alone. */
  observedPaths?: readonly string[];
}

const NO_WORKER_DETAIL =
  "no Worker accounts for this path; the janitor leaves it alone";

function graceHasPassed(reclaimAfter: string, nowIso: string): boolean {
  const after = Date.parse(reclaimAfter);
  const now = Date.parse(nowIso);
  // An unparsable grace is treated as still running: the janitor holds bytes it
  // cannot reason about rather than deleting them.
  if (Number.isNaN(after) || Number.isNaN(now)) return false;
  return now >= after;
}

/**
 * Every path a LIVE Worker owns. A path can be attributed to more than one
 * Worker — a retry reuses the workspace a previous try left (ADR 0103) — so the
 * dead one's release must not offer up bytes the running one is still writing.
 * Liveness wins at PATH granularity, not just at Worker granularity.
 */
function pathsOwnedByLiveWorkers(
  artifacts: readonly WorkerArtifact[],
  liveness: (workerId: string) => WorkerProcessVerdict,
): Set<string> {
  const owned = new Set<string>();
  for (const artifact of artifacts) {
    if (artifact.path === undefined) continue;
    if (liveness(artifact.worker_id) === "dead") continue;
    owned.add(artifact.path);
  }
  return owned;
}

function judge(
  artifact: WorkerArtifact,
  verdict: WorkerProcessVerdict,
  nowIso: string,
  liveOwned: ReadonlySet<string>,
): WorkerArtifactVerdict {
  const cls = classifyWorkerArtifact(artifact.kind);
  const base = {
    worker_id: artifact.worker_id,
    artifact,
    class: cls,
    liveness: verdict,
  } as const;
  const retain = (
    kind: WorkerReclaimVerdictKind,
    reason: string,
  ): WorkerArtifactVerdict => ({ ...base, reclaim: false, verdict: kind, reason });
  const reclaim = (
    kind: WorkerReclaimVerdictKind,
    reason: string,
  ): WorkerArtifactVerdict => ({ ...base, reclaim: true, verdict: kind, reason });

  if (verdict === "alive") {
    return retain(
      "worker-live",
      "the daemon names this Worker, so nothing it owns is reclaimable",
    );
  }
  if (verdict === "unknown") {
    return retain(
      "liveness-unknown",
      "the daemon did not answer for this Worker, and an unanswered question is not a death",
    );
  }
  if (artifact.path !== undefined && liveOwned.has(artifact.path)) {
    return retain(
      "worker-live",
      "a Worker the daemon has not called dead owns this path; this Worker's death does not release it",
    );
  }
  if (artifact.reclaimable === false) {
    return retain("pinned", artifact.reason ?? "this artifact is pinned as not reclaimable");
  }
  if (artifact.reclaim_after && !graceHasPassed(artifact.reclaim_after, nowIso)) {
    return retain("grace-period", `held until reclaim_after ${artifact.reclaim_after}`);
  }
  if (cls === "pointer") {
    return retain(
      "pointer-retained",
      `a ${artifact.kind} pointer is named by the tracker and git, not stored here`,
    );
  }
  if (cls === "unknown") {
    return retain(
      "unclassified",
      `artifact kind ${JSON.stringify(artifact.kind)} is not a known retention class`,
    );
  }
  if (cls === "evidence") {
    return retain(
      "evidence-retained",
      "the Worker is gone, so its cheap evidence is the material a rescue reads",
    );
  }
  return reclaim(
    "workspace-reclaimable",
    "the daemon calls this Worker gone, and its workspace is expensive and regenerable",
  );
}

/**
 * Plan the reclaim for a set of Worker artifacts against the daemon's verdicts.
 *
 * The plan is total: every artifact — plus every observed path no Worker
 * accounts for — appears exactly once across `reclaim`, `retain`, and `dropped`,
 * and `totals` states that identity.
 */
export function planWorkerReclaim(
  artifacts: readonly WorkerArtifact[],
  options: WorkerReclaimOptions,
): WorkerReclaimPlan {
  const nowIso = options.nowIso ?? new Date().toISOString();
  const workers = new Map<string, WorkerRetention>();
  const reclaim: WorkerArtifactVerdict[] = [];
  const retain: WorkerArtifactVerdict[] = [];
  const dropped: WorkerReclaimDrop[] = [];
  const accounted = new Set<string>();
  // Counted from the INPUT, never from the output arrays, so the accounting
  // identity in `totals` is a real assertion rather than a tautology.
  let considered = 0;
  const liveOwned = pathsOwnedByLiveWorkers(artifacts, options.liveness);

  for (const artifact of artifacts) {
    considered += 1;
    if (artifact.path !== undefined) accounted.add(artifact.path);
    const liveness = options.liveness(artifact.worker_id);
    let worker = workers.get(artifact.worker_id);
    if (worker === undefined) {
      worker = { worker_id: artifact.worker_id, liveness, reclaim: [], retain: [] };
      workers.set(artifact.worker_id, worker);
    }
    const verdict = judge(artifact, liveness, nowIso, liveOwned);
    if (!verdict.reclaim) {
      retain.push(verdict);
      worker.retain.push(verdict);
      continue;
    }
    // The cap is applied here so a held-back artifact is REPORTED as a drop
    // rather than quietly re-labelled as retained — a caller reading `retain`
    // must never be told an artifact was kept on purpose when it was really
    // just past the cap.
    if (options.limit !== undefined && reclaim.length >= options.limit) {
      dropped.push({
        reason: WORKER_RECLAIM_LIMIT_REASON,
        detail: `reclaim limit ${options.limit} reached; this artifact was not planned`,
        worker_id: artifact.worker_id,
        ...(artifact.path === undefined ? {} : { path: artifact.path }),
      });
      continue;
    }
    reclaim.push(verdict);
    worker.reclaim.push(verdict);
  }

  for (const path of options.observedPaths ?? []) {
    if (accounted.has(path)) continue;
    accounted.add(path);
    considered += 1;
    dropped.push({ reason: "no-worker", path, detail: NO_WORKER_DETAIL });
  }

  return {
    workers: [...workers.values()],
    reclaim,
    retain,
    dropped,
    truncated: dropped.some((drop) => drop.reason === WORKER_RECLAIM_LIMIT_REASON),
    totals: {
      considered,
      reclaim: reclaim.length,
      retain: retain.length,
      dropped: dropped.length,
    },
  };
}
