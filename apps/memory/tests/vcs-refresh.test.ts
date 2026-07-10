import { describe, expect, test, vi } from "vitest";
import type { MemoryConfig } from "../src/config.js";
import { EMPTY_TREE_OID } from "../src/git-diff-selection.js";
import type { IngestReport } from "../src/ingest.js";
import { type VcsRefreshDeps, refreshFromGit } from "../src/vcs-refresh.js";

const GRAPH_CONFIG = { mode: "graph", storePath: ".red/memory/graph.rdb" } as unknown as MemoryConfig;

function emptyReport(): IngestReport {
  return {
    files: 1,
    nodes: 2,
    edges: 1,
    docs: 0,
    added: 2,
    updated: 0,
    skipped: 0,
    stale: 0,
    semantic: { enabled: false, nodes: 0, edges: 0, token_cost: { input: 0, output: 0 } },
    durationMs: 1,
  };
}

function makeDeps(over: Partial<VcsRefreshDeps> & { git?: (args: string[]) => string }): VcsRefreshDeps {
  const store = { close: vi.fn(async () => {}) };
  return {
    readConfig: vi.fn(async () => GRAPH_CONFIG),
    runGit: vi.fn(async (_root, args) => (over.git ? over.git(args) : "")),
    openStore: vi.fn(async () => store as never),
    refreshFiles: vi.fn(async () => emptyReport()),
    exportGraph: vi.fn(async () => ({
      nodes: 5,
      edges: 3,
      jsonPath: "/tmp/graph.json",
    }) as never),
    ...over,
  };
}

describe("refreshFromGit gating (AC5 — opt-in / safe no-op)", () => {
  test("no-ops when memory is not initialized", async () => {
    const deps = makeDeps({ readConfig: vi.fn(async () => null) });
    const r = await refreshFromGit("/repo", { event: "post-commit" }, deps);
    expect(r.noop).toBe(true);
    expect(r.reason).toMatch(/not initialized/);
    expect(deps.openStore).not.toHaveBeenCalled();
  });

  test("no-ops in markdown-only mode", async () => {
    const deps = makeDeps({
      readConfig: vi.fn(async () => ({ mode: "markdown-only" }) as unknown as MemoryConfig),
    });
    const r = await refreshFromGit("/repo", { event: "post-commit" }, deps);
    expect(r.noop).toBe(true);
    expect(r.reason).toMatch(/graph mode/);
    expect(deps.openStore).not.toHaveBeenCalled();
  });
});

describe("refreshFromGit post-checkout", () => {
  test("a file checkout (flag=0) is a no-op without touching the store", async () => {
    const deps = makeDeps({});
    const r = await refreshFromGit(
      "/repo",
      { event: "post-checkout", prevHead: "a", newHead: "b", flag: "0" },
      deps,
    );
    expect(r.noop).toBe(true);
    expect(deps.openStore).not.toHaveBeenCalled();
  });

  test("a branch checkout refreshes the changed files and re-exports", async () => {
    const deps = makeDeps({
      git: (args) =>
        args[0] === "diff" ? "M\0src/edit.ts\0A\0src/new.ts\0" : "",
    });
    const r = await refreshFromGit(
      "/repo",
      { event: "post-checkout", prevHead: "aaa", newHead: "bbb", flag: "1" },
      deps,
    );
    expect(r.noop).toBe(false);
    expect(r.range).toEqual({ from: "aaa", to: "bbb" });
    expect(deps.refreshFiles).toHaveBeenCalledWith(expect.anything(), ["src/edit.ts", "src/new.ts"], {
      rootDir: "/repo",
    });
    expect(deps.exportGraph).toHaveBeenCalledTimes(1);
    expect(r.exported).toEqual({ nodes: 5, edges: 3, jsonPath: "/tmp/graph.json" });
  });

  test("no changed files short-circuits before opening the store", async () => {
    const deps = makeDeps({ git: () => "" });
    const r = await refreshFromGit(
      "/repo",
      { event: "post-checkout", prevHead: "aaa", newHead: "bbb", flag: "1" },
      deps,
    );
    expect(r.noop).toBe(true);
    expect(r.reason).toMatch(/no changed files/);
    expect(deps.openStore).not.toHaveBeenCalled();
  });
});

describe("refreshFromGit post-commit", () => {
  test("diffs HEAD against its parent", async () => {
    const calls: string[][] = [];
    const deps = makeDeps({});
    deps.runGit = vi.fn(async (_root, args) => {
      calls.push(args);
      if (args[0] === "rev-parse" && args.includes("HEAD~1")) return "parentsha\n";
      if (args[0] === "rev-parse") return "headsha\n";
      if (args[0] === "diff") return "M\0src/a.ts\0";
      return "";
    });
    const r = await refreshFromGit("/repo", { event: "post-commit" }, deps);
    expect(r.range).toEqual({ from: "parentsha", to: "headsha" });
    expect(calls.some((a) => a[0] === "diff" && a.includes("parentsha") && a.includes("headsha"))).toBe(
      true,
    );
  });

  test("the root commit diffs against the empty tree", async () => {
    const deps = makeDeps({});
    deps.runGit = vi.fn(async (_root, args) => {
      if (args[0] === "rev-parse" && args.includes("HEAD~1")) throw new Error("no parent");
      if (args[0] === "rev-parse") return "rootsha\n";
      if (args[0] === "diff") return "A\0src/a.ts\0";
      return "";
    });
    const r = await refreshFromGit("/repo", { event: "post-commit" }, deps);
    expect(r.range).toEqual({ from: EMPTY_TREE_OID, to: "rootsha" });
  });

  test("export can be skipped", async () => {
    const deps = makeDeps({ git: (args) => (args[0] === "diff" ? "M\0a.ts\0" : "x\n") });
    const r = await refreshFromGit("/repo", { event: "post-commit", export: false }, deps);
    expect(r.noop).toBe(false);
    expect(deps.exportGraph).not.toHaveBeenCalled();
    expect(r.exported).toBeUndefined();
  });
});
