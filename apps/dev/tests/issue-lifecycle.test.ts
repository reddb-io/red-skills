import { describe, expect, it } from "vitest";
import {
  ISSUE_LIFECYCLE_TRANSITIONS,
  IllegalIssueLifecycleTransitionError,
  LANE_ISOLATION_LABELS,
  LaneIsolationViolationError,
  classifyIssueLifecycleState,
  laneIsolationRefusal,
  validateIssueLifecycleTransition,
  type IssueLifecycleEdge,
} from "../src/core/issue-lifecycle.js";

describe("issue lifecycle transition table", () => {
  it("classifies lifecycle states from the triage label vocabulary", () => {
    expect(classifyIssueLifecycleState(["ready-for-agent"])).toBe("ready-for-agent");
    expect(classifyIssueLifecycleState(["running"])).toBe("claimed/active");
    expect(classifyIssueLifecycleState(["blocked:dependency"])).toBe("blocked:dependency");
    expect(classifyIssueLifecycleState(["ready-for-human", "blocked:validation"])).toBe("blocked:validation");
    expect(classifyIssueLifecycleState(["ready-for-human"])).toBe("ready-for-human");
    expect(classifyIssueLifecycleState(["ready-for-human", "landing:manual"])).toBe("landing:manual");
  });

  it("has table rows for every edge the runtime validates", () => {
    const edges = new Set(ISSUE_LIFECYCLE_TRANSITIONS.map((row) => row.edge));
    const expected: IssueLifecycleEdge[] = [
      "claim",
      "contest",
      "contest-expired",
      "contest-reclaimed",
      "retry",
      "dependency-unblocked",
      "dependency-blocked",
      "preflight-blocked",
      "validation-blocked",
      "human-blocked",
      "human-delegable",
      "manual-landing",
      "close",
      "requeue",
      "requeue-mixed-blocked-refusal",
    ];
    expect([...edges].sort()).toEqual([...expected].sort());
  });

  it("accepts legal AFK runtime transitions", () => {
    expect(
      validateIssueLifecycleTransition({
        edge: "claim",
        fromLabels: ["ready-for-agent"],
        removeLabels: ["ready-for-agent"],
        addLabels: ["running"],
      }),
    ).toEqual(["running"]);

    expect(
      validateIssueLifecycleTransition({
        edge: "validation-blocked",
        fromLabels: ["running"],
        removeLabels: ["running"],
        addLabels: ["ready-for-human", "blocked:validation"],
      }).sort(),
    ).toEqual(["blocked:validation", "ready-for-human"]);

    expect(
      validateIssueLifecycleTransition({
        edge: "retry",
        fromLabels: ["running"],
        removeLabels: ["running"],
        addLabels: ["ready-for-agent"],
      }),
    ).toEqual(["ready-for-agent"]);

    expect(
      validateIssueLifecycleTransition({
        edge: "contest",
        fromLabels: ["running"],
        removeLabels: [],
        addLabels: ["contested"],
      }).sort(),
    ).toEqual(["contested", "running"]);

    expect(
      validateIssueLifecycleTransition({
        edge: "contest-reclaimed",
        fromLabels: ["running", "contested"],
        removeLabels: ["contested"],
        addLabels: [],
      }),
    ).toEqual(["running"]);

    expect(
      validateIssueLifecycleTransition({
        edge: "contest-expired",
        fromLabels: ["running", "contested"],
        removeLabels: ["running", "contested"],
        addLabels: ["ready-for-agent"],
      }),
    ).toEqual(["ready-for-agent"]);
  });

  it("accepts legal requeue and HITL transitions", () => {
    expect(
      validateIssueLifecycleTransition({
        edge: "requeue",
        fromLabels: ["ready-for-human", "blocked:spec"],
        removeLabels: ["ready-for-human", "blocked:spec"],
        addLabels: ["ready-for-agent"],
      }),
    ).toEqual(["ready-for-agent"]);

    expect(
      validateIssueLifecycleTransition({
        edge: "human-delegable",
        fromLabels: ["ready-for-human", "blocked:validation"],
        removeLabels: ["ready-for-human", "blocked:validation"],
        addLabels: ["ready-for-agent"],
      }),
    ).toEqual(["ready-for-agent"]);
  });

  it("parks a mixed-blocked issue cleanly through preflight-blocked (#1481)", () => {
    // A queued issue carrying a stale `blocked:spec` classifies as illegal. The
    // preflight park sheds every blocked:* in the same edit and lands on a clean
    // ready-for-human — the `from: "*"` row must accept the illegal start state.
    expect(
      validateIssueLifecycleTransition({
        edge: "preflight-blocked",
        fromLabels: ["ready-for-agent", "blocked:validation"],
        removeLabels: ["ready-for-agent", "blocked:validation"],
        addLabels: ["ready-for-human", "blocked:spec"],
      }).sort(),
    ).toEqual(["blocked:spec", "ready-for-human"]);

    // The plain queued → parked case still works (no blocked:* to shed).
    expect(
      validateIssueLifecycleTransition({
        edge: "preflight-blocked",
        fromLabels: ["ready-for-agent"],
        removeLabels: ["ready-for-agent"],
        addLabels: ["ready-for-human"],
      }),
    ).toEqual(["ready-for-human"]);
  });

  it("rejects illegal mixed blocked states through a table edge", () => {
    expect(() =>
      validateIssueLifecycleTransition({
        edge: "requeue-mixed-blocked-refusal",
        fromLabels: ["ready-for-human", "blocked:validation", "blocked:spec"],
        removeLabels: [],
        addLabels: [],
      }),
    ).toThrow(/mixed blocked:\* labels \[blocked:validation, blocked:spec\]/);
  });

  it("rejects illegal transitions with an actionable edge name", () => {
    let thrown: unknown;
    try {
      // `claim` normalizes any pre-active state INTO claimed/active, so it is the
      // destination that constrains it: a claim that lands somewhere other than
      // claimed/active (here ready-for-human) has no legal row.
      validateIssueLifecycleTransition({
        edge: "claim",
        fromLabels: ["ready-for-agent"],
        removeLabels: ["ready-for-agent"],
        addLabels: ["ready-for-human"],
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(IllegalIssueLifecycleTransitionError);
    expect((thrown as Error).message).toContain('illegal issue lifecycle transition "claim"');
    expect((thrown as Error).message).toContain("no legal row");
  });

  // #2894 — `/go` and scout isolation rests on the lane label never sharing an
  // issue with `ready-for-agent`. The lifecycle model previously knew only about
  // parks and blocks, so a `from: "*"` promote edge could legally reach a
  // lane-isolated issue and hand one dispatch to two pools at once.
  describe("lane isolation (#2894)", () => {
    it("refuses every from-* promote edge against a lane-isolated issue", () => {
      const promoteAnywhere = ISSUE_LIFECYCLE_TRANSITIONS.filter(
        (row) => row.from === "*" && row.to === "ready-for-agent",
      );
      // The edge this fixture exists for must actually be in the table — an empty
      // list would make the loop below vacuously green.
      expect(promoteAnywhere.map((row) => row.edge)).toContain("human-delegable");

      for (const row of promoteAnywhere) {
        for (const lane of LANE_ISOLATION_LABELS) {
          let thrown: unknown;
          try {
            validateIssueLifecycleTransition({
              edge: row.edge,
              fromLabels: [lane, "ready-for-human"],
              removeLabels: ["ready-for-human"],
              addLabels: ["ready-for-agent"],
            });
          } catch (error) {
            thrown = error;
          }
          expect(thrown).toBeInstanceOf(LaneIsolationViolationError);
          // The refusal names the EDGE that attempted it, not just the label.
          expect((thrown as Error).message).toContain(`"${row.edge}"`);
          expect((thrown as Error).message).toContain(lane);
        }
      }
    });

    it("refuses a promote that carries the lane in the ADD set", () => {
      expect(() =>
        validateIssueLifecycleTransition({
          edge: "requeue",
          fromLabels: ["ready-for-human"],
          removeLabels: ["ready-for-human"],
          addLabels: ["ready-for-agent", "lane:go"],
        }),
      ).toThrow(LaneIsolationViolationError);
    });

    it("leaves non-promoting lane transitions and ordinary promotes alone", () => {
      // Claiming a lane:go issue is the lane's NORMAL path — it never touches
      // ready-for-agent, so isolation has nothing to say about it.
      expect(
        validateIssueLifecycleTransition({
          edge: "claim",
          fromLabels: ["lane:go", "ready-for-human"],
          removeLabels: ["ready-for-human"],
          addLabels: ["running"],
        }).sort(),
      ).toEqual(["lane:go", "running"]);

      // A plain backlog issue promotes exactly as before.
      expect(laneIsolationRefusal("requeue", ["ready-for-agent"])).toBeNull();
      // The lane alone, with no promotion in sight, is clean.
      expect(laneIsolationRefusal("requeue", ["lane:scout", "running"])).toBeNull();
    });

    it("names the origin for a write that declares no lifecycle edge", () => {
      const refusal = laneIsolationRefusal("direct label write", ["lane:go", "ready-for-agent"]);
      expect(refusal).toBeInstanceOf(LaneIsolationViolationError);
      expect(refusal?.message).toContain("direct label write");
      expect(refusal?.lane).toBe("lane:go");
    });
  });

  it("rejects impossible queued or active blocked label combinations", () => {
    expect(() =>
      validateIssueLifecycleTransition({
        edge: "retry",
        fromLabels: ["running"],
        removeLabels: ["running"],
        addLabels: ["ready-for-agent", "blocked:validation"],
      }),
    ).toThrow(/queued\/active issue cannot also carry blocked:\*/);

    expect(() =>
      validateIssueLifecycleTransition({
        edge: "contest-expired",
        fromLabels: ["running"],
        removeLabels: ["running"],
        addLabels: ["ready-for-agent"],
      }),
    ).toThrow(/no legal row/);
  });
});
