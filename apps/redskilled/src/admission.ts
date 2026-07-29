/**
 * admission — may this host afford one more Worker, right now?
 *
 * The defect ADR 0130 exists to fix is a static per-repository answer: every
 * checkout reads the same host capability profile, concludes the machine affords
 * N Workers, and spends that budget alone, so three projects on one machine run
 * 3N. **Admission is a decision over live process state, never over a stored
 * profile** — the denominator is the Worker set the daemon is holding at this
 * instant, across every project, which is the one number no per-repository read
 * can produce.
 *
 * The shape follows `evaluateHostGateAdmission` in red-castle deliberately: a
 * pure function, a boolean, and a named verdict. What is new here is the live
 * denominator and the fact that the verdict carries the numbers it judged on —
 * a refusal a caller cannot explain to an operator is a refusal that gets
 * disabled.
 *
 * **A Worker's charge is the largest amount it may take**, `MemoryMax` when it
 * declares one and `MemoryHigh` otherwise: `MemoryHigh` is throttling pressure,
 * not a wall, so admitting against it would let the host commit past a ceiling
 * the kernel is willing to exceed.
 *
 * PURE: every input is passed in; {@link resolveHostCeiling} is the one place
 * that reads the environment, and even that takes the host's memory as an
 * argument.
 */
import { totalmem } from "node:os";
import { parseMemoryBudget } from "./budget-accounting.js";
import type { RedskilledWorkerView } from "./host-state.js";
import type { RedskilledWorkerBudget } from "./worker-placement.js";

/** Env var that states the host-wide memory ceiling; `infinity` lifts it. */
export const REDSKILLED_MEMORY_CEILING_ENV = "REDSKILLED_MEMORY_CEILING";

/** Env var that states the host-wide Worker count ceiling; `infinity` lifts it. */
export const REDSKILLED_WORKER_CEILING_ENV = "REDSKILLED_WORKER_CEILING";

/**
 * The share of host memory Workers may commit when nobody stated a ceiling.
 *
 * Short of the whole machine on purpose: the terminal, the editor and the
 * daemon itself are not Workers, and a ceiling that promised every byte to
 * Workers would finance exactly the pressure kill it exists to prevent.
 */
export const DEFAULT_HOST_MEMORY_CEILING_FRACTION = 0.7;

/** The ceiling the host is admitted against. `null` on a dimension means unbounded. */
export interface RedskilledHostCeiling {
  /** Total declared Worker memory this host may commit, in bytes. */
  readonly memory_bytes: number | null;
  /** Total live Workers this host may hold, across every project. */
  readonly worker_count: number | null;
  /** `declared` when an operator stated it, `host-fraction` when derived. */
  readonly source: "declared" | "host-fraction";
}

/** No ceiling at all — an operator's explicit opt-out, and the tests' baseline. */
export const UNBOUNDED_HOST_CEILING: RedskilledHostCeiling = {
  memory_bytes: null,
  worker_count: null,
  source: "declared",
};

/** What the host is already committed to, derived from the live Worker set. */
export interface RedskilledHostConsumption {
  readonly worker_count: number;
  /** Sum of the live Workers' charges, in bytes. */
  readonly memory_bytes: number;
  /** Live Workers whose declared budget could not be reduced to bytes, by id. */
  readonly unaccounted_workers: readonly string[];
}

export type RedskilledAdmissionVerdictKind =
  | "admitted"
  | "refused-over-memory-ceiling"
  | "refused-over-worker-ceiling"
  | "refused-unaccountable-budget";

/**
 * The answer, carrying what it was decided on.
 *
 * `reason` is a whole sentence rather than a code: this string is what a caller
 * shows an operator whose Worker did not start, and a refusal nobody can read is
 * a refusal somebody turns off.
 */
