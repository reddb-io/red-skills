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

export interface CastleCascadeSibling {
  issue: number;
  branch: string;
  base?: string;
  state: "done-waiting" | "active";
}

export interface CastleCascadeRebaseInput {
  issue: number;
  branch: string;
  base?: string;
  trunkTip?: string;
}

export type CastleCascadeRebaseResult =
  | { ok: true; outcome?: "rebased" | "already-current"; message?: string }
  | { ok: false; outcome: "parked"; message?: string };

export type CastleCascadeSiblingOutcome =
  | {
      issue: number;
      branch: string;
      status: "rebased" | "already-current" | "parked";
      message?: string;
    }
  | {
      issue: number;
      branch: string;
      status: "skipped-active";
    };

export interface CastleLandingCascadeInput {
  siblings: readonly CastleCascadeSibling[];
  /**
   * Rebase one DONE-waiting sibling through the same resolution ladder used on
   * the DONE landing path: mechanical, then bounded agent, then park.
   * `runCastleLanding` calls this only after a successful land, while the caller
   * still owns the land-lock / merge-queue serialization context.
   */
  rebase(input: CastleCascadeRebaseInput): Promise<CastleCascadeRebaseResult>;
}

export type CastleLandingResult =
  | {
      ok: true;
      mergeSha?: string;
      cleanupError?: string;
      cascade?: CastleCascadeSiblingOutcome[];
    }
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
  cascade?: CastleLandingCascadeInput;
}

function firstBlockingSinkOutcome(
  outcomes: readonly GateSinkOutcome[],
): GateSinkOutcome | undefined {
  return outcomes.find((outcome) => outcome !== "approved");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function renderCascadeComment(
  outcome: CastleCascadeSiblingOutcome,
  trunkTip?: string,
): string {
  if (outcome.status === "skipped-active") {
    return `🤖 Castle cascade rebase: ${outcome.branch} skipped because the worker is active.`;
  }
  if (outcome.status === "parked") {
    const suffix = outcome.message ? `: ${outcome.message}` : "";
    return `🤖 Castle cascade rebase: ${outcome.branch} parked after the landing rebase ladder${suffix}.`;
  }
  const target = trunkTip ?? "the new trunk tip";
  return `🤖 Castle cascade rebase: ${outcome.branch} ${outcome.status === "already-current" ? "already current with" : "rebased onto"} ${target}.`;
}

async function runCascadeRebase(
  input: RunCastleLandingInput,
  trunkTip?: string,
): Promise<CastleCascadeSiblingOutcome[] | undefined> {
  if (!input.cascade) return undefined;

  const outcomes: CastleCascadeSiblingOutcome[] = [];
  for (const sibling of input.cascade.siblings) {
    if (sibling.state === "active") {
      const outcome: CastleCascadeSiblingOutcome = {
        issue: sibling.issue,
        branch: sibling.branch,
        status: "skipped-active",
      };
      outcomes.push(outcome);
      await input.tracker.commentOnIssue(
        sibling.issue,
        renderCascadeComment(outcome, trunkTip),
      );
      continue;
    }

    const rebased = await input.cascade.rebase({
      issue: sibling.issue,
      branch: sibling.branch,
      base: sibling.base ?? input.base,
      trunkTip,
    });
    const outcome: CastleCascadeSiblingOutcome = rebased.ok
      ? {
          issue: sibling.issue,
          branch: sibling.branch,
          status: rebased.outcome ?? "rebased",
          ...(rebased.message ? { message: rebased.message } : {}),
        }
      : {
          issue: sibling.issue,
          branch: sibling.branch,
          status: "parked",
          ...(rebased.message ? { message: rebased.message } : {}),
        };
    outcomes.push(outcome);
    await input.tracker.commentOnIssue(
      sibling.issue,
      renderCascadeComment(outcome, trunkTip),
    );
  }

  return outcomes;
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

  const cascade = await runCascadeRebase(input, landed.mergeSha);

  await input.tracker.closeIssue(input.issue);

  let cleanupError: string | undefined;
  try {
    await input.cleanupBranch?.(input.branch);
  } catch (error) {
    cleanupError = errorMessage(error);
  }

  return {
    ok: true,
    ...(landed.mergeSha ? { mergeSha: landed.mergeSha } : {}),
    ...(cleanupError ? { cleanupError } : {}),
    ...(cascade ? { cascade } : {}),
  };
}
