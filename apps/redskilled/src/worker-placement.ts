/**
 * worker-placement — where a Worker's resources are charged, decided at launch.
 *
 * **A transient service unit, never a scope.** A scope runs inside the caller's
 * own unit and cannot outlive it, so every Worker would die with the daemon that
 * asked for it — and ADR 0130 rule 5 needs the opposite: units owned by the init
 * system, so the daemon can restart and re-attach by unit name instead of taking
 * every project's work down on an upgrade.
 *
 * **Placement is decided at launch, not adjusted afterwards**, because moving a
 * running process between resource groups does not move its existing memory
 * charge. A Worker born in the caller's group stays charged there for its whole
 * life no matter what is done to it later.
 *
 * The shape follows `fleet-scope` (#2697): this module is PURE planning over
 * injected probes, and the one impure read of the host lives in
 * {@link detectWorkerPlacementProbes}. That is what lets the Linux-with-session
 * and Linux-without-session cases be proven without spawning anything.
 */
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { workerScopeEnvironment } from "@reddb-io/shared/worker-scope.js";
import {
  jobObjectsUnavailable,
  loadJobObjectBinding,
  planJobLimits,
  type RedskilledJobLimits,
  type RedskilledJobObjectReach,
} from "./job-object.js";
import {
  describePosixPlacement,
  planPosixLimits,
  posixLimitsShellArgv,
  posixLimitsUnavailable,
  unenforcedPosixBudgetFields,
  type RedskilledPosixLimits,
  type RedskilledPosixReach,
} from "./posix-limits.js";

/** Env kill-switch: `REDSKILLED_PLACEMENT=off` launches unisolated — loudly. */
export const REDSKILLED_PLACEMENT_ENV = "REDSKILLED_PLACEMENT";

/** The unit-name prefix when a client states none. */
export const DEFAULT_WORKER_UNIT_PREFIX = "red-worker";

export interface WorkerPlacementProbes {
  /** `process.platform` — transient units are a Linux backend. */
  readonly platform: NodeJS.Platform;
  /** `systemd-run` on PATH, or null when the binary is absent. */
  readonly systemdRun: string | null;
  /** True when a systemd `--user` session is reachable. */
  readonly userSession: boolean;
  /**
   * Whether Job Objects are reachable here, and when they are not, why.
   *
   * A reason rather than a flag: the Windows backend degrades to the sampling
   * floor *explicitly*, and a warning that could only say "unavailable" would be
   * the silent downgrade this field exists to prevent.
   */
  readonly jobObjects: RedskilledJobObjectReach;
  /**
   * Whether POSIX rlimits and priority are reachable here, and when not, why.
   *
   * The macOS arm of the same shape `jobObjects` has, for the same reason: this
   * backend is the one that adds real teeth without adding a memory ceiling, so
   * a host that cannot even reach it must degrade with a sentence rather than a
   * flag.
   */
  readonly posix: RedskilledPosixReach;
}

/** The POSIX shell a macOS launch wraps itself in. Present on every Unix host. */
export const POSIX_SHELL_PATH = "/bin/sh";

/**
 * Where the client wants the Worker placed.
 *
 * `inherit` is a client saying "charge it to me" out loud. It is a distinct
 * answer from "isolation was unavailable", and both still carry a warning —
 * an unisolated launch is never silent, however it came to be one.
 */
export interface RedskilledPlacementTarget {
  /**
   * `transient-unit` and `job-object` both mean "isolate this Worker"; they name
   * the backend a client EXPECTS, never one the daemon can be argued into. The
   * host decides which backend exists, so a client asking for a transient unit
   * on Windows gets a Job Object rather than a refusal — the answer to "isolate
   * me" must not depend on the client guessing the platform right.
   */
  readonly isolation: "transient-unit" | "job-object" | "posix-limits" | "inherit";
  readonly unit_prefix?: string;
}

/** The resource budget for one Worker. Every field is optional and opaque. */
export interface RedskilledWorkerBudget {
  readonly memory_high?: string;
  readonly memory_max?: string;
  readonly cpu_weight?: number;
  /**
   * `RLIMIT_NPROC`, honoured by the macOS backend and named as unenforced by the
   * others — a declared limit that quietly did nothing is the failure every
   * warning in this module exists to prevent.
   */
  readonly max_processes?: number;
  /** `RLIMIT_CPU` in seconds, on the same terms as {@link max_processes}. */
  readonly cpu_seconds?: number;
}

/**
 * Which backend a plan resolved to.
 *
 * `none` is a first-class answer, not an absent one: an unisolated launch is a
 * decision the host made, and it is read alongside its warning.
 */