export interface RedskilledAdmissionVerdict {
  readonly version: 1;
  readonly admitted: boolean;
  readonly verdict: RedskilledAdmissionVerdictKind;
  readonly reason: string;
  readonly ceiling: RedskilledHostCeiling;
  readonly consumption: RedskilledHostConsumption;
  /** What this request would add, in bytes; `null` when it declared nothing. */
  readonly requested_memory_bytes: number | null;
  /** Where the host would stand had this request been admitted. */
  readonly projected_worker_count: number;
  readonly projected_memory_bytes: number;
}

export interface EvaluateWorkerAdmissionInput {
  readonly ceiling: RedskilledHostCeiling;
  /** Every Worker the daemon believes is alive — across every project. */
  readonly workers: readonly RedskilledWorkerView[];
  /** The budget the request declared, if any. */
  readonly budget?: RedskilledWorkerBudget;
  /** The requesting project's own opaque label, echoed into the reason. */
  readonly projectLabel?: string;
}

/**
 * The bytes one Worker's declared budget commits, or `null` when it is opaque.
 *
 * A budget the daemon cannot reduce to bytes is named, never rounded to zero —
 * the same rule the accounting follows, for the same reason: understating the
 * host's exposure exactly when it is largest is the failure mode that costs the
 * machine. PURE.
 */
export function budgetMemoryCharge(budget: RedskilledWorkerBudget | undefined): number | null | undefined {
  const declared = budget?.memory_max ?? budget?.memory_high;
  if (declared == null) return undefined;
  return parseMemoryBudget(declared);
}

/** What the live Worker set already commits. PURE. */
export function measureHostConsumption(
  workers: readonly RedskilledWorkerView[],
): RedskilledHostConsumption {
  let memory = 0;
  const unaccounted: string[] = [];
  for (const worker of workers) {
    const charge = budgetMemoryCharge(worker.budget);
    if (charge === null) unaccounted.push(worker.worker_id);
    else if (charge !== undefined) memory += charge;
  }
  return { worker_count: workers.length, memory_bytes: memory, unaccounted_workers: unaccounted.sort() };
}

/**
 * Decide one request against the live host.
 *
 * Refusal is the answer whenever the host cannot *prove* the request fits: over
 * the memory ceiling, over the Worker ceiling, or carrying a budget that cannot
 * be reduced to bytes while a byte ceiling is in force. The third case is a
 * refusal rather than a guess because a request whose size is unknown is
 * indistinguishable, to the host, from one that is too large. PURE.
 */
export function evaluateWorkerAdmission(input: EvaluateWorkerAdmissionInput): RedskilledAdmissionVerdict {
  const { ceiling } = input;
  const consumption = measureHostConsumption(input.workers);
  const charge = budgetMemoryCharge(input.budget);
  const requested = charge === undefined ? null : charge;
  const projectedMemory = consumption.memory_bytes + (charge ?? 0);
  const projectedWorkers = consumption.worker_count + 1;
  const who = input.projectLabel != null && input.projectLabel !== ""
    ? ` for project ${JSON.stringify(input.projectLabel)}`
    : "";
  const at = `the host is already holding ${consumption.memory_bytes} bytes across ${consumption.worker_count} Worker(s)`;

  const refuse = (verdict: RedskilledAdmissionVerdictKind, reason: string): RedskilledAdmissionVerdict => ({
    version: 1,
    admitted: false,
    verdict,
    reason,
    ceiling,
    consumption,
    requested_memory_bytes: requested,
    projected_worker_count: projectedWorkers,
    projected_memory_bytes: projectedMemory,
  });

  if (ceiling.worker_count != null && projectedWorkers > ceiling.worker_count) {
    return refuse(
      "refused-over-worker-ceiling",
      `redskilled refused this Worker${who}: it would be Worker ${projectedWorkers} past a host ceiling of ${ceiling.worker_count} Worker(s), and ${at}`,
    );
  }
  if (ceiling.memory_bytes != null && charge === null) {
    return refuse(
      "refused-unaccountable-budget",
      `redskilled refused this Worker${who}: its declared memory budget cannot be reduced to bytes, so it cannot be proven to fit under the host ceiling of ${ceiling.memory_bytes} bytes, and ${at}`,
    );
  }
  if (ceiling.memory_bytes != null && projectedMemory > ceiling.memory_bytes) {
    return refuse(
      "refused-over-memory-ceiling",
      `redskilled refused this Worker${who}: it would take the host to ${projectedMemory} bytes of declared Worker memory, past the host ceiling of ${ceiling.memory_bytes} bytes, and ${at}`,
    );
  }

  return {
    version: 1,
    admitted: true,
    verdict: "admitted",
    reason: `redskilled admitted this Worker${who}: ${projectedMemory} bytes of declared Worker memory against a host ceiling of ${ceiling.memory_bytes ?? "unbounded"} bytes, and ${at}`,
    ceiling,
    consumption,
    requested_memory_bytes: requested,
    projected_worker_count: projectedWorkers,
    projected_memory_bytes: projectedMemory,
  };
}

