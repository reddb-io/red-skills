import { describe, expect, it } from "vitest";
import { baseMoved, type BaseMovement } from "../src/core/stale-base-drift.js";

function movement(over: Partial<BaseMovement> = {}): BaseMovement {
  return {
    startSha: "aaaaaaa",
    gateSha: "bbbbbbb",
    subjects: ["fix: base"],
    ...over,
  };
}

describe("base movement fact", () => {
  it("is false without complete evidence or when the base stood still", () => {
    expect(baseMoved(undefined)).toBe(false);
    expect(baseMoved(movement({ startSha: "" }))).toBe(false);
    expect(baseMoved(movement({ gateSha: "" }))).toBe(false);
    expect(baseMoved(movement({ gateSha: "aaaaaaa" }))).toBe(false);
  });

  it("is true when the gate-time base head differs from the Worker-start sha", () => {
    expect(baseMoved(movement())).toBe(true);
  });
});
