// verdict — the one owner of post-DONE failure attribution and accounting
// (ADR 0136, issue #3335).
//
// The lifecycle supplies facts it has already observed: validation records,
// the round signature/history, and base/environment facts. This module performs
// no IO and exposes one decision: whose fault the round is, which budget it may
// affect, and whether the branch must park now.

import type { ClassifiableCheck } from "./feedback.js";
import type { GeneratedSurfaceDeclaration } from "./config.js";
import { onlyGeneratedPaths } from "./generated-surfaces.js";
import { VALIDATION_TARGET_MISSING_MARKER } from "./validation-command.js";
import { baseMoved, type BaseMovement } from "./stale-base-drift.js";

export const DEFAULT_ENVIRONMENT_ROUNDS = 2;
export const ENVIRONMENT_ROUNDS_ENV = "RED_GATE_ENVIRONMENT_ROUNDS";

export function resolveEnvironmentRounds(
  raw: string | undefined,
  fallback: number = DEFAULT_ENVIRONMENT_ROUNDS,
): number {
  const parsed = raw === undefined ? NaN : Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

export type EnvironmentCause =
  | "prior-environment"
  | "suspect-infra"
  | "stall"
  | "oom"
  | "setup"
  | "baseline"
  | "missing-target"
  | "capture-overflow"
  | "missing-dependency"
  | "stale-base-drift";

export interface EnvironmentRound {
  readonly cause: EnvironmentCause;
  readonly signature: string;
}

/** One capped economy for every failure that branch code does not own. */
export interface EnvironmentLedger {
  readonly cap: number;
  readonly rounds: readonly EnvironmentRound[];
}

export function emptyEnvironmentLedger(cap: number): EnvironmentLedger {
  return { cap: normaliseCap(cap), rounds: [] };
}

export type VerdictFault =
  | { readonly kind: "branch" }
  | { readonly kind: "environment"; readonly cause: Exclude<EnvironmentCause, "stale-base-drift"> }
  | { readonly kind: "base"; readonly cause: "stale-base-drift" };

export type VerdictBudgetEffect =
  | { readonly kind: "none" }
  | { readonly kind: "charge-branch" }
  | { readonly kind: "consume-environment"; readonly ledger: EnvironmentLedger };

export type VerdictParkReason =
  | "repeated-signature"
  | "environment-exhausted"
  | "branch-exhausted";

export type VerdictRemediation =
  | { readonly kind: "mechanical-regeneration"; readonly declaration: GeneratedSurfaceDeclaration }
  | { readonly kind: "mechanical-regeneration-skipped"; readonly reason: "undeclared" }
  | {
      readonly kind: "agent-correction";
      readonly reason: "mixed-drift" | "mechanical-regeneration-failed";
      readonly evidence?: string;
    };

export interface Verdict {
  readonly fault: VerdictFault;
  readonly budgetEffect: VerdictBudgetEffect;
  readonly parkNow: boolean;
  readonly parkReason?: VerdictParkReason;
  readonly remediation?: VerdictRemediation;
  readonly reason: string;
}

export interface VerdictInput {
  readonly checks: readonly ClassifiableCheck[];
  readonly signature: string;
  readonly history: {
    readonly environment: EnvironmentLedger;
    /** Whether the existing Re-seed economy can heal one branch-owned round. */
    readonly branchBudgetAvailable: boolean;
  };
  readonly environment: {
    readonly movement?: BaseMovement;
    /** Explicit repository declaration beside the Validation moments. */
    readonly subsecondFailuresAreBranchFault?: boolean;
    readonly generated?: GeneratedSurfaceDeclaration;
    readonly mechanicalHealFailure?: string;
  };
}

function normaliseCap(cap: number): number {
  return Number.isInteger(cap) && cap >= 0 ? cap : 0;
}

function failedChecks(checks: readonly ClassifiableCheck[]): readonly ClassifiableCheck[] {
  return checks.filter((check) => check.status === "failed" && check.record.exitCode !== 0);
}

/** Return the first mechanically proved environment cause in check order. */
function checkEnvironmentCause(
  checks: readonly ClassifiableCheck[],
  subsecondFailuresAreBranchFault: boolean,
): Exclude<EnvironmentCause, "stale-base-drift"> | undefined {
  for (const check of failedChecks(checks)) {
    const record = check.record;
    if (record.suspectInfra === true && !subsecondFailuresAreBranchFault) return "suspect-infra";
    if (record.infra === "stall") return "stall";
    const summary = record.summary ?? "";
    if (record.exitCode === 137 || summary.includes("SIGKILL") || /\b137\b/.test(summary)) return "oom";
    if (
      summary.includes("feedback worktree setup failed") ||
      summary.includes("feedback worktree submodule init failed") ||
      summary.includes("feedback worktree install failed")
    ) {
      return "setup";
    }
    if (summary.includes("baseline environment failure") || summary.includes("the baseline could not be built")) {
      return "baseline";
    }
    if (summary.includes(VALIDATION_TARGET_MISSING_MARKER)) return "missing-target";
    if (summary.includes("maxBuffer length exceeded")) return "capture-overflow";
    if (
      summary.includes("node_modules") &&
      (
        summary.includes("ERR_MODULE_NOT_FOUND") ||
        summary.includes("Cannot find module") ||
        summary.includes("Cannot find package") ||
        /ENOENT:[^\n]*no such file or directory/i.test(summary)
      )
    ) {
      return "missing-dependency";
    }
  }
  return undefined;
}

function faultFor(input: VerdictInput): VerdictFault {
  if (baseMoved(input.environment.movement)) return { kind: "base", cause: "stale-base-drift" };
  const environmentCause = checkEnvironmentCause(
    input.checks,
    input.environment.subsecondFailuresAreBranchFault === true,
  );
  if (environmentCause) return { kind: "environment", cause: environmentCause };
  return { kind: "branch" };
}

function environmentCauseOf(fault: VerdictFault): EnvironmentCause | undefined {
  return fault.kind === "branch" ? undefined : fault.cause;
}

function remediationFor(input: VerdictInput, fault: VerdictFault): VerdictRemediation | undefined {
  if (fault.kind !== "base") return undefined;
  if (input.environment.mechanicalHealFailure !== undefined) {
    return {
      kind: "agent-correction",
      reason: "mechanical-regeneration-failed",
      evidence: input.environment.mechanicalHealFailure,
    };
  }
  const declaration = input.environment.generated;
  if (!declaration) return { kind: "mechanical-regeneration-skipped", reason: "undeclared" };
  if (onlyGeneratedPaths(input.environment.movement?.files ?? [], declaration.paths)) {
    return { kind: "mechanical-regeneration", declaration };
  }
  return { kind: "agent-correction", reason: "mixed-drift" };
}

/**
 * Decide one failed round. Environment attribution is sticky: exhaustion can
 * only park that environment fault, never transmute it into branch blame.
 */
export function decideVerdict(input: VerdictInput): Verdict {
  const fault = faultFor(input);
  const remediation = remediationFor(input, fault);
  if (remediation?.kind === "agent-correction") {
    if (!input.history.branchBudgetAvailable) {
      return {
        fault,
        remediation,
        budgetEffect: { kind: "none" },
        parkNow: true,
        parkReason: "branch-exhausted",
        reason: remediation.reason === "mixed-drift"
          ? "mixed stale-base drift requires an agent correction, but the branch repair budget is exhausted"
          : `mechanical regeneration failed and requires an agent correction, but the branch repair budget is exhausted: ${remediation.evidence ?? "no evidence"}`,
      };
    }
    return {
      fault,
      remediation,
      budgetEffect: { kind: "charge-branch" },
      parkNow: false,
      reason: remediation.reason === "mixed-drift"
        ? "mixed stale-base drift requires one agent correction"
        : `mechanical regeneration failed; falling through to agent correction with evidence: ${remediation.evidence ?? "no evidence"}`,
    };
  }
  const cause = environmentCauseOf(fault);
  if (cause === undefined) {
    if (!input.history.branchBudgetAvailable) {
      return {
        fault,
        budgetEffect: { kind: "none" },
        parkNow: true,
        parkReason: "branch-exhausted",
        reason: "the checks failed on a healthy environment and the branch repair budget is exhausted",
      };
    }
    return {
      fault,
      budgetEffect: { kind: "charge-branch" },
      parkNow: false,
      reason: "the checks failed on a healthy environment, so the branch owns one repair round",
    };
  }

  const ledger: EnvironmentLedger = {
    cap: normaliseCap(input.history.environment.cap),
    rounds: input.history.environment.rounds,
  };
  const signature = fault.kind === "base" && input.environment.movement
    ? `${input.signature}:base:${input.environment.movement.gateSha}`
    : input.signature;
  const narration = fault.kind === "base" && input.environment.movement?.subjects.length
    ? `${cause} (${input.environment.movement.subjects.join("; ")})`
    : cause;
  const previous = ledger.rounds.at(-1);
  if (signature !== "" && previous?.signature === signature) {
    return {
      fault,
      ...(remediation ? { remediation } : {}),
      budgetEffect: { kind: "none" },
      parkNow: true,
      parkReason: "repeated-signature",
      reason: `the ${narration} failure repeated signature ${signature} on the unchanged branch/environment`,
    };
  }
  if (ledger.rounds.length >= ledger.cap) {
    return {
      fault,
      ...(remediation ? { remediation } : {}),
      budgetEffect: { kind: "none" },
      parkNow: true,
      parkReason: "environment-exhausted",
      reason: `the shared environment ledger is exhausted at ${ledger.rounds.length}/${ledger.cap}`,
    };
  }

  const nextLedger: EnvironmentLedger = {
    cap: ledger.cap,
    rounds: [...ledger.rounds, { cause, signature }],
  };
  return {
    fault,
    ...(remediation ? { remediation } : {}),
    budgetEffect: { kind: "consume-environment", ledger: nextLedger },
    parkNow: false,
    reason: `${narration} consumed environment round ${nextLedger.rounds.length}/${nextLedger.cap}`,
  };
}

/** Per-cause narration used by free-round and park records. */
export function describeEnvironmentLedger(ledger: EnvironmentLedger): string {
  const counts = new Map<EnvironmentCause, number>();
  for (const round of ledger.rounds) counts.set(round.cause, (counts.get(round.cause) ?? 0) + 1);
  const causes = [...counts.entries()].map(([cause, count]) => `${count}× ${cause}`).join(", ");
  return `${ledger.rounds.length}/${ledger.cap} environment rounds consumed${causes === "" ? "" : `: ${causes}`}`;
}