/**
 * The ceiling this host admits against.
 *
 * An operator's declaration wins; absent one, the ceiling is a share of the
 * machine's own memory, so a host that was never configured still has a real
 * ceiling instead of an unbounded one. `infinity` (systemd's own word) lifts a
 * dimension outright, because an operator who means unbounded should be able to
 * say so rather than have to state a number larger than the machine.
 */
export function resolveHostCeiling(
  env: NodeJS.ProcessEnv = process.env,
  totalMemoryBytes: number = totalmem(),
): RedskilledHostCeiling {
  const declaredMemory = (env[REDSKILLED_MEMORY_CEILING_ENV] ?? "").trim();
  const declaredWorkers = (env[REDSKILLED_WORKER_CEILING_ENV] ?? "").trim();
  const workerCount = parseCountCeiling(declaredWorkers);

  if (declaredMemory !== "") {
    const memory = parseMemoryCeiling(declaredMemory, totalMemoryBytes);
    if (memory !== undefined) return { memory_bytes: memory, worker_count: workerCount, source: "declared" };
  }
  return {
    memory_bytes: Math.floor(totalMemoryBytes * DEFAULT_HOST_MEMORY_CEILING_FRACTION),
    worker_count: workerCount,
    source: declaredWorkers !== "" ? "declared" : "host-fraction",
  };
}

/** `infinity` → unbounded, `N%` → a share of the host, otherwise systemd bytes. */
function parseMemoryCeiling(value: string, totalMemoryBytes: number): number | null | undefined {
  const lowered = value.toLowerCase();
  if (["infinity", "none", "off", "unbounded"].includes(lowered)) return null;
  const percent = /^(\d+(?:\.\d+)?)\s*%$/.exec(value);
  if (percent) return Math.floor(totalMemoryBytes * (Number(percent[1]) / 100));
  return parseMemoryBudget(value) ?? undefined;
}

function parseCountCeiling(value: string): number | null {
  if (value === "") return null;
  if (["infinity", "none", "off", "unbounded"].includes(value.toLowerCase())) return null;
  const count = Number(value);
  return Number.isSafeInteger(count) && count > 0 ? count : null;
}

/** True when `value` is a complete verdict — a client's fail-closed check. */
export function isRedskilledAdmissionVerdict(value: unknown): value is RedskilledAdmissionVerdict {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const verdict = value as Record<string, unknown>;
  const ceiling = verdict.ceiling as Record<string, unknown> | undefined;
  const consumption = verdict.consumption as Record<string, unknown> | undefined;
  return verdict.version === 1 &&
    typeof verdict.admitted === "boolean" &&
    typeof verdict.verdict === "string" &&
    typeof verdict.reason === "string" &&
    ceiling != null && typeof ceiling === "object" &&
    (ceiling.memory_bytes === null || typeof ceiling.memory_bytes === "number") &&
    (ceiling.worker_count === null || typeof ceiling.worker_count === "number") &&
    consumption != null && typeof consumption === "object" &&
    Number.isInteger(consumption.worker_count) &&
    typeof consumption.memory_bytes === "number" &&
    Array.isArray(consumption.unaccounted_workers) &&
    Number.isInteger(verdict.projected_worker_count) &&
    typeof verdict.projected_memory_bytes === "number";
}
