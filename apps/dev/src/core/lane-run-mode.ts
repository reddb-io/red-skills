// lane-run-mode — the lane label IMPLIES the run mode, and the claim enforces it
// (issue #3026).
//
// A `lane:scout` issue is a READ-ONLY investigation: `run_mode=scout` is what
// makes `process-issue` skip push / feedback / landing. That mode arrived only
// through the `/go --scout` dispatch argv, so every OTHER entrance — a plain
// `--issues N` run, a `--lane lane:scout` drain, any future caller — picked the
// same issue up modeless and would have committed against it (observed live
// 2026-08-01). The lane was isolated at SELECTION; the mode was not enforced at
// the CLAIM, so the two agreed only by the argv of one caller.
//
// The contract below states the pair ONCE, and the claim path refuses a
// mismatch. Enforcing it where the issue is claimed — not in a dispatcher —
// means every entrance inherits it, including the ones not written yet.

import { LABEL_GO_LANE, LABEL_SCOUT_LANE } from "./triage-labels.js";
import { SCOUT_RUN_MODE } from "./scout.js";

/** One lane label paired with the run mode a worker MUST hold to claim it. */
export interface LaneRunModeContract {
  /** The lane label carried by the issue (`lane:*`). */
  lane: string;
  /** The run mode the claiming worker must hold, or `null` when the lane
   * imposes none (the ordinary ship pipeline is correct for it). */
  runMode: string | null;
  /** One line on WHY the lane needs that mode — read by whoever hits the refusal. */
  why: string;
}

/**
 * The declared lane-to-mode contract. Every lane-isolated label (the
 * `laneIsolated` set the castle drain selects by) needs an entry here, even
 * when its answer is "no mode required" — an undeclared lane is a pair nobody
 * agreed to, which is exactly how `lane:scout` and `run_mode=scout` drifted
 * apart. The guard (`tests/lane-run-mode-guard.test.ts`) pins the table against
 * that set so the next lane/mode pair cannot drift.
 */
export const LANE_RUN_MODE_CONTRACT: readonly LaneRunModeContract[] = [
  {
    lane: LABEL_GO_LANE,
    runMode: null,
    why: "a /go dispatch runs the ordinary ship pipeline; --pre-pr adds no-mistakes as an OPTION, never a requirement",
  },
  {
    lane: LABEL_SCOUT_LANE,
    runMode: SCOUT_RUN_MODE,
    why: "a scout-lane issue is a read-only investigation: without run_mode=scout the engine would push, open a PR and land",
  },
];

/** The run mode `lane` demands, `null` when it demands none, and `undefined`
 * when the label is not a declared lane at all. PURE. */
export function requiredRunModeForLane(lane: string): string | null | undefined {
  const entry = LANE_RUN_MODE_CONTRACT.find((c) => c.lane === lane);
  return entry ? entry.runMode : undefined;
}

/**
 * The refusal a worker must emit before claiming `labels` under `runMode`, or
 * `undefined` when the pair honours the contract. PURE.
 *
 * The message NAMES the rule — the lane, the mode it implies, and the mode the
 * worker actually holds — because the reader of a refusal is someone who
 * dispatched the issue believing it would run.
 */
export function laneRunModeRefusal(
  labels: readonly string[],
  runMode: string | undefined,
): string | undefined {
  for (const contract of LANE_RUN_MODE_CONTRACT) {
    if (contract.runMode === null) continue;
    if (!labels.includes(contract.lane)) continue;
    if (runMode === contract.runMode) continue;
    return (
      `lane-to-mode contract: \`${contract.lane}\` requires run_mode=${contract.runMode}, ` +
      `this worker holds run_mode=${runMode ?? "(none)"} — refusing the claim. ${contract.why}`
    );
  }
  return undefined;
}
