/**
 * memory-sampler — the floor every placement backend stands on.
 *
 * **Every backend guarantees the same floor**, so backends differ in the
 * *quality* of their teeth and never in whether they have any. A cgroup, a Job
 * Object or an rlimit is an upgrade in precision and latency over this sampler —
 * never a replacement for it, and never a reason for a host without one to run
 * a Worker with no ceiling at all.
 *
 * **One sample per tick covers the whole set.** The sampler is handed every
 * Worker at once and answers for all of them, because the accounting cost is a
 * property of the host's process table rather than of how many Workers happen to
 * be running: a per-Worker read would make the instrument more expensive exactly
 * as the machine got busier, which is when it must stay cheap.
 *
 * **A budgeted termination names the budget, and is never a stall.** A Worker
 * killed for memory and a Worker that hung are different facts with different
 * cures, and conflating them has already cost a debugging session — so the
 * outcome carries the budget's own name (`MemoryMax`/`MemoryHigh`), the declared
 * value, the observed RSS, and the workspace whose branch or PR is handed
 * forward.
 *
 * PURE except for {@link sampleTreeRss}, the one function that reads the host.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseMemoryBudget } from "./budget-accounting.js";
import type { RedskilledWorkerView } from "./host-state.js";

/** How the daemon classifies a termination it decided itself. */
export type RedskilledTerminationClassification = "budget-exceeded";

/**
 * The classification a budgeted termination is NOT.
 *
 * Named here rather than left implicit so the distinction is a value a test can
 * pin: a stall is silence the daemon gave up waiting on, and a budget kill is a
 * measurement the daemon acted on.
 */
export const REDSKILLED_STALL_CLASSIFICATION = "stalled";

/** Which declared budget the floor enforced. The budget's own name, verbatim. */
export type RedskilledBudgetName = "MemoryMax" | "MemoryHigh";

/**
 * One Worker the sampler measured over its budget.
 *
 * `stall` is a literal `false` rather than an absent field: a reader that had to
 * infer "not a stall" from the absence of a flag is a reader that will one day
 * infer it wrong.
 */
export interface RedskilledBudgetTermination {
  readonly version: 1;
  readonly worker_id: string;
  readonly project_label: string;
  readonly outcome: "terminated-over-memory-budget";
  readonly classification: RedskilledTerminationClassification;
  /** Never a stall — the daemon measured this Worker, it did not wait on it. */
  readonly stall: false;
  /** The budget that was exceeded, by its own name. */
  readonly budget_name: RedskilledBudgetName;
  /** The budget exactly as the client declared it, unparsed. */
  readonly budget_declared: string;
  readonly budget_bytes: number;
  readonly observed_rss_bytes: number;
  /** The workspace whose branch or PR the client hands forward. */
  readonly workspace_path: string;
  /** A whole sentence naming the budget — what an operator reads. */
  readonly reason: string;
}

/** A Worker the floor could not enforce, and why — named, never silently skipped. */
export interface RedskilledUnenforceableBudget {
  readonly worker_id: string;
  readonly reason: string;
}

export interface RedskilledMemoryTickOutcome {
  readonly terminations: readonly RedskilledBudgetTermination[];
  readonly unenforceable: readonly RedskilledUnenforceableBudget[];
}

/**
 * Tree RSS per Worker, in bytes, keyed by `worker_id`.
 *
 * A Worker the sampler could not measure is ABSENT from the map rather than
 * present as zero: an unmeasured Worker must not read as an idle one.
 */
export type RedskilledRssReading = Readonly<Record<string, number>>;

/** Measures the whole Worker set in one call. Injected, so a test needs no process. */
export type RedskilledMemorySampler = (
  workers: readonly RedskilledWorkerView[],
) => RedskilledRssReading | Promise<RedskilledRssReading>;

/**
 * The budget this Worker's floor enforces, or `null` when there is none to enforce.
 *
 * `MemoryMax` wins over `MemoryHigh` for the same reason admission charges
 * against it: `MemoryHigh` is throttling pressure and `MemoryMax` is the wall, so
 * a floor that killed at the pressure point would end Workers the kernel was
 * willing to keep running. PURE.
 */
export function resolveEnforcedBudget(
  worker: RedskilledWorkerView,
): { readonly name: RedskilledBudgetName; readonly declared: string; readonly bytes: number } | null {
  const budget = worker.budget ?? {};
  const candidates: ReadonlyArray<readonly [RedskilledBudgetName, string | undefined]> = [
    ["MemoryMax", budget.memory_max],
    ["MemoryHigh", budget.memory_high],
  ];
  for (const [name, declared] of candidates) {
    if (declared == null) continue;
    const bytes = parseMemoryBudget(declared);
    if (bytes == null) return null;
    return { name, declared, bytes };
  }
  return null;
}

/**
 * Judge one tick's reading against the live Worker set. PURE.
 *
 * A Worker is terminated only when the host produced a number that is *above*
 * its budget: an absent reading, an unparseable budget and a Worker at or under
 * its ceiling all leave the Worker running. The floor exists to stop a runaway,
 * and a floor that killed on missing evidence would be a worse failure than the
 * one it prevents.
 */
