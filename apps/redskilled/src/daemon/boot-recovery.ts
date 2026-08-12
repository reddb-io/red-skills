/** Deterministic successor planning over durable registration and daemon facts. */
import type { RedskilledEventLane, RedskilledHostEvent } from "../event-lane.js";
import {
  registrationRenewalStatus,
  type RedskilledProjectRegistration,
} from "../project-registration.js";
import type { RedskilledWorkerView } from "../host-state.js";
import type { RedskilledLease } from "../session-lease.js";

export interface RegistrationBootRecovery {
  readonly live: readonly RedskilledProjectRegistration[];
  readonly recoverable: readonly RedskilledProjectRegistration[];
  readonly abandoned: readonly RedskilledProjectRegistration[];
}

export function planRegistrationBootRecovery(
  restored: readonly RedskilledProjectRegistration[],
  workers: Iterable<RedskilledWorkerView>,
  startedAt: string,
): RegistrationBootRecovery {
  const nowMs = Date.parse(startedAt);
  const liveProjects = new Set([...workers].map((worker) => worker.project_label));
  const live: RedskilledProjectRegistration[] = [];
  const recoverable: RedskilledProjectRegistration[] = [];
  const abandoned: RedskilledProjectRegistration[] = [];
  for (const registration of restored) {
    const renewByMs = Date.parse(registration.renew_by);
    const renewal = Number.isFinite(nowMs)
      ? registrationRenewalStatus(registration, nowMs)
      : "renewing";
    if (!Number.isFinite(renewByMs) || renewal !== "running-on" || liveProjects.has(registration.project_label)) {
      live.push(registration);
      continue;
    }
    abandoned.push(registration);
    if (!Number.isFinite(nowMs) || nowMs - renewByMs <= registration.renew_within_ms) {
      recoverable.push(registration);
    }
  }
  return { live, recoverable, abandoned };
}

export async function recordDaemonBootRecovery(options: {
  readonly eventLane: RedskilledEventLane;
  readonly laneEvents: readonly RedskilledHostEvent[];
  readonly heldLease?: RedskilledLease;
  readonly ownerPid: number;
  readonly startedAt: string;
  readonly socketPath: string;
  readonly recovery: RegistrationBootRecovery;
}): Promise<void> {
  const latest = [...options.laneEvents].reverse().find((event) =>
    event.kind === "daemon-start" || event.kind === "daemon-death" || event.kind === "daemon-stop"
  );
  const predecessor = latest?.kind === "daemon-start"
    ? { pid: latest.pid, socketPath: latest.workspace_path }
    : latest == null && options.heldLease != null && options.heldLease.pid !== options.ownerPid
      ? { pid: options.heldLease.pid, socketPath: options.heldLease.socket_path }
      : null;
  if (predecessor != null) {
    await options.eventLane.recordDaemonDeath({
      ts: options.startedAt,
      pid: predecessor.pid,
      socketPath: predecessor.socketPath,
      detail: `redskilled recovered after daemon ${predecessor.pid} left no stop record`,
      reason: "silent-death",
    });
  }
  const restored = options.recovery.live.length + options.recovery.abandoned.length;
  if (restored > 0 || predecessor != null) {
    await options.eventLane.recordDaemonStart({
      ts: options.startedAt,
      pid: options.ownerPid,
      socketPath: options.socketPath,
      detail:
        `redskilled boot read the host registration intent store: recovered ${options.recovery.live.length} live, ` +
        `lapsed ${options.recovery.abandoned.length} abandoned`,
    });
  }
}
