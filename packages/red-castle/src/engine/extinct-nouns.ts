// extinct-nouns — the migration answer for a caller that still names a Fleet.
//
// ADR 0130 removed the Fleet: the host daemon owns the budget and a project has
// exactly one demand producer, so there is nothing left for a name to address.
// A removal without a migration answer turns every stale invocation into an
// internal error at whatever layer happens to dereference the name first. This
// module is the one place that answers instead, naming the replacement.

/** What a caller that named a fleet is told, in one sentence plus the route. */
export const FLEET_REMOVED_MESSAGE =
  "named fleets were removed (ADR 0130): the host daemon owns the budget and each project has exactly one demand producer, " +
  "so a fleet name addresses nothing. Drop the name — the work scope, the runner and the base branch now ride with the " +
  "project's producer: pass --selector / --runner / --base to `red-skills-dev fleet`, or call the redskilled `project_start` tool " +
  "(status: `project_status`, resize: `project_resize`, stop: `project_stop`).";

/** Raised when an invocation still addresses a fleet by name. */
export class FleetNamingRemovedError extends Error {
  constructor(name?: string) {
    super(
      name === undefined || name === ""
        ? FLEET_REMOVED_MESSAGE
        : `fleet ${JSON.stringify(name)}: ${FLEET_REMOVED_MESSAGE}`,
    );
    this.name = "FleetNamingRemovedError";
  }
}

/**
 * Refuse an input that names a fleet. Returns silently when no name is present,
 * so a call site can guard unconditionally.
 */
export function refuseFleetNaming(name: unknown): void {
  if (name === undefined || name === null || name === "") return;
  throw new FleetNamingRemovedError(typeof name === "string" ? name : String(name));
}
