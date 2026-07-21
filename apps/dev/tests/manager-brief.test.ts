import { decode } from "@reddb-io/toon";
import { describe, expect, it } from "vitest";
import type { EffortRecord } from "../src/core/manager/effort-store.js";
import { renderEffortBrief, renderEmptyPortfolioBrief } from "../src/core/manager/brief.js";

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
