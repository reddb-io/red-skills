/**
 * budget-accounting — what the daemon has promised the machine, in one total.
 *
 * The daemon exists so the memory a host spends on Workers is decided once,
 * host-wide, instead of once per project. That promise is only as good as the
 * daemon's ability to state it, so the accounting is a first-class document
 * rather than a number a caller re-derives — and it is derived from the Worker
 * set alone, which is what makes "the accounting after a restart matches the
 * accounting before it" a property of rehydration rather than of a second
 * durable copy.
 *
 * **A budget that cannot be reduced to bytes is named, never rounded to zero.**
 * `MemoryHigh` accepts forms the daemon does not model (a percentage of the
 * host, `infinity`), and quietly counting those as nothing would understate the
 * host's exposure exactly when it is largest.
 *
 * **One resolver answers "what is this Worker's budget", host-wide and
 * per-project.** {@link appliedWorkerBudget} is that resolver, and every surface
 * reads it. The alternative has already shipped and been wrong on screen (#3080):
 * the HOST panel totalled `worker.budget` while the PROJECTS panel resolved the
 * derived ceiling too, so one frame said `MemoryMax 0B` and `declared 21.8G` at
 * the same time. Two panels derived from one function cannot disagree.
 *
 * PURE: every input is a Worker view.
 */
import type { RedskilledWorkerView } from "./host-state.js";
import type { RedskilledWorkerBudget } from "./worker-placement.js";

export interface RedskilledBudgetAccounting {
  readonly version: 1;
  readonly worker_count: number;
  /** Sum of the declared `MemoryHigh` budgets, in bytes. */
  readonly memory_high_bytes: number;
  /** Sum of the declared `MemoryMax` budgets, in bytes. */
  readonly memory_max_bytes: number;
  /** Sum of the declared CPU weights — a share, reported as declared. */
  readonly cpu_weight_total: number;
  /** Workers whose declared budget could not be reduced to bytes, by id. */
  readonly unaccounted_workers: readonly string[];
  /** Workers with no unit of their own; their charge lands on the daemon. */
  readonly unisolated_workers: readonly string[];
  /**
   * The host memory ceiling these totals were judged against; `null` when unbounded.
   *
   * It rides ON the accounting rather than beside it because the one question an
   * operator asks of a total is "against what?" — and a reader that had to fetch
   * the ceiling from a second document could report a sum as safe that the
   * ceiling it never read calls an over-commitment.
   */
  readonly memory_ceiling_bytes?: number | null;
  /**
   * How far the applied `MemoryMax` walls exceed the host ceiling, in bytes.
   *
   * Zero on a host inside its ceiling. Non-zero is not an error — a per-Worker
   * ceiling is a WALL and never a reservation, so N Workers may legitimately
   * carry N walls that sum past the host's own — but it is the fact the host
   * budget's promise rests on, and it was previously unsayable (#3080).
   */
  readonly over_committed_bytes?: number;
  /** A whole sentence naming the over-commitment; `null` when there is none. */
  readonly over_commitment_reason?: string | null;
}

/**
 * Whatever carries a budget — structural, so a caller need not build a whole view.
 *
 * Three fields rather than one because they are three different facts: what the
 * CLIENT declared, what the placement APPLIED, and the wall the host derived.
 */
export interface RedskilledBudgetBearer {
  /** What the client declared. This, and only this, is what admission charges. */
  readonly budget?: RedskilledWorkerBudget;
  /** What the placement really handed the kernel, recorded at launch. */
  readonly applied_budget?: RedskilledWorkerBudget;
  /** The wall the host derived when the client declared none. */
  readonly memory_ceiling?: string;
}

/**
 * The budget this Worker is really running under. PURE.
 *
 * **What the machine carries, not what the client asked for.** The applied
 * budget wins because it is the one the kernel was handed; absent it, a derived
 * `memory_ceiling` stands in for a `MemoryMax` the client did not declare,
 * exactly as the placement substituted it at launch. A reader that stopped at
 * `worker.budget` reports `0B` for a Worker whose unit carries `10.9G` — which
 * is precisely how a half-full host rendered a `0%` bar.
 */
export function appliedWorkerBudget(worker: RedskilledBudgetBearer): RedskilledWorkerBudget {
  if (worker.applied_budget != null) return worker.applied_budget;
  const declared = worker.budget ?? {};
  if (declared.memory_max == null && declared.memory_high == null && worker.memory_ceiling != null) {
    return { ...declared, memory_max: worker.memory_ceiling };
  }
  return declared;
}

