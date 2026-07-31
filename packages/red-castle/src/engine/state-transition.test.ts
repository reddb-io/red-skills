import { describe, expect, it, vi } from "vitest";
import {
  applyTransition,
  hitlTypesIn,
  isRefused,
  planTransition,
  stateRoleLabels,
  stateRolesOf,
  type StateTransition,
  type StateTransitionLabels,
  type TransitionPlan,
} from "./state-transition.js";

const labels: StateTransitionLabels = {
  ready: "ready-for-agent",
  running: "running",
  human: "ready-for-human",
  needsTriage: "needs-triage",
  needsInfo: "needs-info",
  quarantine: "quarantine",
  dependencyBlocked: "blocked:dependency",
  blockedPrefix: "blocked:",
  reqPrefix: "req:",
};

function plan(current: readonly string[], t: StateTransition): TransitionPlan {
  const p = planTransition(current, t, labels);
  if (isRefused(p)) throw new Error(`unexpected refusal: ${p.reason}`);
  return p;
}

describe("planTransition", () => {
  it("queue: strips park state, reasons, and running in one atomic set", () => {
    const p = plan(["bug", "ready-for-human", "blocked:validation", "running"], { kind: "queue" });
    expect(p.add).toEqual(["ready-for-agent"]);
    expect(new Set(p.remove)).toEqual(
      new Set(["ready-for-human", "running", "blocked:validation"]),
    );
  });

  it("queue: refuses while dependency edges remain", () => {
    const p = planTransition(["blocked:dependency", "req:7"], { kind: "queue" }, labels);
    expect(isRefused(p)).toBe(true);
  });

  it("promote: consumes the req edges in numeric order and re-queues", () => {
    const p = plan(["blocked:dependency", "req:12", "req:3"], { kind: "promote" });
    expect(p.add).toEqual(["ready-for-agent"]);
    expect(p.remove).toEqual(["blocked:dependency", "req:3", "req:12"]);
  });

  it("promote: routes a HITL-typed dependent to the human lane, edges still consumed", () => {
    const hitl: StateTransitionLabels = { ...labels, hitlTypes: ["wayfinder:grilling"] };
    const p = planTransition(
      ["blocked:dependency", "req:8", "req:9", "wayfinder:grilling"],
      { kind: "promote" },
      hitl,
    );
    if (isRefused(p)) throw new Error(`unexpected refusal: ${p.reason}`);
    expect(p.add).toEqual(["ready-for-human"]);
    expect(p.remove).toEqual(["blocked:dependency", "req:8", "req:9"]);
  });

  it("promote: a vocabulary declaring no HITL type re-queues the same dependent", () => {
    const p = plan(["blocked:dependency", "req:8", "wayfinder:grilling"], { kind: "promote" });
    expect(p.add).toEqual(["ready-for-agent"]);
    expect(p.remove).toEqual(["blocked:dependency", "req:8"]);
  });

  it("promote: a dependent outside the HITL vocabulary still re-queues", () => {
    const hitl: StateTransitionLabels = { ...labels, hitlTypes: ["wayfinder:grilling"] };
    const p = planTransition(
      ["blocked:dependency", "req:8", "wayfinder:task"],
      { kind: "promote" },
      hitl,
    );
    if (isRefused(p)) throw new Error(`unexpected refusal: ${p.reason}`);
    expect(p.add).toEqual(["ready-for-agent"]);
  });

  it("hitlTypesIn: names the declared human-only types the label set carries", () => {
    const hitl: StateTransitionLabels = {
      ...labels,
      hitlTypes: ["wayfinder:grilling", "wayfinder:prototype"],
    };
    expect(hitlTypesIn(["bug", "wayfinder:prototype", "req:3"], hitl)).toEqual([
      "wayfinder:prototype",
    ]);
    expect(hitlTypesIn(["bug"], hitl)).toEqual([]);
    expect(hitlTypesIn(["wayfinder:prototype"], labels)).toEqual([]);
  });

  it("park: swaps the blocked reason without stacking a second one", () => {
    const p = plan(["ready-for-agent", "blocked:infra"], {
      kind: "park",
      reason: "blocked:validation",
    });
    expect(new Set(p.add)).toEqual(new Set(["ready-for-human", "blocked:validation"]));
    expect(new Set(p.remove)).toEqual(new Set(["ready-for-agent", "blocked:infra"]));
  });

  it("park: refuses a reason outside the blocked vocabulary", () => {
    const p = planTransition([], { kind: "park", reason: "wontfix" }, labels);
    expect(isRefused(p)).toBe(true);
  });

  it("human: leaves exactly the human role from an incoherent set", () => {
    const p = plan(["quarantine", "ready-for-agent"], { kind: "human" });
    expect(p.add).toEqual(["ready-for-human"]);
    expect(p.remove).toEqual(["ready-for-agent", "quarantine"]);
  });

  it("dependency-block: adds the edges alongside the wait state", () => {
    const p = plan(["ready-for-agent"], { kind: "dependency-block", reqs: [4, 9] });
    expect(new Set(p.add)).toEqual(new Set(["blocked:dependency", "req:4", "req:9"]));
    expect(p.remove).toEqual(["ready-for-agent"]);
  });

  it("dependency-block: refuses an empty req set", () => {
    const p = planTransition([], { kind: "dependency-block", reqs: [] }, labels);
    expect(isRefused(p)).toBe(true);
  });

  it("quarantine: carries the diagnosis as an appended body", () => {
    const p = plan(["ready-for-agent"], { kind: "quarantine", diagnosis: "two state roles" });
    expect(p.add).toEqual(["quarantine"]);
    expect(p.appendBody).toBe("two state roles");
  });

  // #2749 — a park is not terminal. Parked work still lands (human merge,
  // retake, adopt-branch landing) and the close must not preserve the park.
  it("close: leaves ZERO state roles and keeps the permanent markers", () => {
    // The live #2724/#2725 shape: delivered slices closed by GitHub's own
    // PR-closes-issue on a human merge, still wearing their park.
    const current = ["ready-for-human", "blocked:ci", "running", "spec:2723", "type:task"];
    const p = plan(current, { kind: "close" });
    expect(p.add).toEqual([]);
    expect(new Set(p.remove)).toEqual(new Set(["ready-for-human", "blocked:ci", "running"]));
    const after = current.filter((l) => !p.remove.includes(l));
    expect(stateRolesOf(after, labels)).toEqual([]);
    expect(after).toEqual(["spec:2723", "type:task"]);
  });

  it("close: consumes dependency edges alongside the wait state", () => {
    const p = plan(["blocked:dependency", "req:12", "req:3"], { kind: "close" });
    expect(p.add).toEqual([]);
    expect(p.remove).toEqual(["blocked:dependency", "req:3", "req:12"]);
  });

  it("close: is a no-op mutation on an issue that carries no state", () => {
    expect(plan(["spec:2723", "type:task"], { kind: "close" })).toEqual({ add: [], remove: [] });
  });

  it("honours a host vocabulary that differs from the defaults", () => {
    const custom: StateTransitionLabels = { ...labels, ready: "queued", reqPrefix: "needs#" };
    const p = planTransition(["queued", "needs#5"], { kind: "promote" }, custom);
    expect(isRefused(p)).toBe(false);
    expect((p as TransitionPlan).remove).toEqual(["needs#5"]);
  });

  it("stateRolesOf reads the injected vocabulary", () => {
    expect(stateRoleLabels(labels)).toHaveLength(6);
    expect(stateRolesOf(["bug", "quarantine", "ready-for-agent"], labels)).toEqual([
      "ready-for-agent",
      "quarantine",
    ]);
  });
});

describe("applyTransition", () => {
  it("performs one edit and appends the diagnosis to the read body", async () => {
    const editIssue = vi.fn(async () => true);
    const readBody = vi.fn(async () => "body\n");
    const p = plan([], { kind: "quarantine", diagnosis: "diag" });
    const result = await applyTransition({ editIssue, readBody }, 42, p);
    expect(result.ok).toBe(true);
    expect(editIssue).toHaveBeenCalledWith(42, {
      add: ["quarantine"],
      remove: [],
      body: "body\n\ndiag\n",
    });
  });

  it("omits the body read when the plan carries no diagnosis", async () => {
    const editIssue = vi.fn(async () => true);
    const readBody = vi.fn(async () => "body");
    await applyTransition({ editIssue, readBody }, 7, plan(["quarantine"], { kind: "queue" }));
    expect(readBody).not.toHaveBeenCalled();
    expect(editIssue).toHaveBeenCalledWith(7, { add: ["ready-for-agent"], remove: ["quarantine"] });
  });
});
