// hitl-resolve.test.ts — the atomic HITL decision verb (#2369, Spec #2329 E7).
// One human decision on a parked issue = one mutation sequence: rationale
// comment always, claims conceded, labels transitioned through the ADR 0122
// API. Each decision is pinned against injected fakes.

import { describe, expect, it, vi } from "vitest";
import { resolveHitlDecision, type HitlResolveDeps } from "../src/core/hitl-resolve.js";
import { parseCurrentBlocker } from "../src/core/blocker-state.js";

const ACTIVE_BLOCKER_BODY = `## Current blocker

<!-- red:blocker-state v1 -->
status: blocked
kind: runner
summary: Idle-timeout crash during attempt 2.
next: Requeue when the runner environment stabilises.
<!-- /red:blocker-state -->
`;

function makeDeps(labels: string[], conceded: string[] = [], body = ""): HitlResolveDeps & {
  comment: ReturnType<typeof vi.fn>;
  closeIssue: ReturnType<typeof vi.fn>;
  editLabels: ReturnType<typeof vi.fn>;
  releaseClaims: ReturnType<typeof vi.fn>;
  viewBody: ReturnType<typeof vi.fn>;
  editBody: ReturnType<typeof vi.fn>;
  verifyBaseFreshness: ReturnType<typeof vi.fn>;
} {
  let currentBody = body;
  return {
    comment: vi.fn(async () => undefined),
    closeIssue: vi.fn(async () => undefined),
    viewLabels: vi.fn(async () => labels),
    editLabels: vi.fn(async () => undefined),
    releaseClaims: vi.fn(async () => conceded),
    viewBody: vi.fn(async () => currentBody),
    editBody: vi.fn(async (_, newBody: string) => {
      currentBody = newBody;
    }),
    verifyBaseFreshness: vi.fn(async () => ({ ok: true, evidence: "fresh" })),
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
    expect(String(deps.comment.mock.calls[0]![1])).toContain('data-kind="directive"');
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

  it("close: strips the park role BEFORE closing, keeping permanent markers (#2749)", async () => {
    const deps = makeDeps(["ready-for-human", "blocked:ci", "spec:2723", "type:task"]);

    const result = await resolveHitlDecision(deps, {
      issue: 10,
      decision: "close",
      rationale: "superseded by #2523",
    });

    expect(deps.closeIssue).toHaveBeenCalledWith(10);
    expect(deps.comment).toHaveBeenCalledTimes(1);
    expect(deps.releaseClaims).not.toHaveBeenCalled();
    expect(deps.editLabels).toHaveBeenCalledTimes(1);
    const [, remove, add] = deps.editLabels.mock.calls[0]!;
    expect(new Set(remove as string[])).toEqual(new Set(["ready-for-human", "blocked:ci"]));
    expect(add).toEqual([]);
    expect(deps.editLabels.mock.invocationCallOrder[0]!).toBeLessThan(
      deps.closeIssue.mock.invocationCallOrder[0]!,
    );
    expect(result.actions.some((a) => a.includes("close labels reconciled"))).toBe(true);
  });

  it("close: writes no label edit when the issue carries no state to shed", async () => {
    const deps = makeDeps(["spec:2723", "type:task"]);

    await resolveHitlDecision(deps, { issue: 11, decision: "close", rationale: "duplicate" });

    expect(deps.closeIssue).toHaveBeenCalledWith(11);
    expect(deps.editLabels).not.toHaveBeenCalled();
  });

  it("requeue: clears an active body blocker of any kind (runner) and archives the rationale (#2597)", async () => {
    const deps = makeDeps(["ready-for-human", "blocked:runner"], [], ACTIVE_BLOCKER_BODY);

    const result = await resolveHitlDecision(deps, {
      issue: 2428,
      decision: "requeue",
      rationale: "runner environment has stabilised; safe to retry",
    });

    expect(deps.viewBody).toHaveBeenCalledWith(2428);
    expect(deps.verifyBaseFreshness).toHaveBeenCalledWith(ACTIVE_BLOCKER_BODY);
    expect(deps.editBody).toHaveBeenCalledTimes(1);
    const writtenBody = deps.editBody.mock.calls[0]![1] as string;
    expect(parseCurrentBlocker(writtenBody)).toBeNull();
    expect(writtenBody).toContain("Resolved blockers");
    expect(result.actions.some((a) => a.includes("body blocker cleared"))).toBe(true);
    expect(result.actions.some((a) => a.includes("kind=runner"))).toBe(true);
  });

  it("requeues push-failed with human authority through freshness, claim sweep, directive, and one label edit", async () => {
    const body = ACTIVE_BLOCKER_BODY.replace("kind: runner", "kind: push-failed");
    const deps = makeDeps(["ready-for-human", "blocked:push-failed"], ["wOLD"], body);

    const result = await resolveHitlDecision(deps, {
      issue: 3334,
      decision: "requeue",
      rationale: "remote access restored",
    });

    expect(result.refused).toBeUndefined();
    expect(deps.verifyBaseFreshness.mock.invocationCallOrder[0]!).toBeLessThan(
      deps.releaseClaims.mock.invocationCallOrder[0]!,
    );
    expect(deps.releaseClaims).toHaveBeenCalledWith(3334);
    expect(String(deps.comment.mock.calls[0]![1])).toContain('data-kind="directive"');
    expect(deps.editLabels).toHaveBeenCalledTimes(1);
  });

  it("requeue: skips editBody when the issue has no active body blocker", async () => {
    const deps = makeDeps(["ready-for-human"], [], "## Background\n\nNo blocker here.\n");

    await resolveHitlDecision(deps, {
      issue: 99,
      decision: "requeue",
      rationale: "just flipping labels",
    });

    expect(deps.editBody).not.toHaveBeenCalled();
  });

  it("requeue: after clearing blocker, issue body passes the coherence probe — no ready-for-agent + active-blocker pair (#2597)", async () => {
    const deps = makeDeps(["ready-for-human", "blocked:runner"], [], ACTIVE_BLOCKER_BODY);

    await resolveHitlDecision(deps, {
      issue: 2428,
      decision: "requeue",
      rationale: "runner stabilised",
    });

    const writtenBody = deps.editBody.mock.calls[0]![1] as string;
    // Coherence probe: ready-for-agent issues must NOT carry an active Current blocker.
    // After hitl requeue the body blocker must be absent.
    expect(parseCurrentBlocker(writtenBody)).toBeNull();
  });
});
