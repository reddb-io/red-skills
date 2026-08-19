import type {
  FocalBranchProbeInput,
  OperationalProbe,
  OperationalProbeContext,
  OperationalProbeFixDeps,
  OperationalProbeFixResult,
  OperationalProbeResult,
} from "./types.js";

export const FOCAL_BRANCH_PROBE_ID = "afk.focal-branch-resolution";
export const FOCAL_BRANCH_PROBE_NAME = "AFK focal branch resolution";
export const FOCAL_BRANCH_CANONICAL_FIX =
  "Repair stale branch-lock state by clearing a dead lock, or keep a live intentional lock and switch the primary checkout to the resolved focal branch.";

export type FocalBranchFindingKind = "stale-lock-target-missing" | "contradictory-lock-without-live-session";

export interface FocalBranchProbeData {
  readonly resolved: FocalBranchProbeInput["resolved"];
  readonly configuredTrunk: string;
  readonly lock?: FocalBranchProbeInput["lock"];
  readonly finding?: FocalBranchFindingKind;
}

function evidence(input: FocalBranchProbeInput, finding?: FocalBranchFindingKind): string {
  const lock = input.lock;
  const lockEvidence = lock
    ? `; lock=${JSON.stringify(lock.raw)} targetExists=${String(lock.targetExists)}`
    : "";
  const suffix = `; configuredTrunk=${input.configuredTrunk}${lockEvidence}`;
  if (finding === "stale-lock-target-missing") {
    return `resolved ${input.resolved.branch} from ${input.resolved.source}; stale lock target is missing${suffix}`;
  }
  if (finding === "contradictory-lock-without-live-session") {
    return `resolved ${input.resolved.branch} from ${input.resolved.source}; lock diverges from configured trunk without a live holder${suffix}`;
  }
  return `resolved ${input.resolved.branch} from ${input.resolved.source}${suffix}`;
}

function findingKind(input: FocalBranchProbeInput): FocalBranchFindingKind | undefined {
  const lock = input.lock;
  if (!lock?.branch) return undefined;
  if (lock.targetExists === false) return "stale-lock-target-missing";
  if (
    lock.branch !== input.configuredTrunk &&
    lock.heldByLiveSession === false
  ) {
    return "contradictory-lock-without-live-session";
  }
  return undefined;
}

export function runFocalBranchProbe(context: OperationalProbeContext): OperationalProbeResult {
  const input = context.focalBranch;
  if (!input) {
    return {
      id: FOCAL_BRANCH_PROBE_ID,
      name: FOCAL_BRANCH_PROBE_NAME,
      verdict: "ok",
      evidence: "focal branch resolution check not configured",
      canonicalFix: FOCAL_BRANCH_CANONICAL_FIX,
    };
  }

  const finding = findingKind(input);
  return {
    id: FOCAL_BRANCH_PROBE_ID,
    name: FOCAL_BRANCH_PROBE_NAME,
    verdict: finding ? "red" : "ok",
    evidence: evidence(input, finding),
    canonicalFix: FOCAL_BRANCH_CANONICAL_FIX,
    fix: finding
      ? {
          gate: "confirm",
          description: "clear the stale branch-lock so boot falls back to the configured focal branch",
        }
      : undefined,
    data: {
      resolved: input.resolved,
      configuredTrunk: input.configuredTrunk,
      lock: input.lock,
      finding,
    } satisfies FocalBranchProbeData,
  };
}

export async function applyFocalBranchFix(
  finding: OperationalProbeResult,
  deps: OperationalProbeFixDeps,
): Promise<OperationalProbeFixResult> {
  const data = finding.data as Partial<FocalBranchProbeData> | undefined;
  if (!data?.finding) {
    return { probeId: finding.id, status: "noop", evidence: "no focal branch repair is needed" };
  }

  const confirmed = await deps.confirm(finding);
  if (!confirmed) {
    return { probeId: finding.id, status: "declined", evidence: "operator declined fix" };
  }

  if (!deps.removeBranchLock) {
    return { probeId: finding.id, status: "noop", evidence: "branch-lock repair is not wired" };
  }

  await deps.removeBranchLock();
  return { probeId: finding.id, status: "applied", evidence: "cleared branch-lock" };
}

export const focalBranchProbe: OperationalProbe = {
  id: FOCAL_BRANCH_PROBE_ID,
  name: FOCAL_BRANCH_PROBE_NAME,
  canonicalFix: FOCAL_BRANCH_CANONICAL_FIX,
  run: runFocalBranchProbe,
  applyFix: applyFocalBranchFix,
};