export function evaluateMemoryBudgets(input: {
  readonly workers: readonly RedskilledWorkerView[];
  readonly rss: RedskilledRssReading;
}): RedskilledMemoryTickOutcome {
  const terminations: RedskilledBudgetTermination[] = [];
  const unenforceable: RedskilledUnenforceableBudget[] = [];

  for (const worker of input.workers) {
    const budget = resolveEnforcedBudget(worker);
    if (budget == null) {
      unenforceable.push({
        worker_id: worker.worker_id,
        reason: (worker.budget?.memory_max ?? worker.budget?.memory_high) == null
          ? "this Worker declared no memory budget, so the sampler has no ceiling to enforce"
          : "this Worker's declared memory budget cannot be reduced to bytes, so the sampler has no ceiling to enforce",
      });
      continue;
    }
    const observed = input.rss[worker.worker_id];
    if (typeof observed !== "number" || !Number.isFinite(observed)) {
      unenforceable.push({
        worker_id: worker.worker_id,
        reason: "the host produced no RSS reading for this Worker on this tick, and an unmeasured Worker is never killed on suspicion",
      });
      continue;
    }
    if (observed <= budget.bytes) continue;
    terminations.push(buildBudgetTermination(worker, budget, observed));
  }

  return { terminations, unenforceable };
}

/** The terminal outcome document for one budgeted termination. PURE. */
export function buildBudgetTermination(
  worker: RedskilledWorkerView,
  budget: { readonly name: RedskilledBudgetName; readonly declared: string; readonly bytes: number },
  observedRssBytes: number,
): RedskilledBudgetTermination {
  const who = `Worker ${JSON.stringify(worker.worker_id)} of project ${JSON.stringify(worker.project_label)}`;
  return {
    version: 1,
    worker_id: worker.worker_id,
    project_label: worker.project_label,
    outcome: "terminated-over-memory-budget",
    classification: "budget-exceeded",
    stall: false,
    budget_name: budget.name,
    budget_declared: budget.declared,
    budget_bytes: budget.bytes,
    observed_rss_bytes: observedRssBytes,
    workspace_path: worker.workspace_path,
    reason: `redskilled terminated ${who}: its tree RSS of ${observedRssBytes} bytes exceeded its ${budget.name} budget of ` +
      `${budget.declared} (${budget.bytes} bytes). This is a budget termination, not a stall, and the work in ` +
      `${JSON.stringify(worker.workspace_path)} is handed forward.`,
  };
}

/** The Linux page size the kernel reports RSS in. */
const PAGE_SIZE_BYTES = 4096;

/**
 * Read every Worker's tree RSS from `/proc` in ONE pass over the process table.
 *
 * The pass is shared: the process table is read once and each Worker's subtree is
 * summed out of that one snapshot, so a host holding ten Workers pays what a host
 * holding one pays. A Worker whose pid is gone is absent from the reading rather
 * than zero, and a platform without `/proc` yields an empty reading — where the
 * kernel backend enforces, this floor is redundant, and where nothing enforces,
 * an empty reading is the honest report that nothing was measured.
 */
export function sampleTreeRss(
  workers: readonly RedskilledWorkerView[],
  options: { readonly procRoot?: string; readonly platform?: NodeJS.Platform } = {},
): RedskilledRssReading {
  const platform = options.platform ?? process.platform;
  const procRoot = options.procRoot ?? "/proc";
  if (platform !== "linux" && options.procRoot == null) return {};
  if (workers.length === 0) return {};

  const table = readProcessTable(procRoot);
  if (table.size === 0) return {};

  const children = new Map<number, number[]>();
  for (const entry of table.values()) {
    const siblings = children.get(entry.ppid);
    if (siblings) siblings.push(entry.pid);
    else children.set(entry.ppid, [entry.pid]);
  }

  const reading: Record<string, number> = {};
  for (const worker of workers) {
    if (!table.has(worker.pid)) continue;
    let total = 0;
    const queue = [worker.pid];
    const seen = new Set<number>();
    while (queue.length > 0) {
      const pid = queue.pop()!;
      if (seen.has(pid)) continue;
      seen.add(pid);
      const entry = table.get(pid);
      if (!entry) continue;
      total += entry.rssPages * PAGE_SIZE_BYTES;
      for (const child of children.get(pid) ?? []) queue.push(child);
    }
    reading[worker.worker_id] = total;
  }
  return reading;
}

interface ProcessEntry {
  readonly pid: number;
  readonly ppid: number;
  readonly rssPages: number;
}

function readProcessTable(procRoot: string): Map<number, ProcessEntry> {
  const table = new Map<number, ProcessEntry>();
  let entries: string[];
  try {
    entries = readdirSync(procRoot);
  } catch {
    return table;
  }
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    // A process that exits between the listing and the read is simply absent
    // from this snapshot; the next tick sees the host as it then is.
    let raw: string;
    try {
      raw = readFileSync(join(procRoot, name, "stat"), "utf8");
    } catch {
      continue;
    }
    const entry = parseProcStat(raw);
    if (entry) table.set(entry.pid, entry);
  }
  return table;
}

/**
 * Parse one `/proc/<pid>/stat` line. PURE.
 *
 * The command name is read past rather than split on: it is the process's own
 * bytes, parentheses and spaces included, so a field split from the left would
 * mis-index every field after it for a process named `(my prog)`.
 */
export function parseProcStat(raw: string): ProcessEntry | null {
  const close = raw.lastIndexOf(")");
  if (close < 0) return null;
  const pid = Number(raw.slice(0, raw.indexOf(" ")));
  const fields = raw.slice(close + 1).trim().split(/\s+/);
  // Fields after `comm` are 1-indexed from `state` (field 3), so `ppid` (field 4)
  // is index 1 and `rss` (field 24) is index 21.
  const ppid = Number(fields[1]);
  const rssPages = Number(fields[21]);
  if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid) || !Number.isFinite(rssPages)) return null;
  return { pid, ppid, rssPages: Math.max(0, rssPages) };
}
