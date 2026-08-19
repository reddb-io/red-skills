import { describe, expect, it } from "vitest";
import { RWT, doLanding, harness, joined, type LandLock } from "./landing.test-support.js";

const isRestMergeCall = (args: readonly string[]): boolean =>
  args.includes("PUT") && args.some((arg) => /\/pulls\/\d+\/merge$/.test(arg));

describe("doLanding — first-attempt mechanical conflict resolution (#2072)", () => {
  it("PR rebase conflict resolved mechanically → revalidates inside the land-lock before merging", async () => {
    const trace: string[] = [];
    const landLock: LandLock = {
      acquire: async () => {
        trace.push("enter");
        return async () => {
          trace.push("exit");
        };
      },
    };
    const h = harness({
      locked: false,
      openPr: true,
      rebaseCode: 1,
      mechanicalConflictResolve: "resolve",
      postMergeGate: true,
      landLock,
    });

    const resolve = h.deps.resolveMechanicalConflict!;
    h.deps.resolveMechanicalConflict = async (dir) => {
      trace.push(`resolve:${dir}`);
      return resolve(dir);
    };
    const gate = h.deps.postMergeGate!;
    h.deps.postMergeGate = async (dir) => {
      trace.push(`gate:${dir}`);
      return gate(dir);
    };
    const exec = h.deps.mergeExec;
    h.deps.mergeExec = async (args) => {
      if (isRestMergeCall(args)) trace.push("merge");
      return exec(args);
    };

    const r = await doLanding(h.deps, h.input, h.hooks);

    expect(r).toEqual({
      ok: true,
      locked: false,
      mergeSha: "abc1234",
      postMergeValidation: {
        path: "local-rerun",
        prNumber: 42,
        reason: "PR #42 CI evidence was absent or unusable; local post-merge validation fallback ran.",
      },
    });
    expect(h.mechanicalResolverDirs).toEqual([RWT]);
    expect(h.postMergeGateDirs).toEqual([RWT]);
    expect(joined(h.mergeCalls).some((c) => c === `git -C ${RWT} rebase --abort`)).toBe(false);
    expect(trace).toEqual(["enter", `resolve:${RWT}`, `gate:${RWT}`, "merge", "exit"]);
  });

  it("PR rebase conflict outside the mechanical allowlist → aborts and parks as pr-conflict", async () => {
    const h = harness({
      locked: false,
      openPr: true,
      rebaseCode: 1,
      mechanicalConflictResolve: "decline",
      postMergeGate: true,
    });

    const r = await doLanding(h.deps, h.input, h.hooks);

    expect(r).toMatchObject({ ok: false, reason: "pr-conflict", locked: false });
    expect(h.mechanicalResolverDirs).toEqual([RWT]);
    expect(h.agentResolverDirs).toEqual([]);
    expect(h.postMergeGateDirs).toEqual([]);
    const j = joined(h.mergeCalls);
    expect(j).toContain(`git -C ${RWT} rebase --abort`);
    expect(h.mergeCalls.some(isRestMergeCall)).toBe(false);
  });
});

describe("doLanding — agent-tier semantic conflict resolution (#2075)", () => {
  it("PR rebase conflict unresolved mechanically → agent resolves → gate runs in the land-lock before merge", async () => {
    const trace: string[] = [];
    const landLock: LandLock = {
      acquire: async () => {
        trace.push("enter");
        return async () => {
          trace.push("exit");
        };
      },
    };
    const h = harness({
      locked: false,
      openPr: true,
      rebaseCode: 1,
      mechanicalConflictResolve: "decline",
      agentConflictResolve: "resolve",
      postMergeGate: true,
      landLock,
    });

    const mech = h.deps.resolveMechanicalConflict!;
    h.deps.resolveMechanicalConflict = async (dir) => {
      trace.push(`mechanical:${dir}`);
      return mech(dir);
    };
    const agent = h.deps.resolveAgentConflict!;
    h.deps.resolveAgentConflict = async (dir) => {
      trace.push(`agent:${dir}`);
      return agent(dir);
    };
    const gate = h.deps.postMergeGate!;
    h.deps.postMergeGate = async (dir) => {
      trace.push(`gate:${dir}`);
      return gate(dir);
    };
    const exec = h.deps.mergeExec;
    h.deps.mergeExec = async (args) => {
      if (isRestMergeCall(args)) trace.push("merge");
      return exec(args);
    };

    const r = await doLanding(h.deps, h.input, h.hooks);

    expect(r).toEqual({
      ok: true,
      locked: false,
      mergeSha: "abc1234",
      postMergeValidation: {
        path: "local-rerun",
        prNumber: 42,
        reason: "PR #42 CI evidence was absent or unusable; local post-merge validation fallback ran.",
      },
    });
    expect(h.mechanicalResolverDirs).toEqual([RWT]);
    expect(h.agentResolverDirs).toEqual([RWT]);
    expect(h.postMergeGateDirs).toEqual([RWT]);
    expect(joined(h.mergeCalls).some((c) => c === `git -C ${RWT} rebase --abort`)).toBe(false);
    expect(trace).toEqual(["enter", `mechanical:${RWT}`, `agent:${RWT}`, `gate:${RWT}`, "merge", "exit"]);
  });

  it("agent-resolved PR rebase conflict with a failing in-lock gate parks before merge", async () => {
    const h = harness({
      locked: false,
      openPr: true,
      rebaseCode: 1,
      mechanicalConflictResolve: "decline",
      agentConflictResolve: "resolve",
      postMergeGate: true,
      postMergeGateFails: true,
    });

    const r = await doLanding(h.deps, h.input, h.hooks);

    expect(r).toEqual({ ok: false, reason: "post-merge-gate", locked: false, prNumber: 42 });
    expect(h.mechanicalResolverDirs).toEqual([RWT]);
    expect(h.agentResolverDirs).toEqual([RWT]);
    expect(h.postMergeGateDirs).toEqual([RWT]);
    expect(h.mergeCalls.some(isRestMergeCall)).toBe(false);
  });

  it("agent tier exhaustion aborts and parks as pr-conflict", async () => {
    const h = harness({
      locked: false,
      openPr: true,
      rebaseCode: 1,
      mechanicalConflictResolve: "decline",
      agentConflictResolve: "decline",
      postMergeGate: true,
    });

    const r = await doLanding(h.deps, h.input, h.hooks);

    expect(r).toMatchObject({ ok: false, reason: "pr-conflict", locked: false });
    expect(h.mechanicalResolverDirs).toEqual([RWT]);
    expect(h.agentResolverDirs).toEqual([RWT, RWT]);
    expect(h.postMergeGateDirs).toEqual([]);
    const j = joined(h.mergeCalls);
    expect(j).toContain(`git -C ${RWT} rebase --abort`);
    expect(h.mergeCalls.some(isRestMergeCall)).toBe(false);
  });
});
