import { describe, expect, it } from "vitest";
import {
  classifyConflictedFileKind,
  classifyConflictHunk,
  parseConflictHunks,
  partitionConflicts,
  reconcileMergeConflict,
  type ConflictFinding,
  type MergeConflictReconcileDeps,
  type RebaseOutcome,
  type RelandOutcome,
} from "../src/core/merge-conflict-reconcile.js";

// Everything injected is a fake — no real git / gh / resolve ever runs. The
// harness records the side-effect sequence (rebase, resolve, abort, reland,
// park, log) so each test asserts the decision tree as a trace. Mirrors
// reconcile.test.ts so the two read alike.

interface Trace {
  rebased: number;
  resolvedWith: ConflictFinding[][];
  aborted: number;
  relanded: number;
  parked: Array<{ reason: string; findings: ConflictFinding[] }>;
  logs: string[];
}

interface HarnessOptions {
  rebase: RebaseOutcome;
  /** Whether resolveMechanical succeeds (default true). */
  resolveOk?: boolean;
  /** Reland outcome (default ok). */
  reland?: RelandOutcome;
}

function mechanical(path: string, kind = "lint-fix"): ConflictFinding {
  return { path, kind, description: `${kind} conflict in ${path}` };
}

function semantic(path: string, kind = "logic"): ConflictFinding {
  return { path, kind, description: `${kind} conflict in ${path}` };
}

function harness(opts: HarnessOptions): { deps: MergeConflictReconcileDeps; trace: Trace } {
  const trace: Trace = { rebased: 0, resolvedWith: [], aborted: 0, relanded: 0, parked: [], logs: [] };
  const deps: MergeConflictReconcileDeps = {
    rebaseOntoTrunk: async () => {
      trace.rebased++;
      return opts.rebase;
    },
    resolveMechanical: async (findings) => {
      trace.resolvedWith.push(findings);
      return opts.resolveOk ?? true;
    },
    abortRebase: async () => {
      trace.aborted++;
    },
    reland: async () => {
      trace.relanded++;
      return opts.reland ?? { ok: true };
    },
    park: async (reason, findings) => {
      trace.parked.push({ reason, findings });
    },
    appendIterLog: (line) => trace.logs.push(line),
  };
  return { deps, trace };
}

describe("partitionConflicts", () => {
  it("splits findings by the closed mechanical allowlist (intent-by-default)", () => {
    const findings = [
      mechanical("a.ts", "formatter"),
      semantic("b.ts", "logic"),
      mechanical("c.ts", "trailing-newline"),
      semantic("d.ts", "unknown-kind"),
    ];
    const { mechanical: mech, nonMechanical } = partitionConflicts(findings);
    expect(mech.map((f) => f.path)).toEqual(["a.ts", "c.ts"]);
    expect(nonMechanical.map((f) => f.path)).toEqual(["b.ts", "d.ts"]);
  });

  it("classifies every allowlisted kind as mechanical", () => {
    const kinds = [
      "formatter",
      "import-organizer",
      "lint-fix",
      "comment-typo",
      "trailing-whitespace",
      "trailing-newline",
    ];
    const { mechanical: mech, nonMechanical } = partitionConflicts(kinds.map((k) => mechanical("f", k)));
    expect(mech).toHaveLength(kinds.length);
    expect(nonMechanical).toHaveLength(0);
  });
});

describe("parseConflictHunks", () => {
  it("returns [] when there are no conflict markers", () => {
    expect(parseConflictHunks("just\nsome\nlines\n")).toEqual([]);
  });

  it("extracts ours/theirs from a conflict hunk", () => {
    const body = [
      "before",
      "<<<<<<< HEAD",
      "a",
      "b",
      "=======",
      "a ",
      "b",
      ">>>>>>> feature",
      "after",
    ].join("\n");
    expect(parseConflictHunks(body)).toEqual([{ ours: ["a", "b"], theirs: ["a ", "b"] }]);
  });

  it("drops an unterminated hunk", () => {
    const body = ["<<<<<<< HEAD", "a", "=======", "b"].join("\n");
    expect(parseConflictHunks(body)).toEqual([]);
  });
});

