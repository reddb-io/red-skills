/**
 * posix-limits — the macOS placement backend, and the ceiling it refuses to claim.
 *
 * **macOS has no resource-group equivalent, and this backend does not pretend
 * otherwise.** Linux gets a cgroup through a transient unit and Windows gets a
 * Job Object; both carry a memory ceiling the kernel enforces. macOS offers
 * POSIX rlimits and priority, and the rlimit that looks like a memory ceiling —
 * `RLIMIT_AS` — bounds ADDRESS SPACE rather than resident memory. A runtime that
 * reserves address space it never faults in would die under a limit it never
 * used, so setting one would trade a real ceiling for a lie about a fake one.
 * The daemon's RSS sampling floor stays the memory ceiling that actually holds
 * here (ADR 0130 rule 4), and every sentence this module produces says so.
 *
 * **What it genuinely adds is priority.** A Worker that runs at a positive nice
 * yields to the operator's interactive work, which is the difference between a
 * busy machine and an unusable one — a real tooth, just not the memory one.
 *
 * **An rlimit is set only where it behaves predictably.** `ulimit -u` and
 * `ulimit -t` are carried when a client declares them and dropped, by name, when
 * the declared value cannot become one — never silently rounded into something
 * nobody asked for.
 *
 * PURE, entirely: the host is read in `worker-placement`'s probe and nowhere here,
 * which is what lets every case be proven on a machine that is not a Mac.
 */
import { CPU_WEIGHT_FAIR_SHARE } from "./job-object.js";
import type { RedskilledWorkerBudget } from "./worker-placement.js";

/**
 * The nice a Worker runs at when nothing asked for more.
 *
 * Positive by default rather than on request: yielding to interactive work is
 * the reason this backend exists, so it is the behaviour a client gets without
 * having to know the platform it landed on.
 */
export const WORKER_YIELD_NICE = 5;

/** The kernel's highest nice — the most a process can yield. */
export const MAX_POSIX_NICE = 19;

/**
 * Whether this host can wrap a launch in POSIX limits, and when it cannot, why.
 *
 * `nice` is a nullable PATH answer INSIDE the available arm rather than a second
 * unavailable reason: a host with a shell and no `nice` still gets its rlimits,
 * and only loses the priority half — a degradation worth naming, not one worth
 * refusing the whole backend over.
 */
export type RedskilledPosixReach =
  | { readonly available: true; readonly shell: string; readonly nice: string | null }
  | { readonly available: false; readonly reason: string };

/** POSIX reach is unavailable, with the sentence a warning will quote. PURE. */
export function posixLimitsUnavailable(reason: string): RedskilledPosixReach {
  return { available: false, reason };
}

/**
 * The limits one Worker's shell applies to itself before it execs.
 *
 * `memory_ceiling` is a literal `"sampling-floor"` rather than an optional
 * number: it is not a value this backend could one day fill in, it is the
 * statement that the ceiling lives somewhere else — and a reader who had to
 * infer that from an absent field is a reader who will infer it wrong.
 */
export interface RedskilledPosixLimits {
  /** The nice the Worker runs at. Absent only when the host has no `nice`. */
  readonly nice?: number;
  /** `RLIMIT_NPROC`, via `ulimit -u`. Set only when a client declared one. */
  readonly max_processes?: number;
  /** `RLIMIT_CPU` in seconds, via `ulimit -t`. Set only when a client declared one. */
  readonly cpu_seconds?: number;
  /** Always the floor: macOS has no per-process resident-memory ceiling to set. */
  readonly memory_ceiling: "sampling-floor";
  /** Why there is no memory rlimit — quoted into the launch's warning. */
  readonly memory_ceiling_reason: string;
  /** Set when something declared could not be carried, naming the field. */
  readonly note?: string;
}

/** The sentence every macOS launch carries about its missing memory ceiling. */
export const POSIX_MEMORY_CEILING_REASON =
  "an address-space rlimit is not a resident-memory ceiling: a runtime that reserves address space it never faults in " +
  "would die under a limit it never used, so no memory rlimit is set and the daemon's RSS sampling floor is the ceiling " +
  "that actually holds";

/**
 * The limits a budget asks for on this host. PURE.
 *
 * A weight BELOW the fair share deepens the yield proportionally; a weight at or
 * above it buys nothing, because raising a process's priority needs privilege
 * the daemon does not have and must not claim. That asymmetry is the same one
 * the Windows backend refuses to smooth over — a client asking for more than its
 * share gets the default and a sentence, never an invented limit.
 */