/** The empty accounting — a daemon holding nothing still states a total. */
export const EMPTY_BUDGET_ACCOUNTING: RedskilledBudgetAccounting = {
  version: 1,
  worker_count: 0,
  memory_high_bytes: 0,
  memory_max_bytes: 0,
  cpu_weight_total: 0,
  unaccounted_workers: [],
  unisolated_workers: [],
  memory_ceiling_bytes: null,
  over_committed_bytes: 0,
  over_commitment_reason: null,
};

/**
 * Total the budgets a Worker set is really running under. PURE.
 *
 * The totals come from {@link appliedWorkerBudget}, so this document states what
 * the units carry rather than what their clients happened to declare. Pass the
 * host ceiling and the over-commitment is reported rather than left for a reader
 * to notice; omit it and the totals stand alone, which is the honest answer on a
 * host that admits against no ceiling.
 */
export function buildBudgetAccounting(
  workers: readonly RedskilledWorkerView[],
  options: { readonly hostCeilingBytes?: number | null } = {},
): RedskilledBudgetAccounting {
  let memoryHigh = 0;
  let memoryMax = 0;
  let cpuWeight = 0;
  const unaccounted: string[] = [];
  const unisolated: string[] = [];

  for (const worker of workers) {
    const budget = appliedWorkerBudget(worker);
    let opaque = false;
    for (const [declared, add] of [
      [budget.memory_high, (bytes: number) => (memoryHigh += bytes)],
      [budget.memory_max, (bytes: number) => (memoryMax += bytes)],
    ] as const) {
      if (declared == null) continue;
      const bytes = parseMemoryBudget(declared);
      if (bytes == null) opaque = true;
      else add(bytes);
    }
    if (budget.cpu_weight != null) cpuWeight += budget.cpu_weight;
    if (opaque) unaccounted.push(worker.worker_id);
    if (!worker.isolated) unisolated.push(worker.worker_id);
  }

  const ceilingBytes = options.hostCeilingBytes ?? null;
  const over = ceilingBytes == null ? 0 : Math.max(0, memoryMax - ceilingBytes);
  return {
    version: 1,
    worker_count: workers.length,
    memory_high_bytes: memoryHigh,
    memory_max_bytes: memoryMax,
    cpu_weight_total: cpuWeight,
    unaccounted_workers: unaccounted.sort(),
    unisolated_workers: unisolated.sort(),
    memory_ceiling_bytes: ceilingBytes,
    over_committed_bytes: over,
    over_commitment_reason: over === 0 ? null : overCommitmentReason(workers.length, memoryMax, ceilingBytes!, over),
  };
}

/**
 * Why the walls sum past the ceiling, in one sentence an operator can act on. PURE.
 *
 * It names the arithmetic rather than declaring a fault, because the state is
 * not one: a per-Worker `MemoryMax` is the most a Worker may take, so a host
 * whose Workers never all peak at once runs over-committed and perfectly safe.
 * What the sentence buys is that the host stops claiming a promise it is not
 * keeping — which is the whole defect (#3080).
 */
function overCommitmentReason(workers: number, memoryMax: number, ceiling: number, over: number): string {
  return `this host's ${workers} Worker(s) carry ${memoryMax} bytes of applied MemoryMax against a host ceiling of ` +
    `${ceiling} bytes — ${over} bytes over. A per-Worker MemoryMax is a wall rather than a reservation, so the host ` +
    "stays safe only while the Workers do not all peak together; the ceiling is not enforced host-wide.";
}

/**
 * A systemd memory value in bytes, or `null` when it is not a byte quantity.
 *
 * The suffixes are systemd's own (`K`/`M`/`G`/`T`, base 1024, optional `B`).
 * `infinity`, a percentage and anything unrecognised return `null` rather than a
 * guess: the caller reports those Workers by name.
 */
export function parseMemoryBudget(value: string): number | null {
  const match = /^\s*(\d+(?:\.\d+)?)\s*([KMGT]?)(?:B)?\s*$/i.exec(value);
  if (!match) return null;
  const scale = { "": 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 }[match[2]!.toLowerCase()]!;
  return Math.round(Number(match[1]) * scale);
}

/** True when `value` is a complete accounting document — a client's fail-closed check. */
export function isRedskilledBudgetAccounting(value: unknown): value is RedskilledBudgetAccounting {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const accounting = value as Record<string, unknown>;
  return accounting.version === 1 &&
    Number.isInteger(accounting.worker_count) &&
    typeof accounting.memory_high_bytes === "number" &&
    typeof accounting.memory_max_bytes === "number" &&
    typeof accounting.cpu_weight_total === "number" &&
    Array.isArray(accounting.unaccounted_workers) &&
    Array.isArray(accounting.unisolated_workers);
}
