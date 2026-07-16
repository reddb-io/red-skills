import type { CastleGateResult } from "./gate-executor.js";
import type { GateSinkOutcome } from "./gate-sink.js";
import type { TrackerPort } from "./tracker/port.js";

export type CastleLandingGateVerdict = Pick<
  CastleGateResult,
  "ok" | "sinkOutcomes"
>;

export type CastleLandingTracker = Pick<
  TrackerPort,
  "closeIssue" | "commentOnIssue"
>;

export interface CastleLandingMergeInput {
  issue: number;
  branch: string;
  base?: string;
}

export type CastleLandingMergeResult =
  | { ok: true; mergeSha?: string }
  | { ok: false; reason: string; message?: string };

export type CastleLandingResult =
  | { ok: true; mergeSha?: string; cleanupError?: string }
  | {
      ok: false;
      reason: "gate-failed" | "gate-parked" | "land-failed";
      message?: string;
    };

export interface RunCastleLandingInput {
  issue: number;
  branch: string;
  base?: string;
  gate: CastleLandingGateVerdict;
  tracker: CastleLandingTracker;
  land(input: CastleLandingMergeInput): Promise<CastleLandingMergeResult>;
  cleanupBranch?(branch: string): Promise<void>;
}

function firstBlockingSinkOutcome(
  outcomes: readonly GateSinkOutcome[],
): GateSinkOutcome | undefined {
  return outcomes.find((outcome) => outcome !== "approved");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runCastleLanding(
  input: RunCastleLandingInput,
): Promise<CastleLandingResult> {
  if (!input.gate.ok) return { ok: false, reason: "gate-failed" };

  const blockingOutcome = firstBlockingSinkOutcome(input.gate.sinkOutcomes);
  if (blockingOutcome) {
    await input.tracker.commentOnIssue(
      input.issue,
      `🤖 Castle landing skipped: gate sink ${blockingOutcome}.`,
    );
    return { ok: false, reason: "gate-parked" };
  }

  const landed = await input.land({
    issue: input.issue,
    branch: input.branch,
    base: input.base,
  });
  if (!landed.ok) {
    return {
      ok: false,
      reason: "land-failed",
      message: landed.message ?? landed.reason,
    };
  }

  await input.tracker.closeIssue(input.issue);

  let cleanupError: string | undefined;
  try {
    await input.cleanupBranch?.(input.branch);
  } catch (error) {
    cleanupError = errorMessage(error);
  }

  return cleanupError
    ? { ok: true, mergeSha: landed.mergeSha, cleanupError }
    : { ok: true, mergeSha: landed.mergeSha };
}
