// supervisor-lane — how a worker knows which supervisor lane spawned it.
//
// This carried the fleet name before the Fleet was removed (ADR 0130). The
// attribution itself survived the noun: a hard teardown must still kill the
// workers its own supervisor spawned and leave a standalone `/go` or `/afk run`
// worker alone, and the statusline still shows which lane a worker belongs to.
// What changed is that there is one lane to name instead of one per fleet.

/** The env var carrying the supervisor lane across the detached worker spawn. */
export const SUPERVISOR_LANE_ENV = "RED_AFK_SUPERVISOR_LANE";
