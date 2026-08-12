import type { RedskilledProjectRegistration } from "./project-registration.js";
import type { RedskilledQueueDiscovery } from "./queue-discovery.js";

export interface RedskilledRegistrationHistory {
  readonly standing?: true;
  readonly queue_depth?: number;
}

/** Project-policy and backlog facts retained when a registration leaves the live set. */
export function registrationHistory(
  registration: RedskilledProjectRegistration,
  queue: RedskilledQueueDiscovery | null,
): RedskilledRegistrationHistory {
  const observed = queue?.projects.find((project) => project.project_label === registration.project_label);
  return {
    ...(registration.standing === true ? { standing: true as const } : {}),
    ...(observed?.outcome === "counted" && observed.depth != null ? { queue_depth: observed.depth } : {}),
  };
}

/** Whether a lapsed registration remains inside its recoverable policy window. */
export function mayRecoverRegistration(registration: RedskilledProjectRegistration, nowMs: number): boolean {
  return registration.standing === true || !Number.isFinite(nowMs) ||
    nowMs - Date.parse(registration.renew_by) <= registration.renew_within_ms;
}