export type WorkerPlacementBackend = "transient-unit" | "job-object" | "posix-limits" | "none";

/** The Job Object a Windows plan asks for. The handle itself is minted at launch. */
export interface WorkerJobObjectPlan {
  readonly name: string;
  readonly limits: RedskilledJobLimits;
}

export interface WorkerPlacementPlan {
  /**
   * True when the Worker runs inside a resource group of its own.
   *
   * `posix-limits` is deliberately NOT isolated: macOS has no resource group to
   * put a Worker in, so its memory charge lands on the daemon exactly as an
   * unisolated launch's does — and the host-wide accounting must keep counting it
   * that way, however many rlimits the launch also carries.
   */
  readonly isolated: boolean;
  /** The backend that placed it, or `none`. Always set. */
  readonly backend: WorkerPlacementBackend;
  readonly command: string;
  readonly args: readonly string[];
  /** The working directory for the spawn itself; unset when the unit carries it. */
  readonly cwd?: string;
  /** The transient unit name, only under the `transient-unit` backend. */
  readonly unit?: string;
  /** The Job Object to mint and assign this Worker to, only under `job-object`. */
  readonly job?: WorkerJobObjectPlan;
  /** The rlimits and priority the launch applies to itself, only under `posix-limits`. */
  readonly posix?: RedskilledPosixLimits;
  /**
   * Why isolation was skipped, and what the caller now carries instead. ALWAYS
   * set when `isolated` is false.
   */
  readonly warning?: string;
  /** Set when a budget was declared that this placement cannot enforce. */
  readonly budgetWarning?: string;
  /**
   * The memory ceiling this placement actually applies, in the host's notation.
   *
   * Stated even when the placement could not enforce it itself: the sampling
   * floor holds the same number one layer down, and a reader that had to tell
   * "no ceiling" from "a ceiling the kernel is not holding" by which backend ran
   * would be re-deriving a fact the plan already knows.
   */
  readonly memoryCeiling?: string;
  /**
   * What the Worker is told about its own placement — the scope, its ceiling and
   * the degradation when there is no scope (`@reddb-io/shared/worker-scope`).
   *
   * It rides on the plan rather than being assembled at spawn because only the
   * plan knows the unit's name and which backend really ran; a Worker that could
   * not name what contained it writes a death record nothing can attribute.
   */
  readonly environment: Readonly<Record<string, string>>;
}

/**
 * Probe the host for the backend it can actually offer.
 *
 * The systemd `--user` session is proven by its private socket under
 * `XDG_RUNTIME_DIR`, so nothing is spawned on the launch path to find out; the
 * Windows arm loads the N-API addon, which is the only way to know whether the
 * native reach this host was shipped with is really there.
 */
export function detectWorkerPlacementProbes(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): WorkerPlacementProbes {
  const noPosix = posixLimitsUnavailable(
    `POSIX rlimit and priority placement is the macOS backend (platform=${platform})`,
  );
  if (platform === "win32") {
    return {
      platform,
      systemdRun: null,
      userSession: false,
      jobObjects: loadJobObjectBinding({ platform }),
      posix: noPosix,
    };
  }
  const noJobObjects = jobObjectsUnavailable(
    `Job Object placement is the Windows backend (platform=${platform}), so there is no native reach to load here`,
  );
  if (platform === "darwin") {
    return { platform, systemdRun: null, userSession: false, jobObjects: noJobObjects, posix: detectPosixReach(env) };
  }
  if (platform !== "linux") {
    return { platform, systemdRun: null, userSession: false, jobObjects: noJobObjects, posix: noPosix };
  }
  const runtimeDir = (env.XDG_RUNTIME_DIR ?? "").trim();
  const userSession = runtimeDir !== "" && existsSync(join(runtimeDir, "systemd", "private"));
  return {
    platform,
    systemdRun: which("systemd-run", env),
    userSession,
    jobObjects: noJobObjects,
    posix: noPosix,
  };
}

/**
 * Whether this host can wrap a launch in `sh` and, separately, in `nice`.
 *
 * The shell is checked on disk rather than looked up on PATH, because it is the
 * process the daemon is about to exec by absolute path — a `sh` that exists only
 * on a PATH the Worker will not inherit is not the one that would run.
 */
function detectPosixReach(env: NodeJS.ProcessEnv): RedskilledPosixReach {
  if (!existsSync(POSIX_SHELL_PATH)) {
    return posixLimitsUnavailable(
      `no POSIX shell was found at ${POSIX_SHELL_PATH}, so there is nothing to apply rlimits or priority in`,
    );
  }
  return { available: true, shell: POSIX_SHELL_PATH, nice: which("nice", env) };
}

