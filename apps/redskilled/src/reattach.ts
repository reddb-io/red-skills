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
import { spawn, spawnSync } from "node:child_process";
import { constants as osConstants } from "node:os";
import { killTreeAndWait } from "@reddb-io/shared/kill-tree.js";
import { isPidAlive } from "@reddb-io/shared/resident-core.js";
import type { RedskilledWorkerView } from "./host-state.js";
import { DEFAULT_WORKER_UNIT_PREFIX } from "./worker-placement.js";

export interface RedskilledContainerPlacementHandle {
  readonly engine: "docker" | "podman";
  readonly name: string;
}

/** Decode the durable lifecycle handle shared by Docker and Podman. */
export function parseContainerPlacementHandle(value: string | null | undefined): RedskilledContainerPlacementHandle | null {
  const match = value?.match(/^(docker|podman):\/\/([a-z0-9][a-z0-9_.-]*)$/);
  return match == null ? null : { engine: match[1] as "docker" | "podman", name: match[2]! };
}

/** Answers "is this Worker still running?" for one Worker. */
export type RedskilledLivenessProbe = (worker: RedskilledWorkerView) => boolean | Promise<boolean>;

/** The exit receipt systemd retains for a transient Worker unit. */
export interface RedskilledUnitExitFacts {
  readonly systemd_result: string | null;
  readonly exit_code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly memory_peak_bytes: number | null;
  readonly memory_swap_peak_bytes: number | null;
  readonly journal_tail: string | null;
}

/** Reads the exit receipt for a unit that the host no longer reports active. */
export type RedskilledUnitExitFactsProbe = (
  unit: string,
) => RedskilledUnitExitFacts | null | Promise<RedskilledUnitExitFacts | null>;

/** Stops one Worker; returns whether the host confirmed its death. */
export type RedskilledStopProbe = (worker: RedskilledWorkerView) => boolean | Promise<boolean>;

/** Injectable host operations for a deterministic unit-teardown proof. */
export interface RedskilledStopWorkerIO {
  /** Places the stop request; awaited, so a blocking implementation is refusable by type. */
  readonly stopUnit: (unit: string) => void | Promise<void>;
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
  const container = parseContainerPlacementHandle(worker.unit);
  if (container != null) return isContainerActive(container);
  if (worker.unit != null && worker.unit !== "") return isUnitActive(worker.unit);
  return isPidAlive(worker.pid);
}

/** Ask the selected engine whether the named container is still running. */
export function isContainerActive(handle: RedskilledContainerPlacementHandle): boolean {
  const probe = spawnSync(handle.engine, ["inspect", "--format={{.State.Running}}", handle.name], { encoding: "utf8" });
  return probe.error == null && probe.status === 0 && (probe.stdout ?? "").trim() === "true";
}

/** True when systemd reports `unit` in a running state for this user session. */
export function isUnitActive(unit: string): boolean {
  const probe = spawnSync("systemctl", ["--user", "is-active", "--quiet", unit], { stdio: "ignore" });
  if (probe.error != null) return false;
  return probe.status === 0;
}

/**
 * Ask systemd for the unit's own exit, never the `systemd-run --wait` client's.
 *
 * `ExecMainCode=1` is CLD_EXITED and makes `ExecMainStatus` an exit status;
 * CLD_KILLED/CLD_DUMPED make it a signal number. Missing or collected units
 * answer `null` rather than turning the launch client's generic 255 into fact.
 */
export function detectUnitExitFacts(unit: string): RedskilledUnitExitFacts | null {
  const show = spawnSync(
    "systemctl",
    [
      "--user",
      "show",
      "--no-pager",
      "--property=Result",
      "--property=ExecMainCode",
      "--property=ExecMainStatus",
      "--property=MemoryPeak",
      "--property=MemorySwapPeak",
      unit,
    ],
    { encoding: "utf8" },
  );
  const journal = spawnSync(
    "journalctl",
    ["--user", `--user-unit=${unit}`, "--no-pager", "--output=cat", "--lines=20"],
    { encoding: "utf8" },
  );
  const showReadable = show.error == null && show.status === 0;
  const journalReadable = journal.error == null && journal.status === 0;
  if (!showReadable && !journalReadable) return null;
  return parseUnitExitFacts(
    showReadable ? show.stdout ?? "" : "",
    journalReadable ? (journal.stdout ?? "").trim() : "",
  );
}

/** Decode `systemctl show`'s stable `Property=value` surface. PURE. */
export function parseUnitExitFacts(stdout: string, journalTail = ""): RedskilledUnitExitFacts {
  const properties = new Map(
    stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.includes("="))
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)] as const;
      }),
  );
  const mainCode = parseSystemdNumber(properties.get("ExecMainCode"));
  const mainStatus = parseSystemdNumber(properties.get("ExecMainStatus"));
  const journalExit = journalTail.match(/Main process exited, code=(exited|killed|dumped), status=(\d+)(?:\/[A-Z0-9]+)?/);
  const journalStatus = parseSystemdNumber(journalExit?.[2]);
  const journalResult = journalTail.match(/Failed with result ['"]([^'"]+)['"]/i)?.[1] ?? null;
  const memoryPeak = journalTail.match(/([\d.]+)\s*([KMGTPE]?)\s*(?:i?B)?\s+memory peak/i);
  const swapPeak = journalTail.match(/([\d.]+)\s*([KMGTPE]?)\s*(?:i?B)?\s+memory swap peak/i);
  return {
    systemd_result: nonempty(properties.get("Result")) ?? journalResult,
    exit_code: mainCode === 1
      ? mainStatus
      : journalExit?.[1] === "exited" ? journalStatus : null,
    signal: mainCode === 2 || mainCode === 3
      ? signalName(mainStatus)
      : journalExit?.[1] === "killed" || journalExit?.[1] === "dumped" ? signalName(journalStatus) : null,
    memory_peak_bytes: parseSystemdNumber(properties.get("MemoryPeak")) ?? parseJournalBytes(memoryPeak),
    memory_swap_peak_bytes: parseSystemdNumber(properties.get("MemorySwapPeak")) ?? parseJournalBytes(swapPeak),
    journal_tail: nonempty(journalTail),
  };
}

