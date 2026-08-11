/**
 * reattach — how a restarted daemon finds the Workers it left running.
 *
 * **A Worker is an init-system unit, not a daemon child.** That is the whole
 * reason a restart costs nothing: the unit's owner is the init system, so the
 * daemon that asked for it can die, be upgraded and come back, and the Worker
 * never notices. What the new daemon has to do is the inverse of birth — take
 * the handle the lane recorded and ask the host whether it still names something
 * alive.
 *
 * **The handle is the unit name, and the pid is only the fallback.** A pid is
 * not an identity: the OS reuses it, so a restarted daemon that re-attached by
 * pid alone would sooner or later adopt a stranger's process and hold a budget
 * for work nobody is doing. A unit name is unique for as long as the unit
 * exists, which is exactly the window re-attachment cares about. Only an
 * unisolated Worker — one that never got a unit, and whose launch said so out
 * loud — falls back to its pid.
 *
 * **The launch client is not the Worker.** Under the transient-unit backend the
 * process the daemon spawns is `systemd-run --wait`, a client standing next to
 * the unit rather than the unit itself; killing it — as the daemon's own cgroup
 * teardown does on a replacement — leaves the Worker running (issue #2917). So
 * the exit of that client is a QUESTION for the host, never an answer: the same
 * unit probe that re-attaches after a restart decides whether a Worker died, and
 * a daemon that skipped it would write a death onto the lane for a live Worker
 * and every successor would then adopt nothing.
 *
 * The probes are injected, so both branches are provable without systemd.
 */
import { spawnSync } from "node:child_process";
import { killTreeAndWait } from "@reddb-io/shared/kill-tree.js";
import { isPidAlive } from "@reddb-io/shared/resident-core.js";
import type { RedskilledWorkerView } from "./host-state.js";
import { DEFAULT_WORKER_UNIT_PREFIX } from "./worker-placement.js";

/** Answers "is this Worker still running?" for one Worker. */
export type RedskilledLivenessProbe = (worker: RedskilledWorkerView) => boolean | Promise<boolean>;

/** Stops one Worker; returns whether the host confirmed its death. */
export type RedskilledStopProbe = (worker: RedskilledWorkerView) => boolean | Promise<boolean>;

/** Injectable host operations for a deterministic unit-teardown proof. */
export interface RedskilledStopWorkerIO {
  readonly stopUnit: (unit: string) => void;
  readonly unitActive: (unit: string) => boolean;
  readonly leaderAlive: (pid: number) => boolean;
  readonly killTree: (pgid: number) => boolean | Promise<boolean>;
}

export interface ReattachOutcome {
  /** Workers the host still confirms; the restarted daemon adopts these. */
  readonly alive: readonly RedskilledWorkerView[];
  /** Workers that died while no daemon was watching; their deaths are recorded. */
  readonly dead: readonly RedskilledWorkerView[];
}

/**
 * Sort a rehydrated Worker set into the ones still running and the ones gone.
 *
 * A probe that throws counts the Worker as dead. The alternative — treating an
 * unanswerable probe as alive — would hold a budget forever on the first
 * transient failure, and a Worker wrongly declared dead is re-observable the
 * moment the host answers again, while a budget wrongly held is not.
 */
export async function reattachWorkers(
  workers: readonly RedskilledWorkerView[],
  probe: RedskilledLivenessProbe,
): Promise<ReattachOutcome> {
  const alive: RedskilledWorkerView[] = [];
  const dead: RedskilledWorkerView[] = [];
  for (const worker of workers) {
    let live = false;
    try {
      live = (await probe(worker)) === true;
    } catch {
      live = false;
    }
    (live ? alive : dead).push(worker);
  }
  return { alive, dead };
}

export interface SweepHeldWorkerLivenessInput {
  readonly workers: readonly RedskilledWorkerView[];
  readonly reattached_worker_ids: ReadonlySet<string>;
  readonly now_ms: number;
  readonly grace_ms: number;
  readonly probe: RedskilledLivenessProbe;
  readonly on_dead: (worker: RedskilledWorkerView) => void | Promise<void>;
}

/**
 * Probe every held Worker old enough to judge, retiring those the host no
 * longer confirms. Reattached Workers have no child handle, so they are always
 * eligible; newborns retain their grace while the init system creates a unit.
 */
