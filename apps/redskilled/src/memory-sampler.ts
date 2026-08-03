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
 * **RSS and CPU come out of the SAME walk.** Three states hold memory and read
 * alike by RSS alone — a Worker running a long gate, a Worker hung on a wedged
 * command, and a Worker already dead and unreaped — and accumulated CPU time is
 * what separates them. It is read from the `/proc/<pid>/stat` line already open
 * for RSS, so the second measurement costs no second instrument and no per-Worker
 * read: the tick's price stays the host's process table.
 *
 * **The cgroup is asked first, because the daemon created it.** A unit's
 * `memory.current` is the kernel's own charge for every process inside the
 * boundary the placement drew, so it cannot miss a descendant by construction —
 * no ppid chain to walk, nothing to reparent away, and no way for the recorded
 * pid to be the `systemd-run` client rather than the unit's main process. That
 * last case is not hypothetical: it read a 5.38 GiB pair of Workers as `14.6M`,
 * low by a factor of 377, because the pid the daemon holds under `--wait` lives
 * in the DAEMON's cgroup and its subtree is the client, not the Worker (#3080).
 * The walk remains the floor for a Worker genuinely without a unit, and the
 * reading says which instrument answered rather than presenting both as one
 * number.
 *
 * PURE except for {@link sampleWorkerTrees}, the one function that reads the host.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { appliedWorkerBudget, parseMemoryBudget } from "./budget-accounting.js";
import type { RedskilledRssSource, RedskilledWorkerView } from "./host-state.js";
import type { RedskilledWorkerBudget } from "./worker-placement.js";

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

/**
 * Accumulated tree CPU time per Worker, in seconds, keyed by `worker_id`.
 *
 * Absent rather than zero for the same reason RSS is, and for a sharper one: a
 * Worker reported at zero CPU reads as a Worker that has done nothing, which is
 * exactly the state a reader would act on.
 */
export type RedskilledCpuReading = Readonly<Record<string, number>>;

/**
 * One tick's reading of the whole Worker set — both measurements, one walk.
 *
 * The two arrive together because they were taken together: a caller that could
 * ask for CPU separately would be asking the host a second time, and the second
 * ask is the per-Worker cost this module exists to refuse.
 */
export interface RedskilledTreeReading {
  readonly rss: RedskilledRssReading;
  readonly cpu_seconds: RedskilledCpuReading;
  /**
   * Which instrument answered for each Worker, keyed by `worker_id`.
   *
   * Present because the two instruments do not carry the same guarantee, and the
   * weaker one must not pass for the stronger: a reader shown one number could
   * not tell a kernel charge from a ppid walk that quietly missed most of the
   * tree. Absent for a Worker nothing measured, exactly as `rss` is.
   *
   * OPTIONAL on the reading rather than required, because an injected sampler
   * that names no instrument has honestly named none — and a default of `cgroup`
   * would be the silent upgrade this field exists to prevent. {@link
   * sampleWorkerTrees} always states it.
   */
  readonly sources?: Readonly<Record<string, RedskilledRssSource>>;
}

/** Measures the whole Worker set in one call. Injected, so a test needs no process. */
export type RedskilledTreeSampler = (
  workers: readonly RedskilledWorkerView[],
) => RedskilledTreeReading | Promise<RedskilledTreeReading>;

/**
 * The budget this Worker's floor enforces, or `null` when there is none to enforce.
 *
 * `MemoryMax` wins over `MemoryHigh` for the same reason admission charges
 * against it: `MemoryHigh` is throttling pressure and `MemoryMax` is the wall, so
 * a floor that killed at the pressure point would end Workers the kernel was
 * willing to keep running. PURE.
 */
