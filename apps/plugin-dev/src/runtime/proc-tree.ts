// runtime/proc-tree.ts — the real `ps`-backed worker-tree inspector.
//
// Mirrors supervisor.sh's sup_descendant_pids + sup_active_descendant +
// sup_tree_cpu: collect a worker pid's descendant processes (pid + every
// transitive child) and project each to a ProcessSnapshotEntry ({command, cpu})
// the reaper-signal reduction (deriveSnapshot) consumes.
//
// This is the load-bearing SAFETY seam for the native fleet's hard-reaper. The
// reaper only kills a stalled slot when the snapshot shows no active build/test
// descendant AND flat cpu. An EMPTY snapshot therefore reads as "stuck" and
// authorises a kill — so a transient `ps` failure must NEVER degrade to []. On
// any inspection error we return a CONSERVATIVE BUSY snapshot (one synthetic
// high-cpu entry) so a flaky `ps` can only ever spare a live worker, never reap
// one.

import { execFileSync } from "node:child_process";
import type { ProcessSnapshotEntry } from "../core/reaper-signal.js";

/** Synthetic entry returned when process inspection fails. Its cpu sits well
 * above REAPER_SIGNAL_CPU_BUSY_PCT_DEFAULT (5) so deriveSnapshot →
 * decideReaperSignal reads the tree as busy and refuses to kill. The command is
 * deliberately not a recognised build/test tool — the cpu signal alone carries
 * the conservative "busy" verdict, which is exactly the bash `ps` failure
 * fallback intent (a failed ps must not authorise a reap). */
export const CONSERVATIVE_BUSY_SNAPSHOT: readonly ProcessSnapshotEntry[] = [
  { command: "unknown", cpu: 100 },
];

/** True when `pid` is a usable, non-foot-gun process id. Mirrors the
 * sup_descendant_pids / sup_kill_tree guards: empty / non-numeric / <= 1 are
 * refused. */
function isInspectablePid(pid: number): boolean {
  return Number.isInteger(pid) && pid > 1;
}

/**
 * Parse the stdout of `ps -o pid=,ppid=,%cpu=,comm= -e` into a child→parent map
 * plus per-pid {command, cpu}. Each line is whitespace-delimited:
 *   `<pid> <ppid> <cpu> <comm…>`
 * comm may contain spaces (rare, but `ps comm=` can emit a path) so everything
 * past the third field is the command; we take its basename to mirror
 * `ps -o comm=` semantics the busy regex expects. A malformed line is skipped.
 */
export function parsePsTree(stdout: string): {
  children: Map<number, number[]>;
  info: Map<number, ProcessSnapshotEntry>;
} {
  const children = new Map<number, number[]>();
  const info = new Map<number, ProcessSnapshotEntry>();
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 4) continue;
    const pid = Number(parts[0]);
    const ppid = Number(parts[1]);
    const cpu = Number(parts[2]);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    const commandRaw = parts.slice(3).join(" ");
    const command = basename(commandRaw);
    info.set(pid, { command, cpu: Number.isFinite(cpu) ? cpu : 0 });
    const siblings = children.get(ppid);
    if (siblings) siblings.push(pid);
    else children.set(ppid, [pid]);
  }
  return { children, info };
}

/** Basename of a `ps comm` value (strip any directory + trailing args). */
function basename(comm: string): string {
  const firstWord = comm.split(/\s+/)[0] ?? comm;
  const slash = firstWord.lastIndexOf("/");
  return slash >= 0 ? firstWord.slice(slash + 1) : firstWord;
}

/**
 * Walk the parsed tree from `pid` and collect `pid` + every transitive
 * descendant as ProcessSnapshotEntry[]. Mirrors sup_descendant_pids feeding
 * sup_active_descendant + sup_tree_cpu. A pid absent from `info` (raced away
 * between snapshot and walk) contributes nothing.
 */
export function collectTree(
  pid: number,
  children: Map<number, number[]>,
  info: Map<number, ProcessSnapshotEntry>,
): ProcessSnapshotEntry[] {
  const out: ProcessSnapshotEntry[] = [];
  const seen = new Set<number>();
  const stack = [pid];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    const entry = info.get(current);
    if (entry) out.push(entry);
    const kids = children.get(current);
    if (kids) for (const k of kids) stack.push(k);
  }
  return out;
}

/** A synchronous runner that executes `ps -e -o pid=,ppid=,%cpu=,comm=` and
 * returns its stdout. Injectable for testing. */
export type PsTreeRunner = () => string;

