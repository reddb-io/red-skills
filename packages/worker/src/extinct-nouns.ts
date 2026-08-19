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

/** Refuse an input that names a fleet while accepting an absent legacy field. */
export function refuseFleetNaming(name: unknown): void {
  if (name === undefined || name === null || name === "") return;
  throw new FleetNamingRemovedError(typeof name === "string" ? name : String(name));
}
