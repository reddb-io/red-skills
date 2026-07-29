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
 * PURE: every input is a Worker view.
 */
import type { RedskilledWorkerView } from "./host-state.js";

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
};

/** Total the declared budgets of a Worker set. PURE. */
export function buildBudgetAccounting(workers: readonly RedskilledWorkerView[]): RedskilledBudgetAccounting {
  let memoryHigh = 0;
  let memoryMax = 0;
  let cpuWeight = 0;
  const unaccounted: string[] = [];
  const unisolated: string[] = [];

  for (const worker of workers) {
    const budget = worker.budget ?? {};
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

  return {
    version: 1,
    worker_count: workers.length,
    memory_high_bytes: memoryHigh,
    memory_max_bytes: memoryMax,
    cpu_weight_total: cpuWeight,
    unaccounted_workers: unaccounted.sort(),
    unisolated_workers: unisolated.sort(),
  };
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