/** True unless the env kill-switch declines isolation for this host. */
export function placementEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const override = (env[REDSKILLED_PLACEMENT_ENV] ?? "").trim().toLowerCase();
  if (override === "") return true;
  return !["off", "false", "0", "no"].includes(override);
}

/**
 * The transient unit name: `<prefix>-<project>-<worker>.service`.
 *
 * Both identifiers are opaque labels the client chose, so they are slugified
 * rather than parsed — the daemon never learns what a project label means.
 */
/**
 * The Job Object name: `<prefix>-<project>-<worker>`.
 *
 * The same slugified pair as the unit name, without the `.service` suffix — a
 * Job Object is not a unit and naming it like one would invite a reader to look
 * for it in `systemctl`.
 */
export function workerJobObjectName(
  projectLabel: string,
  workerId: string,
  prefix: string = DEFAULT_WORKER_UNIT_PREFIX,
): string {
  return workerUnitName(projectLabel, workerId, prefix).replace(/\.service$/, "");
}

export function workerUnitName(
  projectLabel: string,
  workerId: string,
  prefix: string = DEFAULT_WORKER_UNIT_PREFIX,
): string {
  const head = slug(prefix, "red-worker", 24);
  return `${head}-${slug(projectLabel, "project", 32)}-${slug(workerId, "worker", 32)}.service`;
}

export interface PlanWorkerPlacementOptions {
  readonly workerId: string;
  readonly projectLabel: string;
  /** The workspace path, used verbatim — the daemon derives nothing from it. */
  readonly workspacePath: string;
  readonly command: string;
  readonly args?: readonly string[];
  readonly budget?: RedskilledWorkerBudget;
  /**
   * The ceiling the HOST derived for this Worker when the client declared none
   * (`deriveWorkerScopeCeiling`), with the sentence saying where it came from.
   *
   * Structural rather than imported from `admission`, so the accounting decides
   * the number and the placement only carries it.
   */
  readonly memoryCeiling?: { readonly memory_max: string | null; readonly reason: string };
  readonly target?: RedskilledPlacementTarget;
  readonly probes: WorkerPlacementProbes;
  /** False when the env kill-switch declined isolation host-wide. */
  readonly enabled?: boolean;
  /** Extra `KEY=VALUE` environment for the Worker. */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * True when the caller gave a log path, so the Worker's own output must reach
   * the launcher's file descriptors rather than the init system's journal.
   *
   * It is a placement input rather than a launch detail because only the plan
   * knows whether an init system sits between the daemon and the Worker: a
   * transient unit detaches stdio by default, so the same fds that work for an
   * unisolated spawn silently capture nothing under isolation. A project that
   * lost its Worker's log would lose the only record naming which Workers ran
   * before a circuit trip.
   */
  readonly pipeOutput?: boolean;
}

/**
 * Plan the launch argv.
 *
 * When the host affords it, the Worker runs under a transient
 * `<prefix>-<project>-<worker>.service` carrying the budget as unit properties.
 * Otherwise the original argv is returned unchanged WITH a warning — the launch
 * still happens, but a downgrade is never silent.
 */
