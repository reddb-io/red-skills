import { describe, expect, it, vi } from "vitest";
import {
  classifyFinding,
  runSharedGate,
  makeHeadlessSink,
  makeInteractiveSink,
  MECHANICAL_KINDS,
  allowlistExternalWidened,
  gateVerdict,
  GATE_STAGE_ORDER,
  type EscalationOutcome,
  type GateFinding,
  type SharedGateDeps,
} from "../src/core/shared-gate.js";
import { FOWLER_REFACTORING_SMELLS } from "../src/core/review-extract.js";

// shared-gate — closed mechanical allowlist + context-aware escalation (#931).
//
// Acceptance criteria:
//   1. Mechanical allowlist is closed and auditable — anything not on it is intent.
//   2. Mechanical findings auto-apply + commit.
//   3. Intent findings escalate (never auto-committed).
//   4. Escalation sink switches by context: interactive pause vs headless park.
//   5. Tests cover both sinks and the "default = intent" boundary.

function finding(kind: string, description = "test finding"): GateFinding {
  return { kind, description };
}

function makeDeps(
  applied: GateFinding[] = [],
  escalationOutcome: EscalationOutcome = "approved",
): SharedGateDeps {
  return {
    applyMechanical: vi.fn(async (f) => {
      applied.push(f);
    }),
    escalateIntent: vi.fn(async (): Promise<EscalationOutcome> => escalationOutcome),
  };
}

// ---------- classifyFinding ----------

describe("classifyFinding — closed allowlist", () => {
  it("classifies every enumerated mechanical kind as mechanical", () => {
    for (const kind of MECHANICAL_KINDS) {
      expect(classifyFinding(finding(kind))).toBe("mechanical");
    }
  });

  it("classifies an unknown kind as intent (default = intent)", () => {
    expect(classifyFinding(finding("logic-change"))).toBe("intent");
    expect(classifyFinding(finding("type-error"))).toBe("intent");
    expect(classifyFinding(finding("test-expectation-change"))).toBe("intent");
    expect(classifyFinding(finding("library-upgrade"))).toBe("intent");
  });

  it("treats an empty kind as intent (not mechanical)", () => {
    expect(classifyFinding(finding(""))).toBe("intent");
  });

  it("is case-sensitive — Formatter is not formatter", () => {
    expect(classifyFinding(finding("Formatter"))).toBe("intent");
    expect(classifyFinding(finding("LINT-FIX"))).toBe("intent");
  });

  it("classifies Fowler smell findings as intent, never mechanical auto-applies", () => {
    for (const [smell] of FOWLER_REFACTORING_SMELLS) {
      expect(classifyFinding(finding(smell))).toBe("intent");
    }
  });
});

// ---------- runSharedGate — mechanical path ----------

describe("runSharedGate — mechanical findings", () => {
  it("auto-applies all mechanical findings and passes", async () => {
    const applied: GateFinding[] = [];
    const deps = makeDeps(applied);
    const findings = [finding("formatter"), finding("trailing-whitespace")];

    const result = await runSharedGate(findings, deps);

    expect(result.passed).toBe(true);
    expect(result.mechanicalApplied).toBe(2);
    expect(result.intentEscalated).toBe(0);
    expect(applied).toHaveLength(2);
    expect(result.resolutions[0].applied).toBe(true);
    expect(result.resolutions[1].applied).toBe(true);
  });

  it("calls applyMechanical once per mechanical finding in order", async () => {
    const callOrder: string[] = [];
    const deps: SharedGateDeps = {
      applyMechanical: vi.fn(async (f) => {
        callOrder.push(f.kind);
      }),
      escalateIntent: vi.fn(async (): Promise<EscalationOutcome> => "approved"),
    };

    await runSharedGate(
      [finding("import-organizer"), finding("lint-fix"), finding("comment-typo")],
      deps,
    );

    expect(callOrder).toEqual(["import-organizer", "lint-fix", "comment-typo"]);
  });

  it("never calls escalateIntent for a mechanical finding", async () => {
    const deps = makeDeps();
    await runSharedGate([finding("formatter"), finding("trailing-newline")], deps);
    expect(deps.escalateIntent).not.toHaveBeenCalled();
  });

  it("passes with no findings (empty set)", async () => {
    const deps = makeDeps();
    const result = await runSharedGate([], deps);
    expect(result.passed).toBe(true);
    expect(result.mechanicalApplied).toBe(0);
    expect(result.intentEscalated).toBe(0);
    expect(result.resolutions).toHaveLength(0);
  });
});

// ---------- runSharedGate — intent path ----------

