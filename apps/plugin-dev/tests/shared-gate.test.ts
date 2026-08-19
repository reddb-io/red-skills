import { describe, expect, it, vi } from "vitest";
import {
  classifyFinding,
  MECHANICAL_KINDS,
  allowlistExternalWidened,
  gateVerdict,
  GATE_STAGE_ORDER,
  type GateFinding,
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
    expect(GATE_STAGE_ORDER).toEqual(["feedback", "backpressure", "review"]);
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

  it("names review as the failed stage when the review blocks", () => {
    const verdict = gateVerdict([
      { stage: "feedback", ok: true },
      { stage: "backpressure", ok: true },
      { stage: "review", ok: false },
    ]);
    expect(verdict.ok).toBe(false);
    expect(verdict.failedStage).toBe("review");
  });

  it("a review marked skipped never blocks — it degrades, it does not fail", () => {
    expect(
      gateVerdict([
        { stage: "feedback", ok: true },
        { stage: "backpressure", ok: true },
        { stage: "review", ok: false, skipped: true },
      ]),
    ).toEqual({ ok: true });
  });

  it("does not consult review once an earlier stage blocked", () => {
    const verdict = gateVerdict([
      { stage: "review", ok: false },
      { stage: "backpressure", ok: false },
      { stage: "feedback", ok: false },
    ]);
    expect(verdict.failedStage).toBe("feedback");
  });
});
