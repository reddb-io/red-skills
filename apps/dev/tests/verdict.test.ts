import { describe, expect, it } from "vitest";
import { CANONICAL_HOOK_NAMES, UnknownHookError, resolveHooks } from "../src/core/hook-config.js";
import {
  decideVerdict,
  emptyEnvironmentLedger,
  resolveEnvironmentRounds,
  type EnvironmentCause,
  type EnvironmentLedger,
} from "../src/core/verdict.js";
import type { ClassifiableCheck } from "../src/core/feedback.js";

const SIGNATURE = "sig-one";

function failedCheck(overrides: Partial<ClassifiableCheck["record"]> = {}): ClassifiableCheck {
  return {
    status: "failed",
    record: {
      schema: "red.afk.validation.v1",
      name: "validation:post_done",
      status: "failed",
      command: "pnpm test",
      exitCode: 1,
      durationMs: 400,
      suspectInfra: true,
      ...overrides,
    },
  };
}

function passedCheck(): ClassifiableCheck {
  return {
    status: "passed",
    record: {
      schema: "red.afk.validation.v1",
      name: "validation:post_done",
      status: "passed",
      command: "pnpm test",
      exitCode: 0,
      durationMs: 400,
    },
  };
}

function ledger(rounds: EnvironmentLedger["rounds"], cap = 2): EnvironmentLedger {
  return { cap, rounds };
}