export async function sweepHeldWorkerLiveness(
  input: SweepHeldWorkerLivenessInput,
): Promise<readonly RedskilledWorkerView[]> {
  const held = input.workers.filter((worker) => {
    if (input.reattached_worker_ids.has(worker.worker_id)) return true;
    const bornMs = Date.parse(worker.started_at);
    return !Number.isFinite(bornMs) || input.now_ms - bornMs >= input.grace_ms;
  });
  if (held.length === 0) return [];
  const { dead } = await reattachWorkers(held, input.probe);
  for (const worker of dead) await input.on_dead(worker);
  return dead;
}

/**
 * How long a newborn Worker is exempt from the liveness sweep.
 *
 * The sweep asks the init system, and a Worker whose unit is still being created
 * would answer "not active" for reasons that are birth rather than death — so
 * inside this window the child handle is authoritative and the probe is not
 * asked. Past it, silence from the host means the Worker is gone (#3123).
 */
export const REDSKILLED_LIVENESS_GRACE_MS = 30_000;

/** The default probe: the unit when there is one, the pid when there is not. */
export function detectWorkerLiveness(worker: RedskilledWorkerView): boolean {
  if (worker.unit != null && worker.unit !== "") return isUnitActive(worker.unit);
  return isPidAlive(worker.pid);
}

/** True when systemd reports `unit` in a running state for this user session. */
export function isUnitActive(unit: string): boolean {
  const probe = spawnSync("systemctl", ["--user", "is-active", "--quiet", unit], { stdio: "ignore" });
  if (probe.error != null) return false;
  return probe.status === 0;
}

/** Answers "which process is this unit actually running?"; null when unresolvable. */
export type RedskilledUnitPidProbe = (unit: string) => number | null;

/** Answers "which Worker units does this host have active right now?" */
export type RedskilledUnitInventoryProbe = () => readonly string[] | Promise<readonly string[]>;

/** Env kill-switch: `REDSKILLED_UNIT_DISCOVERY=off` leaves the host un-swept. */
export const REDSKILLED_UNIT_DISCOVERY_ENV = "REDSKILLED_UNIT_DISCOVERY";

/**
 * The project label an adopted Worker carries when nobody's lane claims it.
 *
 * A stated placeholder rather than an empty string: a Worker reported under `""`
 * is a Worker an operator reads as a rendering bug, and one reported under a name
 * that says what happened is a Worker they can go and stop.
 */
export const REDSKILLED_UNOWNED_PROJECT_LABEL = "(unowned)";

/**
 * The unit's main process, asked of the init system rather than remembered.
 *
 * The pid the lane carries is the pid of the LAUNCH CLIENT, which under the
 * transient-unit backend outlives nothing: a restart, or the client being killed
 * on its own, leaves the lane naming a pid the OS has already reclaimed. The
 * sampler measures a tree by pid, so a Worker held under a dead pid is a Worker
 * whose memory the host promises to watch and never measures.
 */
