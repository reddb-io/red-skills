import type { RedskilledProjectRegistration } from "./project-registration.js";
import type { RedskilledQueueDiscovery } from "./queue-discovery.js";
import type { RedskilledRegistrationLapse, RedskilledRegistrationStop } from "./host-state.js";

export interface RedskilledRegistrationHistory {
  readonly standing?: true;
  readonly queue_depth?: number;
}

/** Project-policy and backlog facts retained when a registration leaves the live set. */
function registrationHistory(
  registration: RedskilledProjectRegistration,
  queue: RedskilledQueueDiscovery | null,
): RedskilledRegistrationHistory {
  const observed = queue?.projects.find((project) => project.project_label === registration.project_label);
  return {
    ...(registration.standing === true ? { standing: true as const } : {}),
    ...(observed?.outcome === "counted" && observed.depth != null ? { queue_depth: observed.depth } : {}),
  };
}

export function buildRegistrationLapse(
  registration: RedskilledProjectRegistration,
  queue: RedskilledQueueDiscovery | null,
  at: string,
  detail?: string,
): RedskilledRegistrationLapse {
  return {
    project_label: registration.project_label,
    registered_at: registration.registered_at,
    at,
    renew_by: registration.renew_by,
    renewals: registration.renewals,
    sustains: registration.sustains ?? 0,
    ...registrationHistory(registration, queue),
    detail: detail ??
      `redskilled dropped the registration for project ${JSON.stringify(registration.project_label)}: it stood ` +
      `until ${registration.renew_by} and nothing renewed it — no session spoke for it, and no poll found it ` +
      `work or a Worker to hold it up`,
  };
}

export function buildRegistrationStop(
  registration: RedskilledProjectRegistration,
  queue: RedskilledQueueDiscovery | null,
  at: string,
): RedskilledRegistrationStop {
  return {
    project_label: registration.project_label,
    registered_at: registration.registered_at,
    at,
    ...registrationHistory(registration, queue),
    detail: `redskilled released the registration for project ${JSON.stringify(registration.project_label)}`,
  };
}

/** Whether a lapsed registration remains inside its recoverable policy window. */
export function mayRecoverRegistration(registration: RedskilledProjectRegistration, nowMs: number): boolean {
  return registration.standing === true || !Number.isFinite(nowMs) ||
    nowMs - Date.parse(registration.renew_by) <= registration.renew_within_ms;
}
