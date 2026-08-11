/**
 * Adapt live project registrations to the repository-activity poll.
 *
 * The project authors repository coordinates and counter-label names; the
 * daemon only copies those strings into the budget-aware tracker request.
 */
import type { RedskilledProjectRegistration } from "../project-registration.js";
import {
  fetchRepositoryActivity,
  type RedskilledActivityTransport,
  type RedskilledProjectRepository,
  type RedskilledRepositoryActivity,
} from "../repository-activity.js";

interface ExplicitActivityRegistration {
  readonly projects: readonly RedskilledProjectRepository[];
  readonly hostTokenRef: string;
  readonly transport: RedskilledActivityTransport;
  readonly closedWindowMs?: number;
}

export interface RegistrationActivityPollInput {
  readonly explicit?: ExplicitActivityRegistration;
  readonly registrations: Iterable<RedskilledProjectRegistration>;
  readonly resolveHostTransport: () => RedskilledActivityTransport | undefined;
  readonly now: string;
  readonly previous?: RedskilledRepositoryActivity | null;
}

/** Fetch one cycle, or return honest absence when no registration can be polled. */
export async function pollRegistrationActivity(
  input: RegistrationActivityPollInput,
): Promise<RedskilledRepositoryActivity | null> {
  const projects = input.explicit?.projects ?? registeredActivityProjects(input.registrations);
  if (projects.length === 0) return null;
  const transport = input.explicit?.transport ?? input.resolveHostTransport();
  if (transport == null) return null;
  return await fetchRepositoryActivity({
    projects,
    hostTokenRef: input.explicit?.hostTokenRef ?? "host",
    transport,
    ...(input.explicit?.closedWindowMs == null ? {} : { closedWindowMs: input.explicit.closedWindowMs }),
    now: input.now,
    ...(input.previous === undefined ? {} : { previous: input.previous }),
  });
}

/** Repository plans stated by current registrations, ordered like host state. */
function registeredActivityProjects(
  registrations: Iterable<RedskilledProjectRegistration>,
): readonly RedskilledProjectRepository[] {
  return [...registrations]
    .flatMap((registration): readonly RedskilledProjectRepository[] => {
      const poll = registration.queue_poll;
      if (poll == null) return [];
      return [{
        project_label: registration.project_label,
        owner: poll.owner,
        name: poll.repo,
        ...(poll.counter_labels == null ? {} : { queue_labels: poll.counter_labels }),
      }];
    })
    .sort((left, right) => left.project_label.localeCompare(right.project_label));
}
