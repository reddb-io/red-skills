/**
 * The lane-to-mode invariant: every lane the drain isolates declares the run
 * mode it implies, and the claim path is what enforces it (issue #3026,
 * Spec #3022).
 *
 * Three properties are load-bearing. The contract covers the castle's live
 * `laneIsolated` set in BOTH directions, so a NEW isolated lane cannot land
 * without stating its mode and a removed one cannot linger as fiction — that is
 * the drift the scout lane already suffered, its mode carried by one caller's
 * argv rather than by the pair itself. Every declared entry states WHY, because
 * a table of pairs nobody can read is one the next author overrides. And the
 * claim path actually consults the contract, because a table no enforcement
 * point imports is green by accident.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CASTLE_SELECTION_LABELS } from "@reddb-io/red-castle/engine";
import {
  LANE_RUN_MODE_CONTRACT,
  laneRunModeRefusal,
  requiredRunModeForLane,
} from "../src/core/lane-run-mode.js";
import { REPO_INVARIANT_SUITES } from "../src/core/repo-invariants.js";

const CLAIM_PATH = join(import.meta.dirname, "..", "src", "core", "process-issue", "lifecycle.ts");

describe("lane-to-mode contract (#3026)", () => {
  it("declares exactly the lanes the castle drain isolates — no gap, no fiction", () => {
    const declared = LANE_RUN_MODE_CONTRACT.map((c) => c.lane).sort();
    const isolated = [...DEFAULT_CASTLE_SELECTION_LABELS.laneIsolated].sort();
    expect(declared).toEqual(isolated);
  });

  it("declares each lane once, with a reason", () => {
    const lanes = LANE_RUN_MODE_CONTRACT.map((c) => c.lane);
    expect(new Set(lanes).size).toBe(lanes.length);
    for (const contract of LANE_RUN_MODE_CONTRACT) {
      expect(contract.why.trim().length).toBeGreaterThan(20);
      expect(contract.lane.startsWith("lane:")).toBe(true);
    }
  });

  it("pins the scout pair — the one the live drift broke", () => {
    expect(requiredRunModeForLane("lane:scout")).toBe("scout");
    expect(laneRunModeRefusal(["lane:scout"], undefined)).toBeDefined();
    expect(laneRunModeRefusal(["lane:scout"], "scout")).toBeUndefined();
  });

  it("is enforced at the CLAIM, not at a dispatcher", () => {
    const source = readFileSync(CLAIM_PATH, "utf8");
    expect(source).toContain("laneRunModeRefusal");
  });

  it("runs in every gate cone as a repo-wide invariant", () => {
    const names = REPO_INVARIANT_SUITES.map((s) => s.name);
    expect(names).toContain("invariants:lane-run-mode");
  });
});