describe("runSharedGate — intent findings", () => {
  it("escalates an intent finding and passes when approved", async () => {
    const deps = makeDeps([], "approved");
    const result = await runSharedGate([finding("logic-change")], deps);

    expect(result.passed).toBe(true);
    expect(result.intentEscalated).toBe(1);
    expect(result.mechanicalApplied).toBe(0);
    expect(result.resolutions[0].escalationOutcome).toBe("approved");
  });

  it("fails when an intent finding is parked (headless sink)", async () => {
    const deps = makeDeps([], "parked");
    const result = await runSharedGate([finding("function-rename")], deps);

    expect(result.passed).toBe(false);
    expect(result.intentEscalated).toBe(1);
    expect(result.resolutions[0].escalationOutcome).toBe("parked");
  });

  it("fails when an intent finding is skipped (interactive sink)", async () => {
    const deps = makeDeps([], "skipped");
    const result = await runSharedGate([finding("test-expectation-change")], deps);

    expect(result.passed).toBe(false);
    expect(result.resolutions[0].escalationOutcome).toBe("skipped");
  });

  it("never calls applyMechanical for an intent finding", async () => {
    const deps = makeDeps([], "approved");
    await runSharedGate([finding("library-upgrade")], deps);
    expect(deps.applyMechanical).not.toHaveBeenCalled();
  });
});

// ---------- runSharedGate — mixed findings ----------

describe("runSharedGate — mixed mechanical + intent", () => {
  it("auto-applies mechanical and escalates intent in one pass", async () => {
    const applied: GateFinding[] = [];
    const deps: SharedGateDeps = {
      applyMechanical: vi.fn(async (f) => {
        applied.push(f);
      }),
      escalateIntent: vi.fn(async (): Promise<EscalationOutcome> => "approved"),
    };

    const findings = [
      finding("formatter"),
      finding("logic-change"),
      finding("trailing-whitespace"),
      finding("type-error"),
    ];

    const result = await runSharedGate(findings, deps);

    expect(result.passed).toBe(true);
    expect(result.mechanicalApplied).toBe(2);
    expect(result.intentEscalated).toBe(2);
    expect(applied.map((f) => f.kind)).toEqual(["formatter", "trailing-whitespace"]);
  });

  it("fails when any intent finding blocks even if mechanical ones applied", async () => {
    const deps: SharedGateDeps = {
      applyMechanical: vi.fn(async () => {}),
      escalateIntent: vi.fn(async (): Promise<EscalationOutcome> => "parked"),
    };

    const result = await runSharedGate(
      [finding("formatter"), finding("logic-change")],
      deps,
    );

    expect(result.passed).toBe(false);
    expect(result.mechanicalApplied).toBe(1);
    expect(result.intentEscalated).toBe(1);
  });
});

// ---------- headless sink ----------

describe("makeHeadlessSink — headless escalation", () => {
  it("always returns parked and calls the park callback", async () => {
    const parked: GateFinding[] = [];
    const sink = makeHeadlessSink(async (f) => {
      parked.push(f);
    });

    const f = finding("function-rename");
    const outcome = await sink(f);

    expect(outcome).toBe("parked");
    expect(parked).toHaveLength(1);
    expect(parked[0]).toBe(f);
  });

  it("parks every intent finding in a batch via runSharedGate", async () => {
    const parked: string[] = [];
    const sink = makeHeadlessSink(async (f) => {
      parked.push(f.kind);
    });

    const deps: SharedGateDeps = {
      applyMechanical: vi.fn(async () => {}),
      escalateIntent: sink,
    };

    const result = await runSharedGate(
      [finding("logic-a"), finding("logic-b")],
      deps,
    );

    expect(result.passed).toBe(false);
    expect(parked).toEqual(["logic-a", "logic-b"]);
  });
});

// ---------- interactive sink ----------

describe("makeInteractiveSink — interactive escalation", () => {
  it("returns approved when the user approves", async () => {
    const sink = makeInteractiveSink(async () => "approved");
    expect(await sink(finding("type-change"))).toBe("approved");
  });

  it("returns skipped when the user skips", async () => {
    const sink = makeInteractiveSink(async () => "skipped");
    expect(await sink(finding("type-change"))).toBe("skipped");
  });

  it("passes the finding to the prompt callback", async () => {
    let received: GateFinding | undefined;
    const sink = makeInteractiveSink(async (f) => {
      received = f;
      return "approved";
    });

    const f = finding("library-upgrade", "bumped react to v19");
    await sink(f);
    expect(received).toBe(f);
  });

  it("marks gate passed when user approves all intent findings", async () => {
    const sink = makeInteractiveSink(async () => "approved");
    const deps: SharedGateDeps = {
      applyMechanical: vi.fn(async () => {}),
      escalateIntent: sink,
    };

    const result = await runSharedGate(
      [finding("logic-change"), finding("function-rename")],
      deps,
    );

    expect(result.passed).toBe(true);
    expect(result.intentEscalated).toBe(2);
  });

  it("marks gate failed when user skips an intent finding", async () => {
    const sink = makeInteractiveSink(async () => "skipped");
    const deps: SharedGateDeps = {
      applyMechanical: vi.fn(async () => {}),
      escalateIntent: sink,
    };

    const result = await runSharedGate([finding("type-error")], deps);

    expect(result.passed).toBe(false);
    expect(result.resolutions[0].escalationOutcome).toBe("skipped");
  });
});

// ---------- diff-aware allowlist exemption ----------

