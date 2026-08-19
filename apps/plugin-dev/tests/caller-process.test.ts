import { describe, expect, it } from "vitest";
import { callerProcessTree, parsePsAncestorLine } from "../src/runtime/caller-process.js";

describe("caller-process", () => {
  it("parses ps pid/ppid/comm output", () => {
    expect(parsePsAncestorLine("  42  7 openai-codex\n")).toEqual({
      pid: 42,
      ppid: 7,
      command: "openai-codex",
    });
    expect(parsePsAncestorLine("")).toBeNull();
    expect(parsePsAncestorLine("not a pid")).toBeNull();
  });

  it("walks parent processes into a detection string", () => {
    const table = new Map<number, string>([
      [30, "30 20 node\n"],
      [20, "20 10 openai-codex\n"],
      [10, "10 1 bash\n"],
    ]);

    const tree = callerProcessTree(30, (pid) => table.get(pid) ?? "", 8);

    expect(tree).toContain("node");
    expect(tree).toContain("openai-codex");
    expect(tree).toContain("bash");
  });

  it("stops on cycles", () => {
    const tree = callerProcessTree(30, () => "30 30 codex\n", 8);
    expect(tree).toBe("codex");
  });

  it("degrades to a partial tree when the inspector throws (transient ps failure)", () => {
    // First call succeeds, second throws — the walk stops at depth 1 and
    // returns what it already collected rather than propagating the error.
    const table = new Map<number, string>([
      [30, "30 20 node\n"],
    ]);
    const tree = callerProcessTree(
      30,
      (pid) => {
        const row = table.get(pid);
        if (row) return row;
        throw Object.assign(new Error("spawnSync ps ETIMEDOUT"), { code: "ETIMEDOUT" });
      },
      8,
    );
    expect(tree).toContain("node");
    // Walk stopped — deeper ancestors not included, but no throw.
    expect(tree).not.toContain("openai-codex");
  });

  it("returns empty string when the very first inspector call throws", () => {
    const tree = callerProcessTree(
      30,
      () => { throw Object.assign(new Error("spawnSync ps ETIMEDOUT"), { code: "ETIMEDOUT" }); },
      8,
    );
    expect(tree).toBe("");
  });
});