export function planWorkerPlacement(opts: PlanWorkerPlacementOptions): WorkerPlacementPlan {
  const args = [...(opts.args ?? [])];
  // The ceiling the host derived stands in for a `MemoryMax` the client did not
  // declare, so every Worker is born under a stated ceiling rather than under
  // whichever bystander the machine's memory pressure decides to shoot (#3029).
  // A declared budget is never narrowed: `deriveWorkerScopeCeiling` already
  // returns what the client asked for when it asked for anything.
  const budget: RedskilledWorkerBudget = {
    ...(opts.budget ?? {}),
    ...(opts.budget?.memory_max == null && opts.memoryCeiling?.memory_max != null
      ? { memory_max: opts.memoryCeiling.memory_max }
      : {}),
  };
  const ceilingValue = budget.memory_max ?? budget.memory_high ?? null;
  const declaredBudget = budget.memory_high != null || budget.memory_max != null || budget.cpu_weight != null;
  const target = opts.target ?? { isolation: "transient-unit" as const };

  const unisolated = (warning: string): WorkerPlacementPlan => ({
    isolated: false,
    backend: "none",
    command: opts.command,
    args,
    cwd: opts.workspacePath,
    warning,
    ...(ceilingValue != null ? { memoryCeiling: ceilingValue } : {}),
    // The Worker still learns its ceiling here, and learns WHY it has no scope:
    // an unscoped death that named neither would be the silent degradation this
    // whole module refuses.
    environment: workerScopeEnvironment({
      scope: null,
      memory_ceiling: ceilingValue,
      scope_degradation: warning,
    }),
    ...(declaredBudget
      ? { budgetWarning: "a budget was declared but this placement cannot enforce it: the daemon's RSS sampling is the only remaining floor" }
      : {}),
  });

  if (target.isolation === "inherit") {
    return unisolated("placement target is `inherit`: the Worker is charged to the daemon's own resource group, so a memory-pressure kill can land on the daemon and every Worker it holds");
  }
  if (opts.enabled === false) {
    return unisolated(`worker isolation disabled by ${REDSKILLED_PLACEMENT_ENV}: the Worker is charged to the daemon's own resource group`);
  }
  if (opts.probes.platform === "win32") {
    return planJobObjectPlacement(opts, args, budget, ceilingValue, declaredBudget, unisolated);
  }
  if (opts.probes.platform === "darwin") return planPosixLimitsPlacement(opts, args, budget, ceilingValue, unisolated);
  if (opts.probes.platform !== "linux") {
    return unisolated(`transient-unit placement is the Linux backend (platform=${opts.probes.platform}): the Worker is charged to the daemon's own resource group`);
  }
  if (!opts.probes.systemdRun) {
    return unisolated("transient-unit placement unavailable: systemd-run is not on PATH; the Worker is charged to the daemon's own resource group and a memory-pressure kill will hit the whole session");
  }
  if (!opts.probes.userSession) {
    return unisolated("transient-unit placement unavailable: no systemd --user session; the Worker is charged to the daemon's own resource group and a memory-pressure kill will hit the whole session");
  }

  const unit = workerUnitName(opts.projectLabel, opts.workerId, target.unit_prefix);
  // `--wait` keeps this process alive for the unit's lifetime so its death is
  // observed rather than polled; the unit itself stays owned by the init system,
  // which is what lets a restarted daemon re-attach by name.
  const unitArgs = [
    "--user",
    "--collect",
    "--quiet",
    "--wait",
    `--unit=${unit}`,
    `--working-directory=${opts.workspacePath}`,
  ];
  // `--pipe` connects the unit's stdio to this process's, which is what makes an
  // inherited log fd reach the Worker at all. Without it a transient unit writes
  // to the journal and the caller's log file stays empty — a downgrade nothing
  // would report, because the launch itself succeeds.
  if (opts.pipeOutput === true) unitArgs.push("--pipe");
  if (budget.memory_high != null) unitArgs.push(`--property=MemoryHigh=${budget.memory_high}`);
  if (budget.memory_max != null) unitArgs.push(`--property=MemoryMax=${budget.memory_max}`);
  if (budget.cpu_weight != null) unitArgs.push(`--property=CPUWeight=${budget.cpu_weight}`);
  // The Worker's own placement joins its environment, so the process that dies
  // inside this unit can name the unit that held it and the ceiling it carried.
  const environment = workerScopeEnvironment({
    scope: unit,
    memory_ceiling: ceilingValue,
    scope_degradation: null,
  });
  for (const [key, value] of Object.entries({ ...(opts.env ?? {}), ...environment })) {
    unitArgs.push(`--setenv=${key}=${value}`);
  }

  const unenforced = unenforcedPosixBudgetFields(opts.budget);
  return {
    isolated: true,
    backend: "transient-unit",
    unit,
    command: opts.probes.systemdRun,
    args: [...unitArgs, "--", opts.command, ...args],
    ...(ceilingValue != null ? { memoryCeiling: ceilingValue } : {}),
    environment,
    ...(unenforced != null ? { budgetWarning: unenforced } : {}),
  };
}

/**
 * The macOS arm: rlimits and priority, with the floor left as the memory ceiling.
 *
 * Unlike both other backends this one returns `isolated: false` while still
 * having done real work. That is the honesty the platform forces: the limits are
 * genuine and the resource group does not exist, so the launch is a placement
 * and an unisolated charge at the same time — and the accounting that decides
 * how much of the machine is spoken for must read the second fact, not the first.
 *
 * With no shell to wrap the launch in, nothing is applied and the plan degrades
 * to the plain argv with the same sentence any unisolated launch carries.
 */
