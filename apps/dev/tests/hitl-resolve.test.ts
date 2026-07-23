// hitl-resolve.test.ts — the atomic HITL decision verb (#2369, Spec #2329 E7).
// One human decision on a parked issue = one mutation sequence: rationale
// comment always, claims conceded, labels transitioned through the ADR 0122
// API. Each decision is pinned against injected fakes.

import { describe, expect, it, vi } from "vitest";
import { resolveHitlDecision, type HitlResolveDeps } from "../src/core/hitl-resolve.js";

function makeDeps(labels: string[], conceded: string[] = []): HitlResolveDeps & {
  comment: ReturnType<typeof vi.fn>;
  closeIssue: ReturnType<typeof vi.fn>;
  editLabels: ReturnType<typeof vi.fn>;
  releaseClaims: ReturnType<typeof vi.fn>;
} {
  return {
    comment: vi.fn(async () => undefined),
    closeIssue: vi.fn(async () => undefined),
    viewLabels: vi.fn(async () => labels),
    editLabels: vi.fn(async () => undefined),
    releaseClaims: vi.fn(async () => conceded),
  };
}

describe("hitl_resolve decisions (#2369)", () => {
  it("requeue: concedes claims, strips park labels, adds ready-for-agent — one edit", async () => {
    const deps = makeDeps(["ready-for-human", "blocked:crashed", "running"], ["local:wDEAD"]);

    const result = await resolveHitlDecision(deps, {
      issue: 2404,
      decision: "requeue",
      rationale: "crash was environmental; safe to delegate again",
    });

    expect(deps.comment).toHaveBeenCalledTimes(1);
    expect(String(deps.comment.mock.calls[0]![1])).toContain("HITL decision **requeue**");
    expect(deps.releaseClaims).toHaveBeenCalledWith(2404);
    expect(deps.editLabels).toHaveBeenCalledTimes(1);
    const [, remove, add] = deps.editLabels.mock.calls[0]!;
    expect(new Set(remove as string[])).toEqual(new Set(["ready-for-human", "blocked:crashed", "running"]));
    expect(add).toEqual(["ready-for-agent"]);
    expect(result.actions.some((a) => a.includes("claims conceded: local:wDEAD"))).toBe(true);
    expect(result.refused).toBeUndefined();
  });

  it("requeue over dangling req:* edges promotes (human override) instead of refusing", async () => {
    const deps = makeDeps(["ready-for-human", "req:2526"]);

    await resolveHitlDecision(deps, { issue: 7, decision: "requeue", rationale: "deps shipped" });

    const [, remove, add] = deps.editLabels.mock.calls[0]!;
    expect(remove).toContain("req:2526");
    expect(add).toEqual(["ready-for-agent"]);
  });

  it("retake: same freeing transition, routed to the no-agent landing lane", async () => {
    const deps = makeDeps(["ready-for-human", "blocked:validation"]);

    const result = await resolveHitlDecision(deps, {
      issue: 2432,
      decision: "retake",
      rationale: "branch is complete; validate and land without the agent",
    });

    expect(deps.editLabels).toHaveBeenCalledTimes(1);
    expect(result.actions.some((a) => a.includes("no-agent landing lane"))).toBe(true);
  });

  it("park: keeps ready-for-human, records why, no claim mutation", async () => {
    const deps = makeDeps(["ready-for-agent", "blocked:crashed"]);

    const result = await resolveHitlDecision(deps, {
      issue: 9,
      decision: "park",
      rationale: "needs a design call before another attempt",
    });

    expect(deps.releaseClaims).not.toHaveBeenCalled();
    expect(deps.closeIssue).not.toHaveBeenCalled();
    const [, remove, add] = deps.editLabels.mock.calls[0]!;
    expect(add).toContain("ready-for-human");
    expect(remove).toContain("ready-for-agent");
    expect(result.actions.some((a) => a.includes("rationale comment posted"))).toBe(true);
  });

  it("close: closes with the rationale on record and touches nothing else", async () => {
    const deps = makeDeps(["ready-for-human"]);

    await resolveHitlDecision(deps, { issue: 10, decision: "close", rationale: "superseded by #2523" });

    expect(deps.closeIssue).toHaveBeenCalledWith(10);
    expect(deps.comment).toHaveBeenCalledTimes(1);
    expect(deps.editLabels).not.toHaveBeenCalled();
    expect(deps.releaseClaims).not.toHaveBeenCalled();
  });
});