export function detectUnitMainPid(unit: string): number | null {
  const probe = spawnSync("systemctl", ["--user", "show", "--property=MainPID", "--value", unit], {
    encoding: "utf8",
  });
  if (probe.error != null || probe.status !== 0) return null;
  const pid = Number.parseInt((probe.stdout ?? "").trim(), 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** True unless the env kill-switch declines the host sweep for this daemon. */
export function unitDiscoveryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const override = (env[REDSKILLED_UNIT_DISCOVERY_ENV] ?? "").trim().toLowerCase();
  if (override === "") return true;
  return !["off", "false", "0", "no"].includes(override);
}

/**
 * Whether THIS daemon may sweep the machine — only its arbiter may.
 *
 * Adopting a Worker is a claim on the host budget, so the daemon holding the
 * machine-wide claim is the one entitled to make it. A daemon pinned to some
 * other claim path is a sandbox, a fixture or an operator's second instance, and
 * one of those adopting the machine's real Workers would take them away from the
 * arbiter that actually accounts for them — the opposite of the fix.
 */
export function maySweepMachine(
  machineClaimPath: string,
  machineClaimPathOfThisHost: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return unitDiscoveryEnabled(env) && machineClaimPath === machineClaimPathOfThisHost;
}

/**
 * Every active Worker unit this user session has, by name.
 *
 * Asked of the init system with a glob rather than derived from anything the
 * daemon remembers — the whole point is to see the Workers no memory of this
 * daemon's accounts for. A host with no systemd answers with nothing, which is
 * the same answer a host with no stray Workers gives.
 */
export function listActiveWorkerUnits(prefix: string = DEFAULT_WORKER_UNIT_PREFIX): readonly string[] {
  const probe = spawnSync(
    "systemctl",
    ["--user", "list-units", "--type=service", "--state=active", "--plain", "--no-legend", "--no-pager", `${prefix}-*.service`],
    { encoding: "utf8" },
  );
  if (probe.error != null || probe.status !== 0) return [];
  return (probe.stdout ?? "")
    .split("\n")
    .map((line) => line.trim().split(/\s+/)[0] ?? "")
    .filter((name) => name.startsWith(`${prefix}-`) && name.endsWith(".service"));
}

export interface DiscoverUnownedWorkersInput {
  /** The units the host confirms active right now. */
  readonly units: readonly string[];
  /** The Workers the daemon already holds — replayed, re-attached or newborn. */
  readonly held: readonly RedskilledWorkerView[];
  /** How a unit's live process is resolved; an unresolvable one is reported as pid 0. */
  readonly mainPid?: RedskilledUnitPidProbe;
  /** The instant the daemon adopted them — its own clock, never the unit's. */
  readonly now: string;
}

/**
 * The Workers this host is running that no daemon accounts for. PURE.
 *
 * A unit with no birth on the lane is the residue of exactly the failure #2917
 * describes: a Worker that survived a daemon nobody re-attached it to. Reporting
 * it is not cosmetic — the arbiter's total is the sum of what it holds, so a live
 * Worker it does not hold is room the next admission believes it has and does not.
 *
 * Its identity comes from the unit name, and the view says so out loud: the
 * project's own Worker id and budget were the dead daemon's to remember, and
 * inventing either would be worse than naming them unknown.
 */
export function discoverUnownedWorkers(input: DiscoverUnownedWorkersInput): RedskilledWorkerView[] {
  const held = new Set(
    input.held.map((worker) => worker.unit).filter((unit): unit is string => unit != null && unit !== ""),
  );
  const seen = new Set<string>();
  const discovered: RedskilledWorkerView[] = [];
  for (const unit of input.units) {
    if (unit === "" || held.has(unit) || seen.has(unit)) continue;
    seen.add(unit);
    discovered.push({
      worker_id: unit.replace(/\.service$/, ""),
      project_label: REDSKILLED_UNOWNED_PROJECT_LABEL,
      pid: input.mainPid?.(unit) ?? 0,
      started_at: input.now,
      workspace_path: "",
      isolated: true,
      unit,
      warnings: [
        `adopted from active unit ${JSON.stringify(unit)}, which has no birth on this host's event lane: ` +
          "its project, its Worker id and its budget belonged to a daemon that is gone, so they are reported as unknown " +
          "rather than guessed — it is counted against the host budget from here on instead of running outside it",
      ],
    });
  }
  return discovered;
}

/**
 * Name the Worker whose owning project the lane no longer carries. PURE.
 *
 * The alternative — adopting it under an empty label — reports the Worker while
 * hiding the one fact an operator acts on, and dropping it puts a live process
 * back outside the budget, which is the whole defect.
 */
export function nameUnownedProject(worker: RedskilledWorkerView): RedskilledWorkerView {
  if (worker.project_label.trim() !== "") return worker;
  return {
    ...worker,
    project_label: REDSKILLED_UNOWNED_PROJECT_LABEL,
    warnings: [
      ...worker.warnings,
      "adopted at start with no owning project on the event lane: the daemon that birthed it recorded no project label, " +
        "so it is held and counted under a stated placeholder rather than dropped",
    ],
  };
}

/**
 * Stop one Worker: the unit by name, or the recorded process group.
 *
 * A successful `systemctl stop` is only a request receipt: death is confirmed by
 * both the unit becoming inactive and its recorded leader disappearing. Anything
 * less escalates through the same TERM→grace→KILL→confirm process-group teardown
 * as an unisolated Worker. Legacy records without `pgid` use the detached leader
 * pid, which is the group id by the launch contract.
 */
export function stopWorker(
  worker: RedskilledWorkerView,
  io: RedskilledStopWorkerIO = DEFAULT_STOP_WORKER_IO,
): boolean | Promise<boolean> {
  if (worker.unit != null && worker.unit !== "") {
    try {
      io.stopUnit(worker.unit);
    } catch {
      // A failed stop request still reaches the process-group escalation below.
    }
    if (!io.unitActive(worker.unit) && !io.leaderAlive(worker.pid)) return true;
  }
  return io.killTree(worker.pgid ?? worker.pid);
}

const DEFAULT_STOP_WORKER_IO: RedskilledStopWorkerIO = {
  stopUnit: (unit) => {
    spawnSync("systemctl", ["--user", "stop", unit], { stdio: "ignore" });
  },
  unitActive: isUnitActive,
  leaderAlive: isPidAlive,
  killTree: killTreeAndWait,
};
