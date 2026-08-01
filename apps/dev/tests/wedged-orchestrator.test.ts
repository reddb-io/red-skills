// The post-DONE hang has no detector of its own: every stall signal watches the
// inner agent, and after DONE the agent is gone. #2985 is that gap — 30+ minutes
// of `live=true` with no child, no socket and no write.

import { describe, expect, it } from "vitest";
import {
  ORCHESTRATOR_OWNED_PHASES,
  WEDGED_ORCHESTRATOR_SILENCE_MS,
  detectWedgedOrchestrator,
  type WedgedOrchestratorInput,
} from "../src/core/wedged-orchestrator.js";

/** The wAX3A shape: alive, phase `validating`, agent finished, nothing since. */
function wedgedShape(overrides: Partial<WedgedOrchestratorInput> = {}): WedgedOrchestratorInput {
  return {
    live: true,
    phase: "validating",
    laneAgeMs: 31 * 60_000,
    liveDescendants: false,
    ...overrides,
  };
}

describe("wedged orchestrator detection (#2985)", () => {
  it("pages on the observed shape instead of reporting a healthy worker", () => {
    const alert = detectWedgedOrchestrator(wedgedShape());

    expect(alert?.type).toBe("orchestrator-wedged");
    expect(alert?.message).toContain("31m");
    expect(alert?.message).toContain("validating");
    expect(alert?.message).toContain("no child process");
    expect(alert?.message).toContain("`live=true`");
  });

  it("names the wait when the orchestrator declared one", () => {
    const alert = detectWedgedOrchestrator(
      wedgedShape({
        blockedOn: "lock:validation-gate",
        blockedDetail: "⏳ /afk gate: blocked on the host-wide `validation-gate` lock.",
      }),
    );

    expect(alert?.type).toBe("orchestrator-blocked");
    expect(alert?.message).toContain("lock:validation-gate");
    expect(alert?.message).toContain("host-wide");
  });

  it("stays quiet while the inner agent owns the turn", () => {
    expect(detectWedgedOrchestrator(wedgedShape({ phase: "coding" }))).toBeNull();
    expect(detectWedgedOrchestrator(wedgedShape({ phase: "setup" }))).toBeNull();
    for (const phase of ORCHESTRATOR_OWNED_PHASES) {
      expect(detectWedgedOrchestrator(wedgedShape({ phase }))).not.toBeNull();
    }
  });

  it("stays quiet when something is actually running", () => {
    expect(detectWedgedOrchestrator(wedgedShape({ liveDescendants: true }))).toBeNull();
  });

  it("stays quiet below the silence threshold, and pages at it", () => {
    expect(
      detectWedgedOrchestrator(wedgedShape({ laneAgeMs: WEDGED_ORCHESTRATOR_SILENCE_MS - 1 })),
    ).toBeNull();
    expect(
      detectWedgedOrchestrator(wedgedShape({ laneAgeMs: WEDGED_ORCHESTRATOR_SILENCE_MS })),
    ).not.toBeNull();
    // An unknown lane age is not evidence of a hang.
    expect(detectWedgedOrchestrator(wedgedShape({ laneAgeMs: undefined }))).toBeNull();
  });

  it("leaves a dead worker to the machinery that owns death", () => {
    expect(detectWedgedOrchestrator(wedgedShape({ live: false }))).toBeNull();
  });

  it("honours a caller-supplied threshold", () => {
    expect(
      detectWedgedOrchestrator(wedgedShape({ laneAgeMs: 120_000, silenceThresholdMs: 60_000 }))?.type,
    ).toBe("orchestrator-wedged");
  });
});
