/**
 * job-object — the Windows placement backend, and the honest edge of its reach.
 *
 * **A Job Object is the closest analogue to a Linux resource group that exists
 * off Linux**: it carries a memory ceiling the kernel enforces, CPU rate
 * control, and kill-on-close, so Windows gains real teeth instead of only the
 * daemon's sampling floor (ADR 0130 rule 4).
 *
 * **Native reach is an N-API addon, decided on #2780.** Node reaches none of
 * these APIs on its own. The addon is loaded in-process from a prebuild matching
 * `<platform>-<arch>`, falling back to a `node-gyp` build output when no
 * prebuild matches the host. When neither is there the reach is a REFUSAL
 * CARRYING A REASON rather than a thrown error or a silent `false`: the caller
 * degrades to the sampling floor and says which of the two it is doing.
 *
 * **Kill-on-close is set deliberately, and it is a Windows-only bargain.** On
 * Linux a Worker is owned by the init system so a restarted daemon re-attaches
 * by unit name (ADR 0130 rule 5). A Job Object has no such owner — the handle IS
 * the ownership — so this backend trades re-attach for the guarantee that no
 * Worker outlives the job that owns it. Leaking Workers on every daemon upgrade
 * is the failure this repository already pays a floor to avoid.
 *
 * PURE except {@link loadJobObjectBinding}, the one function that reads the host,
 * and even that takes its `require` and its existence check injected — which is
 * what lets every case here be proven on a machine that is not Windows.
 */
import { join } from "node:path";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import type { RedskilledWorkerView } from "./host-state.js";
import {
  resolveEnforcedBudget,
  type RedskilledBudgetName,
  type RedskilledTerminationClassification,
} from "./memory-sampler.js";
import type { RedskilledWorkerBudget } from "./worker-placement.js";

/** The addon's file name, identical in a prebuild and in a local build. */
export const JOB_OBJECT_ADDON_BASENAME = "redskilled-job-object.node";

/** `CPUWeight`'s systemd default — the fair share, and the line this backend caps below. */
export const CPU_WEIGHT_FAIR_SHARE = 100;

/**
 * The limits one Job Object carries.
 *
 * `kill_on_close` is a literal `true` rather than a boolean: it is the property
 * that makes a Worker unable to outlive its job, so it is not a knob a future
 * caller can turn off by passing the other value.
 */
export interface RedskilledJobLimits {
  /** `JOB_OBJECT_LIMIT_JOB_MEMORY`, in bytes. Absent when no budget declared one. */
  readonly memory_limit_bytes?: number;
  /** The budget's own name, so a limit can always be traced back to what asked for it. */
  readonly memory_budget_name?: RedskilledBudgetName;
  /** The budget exactly as the client declared it, unparsed. */
  readonly memory_budget_declared?: string;
  /** `JOBOBJECT_CPU_RATE_CONTROL_INFORMATION`, as a percentage of one CPU's cycles. */
  readonly cpu_rate_percent?: number;
  /** `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. Always set; never optional. */
  readonly kill_on_close: true;
  /** Set when a declared budget field could not be carried into the job as asked. */
  readonly note?: string;
}

/** One live Job Object. Closing it kills everything inside — that is the point. */
export interface RedskilledJobObjectHandle {
  readonly name: string;
  /** Put a live process under this job's limits. Throws when the host refuses. */
  assign(pid: number): void;
  /** Close the job. With kill-on-close set, this ends every Worker inside it. */
  close(): void;
}

/** What the N-API addon must export. The daemon knows the addon by this alone. */
export interface RedskilledJobObjectBinding {
  createJobObject(request: {
    readonly name: string;
    readonly limits: RedskilledJobLimits;
  }): RedskilledJobObjectHandle;
}

/**
 * Whether this host can reach Job Objects, and when it cannot, why.
 *
 * The unavailable arm carries a whole sentence rather than a flag, because the
 * caller's job is to degrade to the sampling floor *explicitly* — and a
 * degradation nobody can read the cause of is the silent one this shape exists
 * to prevent.
 */
export type RedskilledJobObjectReach =
  | { readonly available: true; readonly binding: RedskilledJobObjectBinding }
  | { readonly available: false; readonly reason: string };

/** Reach is unavailable, with the sentence a warning will quote. PURE. */
export function jobObjectsUnavailable(reason: string): RedskilledJobObjectReach {
  return { available: false, reason };
}

