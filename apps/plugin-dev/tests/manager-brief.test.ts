import { decode } from "@reddb-io/toon";
import { describe, expect, it } from "vitest";
import type { EffortRecord } from "../src/core/manager/effort-store.js";
import {
  renderEffortBrief,
  renderEffortBriefWithDerived,
  renderEmptyPortfolioBrief,
} from "../src/core/manager/brief.js";
import type { ManagerMapDerivedState } from "../src/core/manager/map-reconciler.js";

const EFFORT: EffortRecord = {
  effort_id: "eff_abcdefghijklmnopqrstuvwxyz",
  name: "walking skeleton",
  intent: "prove the manager persists an effort",
  lifecycle: "inbox",
  generation: 3,
  created_at: "2026-07-21T00:00:00.000Z",
  updated_at: "2026-07-21T01:00:00.000Z",
};

describe("effort brief", () => {
  it("renders the owned lifecycle state as TOON", () => {
    const brief = decode(renderEffortBrief(EFFORT)) as Record<string, unknown>;
    expect(brief).toEqual({
      kind: "manager.brief",
      state_source: "owned",
      effort_id: EFFORT.effort_id,
      name: EFFORT.name,
      lifecycle: "inbox",
      generation: 3,
      intent: EFFORT.intent,
      created_at: EFFORT.created_at,
      updated_at: EFFORT.updated_at,
    });
  });

  it("carries no derived state, which later slices reconcile instead of storing", () => {
    const brief = decode(renderEffortBrief(EFFORT)) as Record<string, unknown>;
    for (const derived of ["hitl", "blocked", "frontier", "tracker"]) {
      expect(Object.keys(brief)).not.toContain(derived);
    }
  });

  it("renders an explicit empty brief when the portfolio holds no effort", () => {
    const brief = decode(renderEmptyPortfolioBrief()) as Record<string, unknown>;
    expect(brief).toEqual({ kind: "manager.brief", state_source: "owned", efforts: 0 });
  });
});

describe("effort brief with derived state (slice #2294)", () => {
  const DERIVED_WITH_MAP: ManagerMapDerivedState = {
    map_issue: 42,
    child_count: 3,
    children: [10, 20, 30],
  };

  const DERIVED_NO_MAP: ManagerMapDerivedState = {
    map_issue: null,
    child_count: 0,
    children: [],
  };

  it("renders state_source as reconciled, not owned", () => {
    const brief = decode(renderEffortBriefWithDerived(EFFORT, DERIVED_WITH_MAP)) as Record<
      string,
      unknown
    >;
    expect(brief.state_source).toBe("reconciled");
  });

  it("carries the map issue number in map_issue", () => {
    const brief = decode(renderEffortBriefWithDerived(EFFORT, DERIVED_WITH_MAP)) as Record<
      string,
      unknown
    >;
    expect(brief.map_issue).toBe(42);
  });

  it("carries the child count in child_count", () => {
    const brief = decode(renderEffortBriefWithDerived(EFFORT, DERIVED_WITH_MAP)) as Record<
      string,
      unknown
    >;
    expect(brief.child_count).toBe(3);
  });

  it("carries null map_issue when no map has been published yet", () => {
    const brief = decode(renderEffortBriefWithDerived(EFFORT, DERIVED_NO_MAP)) as Record<
      string,
      unknown
    >;
    expect(brief.map_issue).toBeNull();
    expect(brief.child_count).toBe(0);
  });

  it("still carries all owned lifecycle fields alongside derived state", () => {
    const brief = decode(renderEffortBriefWithDerived(EFFORT, DERIVED_WITH_MAP)) as Record<
      string,
      unknown
    >;
    expect(brief.effort_id).toBe(EFFORT.effort_id);
    expect(brief.name).toBe(EFFORT.name);
    expect(brief.lifecycle).toBe("inbox");
    expect(brief.generation).toBe(3);
    expect(brief.intent).toBe(EFFORT.intent);
  });

  it("does not store the children array in the brief — brief carries count only", () => {
    const brief = decode(renderEffortBriefWithDerived(EFFORT, DERIVED_WITH_MAP)) as Record<
      string,
      unknown
    >;
    expect(Object.keys(brief)).not.toContain("children");
  });
});

describe("effort brief with execution artifact state (slice #2295)", () => {
  const DERIVED_WITH_EXECUTION: ManagerMapDerivedState = {
    map_issue: 42,
    child_count: 1,
    children: [200],
    execution: {
      issue_number: 200,
      state: "open",
      labels: ["ready-for-agent"],
      pr_numbers: [],
    },
  };

  const DERIVED_WITHOUT_EXECUTION: ManagerMapDerivedState = {
    map_issue: 42,
    child_count: 0,
    children: [],
  };

  it("carries execution_issue and execution_state when an execution was dispatched", () => {
    const brief = decode(
      renderEffortBriefWithDerived(EFFORT, DERIVED_WITH_EXECUTION),
    ) as Record<string, unknown>;
    expect(brief.execution_issue).toBe(200);
    expect(brief.execution_state).toBe("open");
  });

  it("carries closed execution_state when the execution issue is closed", () => {
    const derivedClosed: ManagerMapDerivedState = {
      ...DERIVED_WITH_EXECUTION,
      execution: { ...DERIVED_WITH_EXECUTION.execution!, state: "closed" },
    };
    const brief = decode(renderEffortBriefWithDerived(EFFORT, derivedClosed)) as Record<
      string,
      unknown
    >;
    expect(brief.execution_state).toBe("closed");
  });

  it("omits execution_issue and execution_state when no dispatch has occurred", () => {
    const brief = decode(
      renderEffortBriefWithDerived(EFFORT, DERIVED_WITHOUT_EXECUTION),
    ) as Record<string, unknown>;
    expect(Object.keys(brief)).not.toContain("execution_issue");
    expect(Object.keys(brief)).not.toContain("execution_state");
  });

  it("omits execution_issue and execution_state when execution is null", () => {
    const derivedNull: ManagerMapDerivedState = {
      map_issue: 42,
      child_count: 0,
      children: [],
      execution: null,
    };
    const brief = decode(renderEffortBriefWithDerived(EFFORT, derivedNull)) as Record<
      string,
      unknown
    >;
    expect(Object.keys(brief)).not.toContain("execution_issue");
    expect(Object.keys(brief)).not.toContain("execution_state");
  });

  it("still carries state_source as reconciled with execution state", () => {
    const brief = decode(
      renderEffortBriefWithDerived(EFFORT, DERIVED_WITH_EXECUTION),
    ) as Record<string, unknown>;
    expect(brief.state_source).toBe("reconciled");
  });
});
