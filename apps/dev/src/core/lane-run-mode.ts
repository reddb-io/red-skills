// lane-run-mode — the lane label IMPLIES the run mode, and the claim enforces it
// (issue #3026).
//
// The contract itself moved to `@reddb-io/worker/engine` when the native ACP
// Worker began claiming Tickets of its own (issue #4020, ADR 0148): it lives
// beside `DEFAULT_CASTLE_SELECTION_LABELS.laneIsolated`, the lane set the guard
// pins it against, and BOTH Worker bodies read the one table rather than each
// restating a pair that would agree only until somebody edited one.
//
// This module stays because the enforcement point is here: the dev bundle's
// `process-issue/lifecycle.ts` imports `laneRunModeRefusal` from it, and the
// guard reads that import as its proof that a table nobody consults cannot pass
// green by accident.
export {
  LANE_RUN_MODE_CONTRACT,
  laneRunModeRefusal,
  requiredRunModeForLane,
  type LaneRunModeContract,
} from "@reddb-io/worker/engine";
