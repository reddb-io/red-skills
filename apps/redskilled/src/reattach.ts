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
 * The probes are injected, so both branches are provable without systemd.
 */
import { spawnSync } from "node:child_process";
import { isPidAlive } from "@reddb-io/shared/resident-core.js";
import type { RedskilledWorkerView } from "./host-state.js";

/** Answers "is this Worker still running?" for one Worker. */
export type RedskilledLivenessProbe = (worker: RedskilledWorkerView) => boolean | Promise<boolean>;

/** Stops one Worker; returns whether the host accepted the stop. */
export type RedskilledStopProbe = (worker: RedskilledWorkerView) => boolean | Promise<boolean>;

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

/**
 * Stop one Worker: the unit by name, or the process by pid.
 *
 * Stopping the unit rather than the pid is what makes the kill total — a Worker
 * that forked children would otherwise leave them behind, still charged to the
 * budget the daemon just decided to reclaim.
 */
export function stopWorker(worker: RedskilledWorkerView): boolean {
  if (worker.unit != null && worker.unit !== "") {
    const stop = spawnSync("systemctl", ["--user", "stop", worker.unit], { stdio: "ignore" });
    return stop.error == null && stop.status === 0;
  }
  try {
    process.kill(worker.pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}
