import { execFileSync } from "node:child_process";

/**
 * "Is this attempt alive?" evaluator (ADR 0083 §3). The verdict combines two
 * independent signals:
 *
 *   (a) **lane recency** — how long since the substrate's own control flow last
 *       refreshed the liveness lane (see `LivenessLane`), and
 *   (b) a **process-tree cross-check** — whether the attempt's agent process
 *       still has live descendant processes.
 *
 * The cross-check exists because the lane alone cannot see a *wedged substrate
 * with a still-running agent*: if the substrate stops writing the lane but the
 * agent subprocess keeps working, lane recency would read "stalled" while the
 * work is genuinely alive. The cross-check corrects exactly that case.
 */

/** Sandbox provider tag, mirroring `SandboxProvider.tag`. */
export type SandboxTag = "none" | "bind-mount" | "isolated";

export interface LivenessCrossCheckArming {
  readonly crossCheckArmed: boolean;
}

/**
 * Decide whether the process-tree cross-check is armed for a given sandbox
 * mode. Pure, so the arming decision is unit-testable without a real process
 * tree.
 *
 * The cross-check reads the **host** process tree, which is blind to an agent
 * running inside a docker/podman container (the `bind-mount` and `isolated`
 * providers). So it arms only where the tree is visible — the no-sandbox
 * (`"none"`) mode. This is the same switch pattern ADR 0054's
 * `resolveAttemptGuardArming` uses to keep the host-blind lane-idle reaper
 * no-sandbox-only.
 */
export function resolveLivenessCrossCheckArming(opts: {
  sandboxTag: SandboxTag;
}): LivenessCrossCheckArming {
  return { crossCheckArmed: opts.sandboxTag === "none" };
}

/**
 * `capped` is NOT a stall (#2701): the attempt held its issue past the
 * wall-clock ceiling while still doing work — tool calls, reasoning, commits.
 * Folding it into `stalled` made every long-but-productive attempt read as "the
 * agent never finished", so the two verdicts are kept apart at the source: a
 * stall means silence, a cap means a policy deadline expired on live work.
 */
export type LivenessStatus = "alive" | "stalled" | "capped" | "unknown";

export interface LivenessVerdict {
  readonly status: LivenessStatus;
  /** Whether lane recency alone puts the attempt within the idle threshold. */
  readonly laneFresh: boolean;
  /** Age (ms) of the newest lane record, or `undefined` when the lane is empty. */
  readonly laneAgeMs?: number;
  /** Whether the process-tree cross-check was armed for this run. */
  readonly crossCheckArmed: boolean;
  /**
   * Result of the descendant probe. Present only when the cross-check was armed
   * **and** consulted (i.e. the lane was not fresh); absent otherwise.
   */
  readonly liveDescendants?: boolean;
  /**
   * Age (ms) since the attempt claimed its issue. Present only when the
   * wall-clock ceiling (#2286) fired; absent otherwise.
   */
  readonly issueAgeMs?: number;
  /** True when the verdict was decided by the wall-clock ceiling (#2286). */
  readonly wallClockExceeded?: boolean;
  /** Human-readable explanation of how the status was reached. */
  readonly reason: string;
}