/**
 * Inspect the worker `pid`'s process tree into a ProcessSnapshotEntry[] using
 * the provided `run` function to obtain the full-process-list stdout. Best-
 * effort and SAFE BY DEFAULT:
 *   - an un-inspectable pid (<=1, NaN) → [] (no tree, deriveSnapshot is empty;
 *     a freed/garbage slot pid is genuinely not running anything).
 *   - a runner throw (timeout, EAGAIN, missing binary) →
 *     CONSERVATIVE_BUSY_SNAPSHOT so the reaper never kills off the back of a
 *     transient inspection error.
 *   - a successful run that simply does not list the pid (already exited) → []
 *     — that is a real, observed absence, not an inspection failure.
 */
export function inspectProcessTree(
  pid: number,
  run: PsTreeRunner,
): readonly ProcessSnapshotEntry[] {
  if (!isInspectablePid(pid)) return [];
  let stdout: string;
  try {
    stdout = run();
  } catch {
    // runner failed (timeout, missing binary, EAGAIN, …). Falling to [] would
    // read as "stuck" and authorise a kill — refuse: report busy.
    return CONSERVATIVE_BUSY_SNAPSHOT;
  }
  try {
    const { children, info } = parsePsTree(stdout);
    return collectTree(pid, children, info);
  } catch {
    return CONSERVATIVE_BUSY_SNAPSHOT;
  }
}

export function inspectProcessTreeNative(pid: number): readonly ProcessSnapshotEntry[] {
  return inspectProcessTree(pid, () =>
    execFileSync("ps", ["-e", "-o", "pid=,ppid=,%cpu=,comm="], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: 5000,
    }),
  );
}

// ---------- per-attempt memory accounting (ADR 0128 §8) ----------

/**
 * Parse `ps -e -o pid=,ppid=,rss=` into the child edges plus each pid's RSS in
 * KB. A malformed line is skipped. Separate from {@link parsePsTree} on purpose:
 * the reaper's snapshot is a SAFETY input (a failed read must read as busy),
 * while this one is an ACCOUNTING input (a failed read must measure nothing).
 */
export function parsePsRssTree(stdout: string): {
  children: Map<number, number[]>;
  rssKb: Map<number, number>;
} {
  const children = new Map<number, number[]>();
  const rssKb = new Map<number, number>();
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 3) continue;
    const pid = Number(parts[0]);
    const ppid = Number(parts[1]);
    const rss = Number(parts[2]);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid) || !Number.isFinite(rss)) continue;
    rssKb.set(pid, rss);
    const siblings = children.get(ppid);
    if (siblings) siblings.push(pid);
    else children.set(ppid, [pid]);
  }
  return { children, rssKb };
}

/**
 * Resident-set size in MB for each requested pid's whole process tree, from ONE
 * process-table read — so per-attempt memory accounting costs the same whether
 * the fleet runs one worker or eight.
 *
 * FAILS CLOSED ON MEASUREMENT, OPEN ON POLICY: a failed or unreadable sample
 * returns an EMPTY map. An absent pid means "not measured", never 0 and never a
 * fabricated number, so a flaky `ps` can only ever fail to charge an attempt —
 * it can never terminate one that was inside its budget.
 */
export function sampleTreeRssMb(
  pids: readonly number[],
  run: PsTreeRunner,
): Map<number, number> {
  const out = new Map<number, number>();
  const wanted = pids.filter((pid) => isInspectablePid(pid));
  if (wanted.length === 0) return out;
  let stdout: string;
  try {
    stdout = run();
  } catch {
    return out;
  }
  let parsed: ReturnType<typeof parsePsRssTree>;
  try {
    parsed = parsePsRssTree(stdout);
  } catch {
    return out;
  }
  for (const root of wanted) {
    let totalKb = 0;
    let seenAny = false;
    const seen = new Set<number>();
    const stack = [root];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (seen.has(current)) continue;
      seen.add(current);
      const kb = parsed.rssKb.get(current);
      if (kb !== undefined) {
        totalKb += kb;
        seenAny = true;
      }
      const kids = parsed.children.get(current);
      if (kids) for (const k of kids) stack.push(k);
    }
    // A pid the table never listed has already exited — nothing to charge.
    if (seenAny) out.set(root, Math.round(totalKb / 1024));
  }
  return out;
}

/** {@link sampleTreeRssMb} against the real process table. */
export function sampleTreeRssMbNative(pids: readonly number[]): Map<number, number> {
  return sampleTreeRssMb(pids, () =>
    execFileSync("ps", ["-e", "-o", "pid=,ppid=,rss="], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: 5000,
    }),
  );
}