describe("classifyConflictHunk / classifyConflictedFileKind", () => {
  it("classifies a whitespace-only hunk as mechanical", () => {
    expect(classifyConflictHunk({ ours: ["const x = 1;"], theirs: ["const x = 1; "] })).toBe(
      "trailing-whitespace",
    );
  });

  it("classifies a trailing-blank-line-only hunk as mechanical", () => {
    expect(classifyConflictHunk({ ours: ["a", "", ""], theirs: ["a"] })).toBe("trailing-whitespace");
  });

  it("classifies a real content divergence as non-mechanical (null)", () => {
    expect(classifyConflictHunk({ ours: ["const x = 1;"], theirs: ["const x = 2;"] })).toBeNull();
  });

  it("file kind is mechanical only when EVERY hunk is whitespace-only", () => {
    const mechanical = ["<<<<<<< HEAD", "a", "=======", "a ", ">>>>>>> f"].join("\n");
    expect(classifyConflictedFileKind(mechanical)).toBe("trailing-whitespace");

    const mixed = [
      "<<<<<<< HEAD",
      "a",
      "=======",
      "a ",
      ">>>>>>> f",
      "<<<<<<< HEAD",
      "x = 1",
      "=======",
      "x = 2",
      ">>>>>>> f",
    ].join("\n");
    expect(classifyConflictedFileKind(mixed)).toBe("semantic");
  });

  it("file kind is semantic when there are no conflict markers", () => {
    expect(classifyConflictedFileKind("no markers here")).toBe("semantic");
  });
});

describe("reconcileMergeConflict", () => {
  it("relands directly on a CLEAN rebase, trusting prior green (no resolve, no abort)", async () => {
    const { deps, trace } = harness({ rebase: { status: "clean" } });
    const res = await reconcileMergeConflict(deps);
    expect(res).toEqual({ outcome: "relanded" });
    expect(trace.rebased).toBe(1);
    expect(trace.resolvedWith).toHaveLength(0);
    expect(trace.aborted).toBe(0);
    expect(trace.relanded).toBe(1);
    expect(trace.parked).toHaveLength(0);
  });

  it("auto-resolves an ALL-mechanical conflict then relands", async () => {
    const findings = [mechanical("a.ts", "formatter"), mechanical("b.ts", "lint-fix")];
    const { deps, trace } = harness({ rebase: { status: "conflicted", findings } });
    const res = await reconcileMergeConflict(deps);
    expect(res).toEqual({ outcome: "relanded" });
    expect(trace.resolvedWith).toEqual([findings]);
    expect(trace.aborted).toBe(0);
    expect(trace.relanded).toBe(1);
    expect(trace.parked).toHaveLength(0);
  });

  it("aborts + parks semantic-conflict when ANY conflict is outside the allowlist", async () => {
    const findings = [mechanical("a.ts", "formatter"), semantic("b.ts", "logic")];
    const { deps, trace } = harness({ rebase: { status: "conflicted", findings } });
    const res = await reconcileMergeConflict(deps);
    expect(res).toEqual({ outcome: "parked", reason: "semantic-conflict" });
    expect(trace.resolvedWith).toHaveLength(0);
    expect(trace.aborted).toBe(1);
    expect(trace.relanded).toBe(0);
    expect(trace.parked).toEqual([{ reason: "semantic-conflict", findings: [findings[1]] }]);
  });

  it("aborts + parks resolution-failed when mechanical resolution fails", async () => {
    const findings = [mechanical("a.ts", "formatter")];
    const { deps, trace } = harness({ rebase: { status: "conflicted", findings }, resolveOk: false });
    const res = await reconcileMergeConflict(deps);
    expect(res).toEqual({ outcome: "parked", reason: "resolution-failed" });
    expect(trace.resolvedWith).toEqual([findings]);
    expect(trace.aborted).toBe(1);
    expect(trace.relanded).toBe(0);
    expect(trace.parked).toEqual([{ reason: "resolution-failed", findings }]);
  });

  it("parks semantic-conflict when the rebase conflicts with NO classifiable findings", async () => {
    const { deps, trace } = harness({ rebase: { status: "conflicted", findings: [] } });
    const res = await reconcileMergeConflict(deps);
    expect(res).toEqual({ outcome: "parked", reason: "semantic-conflict" });
    expect(trace.aborted).toBe(1);
    expect(trace.resolvedWith).toHaveLength(0);
  });

  it("parks rebase-error when the rebase could not run (no abort attempted)", async () => {
    const { deps, trace } = harness({ rebase: { status: "error", detail: "fetch-failed" } });
    const res = await reconcileMergeConflict(deps);
    expect(res).toEqual({ outcome: "parked", reason: "rebase-error" });
    expect(trace.aborted).toBe(0);
    expect(trace.relanded).toBe(0);
    expect(trace.parked).toEqual([{ reason: "rebase-error", findings: [] }]);
  });

  it("parks reland-failed when a clean/resolved rebase cannot reland", async () => {
    const { deps, trace } = harness({ rebase: { status: "clean" }, reland: { ok: false, reason: "push-rejected" } });
    const res = await reconcileMergeConflict(deps);
    expect(res).toEqual({ outcome: "parked", reason: "reland-failed" });
    expect(trace.relanded).toBe(1);
    expect(trace.parked).toEqual([{ reason: "reland-failed", findings: [] }]);
  });
});
