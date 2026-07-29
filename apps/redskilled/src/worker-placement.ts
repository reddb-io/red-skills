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
}

/**
 * Where the client wants the Worker placed.
 *
 * `inherit` is a client saying "charge it to me" out loud. It is a distinct
 * answer from "isolation was unavailable", and both still carry a warning —
 * an unisolated launch is never silent, however it came to be one.
 */
export interface RedskilledPlacementTarget {
  readonly isolation: "transient-unit" | "inherit";
  readonly unit_prefix?: string;
}

/** The resource budget for one Worker. Every field is optional and opaque. */
export interface RedskilledWorkerBudget {
  readonly memory_high?: string;
  readonly memory_max?: string;
  readonly cpu_weight?: number;
}

export interface WorkerPlacementPlan {
  /** True when the Worker runs inside a transient unit of its own. */
  readonly isolated: boolean;
  readonly command: string;
  readonly args: readonly string[];
  /** The working directory for the spawn itself; unset when the unit carries it. */
  readonly cwd?: string;
  /** The transient unit name, only when isolated. */
  readonly unit?: string;
  /**
   * Why isolation was skipped, and what the caller now carries instead. ALWAYS
   * set when `isolated` is false.
   */
  readonly warning?: string;
  /** Set when a budget was declared that this placement cannot enforce. */
  readonly budgetWarning?: string;
}

/**
 * Probe the host for transient-unit support.
 *
 * The systemd `--user` session is proven by its private socket under
 * `XDG_RUNTIME_DIR`, so nothing is spawned on the launch path to find out.
 */
export function detectWorkerPlacementProbes(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): WorkerPlacementProbes {
  if (platform !== "linux") return { platform, systemdRun: null, userSession: false };
  const runtimeDir = (env.XDG_RUNTIME_DIR ?? "").trim();
  const userSession = runtimeDir !== "" && existsSync(join(runtimeDir, "systemd", "private"));
  return { platform, systemdRun: which("systemd-run", env), userSession };
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
  readonly target?: RedskilledPlacementTarget;
  readonly probes: WorkerPlacementProbes;
  /** False when the env kill-switch declined isolation host-wide. */
  readonly enabled?: boolean;
  /** Extra `KEY=VALUE` environment for the Worker. */
  readonly env?: Readonly<Record<string, string>>;
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
  const budget = opts.budget ?? {};
  const declaredBudget = budget.memory_high != null || budget.memory_max != null || budget.cpu_weight != null;
  const target = opts.target ?? { isolation: "transient-unit" as const };

  const unisolated = (warning: string): WorkerPlacementPlan => ({
    isolated: false,
    command: opts.command,
    args,
    cwd: opts.workspacePath,
    warning,
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
  if (budget.memory_high != null) unitArgs.push(`--property=MemoryHigh=${budget.memory_high}`);
  if (budget.memory_max != null) unitArgs.push(`--property=MemoryMax=${budget.memory_max}`);
  if (budget.cpu_weight != null) unitArgs.push(`--property=CPUWeight=${budget.cpu_weight}`);
  for (const [key, value] of Object.entries(opts.env ?? {})) unitArgs.push(`--setenv=${key}=${value}`);

  return {
    isolated: true,
    unit,
    command: opts.probes.systemdRun,
    args: [...unitArgs, "--", opts.command, ...args],
  };
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
