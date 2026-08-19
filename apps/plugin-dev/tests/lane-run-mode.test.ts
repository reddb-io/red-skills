// The lane label implies the run mode, enforced at the CLAIM (issue #3026).
import { describe, expect, harness, it, processIssue } from "./process-issue.test-helpers.js";
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

describe("processIssue — lane-to-mode enforcement at the claim (#3026)", () => {
  it("refuses a scout-lane issue picked up by a plain run, before any claim or agent run", async () => {
    const { deps, input, trace } = harness({
      outcome: "done",
      labels: ["ready-for-agent", "lane:scout"],
    });
    const result = await processIssue(deps, input);
    expect(result.outcome).toBe("claim-lost");
    expect(trace.iterLogs.join("\n")).toContain("lane-to-mode contract");
    expect(trace.iterLogs.join("\n")).toContain("run_mode=scout");
    // Nothing was claimed, labelled, commented on, or run.
    expect(trace.runAgentCalls).toHaveLength(0);
    expect(trace.labelEdits).toHaveLength(0);
    expect(trace.comments).toHaveLength(0);
  });

  it("still runs the same issue read-only through the scout dispatch path", async () => {
    const { deps, input, trace } = harness({
      outcome: "done",
      labels: ["lane:scout"],
      laneLabel: "lane:scout",
      runMode: "scout",
    });
    const result = await processIssue(deps, input);
    expect(result.outcome).not.toBe("claim-lost");
    expect(trace.iterLogs.join("\n")).not.toContain("lane-to-mode contract");
    expect(trace.runAgentCalls.length).toBeGreaterThan(0);
    // Read-only: the scout run never pushes a branch.
    expect(trace.pushedAttempt).toHaveLength(0);
  });
});