describe("decideVerdict — one fault, budget effect, and park decision", () => {
  it("resolves the one environment-ledger cap", () => {
    expect(resolveEnvironmentRounds(undefined)).toBe(2);
    expect(resolveEnvironmentRounds("3")).toBe(3);
    expect(resolveEnvironmentRounds("0")).toBe(0);
    expect(resolveEnvironmentRounds("nope")).toBe(2);
  });

  it("consumes the one environment ledger for suspect-infra, then fast-parks an identical signature", () => {
    const first = decideVerdict({
      checks: [failedCheck()],
      signature: SIGNATURE,
      history: { environment: emptyEnvironmentLedger(2), branchBudgetAvailable: true },
      environment: {},
    });

    expect(first).toMatchObject({
      fault: { kind: "environment", cause: "suspect-infra" },
      budgetEffect: { kind: "consume-environment" },
      parkNow: false,
    });
    expect(first.budgetEffect.kind === "consume-environment" && first.budgetEffect.ledger.rounds)
      .toEqual([{ cause: "suspect-infra", signature: SIGNATURE }]);

    const repeated = decideVerdict({
      checks: [failedCheck()],
      signature: SIGNATURE,
      history: {
        environment: ledger([{ cause: "suspect-infra", signature: SIGNATURE }]),
        branchBudgetAvailable: true,
      },
      environment: {},
    });

    expect(repeated).toMatchObject({
      fault: { kind: "environment", cause: "suspect-infra" },
      budgetEffect: { kind: "none" },
      parkNow: true,
      parkReason: "repeated-signature",
    });
  });

  it("honours the declared sub-second escape as branch fault", () => {
    expect(decideVerdict({
      checks: [failedCheck()],
      signature: SIGNATURE,
      history: { environment: emptyEnvironmentLedger(2), branchBudgetAvailable: true },
      environment: { subsecondFailuresAreBranchFault: true },
    })).toMatchObject({
      fault: { kind: "branch" },
      budgetEffect: { kind: "charge-branch" },
      parkNow: false,
    });
  });

  it("attributes a moved base before interpreting check-local environment markers", () => {
    expect(decideVerdict({
      checks: [failedCheck()],
      signature: SIGNATURE,
      history: { environment: emptyEnvironmentLedger(2), branchBudgetAvailable: true },
      environment: {
        movement: { startSha: "before", gateSha: "after", subjects: ["fix: base moved"] },
      },
    })).toMatchObject({
      fault: { kind: "base", cause: "stale-base-drift" },
      budgetEffect: { kind: "consume-environment" },
      parkNow: false,
    });
  });

  it("owns the generated-drift cure truth table", () => {
    const movement = {
      startSha: "before",
      gateSha: "after",
      subjects: ["chore(release): version packages"],
      files: ["packaging/pi/dev/package.json"],
    } as const;
    const generated = {
      paths: ["packaging/pi/**"],
      command: "pnpm generate-manifests && pnpm pi:packages:build",
    } as const;
    const input = {
      checks: [failedCheck()],
      signature: SIGNATURE,
      history: { environment: emptyEnvironmentLedger(2), branchBudgetAvailable: true },
      environment: { movement, generated },
    } as const;

    expect(decideVerdict(input)).toMatchObject({
      fault: { kind: "base", cause: "stale-base-drift" },
      budgetEffect: { kind: "consume-environment" },
      remediation: { kind: "mechanical-regeneration", declaration: generated },
      parkNow: false,
    });
    expect(decideVerdict({
      ...input,
      environment: {
        movement: { ...movement, files: [...movement.files, "apps/dev/src/core/verdict.ts"] },
        generated,
      },
    })).toMatchObject({
      budgetEffect: { kind: "charge-branch" },
      remediation: { kind: "agent-correction", reason: "mixed-drift" },
      parkNow: false,
    });
    expect(decideVerdict({ ...input, environment: { movement } })).toMatchObject({
      remediation: { kind: "mechanical-regeneration-skipped", reason: "undeclared" },
    });
    expect(decideVerdict({
      ...input,
      environment: { movement, generated, mechanicalHealFailure: "generator exited 1" },
    })).toMatchObject({
      budgetEffect: { kind: "charge-branch" },
      remediation: {
        kind: "agent-correction",
        reason: "mechanical-regeneration-failed",
        evidence: "generator exited 1",
      },
    });
  });

  it("keeps every environment cause off the branch budget, including exhaustion", () => {
    const cases: ReadonlyArray<{ cause: EnvironmentCause; checks: ClassifiableCheck[]; movement?: {
      startSha: string;
      gateSha: string;
      subjects: string[];
    } }> = [
      { cause: "suspect-infra", checks: [failedCheck()] },
      { cause: "stall", checks: [failedCheck({ suspectInfra: undefined, infra: "stall" })] },
      { cause: "oom", checks: [failedCheck({ suspectInfra: undefined, exitCode: 137 })] },
      { cause: "setup", checks: [failedCheck({ suspectInfra: undefined, summary: "feedback worktree setup failed" })] },
      { cause: "capture-overflow", checks: [failedCheck({ suspectInfra: undefined, summary: "maxBuffer length exceeded" })] },
      { cause: "missing-dependency", checks: [failedCheck({ suspectInfra: undefined, summary: "Cannot find module node_modules/x" })] },
      {
        cause: "stale-base-drift",
        checks: [failedCheck({ suspectInfra: undefined, durationMs: 1200 })],
        movement: { startSha: "aaaa", gateSha: "bbbb", subjects: ["fix: base"] },
      },
    ];

    for (const row of cases) {
      const verdict = decideVerdict({
        checks: row.checks,
        signature: `${SIGNATURE}-${row.cause}`,
        history: {
          environment: ledger([
            { cause: "setup", signature: "old-one" },
            { cause: "oom", signature: "old-two" },
          ]),
          branchBudgetAvailable: true,
        },
        environment: { movement: row.movement },
      });
      expect(verdict.fault).toMatchObject({ cause: row.cause });
      expect(verdict).toMatchObject({ budgetEffect: { kind: "none" }, parkNow: true, parkReason: "environment-exhausted" });
      expect(verdict.budgetEffect.kind).not.toBe("charge-branch");
    }
  });

  it("charges only a healthy-environment branch failure and parks when that budget is unavailable", () => {
    const input = {
      checks: [failedCheck({ suspectInfra: undefined, durationMs: 1200 })],
      signature: SIGNATURE,
      history: { environment: emptyEnvironmentLedger(2), branchBudgetAvailable: true },
      environment: {},
    } as const;
    expect(decideVerdict(input)).toMatchObject({
      fault: { kind: "branch" },
      budgetEffect: { kind: "charge-branch" },
      parkNow: false,
    });
    expect(decideVerdict({ ...input, history: { ...input.history, branchBudgetAvailable: false } })).toMatchObject({
      fault: { kind: "branch" },
      budgetEffect: { kind: "none" },
      parkNow: true,
      parkReason: "branch-exhausted",
    });
  });

  it("never classifies all-green evidence as an environment failure", () => {
    const verdict = decideVerdict({
      checks: [passedCheck()],
      signature: SIGNATURE,
      history: { environment: emptyEnvironmentLedger(2), branchBudgetAvailable: false },
      environment: {},
    });

    expect(verdict.fault).toEqual({ kind: "branch" });
    expect(verdict.budgetEffect).toEqual({ kind: "none" });
  });
});

describe("classification-hook extinction guard", () => {
  it("keeps the removed hook outside the registry and rejects config that tries to restore it", () => {
    const extinct = ["on", "feedback", "classify"].join("_");
    expect(CANONICAL_HOOK_NAMES).not.toContain(extinct);
    expect(() => resolveHooks({ [`afk.hooks.${extinct}`]: "echo forbidden" }, { defaultCommand: () => undefined }))
      .toThrow(UnknownHookError);
  });
});
