import { describe, expect, it } from "vitest";
import {
  classifyDocsPath,
  planDocsSweep,
  type DocsSweepFileState,
} from "../src/core/docs-sweep.js";

function file(over: Partial<DocsSweepFileState> & Pick<DocsSweepFileState, "path" | "state">): DocsSweepFileState {
  return {
    path: over.path,
    state: over.state,
    group: over.group ?? classifyDocsPath(over.path),
    ignored: over.ignored ?? false,
    trackedPrecedent: over.trackedPrecedent ?? true,
  };
}

describe("Docs Sweep planner", () => {
  it("returns clean when no doc files are unlanded", () => {
    expect(planDocsSweep({ base: "main", files: [] })).toEqual({
      action: "clean",
      base: "main",
      files: [],
      haltReason: undefined,
    });
  });

  it("plans land for modified glossary docs", () => {
    const f = file({ path: ".red/CONTEXT-MAP.md", state: "modified" });
    expect(planDocsSweep({ base: "main", files: [f] })).toEqual({
      action: "land",
      base: "main",
      files: [f],
      haltReason: undefined,
    });
  });

  it("plans land for untracked ADR docs", () => {
    const f = file({ path: ".red/adr/0099-docs-sweep.md", state: "untracked" });
    expect(planDocsSweep({ base: "main", files: [f] }).action).toBe("land");
  });

  it("plans land for doc files committed ahead of origin", () => {
    const f = file({ path: ".red/contexts/dev/CONTEXT.md", state: "ahead" });
    expect(planDocsSweep({ base: "main", files: [f] }).files).toEqual([f]);
  });

  it("excludes gitignored operational surfaces", () => {
    const op = file({ path: ".red/tmp/handoff.md", state: "untracked", group: "operational", ignored: true });
    expect(planDocsSweep({ base: "main", files: [op] })).toEqual({
      action: "clean",
      base: "main",
      files: [],
      haltReason: undefined,
    });
  });

  it("force-publishes ignored docs only when their path class has tracked precedent", () => {
    const publishable = file({
      path: ".red/contexts/dev/NEW.md",
      state: "untracked",
      ignored: true,
      trackedPrecedent: true,
    });
    expect(planDocsSweep({ base: "main", files: [publishable] }).action).toBe("land");
  });

  it("halts ignored docs in zero-precedent path classes", () => {
    const stranded = file({
      path: ".red/adr/0099-docs-sweep.md",
      state: "untracked",
      ignored: true,
      trackedPrecedent: false,
    });
    expect(planDocsSweep({ base: "main", files: [stranded] })).toEqual({
      action: "halt",
      base: "main",
      files: [stranded],
      haltReason: "zero-precedent",
    });
  });

  it("halts with the explicit file list when origin reachability cannot be verified", () => {
    const f = file({ path: ".red/CONTEXT.md", state: "modified" });
    expect(planDocsSweep({ base: "main", files: [f], originReachable: false })).toEqual({
      action: "halt",
      base: "main",
      files: [f],
      haltReason: "origin-unreachable",
    });
  });
});
