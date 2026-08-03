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
 * The ceiling one Worker's own scope carries, and where it came from.
 *
 * `memory_max` is `null` when the host has no accounting to derive one from —
 * an answer, never an omission, and `reason` says which host fact produced it.
 */
export interface RedskilledScopeCeiling {
  /** The scope's `MemoryMax`, in the host's own notation; `null` for none. */
  readonly memory_max: string | null;
  /** A whole sentence naming where this ceiling came from. */
  readonly reason: string;
}

/**
 * The ceiling one Worker's scope is born with — derived, never configured.
 *
 * **No new knob.** A per-Worker ceiling nobody sets is a per-Worker ceiling
 * nobody has, so it is derived from the accounting the host already keeps: the
 * host ceiling it admits against, divided by the Worker slots it admits when an
 * operator declared a count, and otherwise capped at the headroom left after the
 * live Workers' declared budgets. A Worker past that number is, by the host's own
 * arithmetic, taking more than the machine ever promised Workers — so the kernel
 * kills IT rather than whatever bystander the host's memory pressure finds first.
 *
 * **A declared budget is never overridden.** A client that stated its own ceiling
 * has already answered this question, and a host that silently narrowed it would
 * be enforcing a limit the client could not read back from what it asked for.
 *
 * The derived ceiling deliberately does NOT enter the admission charge: it is the
 * wall a Worker may not pass, never memory set aside for it, and counting it as
 * committed would let the first Worker born spend the whole host's accounting and
 * have every Worker after it refused. PURE.
 */
export function deriveWorkerScopeCeiling(input: {
  readonly ceiling: RedskilledHostCeiling;
  /** Every Worker the daemon is holding right now, across every project. */
  readonly workers: readonly RedskilledWorkerView[];
  /** The budget the request declared, if any. */
  readonly budget?: RedskilledWorkerBudget;
}): RedskilledScopeCeiling {
  const declared = input.budget?.memory_max ?? input.budget?.memory_high;
  if (declared != null) {
    return {
      memory_max: declared,
      reason: `the client declared this Worker's memory ceiling (${declared}), so the host derived none`,
    };
  }
  if (input.ceiling.memory_bytes == null) {
    return {
      memory_max: null,
      reason:
        "this host admits Workers against no memory ceiling, so there is no accounting to derive a per-Worker ceiling from; " +
        "the daemon's RSS sampling floor is the only remaining ceiling",
    };
  }

  const consumption = measureHostConsumption(input.workers);
  const headroom = input.ceiling.memory_bytes - consumption.memory_bytes;
  const slots = input.ceiling.worker_count;
  const share = slots == null ? headroom : Math.floor(input.ceiling.memory_bytes / slots);
  const bytes = Math.min(headroom, share);
  if (bytes <= 0) {
    return {
      memory_max: null,
      reason:
        `this host's memory ceiling of ${input.ceiling.memory_bytes} bytes is already fully committed to ` +
        `${consumption.worker_count} Worker(s), so no positive per-Worker ceiling can be derived; ` +
        "the daemon's RSS sampling floor is the only remaining ceiling",
    };
  }
  // **With no slot count, the derived ceiling is a per-Worker wall and NOT
  // memory the host sets aside, and it says so.** The arithmetic is unchanged — a
  // share cannot be divided by a number nobody stated — but the promise it was
  // silently making could not be kept: two Workers each derived the whole
  // ceiling, so the host carried 2× what it admits against while reporting
  // nothing (#3080). Narrowing the share instead would be worse, not better: the
  // second Worker would derive zero and fall through to `memory_max: null`,
  // trading a stated over-commitment for a Worker with no kernel wall at all.
  // So the host states the exposure here, and `buildBudgetAccounting` totals it.
  const from = slots == null
    ? `the headroom under this host's memory ceiling of ${input.ceiling.memory_bytes} bytes; this host declares no ` +
      `Worker slot count (${REDSKILLED_WORKER_CEILING_ENV} is unset), so this ceiling is a per-Worker wall and not ` +
      "memory the host sets aside — N Workers may carry N such walls, and the host ceiling is not enforced " +
      "host-wide. Declare a slot count to make it divide into shares that sum to it"
    : `this host's memory ceiling of ${input.ceiling.memory_bytes} bytes shared across its ${slots} Worker slot(s)`;
  return {
    memory_max: String(bytes),
    reason: `derived from ${from} (ceiling source: ${input.ceiling.source})`,
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
    // Named rather than obeyed in silence. A malformed ceiling is a limit the
    // operator believes they set, and falling through quietly gives them the
    // 0.7 fraction instead — which for a mistyped `50%` is MORE permissive than
    // what they asked for, so the daemon admits Workers past the line they
    // meant to draw. Loud and continue: a bad env var must not stop the host.
    warn(
      `redskilled: ${REDSKILLED_MEMORY_CEILING_ENV}=${JSON.stringify(declaredMemory)} is not a memory ceiling ` +
        `this host can read; using ${DEFAULT_HOST_MEMORY_CEILING_FRACTION * 100}% of host memory instead. ` +
        `Accepted forms: systemd bytes (\`8G\`), a percentage (\`50%\`), or \`infinity\`.`,
    );
  }
  if (declaredWorkers !== "" && workerCount === null && !isUnbounded(declaredWorkers)) {
    // Same rule for the count: `parseCountCeiling` discards a non-integer or a
    // non-positive value just as quietly, and an ignored worker ceiling is an
    // unbounded host wearing a number the operator thinks they set.
    warn(
      `redskilled: ${REDSKILLED_WORKER_CEILING_ENV}=${JSON.stringify(declaredWorkers)} is not a positive ` +
        `integer; this host admits an unbounded number of Workers instead.`,
    );
  }
  return {
    memory_bytes: Math.floor(totalMemoryBytes * DEFAULT_HOST_MEMORY_CEILING_FRACTION),
    worker_count: workerCount,
    // **The source describes the MEMORY ceiling, and reaching here means it was
    // derived.** It used to be read off `declaredWorkers`, so declaring only a
    // WORKER ceiling labelled a derived memory ceiling `declared` — and that
    // word is interpolated into the admission reason, which speaks purely about
    // memory. An operator debugging a denied Worker was told they had stated a
    // number they never stated.
    source: "host-fraction",
  };
}

/** `infinity` and its synonyms — a real declaration of "no ceiling". */
function isUnbounded(value: string): boolean {
  return ["infinity", "none", "off", "unbounded"].includes(value.trim().toLowerCase());
}

/** Where a named fallback goes. An input only so a test can watch it. */
let warn: (message: string) => void = (message) => process.stderr.write(`${message}\n`);

/** Redirect the warning sink; returns the previous one. For tests. */
export function setHostCeilingWarningSink(sink: (message: string) => void): (message: string) => void {
  const previous = warn;
  warn = sink;
  return previous;
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