export function planPosixLimits(
  budget: RedskilledWorkerBudget | undefined,
  reach: { readonly canRenice: boolean },
): RedskilledPosixLimits {
  const declared = budget ?? {};
  const notes: string[] = [];

  let nice: number | undefined;
  if (!reach.canRenice) {
    notes.push("nice is not on this host, so no priority control was applied and the Worker competes with interactive work");
  } else if (declared.cpu_weight == null) {
    nice = WORKER_YIELD_NICE;
  } else if (declared.cpu_weight < CPU_WEIGHT_FAIR_SHARE) {
    const scaled = Math.round((MAX_POSIX_NICE * (CPU_WEIGHT_FAIR_SHARE - declared.cpu_weight)) / CPU_WEIGHT_FAIR_SHARE);
    nice = Math.min(MAX_POSIX_NICE, Math.max(WORKER_YIELD_NICE, scaled));
  } else {
    nice = WORKER_YIELD_NICE;
    notes.push(
      `cpu_weight=${declared.cpu_weight} is at or above the fair share of ${CPU_WEIGHT_FAIR_SHARE}, and raising a ` +
        `process's priority requires privilege this daemon does not have, so the Worker keeps the default yield of nice ` +
        `${WORKER_YIELD_NICE}`,
    );
  }

  const maxProcesses = positiveInteger(declared.max_processes);
  if (maxProcesses == null && declared.max_processes != null) {
    notes.push(`max_processes=${declared.max_processes} is not a positive whole number, so no ulimit -u is set`);
  }
  const cpuSeconds = positiveInteger(declared.cpu_seconds);
  if (cpuSeconds == null && declared.cpu_seconds != null) {
    notes.push(`cpu_seconds=${declared.cpu_seconds} is not a positive whole number, so no ulimit -t is set`);
  }

  return {
    ...(nice != null ? { nice } : {}),
    ...(maxProcesses != null ? { max_processes: maxProcesses } : {}),
    ...(cpuSeconds != null ? { cpu_seconds: cpuSeconds } : {}),
    memory_ceiling: "sampling-floor",
    memory_ceiling_reason: POSIX_MEMORY_CEILING_REASON,
    ...(notes.length > 0 ? { note: notes.join("; ") } : {}),
  };
}

/**
 * The shell argv that applies these limits and then becomes the Worker. PURE.
 *
 * The command and its arguments ride after a `--` placeholder and are executed
 * as `"$@"` rather than being
 * interpolated into the script, so a workspace, a flag or a path containing
 * spaces or quotes is passed through byte-for-byte — a launcher that quoted its
 * own payload into a script would be one argument away from running something
 * else. `exec` is what makes the shell disappear: the Worker keeps the pid the
 * daemon sampled and there is no extra process between it and its limits. The
 * core-dump cap is unconditional; callers without any other POSIX limits use the
 * same argv shape with `limits` absent.
 */
export function posixLimitsShellArgv(input: {
  readonly limits?: RedskilledPosixLimits;
  readonly nice: string | null;
  readonly command: string;
  readonly args: readonly string[];
}): readonly string[] {
  const { limits } = input;
  const lines = ["ulimit -c 0"];
  // A ulimit the host refuses (a hard limit already lower) prints and continues:
  // a Worker that never started because it could not lower a soft limit would be
  // a worse outcome than one running under the limit it inherited.
  if (limits?.max_processes != null) lines.push(`ulimit -u ${limits.max_processes}`);
  if (limits?.cpu_seconds != null) lines.push(`ulimit -t ${limits.cpu_seconds}`);
  lines.push(
    limits?.nice != null && input.nice != null
      ? `exec ${quote(input.nice)} -n ${limits.nice} "$@"`
      : 'exec "$@"',
  );
  return ["-c", lines.join("\n"), "--", input.command, ...input.args];
}

/**
 * The whole sentence a macOS launch carries. PURE.
 *
 * It states the teeth AND the missing one in the same breath, because this
 * placement is a downgrade and an upgrade at once: an operator reading only
 * "unisolated" would miss the priority, and one reading only "nice 5" would
 * think the memory budget had a kernel behind it.
 */
export function describePosixPlacement(limits: RedskilledPosixLimits): string {
  const applied: string[] = [];
  if (limits.nice != null) applied.push(`the Worker runs at nice ${limits.nice} so it yields to interactive work`);
  else applied.push("no priority control was applied");
  if (limits.max_processes != null) applied.push(`its processes are capped at ${limits.max_processes}`);
  if (limits.cpu_seconds != null) applied.push(`its CPU time is capped at ${limits.cpu_seconds} seconds`);
  return (
    `macOS placement applied POSIX limits: ${applied.join(", ")}. macOS has no resource-group equivalent, so the ` +
    `Worker is charged to the daemon's own resource group, and ${limits.memory_ceiling_reason}` +
    (limits.note != null ? ` (${limits.note})` : "")
  );
}

/**
 * Name the POSIX-only budget fields a non-POSIX backend cannot carry. PURE.
 *
 * Returns `null` when there is nothing to say. A declared limit that quietly
 * did nothing is the failure this repository already pays warnings to avoid, so
 * the fields are named on the backends that ignore them rather than only
 * honoured on the one that does not.
 */
export function unenforcedPosixBudgetFields(budget: RedskilledWorkerBudget | undefined): string | null {
  const declared = budget ?? {};
  const fields = [
    declared.max_processes != null ? "max_processes" : null,
    declared.cpu_seconds != null ? "cpu_seconds" : null,
  ].filter((field): field is string => field != null);
  if (fields.length === 0) return null;
  return `${fields.join(" and ")} ${fields.length === 1 ? "is a POSIX rlimit" : "are POSIX rlimits"} honoured only by the macOS placement backend, so this placement carries no equivalent`;
}

function positiveInteger(value: number | undefined): number | undefined {
  if (value == null) return undefined;
  if (!Number.isSafeInteger(value) || value <= 0) return undefined;
  return value;
}

/** Single-quote a path for `sh`, so a host-supplied path is a word and not a script. */
function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
