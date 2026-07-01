import { describe, expect, it } from "vitest";
import {
  INITIAL_SELF_REPAIR_STATE,
  SELF_REPAIR_DEFAULTS,
  outcomeForFailureKind,
  repairInstructionFor,
  resolveSelfRepairConfig,
  stepSelfRepair,
  type SelfRepairFailureKind,
  type SelfRepairState,
} from "../src/core/self-repair.js";

// self-repair is the UNIFIED attempt-level loop (#940): ONE consecutive-failure
// counter over the three failure kinds, an explicit repair instruction seeded
// into every failed iteration, and a three-strike abort to `ready-for-human`
// with work preserved. These tests pin all four acceptance criteria.

const KINDS: SelfRepairFailureKind[] = [
  "structured-output-invalid",
  "commit-fail",
  "gate-reject",
];

describe("config resolution", () => {
  it("defaults to a three-strike budget", () => {
    expect(SELF_REPAIR_DEFAULTS.maxConsecutiveFailures).toBe(3);
    expect(resolveSelfRepairConfig({})).toEqual(SELF_REPAIR_DEFAULTS);
  });

  it("honours RED_AFK_SELF_REPAIR_MAX when positive", () => {
    expect(resolveSelfRepairConfig({ RED_AFK_SELF_REPAIR_MAX: "5" }).maxConsecutiveFailures).toBe(5);
  });

  it("ignores a non-positive / unparseable override (never abort before a repair)", () => {
    expect(resolveSelfRepairConfig({ RED_AFK_SELF_REPAIR_MAX: "0" }).maxConsecutiveFailures).toBe(3);
    expect(resolveSelfRepairConfig({ RED_AFK_SELF_REPAIR_MAX: "-2" }).maxConsecutiveFailures).toBe(3);
    expect(resolveSelfRepairConfig({ RED_AFK_SELF_REPAIR_MAX: "junk" }).maxConsecutiveFailures).toBe(3);
  });
});

describe("failure-kind → existing vocabulary (consolidation, not a parallel path)", () => {
  it("maps each kind to an established AttemptOutcome", () => {
    expect(outcomeForFailureKind("structured-output-invalid")).toBe("no-sentinel");
    expect(outcomeForFailureKind("commit-fail")).toBe("no-sentinel");
    expect(outcomeForFailureKind("gate-reject")).toBe("feedback-failed");
  });

  it("gives every kind an explicit repair instruction that promises preserved work", () => {
    for (const kind of KINDS) {
      const instruction = repairInstructionFor(kind);
      expect(instruction).toMatch(/^REPAIR:/);
      expect(instruction.toLowerCase()).toContain("preserved");
    }
  });
});

describe("stepSelfRepair — one counter over all three kinds", () => {
  it("seeds a repair instruction and preserves work below the threshold", () => {
    const decision = stepSelfRepair(INITIAL_SELF_REPAIR_STATE, {
      type: "failure",
      kind: "gate-reject",
    });
    expect(decision.action).toBe("repair");
    if (decision.action !== "repair") throw new Error("unreachable");
    expect(decision.strike).toBe(1);
    expect(decision.state.consecutiveFailures).toBe(1);
    expect(decision.instruction).toBe(repairInstructionFor("gate-reject"));
  });

  it("a success resets the counter (budget is for CONSECUTIVE failure)", () => {
    const afterTwo: SelfRepairState = { consecutiveFailures: 2 };
    const decision = stepSelfRepair(afterTwo, { type: "success" });
    expect(decision.action).toBe("reset");
    expect(decision.state).toEqual(INITIAL_SELF_REPAIR_STATE);
  });

  it("counts MIXED kinds as consecutive strikes, not separate budgets", () => {
    // gate-reject → commit-fail → structured-output-invalid: three DIFFERENT
    // kinds, but one shared counter — the third is the three-strike abort.
    let state = INITIAL_SELF_REPAIR_STATE;
    const mixed: SelfRepairFailureKind[] = KINDS; // one of each, in order
    const actions: string[] = [];
    let lastOutcome: string | undefined;
    for (const kind of mixed) {
      const decision = stepSelfRepair(state, { type: "failure", kind });
      state = decision.state;
      actions.push(decision.action);
      if (decision.action === "abort") lastOutcome = decision.outcome;
    }
    expect(actions).toEqual(["repair", "repair", "abort"]);
    expect(state.consecutiveFailures).toBe(3);
    // Aborts under the THIRD failure's own existing outcome vocabulary — the
    // strike that trips the abort is the last kind in `mixed` (gate-reject).
    expect(lastOutcome).toBe(outcomeForFailureKind(mixed[mixed.length - 1]!));
  });

  it("ACCEPTANCE: work preserved + abort to ready-for-human after N consecutive failures", () => {
    // Drive N (=3) consecutive failures of a single kind. Assert:
    //   - the first N-1 are `repair` (work preserved, next iteration seeded);
    //   - the Nth is `abort` under an escalating AttemptOutcome (→ ready-for-human);
    //   - at NO point is a discard signalled (every step returns an instruction
    //     and a monotonically rising counter — the work is never thrown away).
    const config = SELF_REPAIR_DEFAULTS;
    let state = INITIAL_SELF_REPAIR_STATE;
    const trace: string[] = [];
    for (let i = 0; i < config.maxConsecutiveFailures; i++) {
      const decision = stepSelfRepair(state, { type: "failure", kind: "commit-fail" }, config);
      trace.push(decision.action);
      // Every failing step carries a repair instruction — work-preservation is
      // never dropped, even on the aborting strike.
      if (decision.action !== "reset") {
        expect(decision.instruction.length).toBeGreaterThan(0);
        expect(decision.strike).toBe(i + 1);
      }
      state = decision.state;
    }
    expect(trace).toEqual(["repair", "repair", "abort"]);

    const abort = stepSelfRepair(
      { consecutiveFailures: config.maxConsecutiveFailures - 1 },
      { type: "failure", kind: "commit-fail" },
      config,
    );
    expect(abort.action).toBe("abort");
    if (abort.action !== "abort") throw new Error("unreachable");
    // Escalates under the established outcome → the same `ready-for-human`
    // routing recoveryReasonFor/blockedLabelFor already own.
    expect(abort.outcome).toBe("no-sentinel");
    expect(abort.state.consecutiveFailures).toBe(config.maxConsecutiveFailures);
  });

  it("respects a custom threshold from config", () => {
    const config = { maxConsecutiveFailures: 2 };
    const first = stepSelfRepair(INITIAL_SELF_REPAIR_STATE, { type: "failure", kind: "gate-reject" }, config);
    expect(first.action).toBe("repair");
    const second = stepSelfRepair(first.state, { type: "failure", kind: "gate-reject" }, config);
    expect(second.action).toBe("abort");
  });
});