function planPosixLimitsPlacement(
  opts: PlanWorkerPlacementOptions,
  args: readonly string[],
  effectiveBudget: RedskilledWorkerBudget,
  ceilingValue: string | null,
  unisolated: (warning: string) => WorkerPlacementPlan,
): WorkerPlacementPlan {
  const reach = opts.probes.posix;
  if (!reach.available) {
    return unisolated(
      `POSIX limit placement unavailable: ${reach.reason}. The Worker is charged to the daemon's own resource group ` +
        "and the daemon's RSS sampling floor is the only remaining ceiling",
    );
  }

  const limits = planPosixLimits(effectiveBudget, { canRenice: reach.nice != null });
  const declaredMemory = effectiveBudget.memory_high != null || effectiveBudget.memory_max != null;
  const warning = describePosixPlacement(limits);
  return {
    isolated: false,
    backend: "posix-limits",
    command: reach.shell,
    args: posixLimitsShellArgv({ limits, nice: reach.nice, command: opts.command, args }),
    cwd: opts.workspacePath,
    posix: limits,
    warning,
    ...(ceilingValue != null ? { memoryCeiling: ceilingValue } : {}),
    // No scope: macOS has no resource group to name, so the Worker is told its
    // ceiling and told, in the same breath, that nothing but the floor holds it.
    environment: workerScopeEnvironment({
      scope: null,
      memory_ceiling: ceilingValue,
      scope_degradation: warning,
    }),
    // Named for the same reason the Windows note is: the budget still holds, it
    // just holds one layer down, and nobody should have to discover that from
    // the absence of a limit.
    ...(declaredMemory
      ? {
          budgetWarning:
            `the declared memory budget is enforced by the daemon's RSS sampling floor rather than by the kernel: ` +
            limits.memory_ceiling_reason,
        }
      : {}),
  };
}

/**
 * The Windows arm: a Job Object carrying the budget, with kill-on-close.
 *
 * Unlike the Linux backend, the argv is UNCHANGED — Windows has no launcher to
 * wrap the command in, so the Worker is spawned normally and assigned to its job
 * at birth. That is why the plan carries the job as data rather than as
 * arguments, and why `cwd` stays the daemon's job here: there is no unit to hand
 * the workspace to.
 *
 * With native reach missing the Worker still launches, and the plan says the
 * sampling floor is now the only ceiling. That degradation is the whole reason
 * the floor is uniform across backends (ADR 0130 rule 4).
 */
function planJobObjectPlacement(
  opts: PlanWorkerPlacementOptions,
  args: readonly string[],
  effectiveBudget: RedskilledWorkerBudget,
  ceilingValue: string | null,
  declaredBudget: boolean,
  unisolated: (warning: string) => WorkerPlacementPlan,
): WorkerPlacementPlan {
  const reach = opts.probes.jobObjects;
  if (!reach.available) {
    return unisolated(
      `Job Object placement unavailable: ${reach.reason}. The Worker is charged to the daemon's own resource group ` +
        "and the daemon's RSS sampling floor is the only remaining ceiling",
    );
  }
  const limits = planJobLimits(effectiveBudget);
  const name = workerJobObjectName(opts.projectLabel, opts.workerId, opts.target?.unit_prefix);
  return {
    isolated: true,
    backend: "job-object",
    command: opts.command,
    args: [...args],
    cwd: opts.workspacePath,
    job: { name, limits },
    ...(ceilingValue != null ? { memoryCeiling: ceilingValue } : {}),
    // The job IS the scope on Windows, so the Worker names it exactly as a Linux
    // Worker names its unit — one vocabulary, whichever kernel drew the wall.
    environment: workerScopeEnvironment({
      scope: name,
      memory_ceiling: ceilingValue,
      scope_degradation: null,
    }),
    // A budget the job could not carry is named here for the same reason an
    // unisolated launch is: the floor still holds it, and nobody should have to
    // discover that from the absence of a limit.
    ...(budgetWarningFor(declaredBudget && limits.note != null
      ? `${limits.note}; the daemon's RSS sampling floor is the ceiling for that budget`
      : null, unenforcedPosixBudgetFields(opts.budget))),
  };
}

/** Join what a placement could not carry into one warning, or into none. PURE. */
function budgetWarningFor(...notes: ReadonlyArray<string | null>): { budgetWarning?: string } {
  const said = notes.filter((note): note is string => note != null && note !== "");
  return said.length > 0 ? { budgetWarning: said.join("; ") } : {};
}

function which(binary: string, env: NodeJS.ProcessEnv): string | null {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, binary);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function slug(value: string, fallback: string, max: number): string {
  const cleaned = (value || "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
  return cleaned || fallback;
}