export interface EvaluateLivenessInput {
  /**
   * Epoch-ms of the newest lane record, or `undefined` when the lane has no
   * records (e.g. `readLivenessRecency`).
   */
  readonly laneRecencyMs: number | undefined;
  /** Current epoch-ms. Injected so tests drive it with a fake clock. */
  readonly now: number;
  /** The lane is idle once its newest record is older than this many ms. */
  readonly laneIdleMs: number;
  /** Cross-check arming, from {@link resolveLivenessCrossCheckArming}. */
  readonly crossCheckArmed: boolean;
  /**
   * Probe: does the attempt's agent process still have live descendants?
   * Consulted **only** when `crossCheckArmed` is true and the lane is not
   * fresh. Injected so tests supply a fake probe.
   */
  readonly hasLiveDescendants?: () => boolean;
  /**
   * Hard-silence backstop (#2203): once the lane has been idle for at least
   * this many ms, the verdict is `stalled` regardless of live descendants or
   * cross-check arming — a wedged agent (a hung child at flat cpu that keeps
   * the process alive but never advances the lane) must never hold a slot
   * forever. `undefined` disables the backstop (the pre-#2203 behaviour). Must
   * be well above `laneIdleMs`.
   */
  readonly laneHardIdleMs?: number;
  /**
   * Epoch-ms at which this attempt claimed its issue. Feeds the wall-clock
   * ceiling below; `undefined` (claim epoch unknown) disables the ceiling.
   */
  readonly issueClaimedAtMs?: number;
  /**
   * Activity-independent wall-clock-per-issue ceiling (#2286) — the age-based
   * twin of `laneHardIdleMs`. Once the attempt has held its issue for at least
   * this many ms, the verdict is `stalled` no matter how alive it looks: an
   * attempt that keeps its lane fresh and its tree busy while never converging
   * (a retry loop, a self-feeding edit/test cycle) is invisible to every
   * silence-based cap, yet still holds a slot forever. `undefined` disables the
   * ceiling.
   */
  readonly issueWallClockMaxMs?: number;
}

/**
 * Combine lane recency and the process cross-check into a single verdict.
 *
 * - Lane fresh                                   → `alive` (recency is enough).
 * - Lane idle, cross-check armed, live agent     → `alive` (wedged substrate,
 *                                                  but the agent is still working).
 * - Lane idle, cross-check armed, no live agent  → `stalled`.
 * - Lane idle, cross-check disarmed (container)  → `unknown` (cannot corroborate
 *                                                  without the host process tree).
 */
export function evaluateLiveness(
  input: EvaluateLivenessInput,
): LivenessVerdict {
  const { laneRecencyMs, now, laneIdleMs, crossCheckArmed } = input;
  const laneAgeMs =
    laneRecencyMs === undefined ? undefined : Math.max(0, now - laneRecencyMs);
  const laneFresh = laneAgeMs !== undefined && laneAgeMs <= laneIdleMs;

  // Wall-clock-per-issue ceiling (#2286): age since claim, evaluated FIRST so
  // no activity signal can veto it. Lane freshness and live descendants both
  // measure *activity*, and the failure this catches is a busy attempt that
  // never converges — it stays fresh and stays alive while holding a slot
  // forever. The reaper still gates the irreversible kill behind
  // decideReaperSignal + the on_stall_reap hook.
  if (
    input.issueWallClockMaxMs !== undefined &&
    input.issueClaimedAtMs !== undefined
  ) {
    const issueAgeMs = Math.max(0, now - input.issueClaimedAtMs);
    if (issueAgeMs >= input.issueWallClockMaxMs) {
      return {
        // `capped`, never `stalled` (#2701): the ceiling measures ELAPSED TIME,
        // not silence. A fresh lane here proves the attempt was working when the
        // deadline fired, and calling that a stall orphaned its committed work.
        status: "capped",
        laneFresh,
        laneAgeMs,
        crossCheckArmed,
        issueAgeMs,
        wallClockExceeded: true,
        reason: `issue wall-clock ceiling exceeded (${issueAgeMs}ms >= ${input.issueWallClockMaxMs}ms since claim) — activity-independent`,
      };
    }
  }

  if (laneFresh) {
    return {
      status: "alive",
      laneFresh: true,
      laneAgeMs,
      crossCheckArmed,
      reason: `lane fresh (${laneAgeMs}ms <= ${laneIdleMs}ms idle threshold)`,
    };
  }

  const ageDesc =
    laneAgeMs === undefined
      ? "lane empty"
      : `lane idle (${laneAgeMs}ms > ${laneIdleMs}ms)`;

  // Hard-silence backstop (#2203): once the liveness lane has been silent past
  // the hard cap, the attempt is stalled regardless of live descendants or
  // cross-check arming — a wedged agent (a live child at flat cpu that stops
  // advancing the lane) must never hold a slot forever. Placed before the
  // arming/descendant checks so neither can veto it; the reaper's kill
  // predicate still gates the irreversible kill on a flat-cpu / no-build tree,
  // and genuine work keeps its lane fresh, so this never fires for real work.
  if (
    laneAgeMs !== undefined &&
    input.laneHardIdleMs !== undefined &&
    laneAgeMs >= input.laneHardIdleMs
  ) {
    return {
      status: "stalled",
      laneFresh: false,
      laneAgeMs,
      crossCheckArmed,
      reason: `${ageDesc} past hard-silence cap (${input.laneHardIdleMs}ms) — descendant/cross-check overridden`,
    };
  }

  // Lane is idle or empty. The lane alone would call this stalled, but a wedged
  // substrate can stop writing the lane while the agent keeps working — the
  // cross-check is the only signal that can see that.
  if (!crossCheckArmed) {
    return {
      status: "unknown",
      laneFresh: false,
      laneAgeMs,
      crossCheckArmed: false,
      reason: `${ageDesc}; process cross-check disarmed under container isolation`,
    };
  }

  const liveDescendants = input.hasLiveDescendants
    ? input.hasLiveDescendants()
    : false;
  if (liveDescendants) {
    return {
      status: "alive",
      laneFresh: false,
      laneAgeMs,
      crossCheckArmed: true,
      liveDescendants: true,
      reason: `${ageDesc} but live agent descendants (substrate may be wedged)`,
    };
  }
  return {
    status: "stalled",
    laneFresh: false,
    laneAgeMs,
    crossCheckArmed: true,
    liveDescendants: false,
    reason: `${ageDesc} and no live agent descendants`,
  };
}