export function resolveEnforcedBudget(
  worker: {
    readonly budget?: RedskilledWorkerBudget;
    readonly applied_budget?: RedskilledWorkerBudget;
    readonly memory_ceiling?: string;
  },
): { readonly name: RedskilledBudgetName; readonly declared: string; readonly bytes: number } | null {
  // The SAME resolver the host accounting totals, so the floor enforces exactly
  // the wall the accounting reports. Two resolutions of one question is how the
  // HOST and PROJECTS panels came to disagree in a single frame (#3080).
  //
  // The scope's ceiling is folded in last and answers only for a Worker whose
  // client declared nothing: on a host with no cgroup to hold it — no systemd, or
  // a Mac — the derived ceiling would otherwise be a wall with nothing behind it
  // (#3029). Where the kernel does hold it, the floor is the redundant second
  // ceiling it has always been.
  const budget = appliedWorkerBudget(worker);
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
 *
 * **The floor stands down where the kernel is already holding the wall.** A
 * cgroup reading is `memory.current`, which counts reclaimable page cache that a
 * process-tree RSS never saw — so a Worker that merely read a large repository
 * can sit near its `MemoryMax` with no anonymous pressure at all, and the kernel
 * reclaims that cache rather than killing it. A software floor acting on the
 * same number would kill the Worker the kernel deliberately kept. The unit
 * carries that exact `MemoryMax`, so the enforcement is not lost, only left to
 * the one enforcer that can tell cache from anonymous memory.
 */
export function evaluateMemoryBudgets(input: {
  readonly workers: readonly RedskilledWorkerView[];
  readonly rss: RedskilledRssReading;
  /** Which instrument produced each reading; absent leaves every Worker judged. */
  readonly sources?: Readonly<Record<string, RedskilledRssSource>>;
}): RedskilledMemoryTickOutcome {
  const terminations: RedskilledBudgetTermination[] = [];
  const unenforceable: RedskilledUnenforceableBudget[] = [];

  for (const worker of input.workers) {
    const budget = resolveEnforcedBudget(worker);
    if (budget == null) {
      unenforceable.push({
        worker_id: worker.worker_id,
        reason: (appliedWorkerBudget(worker).memory_max ?? appliedWorkerBudget(worker).memory_high) == null
          ? "this Worker declared no memory budget and the host derived no ceiling for it, so the sampler has none to enforce"
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
    if (input.sources?.[worker.worker_id] === "cgroup" && budget.name === "MemoryMax") {
      unenforceable.push({
        worker_id: worker.worker_id,
        reason: `this Worker's ${budget.name} of ${budget.declared} is held by the kernel on its own cgroup, and the ` +
          "reading is memory.current — which counts reclaimable page cache the kernel drops before it kills anything, " +
          "so the daemon does not duplicate an enforcement that can tell cache from anonymous memory",
      });
      continue;
    }
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
 * Read every Worker's tree RSS and CPU in ONE pass over the host's process table.
 *
 * The pass is shared: the process table is read once and each Worker's subtree is
 * summed out of that one snapshot, so a host holding ten Workers pays what a host
 * holding one pays. A Worker whose pid is gone is absent from the reading rather
 * than zero.
 *
 * **CPU rides the same rows RSS does.** Both numbers are summed in the same
 * traversal of the same snapshot, so the reading answers "is this Worker alive
 * and working?" without a second instrument. What the number MEANS is the
 * reader's business: the daemon measures a Worker, it never judges the project's
 * task (ADR 0130 rule 3).
 *
 * **The source of the table is the platform's, and only the source differs.**
 * Linux reads `/proc`; macOS reads `ps`, because it has no `/proc` and IS the
 * platform where this floor is the memory ceiling rather than a redundant second
 * one — a macOS sampler that returned nothing would leave the only backend
 * without kernel teeth with no teeth at all. A host whose table cannot be read
 * yields an empty reading, which is the honest report that nothing was measured.
 */
export function sampleWorkerTrees(
  workers: readonly RedskilledWorkerView[],
  options: SampleWorkerTreesOptions = {},
): RedskilledTreeReading {
  const platform = options.platform ?? process.platform;
  const empty: RedskilledTreeReading = { rss: {}, cpu_seconds: {}, sources: {} };
  if (workers.length === 0) return empty;

  const rss: Record<string, number> = {};
  const cpuSeconds: Record<string, number> = {};
  const sources: Record<string, RedskilledRssSource> = {};

  // The kernel's own charge first, for every Worker the daemon put in a unit.
  const cgroups = resolveUnitCgroups(workers, platform, options);
  for (const [workerId, dir] of cgroups) {
    const charge = readCgroupCharge(dir);
    if (charge == null) continue;
    rss[workerId] = charge.memoryBytes;
    if (charge.cpuSeconds != null) cpuSeconds[workerId] = charge.cpuSeconds;
    sources[workerId] = "cgroup";
  }

  // The walk answers only for whoever the kernel did not: an unisolated Worker, a
  // host with no cgroup filesystem, or a unit whose directory is already gone.
  const remaining = workers.filter((worker) => sources[worker.worker_id] == null);
  if (remaining.length === 0) return { rss, cpu_seconds: cpuSeconds, sources };

  const table = readHostProcessTable(platform, options);
  if (table.size === 0) return { rss, cpu_seconds: cpuSeconds, sources };

  const children = new Map<number, number[]>();
  for (const entry of table.values()) {
    const siblings = children.get(entry.ppid);
    if (siblings) siblings.push(entry.pid);
    else children.set(entry.ppid, [entry.pid]);
  }

  for (const worker of remaining) {
    if (!table.has(worker.pid)) continue;
    let totalRss = 0;
    let totalCpu = 0;
    const queue = [worker.pid];
    const seen = new Set<number>();
    while (queue.length > 0) {
      const pid = queue.pop()!;
      if (seen.has(pid)) continue;
      seen.add(pid);
      const entry = table.get(pid);
      if (!entry) continue;
      totalRss += entry.rssBytes;
      totalCpu += entry.cpuSeconds;
      for (const child of children.get(pid) ?? []) queue.push(child);
    }
    rss[worker.worker_id] = totalRss;
    cpuSeconds[worker.worker_id] = totalCpu;
    sources[worker.worker_id] = "process-tree";
  }
  return { rss, cpu_seconds: cpuSeconds, sources };
}

export interface SampleWorkerTreesOptions {
  readonly procRoot?: string;
  readonly platform?: NodeJS.Platform;
  /** Injected `ps` output, so the macOS arm is provable off a Mac. */
  readonly psTable?: () => string;
  /** The unified cgroup mount point; injected so the arm is provable off a host. */
  readonly cgroupRoot?: string;
  /** The daemon's own cgroup path, as `/proc/self/cgroup` states it. Injected in tests. */
  readonly selfCgroupPath?: string;
  /** The uid whose `user@<uid>.service` slice holds the units. Defaults to the daemon's. */
  readonly uid?: number;
}

/** The unified cgroup hierarchy's conventional mount point. */
export const DEFAULT_CGROUP_ROOT = "/sys/fs/cgroup";

/**
 * The cgroup directory holding each Worker's unit, keyed by `worker_id`. PURE-ish.
 *
 * **Keyed by the unit's NAME, never by the Worker's pid.** The pid the daemon
 * holds is the `systemd-run --wait` client, which lives in the daemon's own
 * cgroup — reading `/proc/<pid>/cgroup` would therefore hand back the DAEMON's
 * directory and charge every Worker with the daemon's memory (#3080). The unit
 * name is the one identifier that survives that indirection, and the placement
 * already recorded it.
 *
 * A Worker with no unit is simply absent: it has no cgroup to read, which is the
 * `unisolated_workers` case the walk exists for.
 */
function resolveUnitCgroups(
  workers: readonly RedskilledWorkerView[],
  platform: NodeJS.Platform,
  options: SampleWorkerTreesOptions,
): Map<string, string> {
  const found = new Map<string, string>();
  const explicitRoot = options.cgroupRoot != null;
  if (!explicitRoot && platform !== "linux") return found;
  const root = options.cgroupRoot ?? DEFAULT_CGROUP_ROOT;
  const units = workers.filter((worker) => worker.unit != null && worker.unit !== "");
  if (units.length === 0) return found;

  const parents = candidateUnitParents(root, options);
  for (const worker of units) {
    for (const parent of parents) {
      const dir = join(parent, worker.unit!);
      if (existsSync(join(dir, "memory.current"))) {
        found.set(worker.worker_id, dir);
        break;
      }
    }
  }
  return found;
}

/**
 * Where a transient `--user` unit's directory could be, best guess first. PURE-ish.
 *
 * Derived from the daemon's OWN cgroup rather than hard-coded, because the two
 * are siblings whenever the daemon itself runs under a unit — which is the
 * arrangement ADR 0130 rule 5 puts it in. The ancestors are walked because the
 * daemon may sit one level deeper (`app.slice/redskilled.service`) or shallower
 * (a login `session-N.scope`), and `user@<uid>.service/app.slice` is appended
 * last for the case where the daemon is not in the user manager's slice at all.
 *
 * Every candidate costs one `existsSync`, so the whole search is cheaper than the
 * `/proc` walk it replaces even when it misses.
 */
function candidateUnitParents(root: string, options: SampleWorkerTreesOptions): readonly string[] {
  const self = options.selfCgroupPath ?? readSelfCgroupPath();
  const parents: string[] = [];
  const push = (path: string) => {
    if (!parents.includes(path)) parents.push(path);
  };

  let relative = self;
  while (relative != null && relative !== "" && relative !== "/" && relative !== ".") {
    push(join(root, relative));
    const parent = dirname(relative);
    if (parent === relative) break;
    relative = parent;
  }
  push(root);

  const uid = options.uid ?? process.getuid?.();
  if (uid != null) {
    push(join(root, "user.slice", `user-${uid}.slice`, `user@${uid}.service`, "app.slice"));
  }
  return parents;
}

/** The daemon's own cgroup path, or `null` — an unreadable `/proc` is never a crash. */
function readSelfCgroupPath(): string | null {
  try {
    // cgroup v2 writes exactly one line, `0::<path>`; on a v1/hybrid host the
    // unified controller is the same `0::` row, so the same read answers both.
    for (const line of readFileSync("/proc/self/cgroup", "utf8").split("\n")) {
      if (line.startsWith("0::")) return line.slice(3).trim();
    }
  } catch {
    // A host with no `/proc` falls back to the conventional slice path below.
  }
  return null;
}

/**
 * One unit's memory charge and accumulated CPU, straight from the kernel.
 *
 * `memory.current` is the whole cgroup's charge — every process inside the
 * boundary, however it got there — so it is a single read where the walk is a
 * traversal, and it is exact where the walk is a best effort. CPU rides along
 * from `cpu.stat` for the reason it rides the `/proc` line: the question "is this
 * Worker alive and working?" must not need a second instrument.
 *
 * `null` when the directory holds no readable `memory.current`, which is a unit
 * that has already gone away — the caller then falls back to the walk rather
 * than reporting a Worker at zero.
 */
function readCgroupCharge(dir: string): { readonly memoryBytes: number; readonly cpuSeconds: number | null } | null {
  let raw: string;
  try {
    raw = readFileSync(join(dir, "memory.current"), "utf8");
  } catch {
    return null;
  }
  const memoryBytes = Number(raw.trim());
  if (!Number.isFinite(memoryBytes) || memoryBytes < 0) return null;
  return { memoryBytes, cpuSeconds: readCgroupCpuSeconds(dir) };
}

/** `usage_usec` out of `cpu.stat`, in seconds; `null` when the host keeps none. */
function readCgroupCpuSeconds(dir: string): number | null {
  let raw: string;
  try {
    raw = readFileSync(join(dir, "cpu.stat"), "utf8");
  } catch {
    return null;
  }
  return parseCgroupCpuStat(raw);
}

/** Microseconds of `usage_usec` as seconds, or `null` when the key is absent. PURE. */
export function parseCgroupCpuStat(raw: string): number | null {
  for (const line of raw.split("\n")) {
    const [key, value] = line.trim().split(/\s+/);
    if (key !== "usage_usec") continue;
    const usec = Number(value);
    if (!Number.isFinite(usec) || usec < 0) return null;
    return usec / 1_000_000;
  }
  return null;
}

/** One `/proc` row, in the kernel's own units. */
interface ProcessEntry {
  readonly pid: number;
  readonly ppid: number;
  readonly rssPages: number;
  /** `utime + stime`, in the clock ticks `/proc` counts them in. */
  readonly cpuTicks: number;
}

/**
 * One row of the host's process table, in bytes and seconds.
 *
 * Bytes rather than each source's own unit — pages on Linux, KiB from `ps` — and
 * seconds rather than ticks or `ps`'s clock string, because the summation above
 * must not have to know which platform produced the row it is adding.
 */
interface HostProcessEntry {
  readonly pid: number;
  readonly ppid: number;
  readonly rssBytes: number;
  readonly cpuSeconds: number;
}

/**
 * The host's process table, from whichever source this platform has.
 *
 * An injected `procRoot` or `psTable` picks the arm regardless of platform, so
 * each source is provable on a machine that is not the one it belongs to.
 */
function readHostProcessTable(
  platform: NodeJS.Platform,
  options: { readonly procRoot?: string; readonly psTable?: () => string },
): Map<number, HostProcessEntry> {
  if (options.procRoot != null || platform === "linux") return readProcessTable(options.procRoot ?? "/proc");
  if (options.psTable != null || platform === "darwin") return parsePsTable(readPsTable(options.psTable));
  return new Map();
}

/** `ps` in one call, or the empty string — an unreadable table is never a crash. */
function readPsTable(injected?: () => string): string {
  try {
    return (injected ?? runPs)();
  } catch {
    return "";
  }
}

function runPs(): string {
  return execFileSync("ps", ["-axo", "pid=,ppid=,rss=,time="], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
}

/** How `ps` reports RSS on macOS. */
const PS_RSS_UNIT_BYTES = 1024;

/**
 * Parse `ps -axo pid=,ppid=,rss=,time=` output into the host process table. PURE.
 *
 * The CPU column rides the SAME `ps` call the RSS column does — one invocation,
 * one table, both numbers — for the reason `/proc` reads both out of one line.
 *
 * Every line that is not three numbers and a clock is skipped rather than guessed
 * at: a header a future `ps` decides to print, or a truncated final line, must
 * cost a row and never a wrong parent — a mis-parsed ppid would attribute a
 * stranger's memory to a Worker and terminate it for someone else's leak.
 */
export function parsePsTable(raw: string): Map<number, HostProcessEntry> {
  const table = new Map<number, HostProcessEntry>();
  for (const line of raw.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 4) continue;
    const [pid, ppid, rssKib] = fields.slice(0, 3).map(Number);
    if (![pid, ppid, rssKib].every((value) => value != null && Number.isSafeInteger(value) && value >= 0)) continue;
    const cpuSeconds = parsePsCpuSeconds(fields[3]!);
    if (cpuSeconds == null) continue;
    table.set(pid!, { pid: pid!, ppid: ppid!, rssBytes: rssKib! * PS_RSS_UNIT_BYTES, cpuSeconds });
  }
  return table;
}

/**
 * Parse `ps`'s accumulated CPU clock — `[[dd-]hh:]mm:ss[.ff]` — into seconds. PURE.
 *
 * Read from the right so the same reader handles every width `ps` prints: the
 * last segment is seconds, each one to its left is sixty times the one after it,
 * and an optional leading `dd-` is days. A segment that is not a number costs the
 * whole row rather than a guessed magnitude.
 */
export function parsePsCpuSeconds(raw: string): number | null {
  const dash = raw.indexOf("-");
  const days = dash < 0 ? 0 : Number(raw.slice(0, dash));
  if (!Number.isFinite(days) || days < 0) return null;
  const segments = raw.slice(dash + 1).split(":");
  let seconds = days * 86_400;
  let multiplier = 1;
  for (let i = segments.length - 1; i >= 0; i--) {
    const value = Number(segments[i]);
    if (!Number.isFinite(value) || value < 0 || segments[i] === "") return null;
    seconds += value * multiplier;
    multiplier *= 60;
  }
  return seconds;
}

function readProcessTable(procRoot: string): Map<number, HostProcessEntry> {
  const table = new Map<number, HostProcessEntry>();
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
    if (entry) {
      table.set(entry.pid, {
        pid: entry.pid,
        ppid: entry.ppid,
        rssBytes: entry.rssPages * PAGE_SIZE_BYTES,
        cpuSeconds: entry.cpuTicks / CLOCK_TICKS_PER_SECOND,
      });
    }
  }
  return table;
}

/**
 * The `USER_HZ` `/proc` counts CPU time in.
 *
 * 100 on every Linux this daemon runs on, and stated as a constant rather than
 * asked of the host: `sysconf` is not reachable from Node without a native
 * binding, and a binding for a number that has not moved would be a new
 * dependency for the instrument that must stay cheapest.
 */
const CLOCK_TICKS_PER_SECOND = 100;

/**
 * Parse one `/proc/<pid>/stat` line. PURE.
 *
 * The command name is read past rather than split on: it is the process's own
 * bytes, parentheses and spaces included, so a field split from the left would
 * mis-index every field after it for a process named `(my prog)`.
 *
 * `utime` and `stime` are read from THIS line, next to `rss`: the CPU reading
 * costs the same open file the memory reading already paid for.
 */
export function parseProcStat(raw: string): ProcessEntry | null {
  const close = raw.lastIndexOf(")");
  if (close < 0) return null;
  const pid = Number(raw.slice(0, raw.indexOf(" ")));
  const fields = raw.slice(close + 1).trim().split(/\s+/);
  // Fields after `comm` are 1-indexed from `state` (field 3), so `ppid` (field 4)
  // is index 1, `utime` (field 14) is index 11, `stime` (field 15) is index 12 and
  // `rss` (field 24) is index 21.
  const ppid = Number(fields[1]);
  const utime = Number(fields[11]);
  const stime = Number(fields[12]);
  const rssPages = Number(fields[21]);
  if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid) || !Number.isFinite(rssPages)) return null;
  if (!Number.isFinite(utime) || !Number.isFinite(stime)) return null;
  return {
    pid,
    ppid,
    rssPages: Math.max(0, rssPages),
    cpuTicks: Math.max(0, utime) + Math.max(0, stime),
  };
}
