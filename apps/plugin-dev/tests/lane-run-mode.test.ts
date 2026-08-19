// The lane label implies the run mode, enforced at the CLAIM (issue #3026).
import { describe, expect, it } from "vitest";
import { laneRunModeRefusal, requiredRunModeForLane } from "../src/core/lane-run-mode.js";

describe("laneRunModeRefusal — the pure contract", () => {
  it("refuses a scout-lane issue claimed without run_mode=scout, naming the rule", () => {
    const refusal = laneRunModeRefusal(["ready-for-agent", "lane:scout"], undefined);
    expect(refusal).toContain("lane-to-mode contract");
    expect(refusal).toContain("lane:scout");
    expect(refusal).toContain("run_mode=scout");
    expect(refusal).toContain("run_mode=(none)");
  });

  it("refuses a scout-lane issue claimed under a DIFFERENT mode", () => {
    expect(laneRunModeRefusal(["lane:scout"], "no-mistakes")).toContain("run_mode=no-mistakes");
  });

  it("admits the scout dispatch and every lane that imposes no mode", () => {
    expect(laneRunModeRefusal(["lane:scout"], "scout")).toBeUndefined();
    expect(laneRunModeRefusal(["lane:go"], undefined)).toBeUndefined();
    expect(laneRunModeRefusal(["ready-for-agent"], undefined)).toBeUndefined();
  });

  it("answers the required mode per lane, and `undefined` for a label that is no declared lane", () => {
    expect(requiredRunModeForLane("lane:scout")).toBe("scout");
    expect(requiredRunModeForLane("lane:go")).toBeNull();
    expect(requiredRunModeForLane("ready-for-agent")).toBeUndefined();
  });
});

// The enforcement half of this file drove `processIssue`, the dev CLI's engine.
// That body had no shipped caller after #4031 removed the binary, and it is
// deleted now — so what remains here is the contract itself, which the Worker
// carrying the dev skills is the one that has to honour.
