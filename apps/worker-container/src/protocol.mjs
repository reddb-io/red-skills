/**
 * The wire constants this container shares with the daemon.
 *
 * Spelled here rather than imported: the image carries no repository source and
 * no workspace `node_modules`, so `@reddb-io/protocol-acp` is not reachable at
 * runtime. `apps/plugin-dev/tests/worker-container-lane.test.ts` pins both
 * values against the package that owns them, so the copy cannot drift.
 */

/** ADR 0148's RedSkills wire major, as `packages/protocol-acp/compat.ts` states it. */
export const REDSKILLS_WIRE_MAJOR = 1;

/** The `_redskills/*` Project control surface this lane uses. */
export const REDSKILLS_ACP_METHODS = Object.freeze({
  projectDrain: "_redskills/project_drain",
  projectStop: "_redskills/project_stop",
  projectStatus: "_redskills/project_status",
});
