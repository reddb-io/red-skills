/**
 * worker-launch — birth: a spec in, a live Worker and its warnings out.
 *
 * The impure half of placement. It plans (pure, in `worker-placement`), spawns
 * once, and reports what it actually did — including when what it did was worse
 * than what was asked for.
 *
 * **The spec is data, not a description of a repository.** The daemon receives a
 * command, a placement target, a budget, a project label and a workspace path,
 * and it reads none of them for meaning: no marker file is looked for, no parent
 * directory is walked, no layout is assumed. A path it needs is a path it was
 * given (ADR 0130 rule 3), which is what lets one daemon serve checkouts pinned
 * to different bundle versions.
 *
 * **A birth carries the verdict that allowed it.** The host-wide admission
 * verdict is a required launch input rather than a check the caller is trusted
 * to have run first, so "no code path spawns a Worker without an admission
 * verdict" is a property of this function instead of a convention every future
 * call site has to remember.
 */
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { pathWithEngineNode } from "@reddb-io/shared/engine-node.js";
import type { RedskilledAdmissionVerdict } from "./admission.js";
import type { RedskilledWorkerView } from "./host-state.js";
import type { RedskilledJobObjectHandle } from "./job-object.js";
import {
  detectWorkerPlacementProbes,
  placementEnabled,
  planWorkerPlacement,
  type RedskilledPlacementTarget,
  type RedskilledWorkerBudget,
  type WorkerPlacementPlan,
  type WorkerPlacementProbes,
} from "./worker-placement.js";

/** What a client hands over to ask for a Worker. Every field is opaque to the daemon. */
export interface RedskilledWorkerSpec {
  /** The client's own id for this Worker; the daemon mints one when absent. */
  readonly worker_id?: string;
  readonly project_label: string;
  /** Used verbatim as the Worker's working directory. */
  readonly workspace_path: string;
  /**
   * Where this Worker will write its log, if the client wants it recoverable.
   *
   * Optional, and opaque: the daemon opens it only to rehydrate a heartbeat it
   * lost to a restart. A client that gives none keeps the whole mechanism on the
   * heartbeat, which is the normal path anyway.
   */
  readonly log_path?: string;
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly placement?: RedskilledPlacementTarget;
  readonly budget?: RedskilledWorkerBudget;
}

/** Raised when a spec is not launchable. Fail closed: no Worker, and a reason. */
export class RedskilledWorkerSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RedskilledWorkerSpecError";
  }
}

/**
 * Raised when a launch was attempted without a verdict admitting it.
 *
 * Its own type, not a spec error: a spec the daemon cannot act on is the
 * client's mistake, while a birth attempted past the host's answer is the
 * daemon's, and an operator reading a refusal needs to know which happened.
 */
export class RedskilledAdmissionError extends Error {
  constructor(
    message: string,
    readonly admission?: RedskilledAdmissionVerdict,
  ) {
    super(message);
    this.name = "RedskilledAdmissionError";
  }
}

export interface LaunchedWorker {
  readonly worker: RedskilledWorkerView;
  /** The verdict that allowed this birth, carried into the caller's reply. */
  readonly admission: RedskilledAdmissionVerdict;
  /** The same warnings the view carries, for a caller that reports them once. */
  readonly warnings: readonly string[];
  readonly plan: WorkerPlacementPlan;
  readonly child: ChildProcess;
  /**
   * The Job Object holding this Worker, on Windows and only when it was minted.
   *
   * It is HELD, not closed: kill-on-close means letting go of this handle ends
   * the Worker, so the daemon keeps it for the Worker's life and closes it when
   * the Worker is gone.
   */
  readonly job?: RedskilledJobObjectHandle;
}

export interface LaunchWorkerOptions {
  readonly spec: RedskilledWorkerSpec;
  /** The host-wide verdict admitting this birth. Required: no verdict, no Worker. */
  readonly admission: RedskilledAdmissionVerdict;
  readonly probes?: WorkerPlacementProbes;
  /**
   * The ceiling the host derived for this Worker (`deriveWorkerScopeCeiling`).
   *
   * A launch input rather than something read here, because the number comes out
   * of the host-wide accounting and only the daemon holds the live Worker set it
   * is derived from. Absent, the Worker is born under whatever the client
   * declared — which for a client that declared nothing is no ceiling at all.
   */
  readonly memoryCeiling?: { readonly memory_max: string | null; readonly reason: string };
  readonly enabled?: boolean;
  readonly env?: NodeJS.ProcessEnv;
  /**
   * The node the daemon itself runs on, handed down to the Worker (#3064).
   * Defaults to this process's `execPath`; an input only so a test can pose a
   * version-manager host without one being installed.
   */
  readonly execPath?: string;
  readonly clock?: () => string;
  readonly workerId?: string;
  readonly spawnFn?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
  /** Called when the daemon observes this Worker's process end. */
  readonly onExit?: (workerId: string, code: number | null, signal: NodeJS.Signals | null) => void;
  /** False to leave the spec's `log_path` unopened — for a test with no real fs. */
  readonly openLog?: boolean;
}