const allowlistJson = (entries: { id: string; classification: string; reason?: string }[]) =>
  JSON.stringify({ version: 1, entries }, null, 2);
const mig = (id: string) => ({ id, classification: "migrate" });
const ext = (id: string, reason: string) => ({ id, classification: "external", reason });

describe("allowlistExternalWidened — trust-preserving allowlist diff", () => {
  it("removing a migrate entry is safe (not widened)", () => {
    const oldC = allowlistJson([mig("a#k#1"), mig("b#k#2"), ext("c#k#3", "MCP config")]);
    const newC = allowlistJson([mig("a#k#1"), ext("c#k#3", "MCP config")]);
    expect(allowlistExternalWidened(oldC, newC)).toBe(false);
  });

  it("removing an external entry is safe (shrinking the exception set)", () => {
    const oldC = allowlistJson([ext("c#k#3", "MCP config"), mig("a#k#1")]);
    const newC = allowlistJson([mig("a#k#1")]);
    expect(allowlistExternalWidened(oldC, newC)).toBe(false);
  });

  it("adding a new external entry is widened (unsafe)", () => {
    const oldC = allowlistJson([mig("a#k#1")]);
    const newC = allowlistJson([mig("a#k#1"), ext("new#k#9", "sneaked in")]);
    expect(allowlistExternalWidened(oldC, newC)).toBe(true);
  });

  it("changing an external entry's reason is widened (unsafe)", () => {
    const oldC = allowlistJson([ext("c#k#3", "MCP config")]);
    const newC = allowlistJson([ext("c#k#3", "now something else")]);
    expect(allowlistExternalWidened(oldC, newC)).toBe(true);
  });

  it("flipping a migrate entry to external is widened (unsafe)", () => {
    const oldC = allowlistJson([mig("a#k#1")]);
    const newC = allowlistJson([ext("a#k#1", "reclassified")]);
    expect(allowlistExternalWidened(oldC, newC)).toBe(true);
  });

  it("adding a migrate entry is safe (tracked debt, not a guard bypass)", () => {
    const oldC = allowlistJson([mig("a#k#1")]);
    const newC = allowlistJson([mig("a#k#1"), mig("b#k#2")]);
    expect(allowlistExternalWidened(oldC, newC)).toBe(false);
  });

  it("unparseable new content fails closed (treated as widened)", () => {
    const oldC = allowlistJson([mig("a#k#1")]);
    expect(allowlistExternalWidened(oldC, "{ not json")).toBe(true);
  });

  it("identical content is not widened", () => {
    const c = allowlistJson([mig("a#k#1"), ext("c#k#3", "MCP config")]);
    expect(allowlistExternalWidened(c, c)).toBe(false);
  });
});

// ---------- "default = intent" boundary ----------

describe("default = intent boundary", () => {
  it("a near-miss kind (e.g. 'format' vs 'formatter') is intent", () => {
    expect(classifyFinding(finding("format"))).toBe("intent");
    expect(classifyFinding(finding("lint"))).toBe("intent");
    expect(classifyFinding(finding("whitespace"))).toBe("intent");
  });

  it("a kind that is a prefix of a mechanical kind is still intent", () => {
    expect(classifyFinding(finding("trailing"))).toBe("intent");
    expect(classifyFinding(finding("import"))).toBe("intent");
  });

  it("a concatenated kind that contains a mechanical substring is intent", () => {
    expect(classifyFinding(finding("formatter-plus-logic"))).toBe("intent");
    expect(classifyFinding(finding("custom-lint-fix"))).toBe("intent");
  });

  it("MECHANICAL_KINDS are all lowercase (no hidden casing exceptions)", () => {
    for (const kind of MECHANICAL_KINDS) {
      expect(kind).toBe(kind.toLowerCase());
    }
  });
});

// ---------- ordered gate verdict (issue #2245) ----------

describe("gateVerdict — one verdict, cheap stage first", () => {
  it("orders the stages cheap → expensive", () => {
    expect(GATE_STAGE_ORDER).toEqual(["feedback", "backpressure"]);
  });

  it("is green when every stage passed", () => {
    expect(
      gateVerdict([
        { stage: "feedback", ok: true },
        { stage: "backpressure", ok: true },
      ]),
    ).toEqual({ ok: true });
  });

  it("reports the EARLIEST blocking stage, not the first one evaluated", () => {
    const verdict = gateVerdict([
      { stage: "backpressure", ok: false },
      { stage: "feedback", ok: false },
    ]);
    expect(verdict.ok).toBe(false);
    expect(verdict.failedStage).toBe("feedback");
  });

  it("a skipped stage never blocks", () => {
    expect(
      gateVerdict([
        { stage: "feedback", ok: true },
        { stage: "backpressure", ok: false, skipped: true },
      ]),
    ).toEqual({ ok: true });
  });

  it("folds the stages run so far — a partial gate is still one verdict", () => {
    expect(gateVerdict([{ stage: "feedback", ok: true }])).toEqual({ ok: true });
    expect(gateVerdict([]).ok).toBe(true);
  });
});