// ---------- process-tree descendant probe ----------

/** One row of a `ps` process-table snapshot: a pid and its parent pid. */
export interface ProcSnapshotEntry {
  readonly pid: number;
  readonly ppid: number;
}

/**
 * Parse a `ps -eo pid=,ppid=` snapshot (two whitespace-separated integer
 * columns per line). Lines that do not parse to two integers are skipped.
 */
export function parsePsSnapshot(raw: string): ProcSnapshotEntry[] {
  const entries: ProcSnapshotEntry[] = [];
  for (const line of raw.split("\n")) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 2) continue;
    const pid = Number(cols[0]);
    const ppid = Number(cols[1]);
    if (Number.isInteger(pid) && Number.isInteger(ppid)) {
      entries.push({ pid, ppid });
    }
  }
  return entries;
}

/**
 * Whether `rootPid` has at least one live descendant in the snapshot. Walks the
 * ppid→children edges breadth-first, so grandchildren count too. The root pid
 * itself does not count — only its descendants.
 */
export function hasDescendantInSnapshot(
  rootPid: number,
  entries: readonly ProcSnapshotEntry[],
): boolean {
  const childrenOf = new Map<number, number[]>();
  for (const { pid, ppid } of entries) {
    const list = childrenOf.get(ppid);
    if (list) list.push(pid);
    else childrenOf.set(ppid, [pid]);
  }
  const queue = [...(childrenOf.get(rootPid) ?? [])];
  if (queue.length > 0) return true;
  return false;
}

export interface ProcessDescendantProbeOptions {
  /** The attempt's agent process pid whose descendants we probe for. */
  readonly agentPid: number;
  /**
   * Returns a `ps` snapshot (one `"<pid> <ppid>"` line per process). Injected
   * so tests supply a fake table; defaults to spawning `ps -eo pid=,ppid=`.
   */
  readonly snapshot?: () => string;
}

const defaultPsSnapshot = (): string =>
  execFileSync("ps", ["-eo", "pid=,ppid="], { encoding: "utf-8" });

/**
 * Build a sync `hasLiveDescendants` probe for {@link evaluateLiveness}. Any
 * probe failure (no `ps`, spawn error) degrades to `false` — "no descendants
 * seen" — so the evaluator falls back to lane recency rather than crashing.
 */
export function createProcessDescendantProbe(
  options: ProcessDescendantProbeOptions,
): () => boolean {
  const read = options.snapshot ?? defaultPsSnapshot;
  return () => {
    try {
      return hasDescendantInSnapshot(options.agentPid, parsePsSnapshot(read()));
    } catch {
      return false;
    }
  };
}