/** Open a Worker's log for append, or null when it has none / cannot be opened. */
function openWorkerLog(logPath: string | undefined): number | null {
  if (logPath == null || logPath.trim() === "") return null;
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    return openSync(logPath, "a");
  } catch {
    return null;
  }
}

function closeWorkerLog(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    // A descriptor the host already reclaimed is the outcome we wanted anyway.
  }
}

/** Reject a spec the daemon cannot act on, naming the field rather than the shape. */
export function assertLaunchableSpec(spec: RedskilledWorkerSpec): void {
  const required: Array<[string, unknown]> = [
    ["project_label", spec.project_label],
    ["workspace_path", spec.workspace_path],
    ["command", spec.command],
  ];
  for (const [field, value] of required) {
    if (typeof value !== "string" || value.trim() === "") {
      throw new RedskilledWorkerSpecError(`redskilled worker spec is missing ${field}`);
    }
  }
  if (spec.args != null && !Array.isArray(spec.args)) {
    throw new RedskilledWorkerSpecError("redskilled worker spec args must be an array");
  }
}

/**
 * Refuse a birth no verdict admitted — including the birth nobody judged at all.
 *
 * An absent verdict is treated exactly like a refusal, because the two mean the
 * same thing to the host: nothing proved this Worker fits.
 */
export function assertAdmitted(admission: RedskilledAdmissionVerdict | undefined): void {
  if (admission == null) {
    throw new RedskilledAdmissionError(
      "redskilled refused this Worker: no host admission verdict was handed over, and an unjudged birth is an unbudgeted one",
    );
  }
  if (!admission.admitted) throw new RedskilledAdmissionError(admission.reason, admission);
}

/**
 * Launch one Worker.
 *
 * Failure to spawn throws rather than returning a half-Worker: a caller that
 * could not tell "running" from "never started" would leak the budget.
 */
