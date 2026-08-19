import { describe, expect, it } from "vitest";
import {
  LABEL_MANAGER_MAP,
  MANAGER_MAP_MARKER_PREFIX,
  buildEffortMarker,
  buildMapBody,
  buildMapTitle,
  computeDerivedState,
  computeDesiredLabels,
  computeLabelsToAdd,
  extractEffortIdFromBody,
  planMapPublish,
} from "../src/core/manager/map-reconciler.js";
import type { EffortRecord } from "../src/core/manager/effort-store.js";

const EFFORT: EffortRecord = {
  effort_id: "eff_abcdefghijklmnopqrstuvwxyz",
  name: "walking skeleton",
  intent: "prove the manager persists an effort",
  lifecycle: "inbox",
  generation: 1,
  created_at: "2026-07-21T00:00:00.000Z",
  updated_at: "2026-07-21T00:00:00.000Z",
};

describe("effort-ID marker", () => {
  it("round-trips through extract", () => {
    const marker = buildEffortMarker(EFFORT.effort_id);
    expect(extractEffortIdFromBody(marker)).toBe(EFFORT.effort_id);
  });

  it("returns null when the marker is absent", () => {
    expect(extractEffortIdFromBody("no marker here")).toBeNull();
  });

  it("returns null for a marker whose effort-id does not match the eff_ pattern", () => {
    expect(
      extractEffortIdFromBody("<!-- red-skills:manager-map effort-id=not-an-id v1 -->"),
    ).toBeNull();
  });

  it("returns null when the version tag differs", () => {
    expect(
      extractEffortIdFromBody(
        `<!-- red-skills:manager-map effort-id=${EFFORT.effort_id} v2 -->`,
      ),
    ).toBeNull();
  });

  it("the built marker starts with MANAGER_MAP_MARKER_PREFIX", () => {
    expect(buildEffortMarker(EFFORT.effort_id).startsWith(MANAGER_MAP_MARKER_PREFIX)).toBe(true);
  });
});

describe("map body", () => {
  it("embeds the marker as the first line so it is always present after find-or-create", () => {
    const body = buildMapBody(EFFORT);
    expect(body.split("\n")[0]).toBe(buildEffortMarker(EFFORT.effort_id));
  });

  it("carries the effort name and intent", () => {
    const body = buildMapBody(EFFORT);
    expect(body).toContain(EFFORT.name);
    expect(body).toContain(EFFORT.intent);
  });

  it("does not mirror child-owned fields — frontier, workers, blockers, decisions are absent", () => {
    const body = buildMapBody(EFFORT).toLowerCase();
    for (const field of ["hitl", "blocked", "frontier", "worker", "children", "child_count"]) {
      expect(body).not.toContain(field);
    }
  });

  it("the extracted effort-id from the built body matches the effort", () => {
    const body = buildMapBody(EFFORT);
    expect(extractEffortIdFromBody(body)).toBe(EFFORT.effort_id);
  });
});

describe("map title", () => {
  it("prefixes the effort name with [manager]", () => {
    expect(buildMapTitle(EFFORT)).toBe(`[manager] ${EFFORT.name}`);
  });
});

describe("labels", () => {
  it("desired label set always includes LABEL_MANAGER_MAP", () => {
    expect(computeDesiredLabels()).toContain(LABEL_MANAGER_MAP);
  });

  it("computeLabelsToAdd returns labels not already present", () => {
    expect(computeLabelsToAdd([], [LABEL_MANAGER_MAP])).toEqual([LABEL_MANAGER_MAP]);
  });

  it("computeLabelsToAdd returns empty when all desired labels are present", () => {
    expect(computeLabelsToAdd([LABEL_MANAGER_MAP], [LABEL_MANAGER_MAP])).toEqual([]);
  });

  it("computeLabelsToAdd is additive only — it never removes existing labels", () => {
    const existing = [LABEL_MANAGER_MAP, "some-other-label"];
    const desired = [LABEL_MANAGER_MAP];
    const toAdd = computeLabelsToAdd(existing, desired);
    expect(toAdd).toEqual([]);
    expect(existing).toContain("some-other-label");
  });
});

describe("planMapPublish", () => {
  it("plans create when no existing map is found", () => {
    const plan = planMapPublish(EFFORT, null);
    expect(plan.action).toBe("create");
    expect(plan.mapNumber).toBeUndefined();
  });

  it("plans ok when the existing map already has all desired labels", () => {
    const plan = planMapPublish(EFFORT, { number: 42, labels: [LABEL_MANAGER_MAP] });
    expect(plan.action).toBe("ok");
    expect(plan.mapNumber).toBe(42);
  });

  it("plans update-labels when the map is missing a desired label", () => {
    const plan = planMapPublish(EFFORT, { number: 42, labels: [] });
    expect(plan.action).toBe("update-labels");
    expect(plan.mapNumber).toBe(42);
    expect(plan.labelsToAdd).toContain(LABEL_MANAGER_MAP);
  });

  it("converges — a rerun after update-labels applied the label returns ok", () => {
    const plan = planMapPublish(EFFORT, { number: 42, labels: [LABEL_MANAGER_MAP] });
    expect(plan.action).toBe("ok");
  });

  it("rename-rejoin — the plan is ok when a renamed map still carries the marker label", () => {
    const renamed = { number: 42, labels: [LABEL_MANAGER_MAP] };
    expect(planMapPublish(EFFORT, renamed).action).toBe("ok");
  });
});

describe("computeDerivedState", () => {
  it("carries the map issue number and a child count matching the array length", () => {
    const derived = computeDerivedState(99, [1, 2, 3]);
    expect(derived.map_issue).toBe(99);
    expect(derived.child_count).toBe(3);
    expect(derived.children).toEqual([1, 2, 3]);
  });

  it("carries null map_issue and zero children when no map has been published", () => {
    const derived = computeDerivedState(null, []);
    expect(derived.map_issue).toBeNull();
    expect(derived.child_count).toBe(0);
    expect(derived.children).toEqual([]);
  });

  it("child_count matches the children array even with many children", () => {
    const children = Array.from({ length: 50 }, (_, i) => i + 1);
    const derived = computeDerivedState(7, children);
    expect(derived.child_count).toBe(50);
    expect(derived.children).toHaveLength(50);
  });
});
