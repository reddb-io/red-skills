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
import type { RedskilledAdmissionVerdict } from "./admission.js";
import type { RedskilledWorkerView } from "./host-state.js";
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
}

export interface LaunchWorkerOptions {
  readonly spec: RedskilledWorkerSpec;
  /** The host-wide verdict admitting this birth. Required: no verdict, no Worker. */
  readonly admission: RedskilledAdmissionVerdict;
  readonly probes?: WorkerPlacementProbes;
  readonly enabled?: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly clock?: () => string;
  readonly workerId?: string;
  readonly spawnFn?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
  /** Called when the daemon observes this Worker's process end. */
  readonly onExit?: (workerId: string, code: number | null, signal: NodeJS.Signals | null) => void;
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
  const plan = planWorkerPlacement({
    workerId,
    projectLabel: spec.project_label,
    workspacePath: spec.workspace_path,
    command: spec.command,
    args: spec.args,
    budget: spec.budget,
    target: spec.placement,
    env: spec.env,
    enabled: options.enabled ?? placementEnabled(env),
    probes: options.probes ?? detectWorkerPlacementProbes(env),
  });

  const spawnFn = options.spawnFn ?? spawn;
  const child = spawnFn(plan.command, plan.args, {
    // When isolated the unit carries the workspace, so the spawn deliberately
    // does not: a cwd the daemon cannot chdir into would fail a launch the unit
    // would have run fine.
    ...(plan.cwd != null ? { cwd: plan.cwd } : {}),
    detached: true,
    stdio: "ignore",
    // The Worker's own env goes through `--setenv` when isolated; unisolated it
    // has to be merged here, or the downgrade would silently change behaviour.
    env: plan.isolated ? { ...env } : { ...env, ...(spec.env ?? {}) },
  });

  if (child.pid == null) {
    child.once("error", () => undefined);
    throw new RedskilledWorkerSpecError(`redskilled could not spawn ${JSON.stringify(plan.command)} for worker ${workerId}`);
  }

  // Observed, not polled — but never a reason to keep the daemon alive on its
  // own, so the handle is unref'd and the exit is still delivered while we live.
  child.once("error", () => undefined);
  if (options.onExit) child.once("exit", (code, signal) => options.onExit?.(workerId, code, signal));
  child.unref();

  const warnings = [plan.warning, plan.budgetWarning].filter((warning): warning is string => warning != null);
  const worker: RedskilledWorkerView = {
    worker_id: workerId,
    project_label: spec.project_label,
    pid: child.pid,
    started_at: clock(),
    workspace_path: spec.workspace_path,
    isolated: plan.isolated,
    ...(plan.unit != null ? { unit: plan.unit } : {}),
    ...(spec.budget != null ? { budget: spec.budget } : {}),
    warnings,
  };
  return { worker, admission, warnings, plan, child };
}
