import { describe, expect, it, vi } from "vitest";
import {
  applyTransition,
  isRefused,
  planTransition,
  stateRolesOf,
  type TransitionPlan,
} from "../src/core/state-transition.js";
import { LABEL_QUARANTINE } from "../src/core/triage-labels.js";

function plan(current: readonly string[], t: Parameters<typeof planTransition>[1]): TransitionPlan {
  const p = planTransition(current, t);
  if (isRefused(p)) throw new Error(`unexpected refusal: ${p.reason}`);
  return p;
}

describe("planTransition", () => {
  it("queue: strips park state, reasons, and running in one atomic set", () => {
    const p = plan(
      ["bug", "ready-for-human", "blocked:validation", "running", "priority:high"],
      { kind: "queue" },
    );
    expect(new Set(p.remove)).toEqual(
      new Set(["ready-for-human", "blocked:validation", "running"]),
    );
    expect(p.add).toEqual(["ready-for-agent"]);
  });

  it("park: swaps ready-for-agent for ready-for-human plus exactly one blocked reason", () => {
    const p = plan(["ready-for-agent", "blocked:quota"], {
      kind: "park",
      reason: "blocked:validation",
    });
    expect(new Set(p.add)).toEqual(new Set(["ready-for-human", "blocked:validation"]));
    expect(new Set(p.remove)).toEqual(new Set(["ready-for-agent", "blocked:quota"]));
  });

  it("park: refuses a reason outside the blocked:* vocabulary", () => {
    const p = planTransition(["ready-for-agent"], { kind: "park", reason: "wontfix" });
    expect(isRefused(p) && p.reason).toMatch(/blocked:\*/);
  });

  it("dependency-block: adds blocked:dependency plus one req:N per blocker", () => {
    const p = plan(["ready-for-agent"], { kind: "dependency-block", reqs: [2524, 2526] });
    expect(new Set(p.add)).toEqual(
      new Set(["blocked:dependency", "req:2524", "req:2526"]),
    );
    expect(p.remove).toEqual(["ready-for-agent"]);
  });

  it("dependency-block: refuses an empty blocker list", () => {
    expect(isRefused(planTransition(["ready-for-agent"], { kind: "dependency-block", reqs: [] }))).toBe(true);
  });

  it("quarantine: swaps ready-for-agent for quarantine and carries the diagnosis", () => {
    const p = plan(["ready-for-agent", "enhancement"], {
      kind: "quarantine",
      diagnosis: "coherence: active blocker on a queued issue",
    });
    expect(p.add).toEqual([LABEL_QUARANTINE]);
    expect(p.remove).toEqual(["ready-for-agent"]);
    expect(p.appendBody).toContain("active blocker");
  });

  it("promote: consumes req:* edges and blocked:dependency into ready-for-agent", () => {
    const p = plan(["blocked:dependency", "req:2524", "req:2526", "enhancement"], {
      kind: "promote",
    });
    expect(p.add).toEqual(["ready-for-agent"]);
    expect(new Set(p.remove)).toEqual(
      new Set(["blocked:dependency", "req:2524", "req:2526"]),
    );
  });

  it("queue: refused while req:* edges remain", () => {
    const p = planTransition(["blocked:dependency", "req:2524"], { kind: "queue" });
    expect(isRefused(p) && p.reason).toMatch(/req:2524/);
  });

  it("heals the 2026-07-22 poison shape: park stacked on ready-for-agent", () => {
    const poisoned = ["ready-for-agent", "ready-for-human", "blocked:crashed", "running"];
    expect(stateRolesOf(poisoned).length).toBe(2);
    const p = plan(poisoned, { kind: "queue" });
    const result = new Set(poisoned);
    for (const l of p.remove) result.delete(l);
    for (const l of p.add) result.add(l);
    expect(stateRolesOf([...result])).toEqual(["ready-for-agent"]);
  });

  // #2749 — a park is not terminal. The live shape: #2724/#2725 landed anyway
  // and GitHub's PR-closes-issue closed them still wearing ready-for-human +
  // blocked:ci, recording two delivered slices as human-escalated.
  it("close: no park role survives, and the Spec child label is untouched", () => {
    const current = ["ready-for-human", "blocked:ci", "running", "spec:2723", "priority:high"];
    const p = plan(current, { kind: "close" });
    expect(p.add).toEqual([]);
    expect(new Set(p.remove)).toEqual(new Set(["ready-for-human", "blocked:ci", "running"]));
    const after = current.filter((l) => !p.remove.includes(l));
    expect(stateRolesOf(after)).toEqual([]);
    expect(after).toEqual(["spec:2723", "priority:high"]);
  });

  it("close: refuses nothing and adds nothing on an already-clean issue", () => {
    expect(plan(["type:task"], { kind: "close" })).toEqual({ add: [], remove: [] });
  });

  it("human: plain human gate keeps no blocked modifiers", () => {
    const p = plan(["ready-for-agent", "blocked:validation"], { kind: "human" });
    expect(p.add).toEqual(["ready-for-human"]);
    expect(new Set(p.remove)).toEqual(new Set(["ready-for-agent", "blocked:validation"]));
  });
});

describe("applyTransition", () => {
  it("performs exactly one tracker mutation for a label-only plan", async () => {
    const editIssue = vi.fn(async () => true);
    const readBody = vi.fn(async () => "body");
    const p = plan(["ready-for-agent"], { kind: "human" });
    const r = await applyTransition({ editIssue, readBody }, 42, p);
    expect(r.ok).toBe(true);
    expect(editIssue).toHaveBeenCalledTimes(1);
    expect(readBody).not.toHaveBeenCalled();
    expect(editIssue).toHaveBeenCalledWith(42, {
      add: p.add,
      remove: p.remove,
    });
  });

  it("rides the diagnosis on the SAME mutation for quarantine plans", async () => {
    const editIssue = vi.fn(async () => true);
    const readBody = vi.fn(async () => "## What\n\nbody\n");
    const p = plan(["ready-for-agent"], { kind: "quarantine", diagnosis: "probe: X" });
    await applyTransition({ editIssue, readBody }, 7, p);
    expect(editIssue).toHaveBeenCalledTimes(1);
    const edit = (editIssue.mock.calls[0] as unknown as [number, { body?: string }])[1];
    expect(edit.body).toContain("## What");
    expect(edit.body).toContain("probe: X");
  });
});