export function launchWorker(options: LaunchWorkerOptions): LaunchedWorker {
  const { spec, admission } = options;
  assertAdmitted(admission);
  assertLaunchableSpec(spec);

  const env = options.env ?? process.env;
  const clock = options.clock ?? (() => new Date().toISOString());
  const workerId = (spec.worker_id ?? options.workerId ?? randomUUID()).trim() || randomUUID();
  const probes = options.probes ?? detectWorkerPlacementProbes(env);
  // The Worker's own output is the project's log, so the daemon opens the file
  // the client named and hands the descriptor to the process it owns. Failing to
  // open it degrades to a silent Worker rather than a refused launch: a log is
  // evidence, and losing evidence must never cost the work.
  const logFd = options.openLog === false ? null : openWorkerLog(spec.log_path);
  // The daemon hands its own node down instead of hoping the Worker's PATH
  // holds one (#3064). Under a transient unit the Worker's PATH is the init
  // system's canonical `/usr/bin`-shaped one, so on a version-manager host
  // (mise, nvm, asdf, volta) every system tool resolves and node alone goes
  // missing — while the daemon deciding that is itself running on the node it
  // failed to pass on. `process.execPath` is that answer, already held.
  const workerEnv: Record<string, string> = {
    ...(spec.env ?? {}),
    PATH: pathWithEngineNode(spec.env?.PATH ?? env.PATH, options.execPath ?? process.execPath),
  };
  const plan = planWorkerPlacement({
    workerId,
    projectLabel: spec.project_label,
    workspacePath: spec.workspace_path,
    command: spec.command,
    args: spec.args,
    budget: spec.budget,
    ...(options.memoryCeiling != null ? { memoryCeiling: options.memoryCeiling } : {}),
    target: spec.placement,
    env: workerEnv,
    enabled: options.enabled ?? placementEnabled(env),
    probes,
    pipeOutput: logFd !== null,
  });

  const spawnFn = options.spawnFn ?? spawn;
  const child = spawnFn(plan.command, plan.args, {
    // When isolated the unit carries the workspace, so the spawn deliberately
    // does not: a cwd the daemon cannot chdir into would fail a launch the unit
    // would have run fine.
    ...(plan.cwd != null ? { cwd: plan.cwd } : {}),
    detached: true,
    stdio: logFd === null ? "ignore" : ["ignore", logFd, logFd],
    // The Worker's own env goes through `--setenv` under the transient unit;
    // every other backend has to merge it here, or the downgrade would silently
    // change behaviour. The backend decides, not `isolated`: a Job Object is
    // isolated and still spawns through a plain `spawn`, so keying on isolation
    // would drop a Windows Worker's environment — including the placement facts
    // its own death record is written from.
    env: plan.backend === "transient-unit"
      ? { ...env }
      : { ...env, ...workerEnv, ...plan.environment },
  });
  // The child holds its own copy from here on; a descriptor left open in the
  // daemon would keep the file alive for the daemon's lifetime, not the Worker's.
  if (logFd !== null) closeWorkerLog(logFd);

  if (child.pid == null) {
    child.once("error", () => undefined);
    throw new RedskilledWorkerSpecError(`redskilled could not spawn ${JSON.stringify(plan.command)} for worker ${workerId}`);
  }

  // The Windows backend isolates AFTER the spawn, because Node offers no way to
  // start a process already inside a job. The window between the two is bounded
  // by the sampling floor rather than left unenforced — the same floor that
  // covers a host with no native reach at all.
  const placed = plan.job != null ? placeInJobObject(plan, probes, child.pid) : null;

  // Observed, not polled — but never a reason to keep the daemon alive on its
  // own, so the handle is unref'd and the exit is still delivered while we live.
  child.once("error", () => undefined);
  child.once("exit", (code, signal) => {
    // Closing the job is what releases the kernel object; with kill-on-close set
    // it also guarantees nothing of this Worker is left behind.
    try {
      placed?.job?.close();
    } catch {
      // A job the host already tore down is the outcome we wanted anyway.
    }
    options.onExit?.(workerId, code, signal);
  });
  child.unref();

  const isolated = plan.job != null ? placed?.job != null : plan.isolated;
  const warnings = [plan.warning, placed?.warning, plan.budgetWarning].filter(
    (warning): warning is string => warning != null,
  );
  const worker: RedskilledWorkerView = {
    worker_id: workerId,
    project_label: spec.project_label,
    pid: child.pid,
    started_at: clock(),
    workspace_path: spec.workspace_path,
    ...(spec.log_path != null ? { log_path: spec.log_path } : {}),
    isolated,
    ...(plan.unit != null ? { unit: plan.unit } : {}),
    ...(spec.budget != null ? { budget: spec.budget } : {}),
    // Carried for the Worker's whole life, beside the budget and for the same
    // reason: a ceiling stated once at launch is a ceiling no later reader —
    // the sampling floor included — can ask for.
    ...(plan.memoryCeiling != null
      ? {
          memory_ceiling: plan.memoryCeiling,
          memory_ceiling_reason: options.memoryCeiling?.reason
            ?? "this Worker's ceiling is the budget its client declared",
        }
      : {}),
    warnings,
  };
  return { worker, admission, warnings, plan, child, ...(placed?.job != null ? { job: placed.job } : {}) };
}

/**
 * Mint this Worker's Job Object and put the live process inside it.
 *
 * Every failure here degrades to the sampling floor EXPLICITLY and none of them
 * ends the launch: a Worker running under the floor is worse than one running
 * under the kernel, and far better than one that never started because an
 * optional native artifact misbehaved. A job that was minted but could not take
 * the process is closed immediately — an empty job with kill-on-close set is a
 * handle waiting to kill the wrong thing later.
 */
function placeInJobObject(
  plan: WorkerPlacementPlan,
  probes: WorkerPlacementProbes,
  pid: number,
): { readonly job?: RedskilledJobObjectHandle; readonly warning?: string } {
  const job = plan.job;
  if (job == null) return {};
  const floor = "the Worker is charged to the daemon's own resource group and the daemon's RSS sampling floor is the only remaining ceiling";
  if (!probes.jobObjects.available) {
    return { warning: `Job Object placement unavailable: ${probes.jobObjects.reason}. ${floor}` };
  }

  let handle: RedskilledJobObjectHandle;
  try {
    handle = probes.jobObjects.binding.createJobObject({ name: job.name, limits: job.limits });
  } catch (err) {
    return { warning: `Job Object ${JSON.stringify(job.name)} could not be created: ${reason(err)}. ${floor}` };
  }
  try {
    handle.assign(pid);
  } catch (err) {
    try {
      handle.close();
    } catch {
      // Nothing was ever inside it; a close the host refused changes nothing.
    }
    return { warning: `Worker pid ${pid} could not be assigned to Job Object ${JSON.stringify(job.name)}: ${reason(err)}. ${floor}` };
  }
  return { job: handle };
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