/**
 * Where the addon is looked for, in the order it is looked for. PURE.
 *
 * A prebuild for this exact `<platform>-<arch>` first, then the `node-gyp`
 * output a host that compiled its own would produce. Both are listed in a
 * failure so an operator reads where to put the artifact, not just that it is
 * missing.
 */
export function jobObjectAddonCandidates(
  platform: NodeJS.Platform,
  arch: string,
  packageRoot: string,
): readonly string[] {
  return [
    join(packageRoot, "prebuilds", `${platform}-${arch}`, JOB_OBJECT_ADDON_BASENAME),
    join(packageRoot, "native", "build", "Release", JOB_OBJECT_ADDON_BASENAME),
  ];
}

export interface LoadJobObjectBindingOptions {
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly packageRoot?: string;
  /** Injected so a non-Windows host can prove every arm of this function. */
  readonly requireFn?: (path: string) => unknown;
  readonly exists?: (path: string) => boolean;
}

/**
 * Load the Job Object addon, or refuse with a reason.
 *
 * The one impure read of the host in this module, and it never throws: a
 * daemon that crashed because an optional native artifact was missing would be
 * worse than the unenforced ceiling it was trying to install.
 */
export function loadJobObjectBinding(
  options: LoadJobObjectBindingOptions = {},
): RedskilledJobObjectReach {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  if (platform !== "win32") {
    return jobObjectsUnavailable(
      `Job Object placement is the Windows backend (platform=${platform}), so there is no native reach to load here`,
    );
  }

  const packageRoot = options.packageRoot ?? defaultPackageRoot();
  const exists = options.exists ?? existsSync;
  const candidates = jobObjectAddonCandidates(platform, arch, packageRoot);
  const found = candidates.find((candidate) => exists(candidate));
  if (found == null) {
    return jobObjectsUnavailable(
      `no Job Object addon was found for ${platform}-${arch} (looked in ${candidates.join(", ")}); ` +
        "either install the prebuild for this platform and architecture or build the addon locally",
    );
  }

  const requireFn = options.requireFn ?? createRequire(import.meta.url);
  let loaded: unknown;
  try {
    loaded = requireFn(found);
  } catch (err) {
    return jobObjectsUnavailable(
      `the Job Object addon at ${found} could not be loaded: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!isJobObjectBinding(loaded)) {
    return jobObjectsUnavailable(
      `the Job Object addon at ${found} does not export createJobObject, so it cannot be the native reach`,
    );
  }
  return { available: true, binding: loaded };
}

function isJobObjectBinding(value: unknown): value is RedskilledJobObjectBinding {
  return typeof value === "object" && value != null &&
    typeof (value as { createJobObject?: unknown }).createJobObject === "function";
}

function defaultPackageRoot(): string {
  return new URL("..", import.meta.url).pathname;
}

/**
 * The job limits one budget asks for. PURE.
 *
 * `MemoryMax` wins over `MemoryHigh` for the same reason the sampling floor
 * enforces it: `MemoryHigh` is throttling pressure and `MemoryMax` is the wall,
 * and a job whose hard ceiling sat at the pressure point would end Workers the
 * kernel was willing to keep.
 *
 * **CPU rate control is not `CPUWeight`, and this refuses to pretend it is.**
 * Windows caps an absolute percentage of cycles while `CPUWeight` states a
 * relative share, so a weight AT OR ABOVE the fair share buys no cap at all —
 * turning "give this Worker more than its share" into a hard ceiling would
 * install a limit nobody asked for. Only a deprioritising weight becomes a rate.
 */
export function planJobLimits(budget: RedskilledWorkerBudget | undefined): RedskilledJobLimits {
  const declared = budget ?? {};
  const notes: string[] = [];
  const memory = resolveJobMemoryLimit(declared);
  if (memory == null && (declared.memory_max ?? declared.memory_high) != null) {
    notes.push("the declared memory budget could not be reduced to bytes, so the job carries no memory ceiling");
  }
  let cpuRate: number | undefined;
  if (declared.cpu_weight != null) {
    if (declared.cpu_weight < CPU_WEIGHT_FAIR_SHARE) {
      cpuRate = Math.max(1, Math.min(100, Math.round(declared.cpu_weight)));
    } else {
      notes.push(
        `cpu_weight=${declared.cpu_weight} is at or above the fair share of ${CPU_WEIGHT_FAIR_SHARE}, and Windows CPU ` +
          "rate control is an absolute cap rather than a share, so no rate limit is set",
      );
    }
  }
  return {
    ...(memory != null
      ? {
          memory_limit_bytes: memory.bytes,
          memory_budget_name: memory.name,
          memory_budget_declared: memory.declared,
        }
      : {}),
    ...(cpuRate != null ? { cpu_rate_percent: cpuRate } : {}),
    kill_on_close: true,
    ...(notes.length > 0 ? { note: notes.join("; ") } : {}),
  };
}

function resolveJobMemoryLimit(
  budget: RedskilledWorkerBudget,
): { readonly name: RedskilledBudgetName; readonly declared: string; readonly bytes: number } | null {
  // The floor already owns this precedence and its parsing; a second copy here
  // would be a second answer to "which budget is the wall".
  return resolveEnforcedBudget({ budget });
}

/**
 * Windows exit codes a process shows when the job's memory ceiling stopped it.
 *
 * A job memory limit does not shoot the process — it fails its allocations, and
 * the runtime dies of the failure. These are the NTSTATUS values that arrives as,
 * named rather than inlined so a reader of an outcome can look them up.
 */
export const JOB_MEMORY_EXIT_CODES: Readonly<Record<number, string>> = {
  0xc0000017: "STATUS_NO_MEMORY",
  0xc000012d: "STATUS_COMMITMENT_LIMIT",
  0xc0000409: "STATUS_STACK_BUFFER_OVERRUN",
};

/**
 * One Worker the Windows kernel stopped for its job's memory ceiling.
 *
 * It shares `outcome`, `classification` and `stall` with the sampling floor's
 * termination on purpose — the same fact happened, with better teeth — and adds
 * `enforced_by` so a reader can tell which backend acted without inferring it
 * from the presence of an RSS number nobody measured.
 */
export interface RedskilledJobObjectTermination {
  readonly version: 1;
  readonly worker_id: string;
  readonly project_label: string;
  readonly outcome: "terminated-over-memory-budget";
  readonly classification: RedskilledTerminationClassification;
  /** Never a stall — the kernel refused this Worker's memory, it did not wait on it. */
  readonly stall: false;
  readonly enforced_by: "job-object";
  readonly job_name: string;
  readonly budget_name: RedskilledBudgetName;
  readonly budget_declared: string;
  readonly budget_bytes: number;
  readonly exit_code: number;
  readonly exit_status: string;
  readonly workspace_path: string;
  /** A whole sentence naming the budget — what an operator reads. */
  readonly reason: string;
}

export interface ClassifyJobObjectExitInput {
  readonly worker: RedskilledWorkerView;
  readonly jobName: string;
  readonly limits: RedskilledJobLimits;
  readonly exitCode: number | null;
}

/**
 * Read a Worker's death against the job that held it. PURE.
 *
 * Returns `null` for every exit this backend cannot attribute — a clean exit, a
 * job with no memory ceiling, an unknown status. A backend that claimed every
 * death as a budget kill would make the outcome worthless exactly where it is
 * read most: after an incident.
 */
export function classifyJobObjectExit(
  input: ClassifyJobObjectExitInput,
): RedskilledJobObjectTermination | null {
  const { worker, limits, exitCode } = input;
  if (exitCode == null) return null;
  if (limits.memory_limit_bytes == null || limits.memory_budget_name == null) return null;
  const status = JOB_MEMORY_EXIT_CODES[exitCode >>> 0];
  if (status == null) return null;

  const who = `Worker ${JSON.stringify(worker.worker_id)} of project ${JSON.stringify(worker.project_label)}`;
  const declared = limits.memory_budget_declared ?? String(limits.memory_limit_bytes);
  return {
    version: 1,
    worker_id: worker.worker_id,
    project_label: worker.project_label,
    outcome: "terminated-over-memory-budget",
    classification: "budget-exceeded",
    stall: false,
    enforced_by: "job-object",
    job_name: input.jobName,
    budget_name: limits.memory_budget_name,
    budget_declared: declared,
    budget_bytes: limits.memory_limit_bytes,
    exit_code: exitCode,
    exit_status: status,
    workspace_path: worker.workspace_path,
    reason:
      `the Windows kernel terminated ${who}: its Job Object ${JSON.stringify(input.jobName)} enforced the ` +
      `${limits.memory_budget_name} budget of ${declared} (${limits.memory_limit_bytes} bytes) and the Worker died ` +
      `with ${status} (0x${(exitCode >>> 0).toString(16)}). This is a budget termination, not a stall, and the work ` +
      `in ${JSON.stringify(worker.workspace_path)} is handed forward.`,
  };
}