function nonempty(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed == null || trimmed === "" ? null : trimmed;
}

function parseSystemdNumber(value: string | undefined): number | null {
  if (value == null || !/^\d+$/.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function parseJournalBytes(match: RegExpMatchArray | null): number | null {
  if (match == null) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value < 0) return null;
  const power = "KMGTPE".indexOf((match[2] ?? "").toUpperCase()) + 1;
  const bytes = value * (power === 0 ? 1 : 1024 ** power);
  return Number.isSafeInteger(bytes) ? bytes : null;
}

function signalName(number: number | null): NodeJS.Signals | null {
  if (number == null) return null;
  const match = Object.entries(osConstants.signals).find(([, value]) => value === number)?.[0];
  return match?.startsWith("SIG") ? match as NodeJS.Signals : null;
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
  const container = parseContainerPlacementHandle(unit);
  if (container != null) {
    const probe = spawnSync(container.engine, ["inspect", "--format={{.State.Pid}}", container.name], {
      encoding: "utf8",
    });
    if (probe.error != null || probe.status !== 0) return null;
    const pid = Number.parseInt((probe.stdout ?? "").trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  }
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
 * How long the daemon lets a stopping Worker leave on its own terms.
 *
 * `killTreeAndWait`'s own default grace is 2s, which is a teardown budget and
 * not a shutdown budget: a runner asked to stop mid-turn has a transcript and a
 * lock file to flush. Five seconds is long enough for that and short enough that
 * a stop is still an operation an operator waits through, rather than the
 * ninety-second `TimeoutStopSec` escalation the init system would otherwise be
 * the only thing ending.
 */
const REDSKILLED_UNIT_STOP_GRACE_TRIES = 50;

/**
 * Stop one Worker: the unit by name, or the recorded process group.
 *
 * A successful `systemctl stop` is only a request receipt: death is confirmed by
 * both the unit becoming inactive and its recorded leader disappearing. Anything
 * less escalates through the same TERM→grace→KILL→confirm process-group teardown
 * as an unisolated Worker. Legacy records without `pgid` use the detached leader
 * pid, which is the group id by the launch contract.
 *
 * **The stop request is asked for, never waited on.** `systemctl --user stop`
 * without `--no-block` does not return until the job finishes, and a job whose
 * runner ignores SIGTERM does not finish until `TimeoutStopSec` escalates —
 * ninety seconds by default. Spent inside the daemon that is the whole machine's
 * only socket, that wait is the outage: the request is placed and the daemon
 * then confirms the death itself, on its own grace, through the escalation it
 * already owned. What replaced the init system's timeout is this function's, and
 * it is measured in seconds.
 */
export async function stopWorker(
  worker: RedskilledWorkerView,
  io: RedskilledStopWorkerIO = DEFAULT_STOP_WORKER_IO,
): Promise<boolean> {
  const container = parseContainerPlacementHandle(worker.unit);
  if (container != null) {
    try {
      await stopContainer(container);
    } catch {
      // The process-group fallback below remains the last line of authority.
    }
    if (!isContainerActive(container)) return true;
    return await io.killTree(worker.pgid ?? worker.pid);
  }
  if (worker.unit != null && worker.unit !== "") {
    try {
      await io.stopUnit(worker.unit);
    } catch {
      // A failed stop request still reaches the process-group escalation below.
    }
    if (!io.unitActive(worker.unit) && !io.leaderAlive(worker.pid)) return true;
  }
  return await io.killTree(worker.pgid ?? worker.pid);
}

/** Place one bounded engine stop request without transferring lifecycle ownership. */
export async function stopContainer(handle: RedskilledContainerPlacementHandle): Promise<void> {
  await new Promise<void>((resolve) => {
    const request = spawn(handle.engine, ["stop", "--time=10", handle.name], { stdio: "ignore" });
    request.once("error", () => resolve());
    request.once("close", () => resolve());
  });
}

/**
 * The stop request, as argv — and `--no-block` is the whole of the fix.
 *
 * Without it `systemctl stop` returns when the JOB finishes, which for a runner
 * that ignores SIGTERM is `TimeoutStopSec` later. Named here rather than written
 * inline so the flag is pinnable: it is the difference between a stop and an
 * outage, and nothing else in the argv carries any weight.
 */
export function redskilledUnitStopArgv(unit: string): readonly string[] {
  return ["--user", "stop", "--no-block", unit];
}

const DEFAULT_STOP_WORKER_IO: RedskilledStopWorkerIO = {
  // `spawn` rather than `spawnSync` so that even placing the request cannot hold
  // the event loop. Neither the exit code nor the output is read: a refused stop
  // is indistinguishable here from one the init system accepted and could not
  // finish, and the only thing that settles either is the liveness escalation
  // the caller runs next.
  stopUnit: async (unit) => {
    await new Promise<void>((resolve) => {
      const request = spawn("systemctl", [...redskilledUnitStopArgv(unit)], { stdio: "ignore" });
      request.once("error", () => resolve());
      request.once("close", () => resolve());
    });
  },
  unitActive: isUnitActive,
  leaderAlive: isPidAlive,
  killTree: (pgid) => killTreeAndWait(pgid, { graceTries: REDSKILLED_UNIT_STOP_GRACE_TRIES }),
};
