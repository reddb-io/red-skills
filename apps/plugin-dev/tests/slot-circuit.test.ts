import { describe, expect, it } from "vitest";
import {
  computeHalfOpenBackoff,
  isHalfOpenDue,
  SLOT_CIRCUIT_DEFAULTS,
  type SlotCircuitConfig,
} from "../src/core/slot-circuit.js";

const BASE = 60;
const CAP = 3600;

function cfg(over: Partial<SlotCircuitConfig> = {}): SlotCircuitConfig {
  return { halfOpenBaseS: BASE, halfOpenCapS: CAP, ...over };
}

// ---------- computeHalfOpenBackoff ----------

describe("computeHalfOpenBackoff", () => {
  it("step 0 returns the base cooldown", () => {
    expect(computeHalfOpenBackoff(0, cfg())).toBe(60);
  });

  it("step 1 returns 2× base", () => {
    expect(computeHalfOpenBackoff(1, cfg())).toBe(120);
  });

  it("step 2 returns 4× base", () => {
    expect(computeHalfOpenBackoff(2, cfg())).toBe(240);
  });

  it("step 3 returns 8× base", () => {
    expect(computeHalfOpenBackoff(3, cfg())).toBe(480);
  });

  it("caps at halfOpenCapS", () => {
    // step 6 → 60 × 64 = 3840, exceeds cap 3600
    expect(computeHalfOpenBackoff(6, cfg())).toBe(3600);
  });

  it("large step still returns cap, not beyond", () => {
    expect(computeHalfOpenBackoff(100, cfg())).toBe(3600);
  });

  it("respects a custom base and cap", () => {
    expect(computeHalfOpenBackoff(0, cfg({ halfOpenBaseS: 30, halfOpenCapS: 300 }))).toBe(30);
    expect(computeHalfOpenBackoff(4, cfg({ halfOpenBaseS: 30, halfOpenCapS: 300 }))).toBe(300); // 30×16=480 > 300
  });

  it("SLOT_CIRCUIT_DEFAULTS has expected values", () => {
    expect(SLOT_CIRCUIT_DEFAULTS.halfOpenBaseS).toBe(60);
    expect(SLOT_CIRCUIT_DEFAULTS.halfOpenCapS).toBe(3600);
  });
});

// ---------- isHalfOpenDue ----------

describe("isHalfOpenDue", () => {
  const TRIP = 1_000_000;

  it("returns false when tripEpoch is 0 (slot never tripped)", () => {
    expect(isHalfOpenDue(0, 0, TRIP + 9999, cfg())).toBe(false);
  });

  it("returns false when not enough time has passed for step 0", () => {
    expect(isHalfOpenDue(TRIP, 0, TRIP + 59, cfg())).toBe(false);
  });

  it("returns true exactly at the step-0 cooldown boundary", () => {
    expect(isHalfOpenDue(TRIP, 0, TRIP + 60, cfg())).toBe(true);
  });

  it("returns true when past the step-0 cooldown", () => {
    expect(isHalfOpenDue(TRIP, 0, TRIP + 120, cfg())).toBe(true);
  });

  it("returns false when not enough time for step 1 (120s)", () => {
    expect(isHalfOpenDue(TRIP, 1, TRIP + 119, cfg())).toBe(false);
  });

  it("returns true exactly at the step-1 cooldown boundary (120s)", () => {
    expect(isHalfOpenDue(TRIP, 1, TRIP + 120, cfg())).toBe(true);
  });

  it("returns false when not enough time for step 2 (240s)", () => {
    expect(isHalfOpenDue(TRIP, 2, TRIP + 239, cfg())).toBe(false);
  });

  it("returns true exactly at the step-2 cooldown boundary (240s)", () => {
    expect(isHalfOpenDue(TRIP, 2, TRIP + 240, cfg())).toBe(true);
  });

  it("uses the cap: step 6 is capped at 3600s, not 3840s", () => {
    expect(isHalfOpenDue(TRIP, 6, TRIP + 3599, cfg())).toBe(false);
    expect(isHalfOpenDue(TRIP, 6, TRIP + 3600, cfg())).toBe(true);
  });

  it("large step uses cap, not astronomically large backoff", () => {
    expect(isHalfOpenDue(TRIP, 100, TRIP + 3599, cfg())).toBe(false);
    expect(isHalfOpenDue(TRIP, 100, TRIP + 3600, cfg())).toBe(true);
  });

  it("handles clock skew: future trip epoch → not due", () => {
    // trip epoch in the future: now - tripEpoch is negative
    expect(isHalfOpenDue(TRIP + 9999, 0, TRIP, cfg())).toBe(false);
  });
});
