import { describe, expect, it } from "vitest";
import { parseRunFlags, RunFlagError, deriveStage } from "../src/commands/run.js";
import type { AgentStreamEvent } from "../src/core/execution.js";

describe("deriveStage (native-path monitor stage detection)", () => {
  const tool = (name: string, formattedArgs: string): AgentStreamEvent => ({
    type: "toolCall",
    name,
    formattedArgs,
    iteration: 1,
    timestamp: new Date(0),
  });

  it("returns undefined for text chunks (no stage signal)", () => {
    expect(deriveStage({ type: "text", message: "thinking…", iteration: 1, timestamp: new Date(0) })).toBeUndefined();
  });

  it("maps Edit/Write tools to impl", () => {
    expect(deriveStage(tool("Edit", "src/foo.ts"))).toBe("impl");
    expect(deriveStage(tool("Write", "src/bar.ts"))).toBe("impl");
  });

  it("maps a git commit to commit (before the generic test/explore checks)", () => {
    expect(deriveStage(tool("Bash", "git commit -m 'feat: x'"))).toBe("commit");
  });

  it("maps a vitest / pnpm test run to tests", () => {
    expect(deriveStage(tool("Bash", "pnpm -C pkg test"))).toBe("tests");
    expect(deriveStage(tool("Bash", "./node_modules/.bin/vitest run"))).toBe("tests");
  });

  it("maps Read/Grep and git ls-files/find to explore", () => {
    expect(deriveStage(tool("Read", "src/foo.ts"))).toBe("explore");
    expect(deriveStage(tool("Grep", "needle"))).toBe("explore");
    expect(deriveStage(tool("Bash", "git ls-files"))).toBe("explore");
    expect(deriveStage(tool("Bash", "find . -name '*.ts'"))).toBe("explore");
  });

  it("does not mislabel an explore/read of a 'test'-containing path as tests (#589)", () => {
    expect(deriveStage(tool("Read", "src/components/test-utils.ts"))).toBe("explore");
    expect(deriveStage(tool("Read", "src/foo.test.ts"))).toBe("explore");
    expect(deriveStage(tool("Glob", "**/*.test.ts"))).toBe("explore");
    // Editing a test file is implementation work, not a test run.
    expect(deriveStage(tool("Edit", "src/foo.test.ts"))).toBe("impl");
    // A real test-runner invocation is still tests.
    expect(deriveStage(tool("Bash", "pnpm test src/foo.test.ts"))).toBe("tests");
  });

  it("returns undefined for an unrecognised tool with no stage signal", () => {
    expect(deriveStage(tool("WebFetch", "https://example.com"))).toBeUndefined();
  });
});

describe("parseRunFlags", () => {
  it("defaults to the all filter with no cap", () => {
    expect(parseRunFlags([])).toEqual({
      filter: { kind: "all" },
      iterCap: undefined,
      once: false,
      runnerFlag: undefined,
      request: undefined,
      alternate: false,
      fallbackRunner: false,
      bootOnly: false,
    });
  });

  it("parses --boot-only as a boolean, defaulting to false", () => {
    expect(parseRunFlags(["--boot-only"]).bootOnly).toBe(true);
    expect(parseRunFlags([]).bootOnly).toBe(false);
  });

  it("parses --alternate and --fallback-runner as booleans", () => {
    const f = parseRunFlags(["--alternate", "--fallback-runner"]);
    expect(f.alternate).toBe(true);
    expect(f.fallbackRunner).toBe(true);
  });

  it("defaults --alternate and --fallback-runner to false", () => {
    const f = parseRunFlags(["--prd", "7"]);
    expect(f.alternate).toBe(false);
    expect(f.fallbackRunner).toBe(false);
  });

  it("throws RunFlagError when --alternate is combined with --runner", () => {
    expect(() => parseRunFlags(["--alternate", "--runner", "codex"])).toThrow(RunFlagError);
    expect(() => parseRunFlags(["--runner", "claude", "--alternate"])).toThrow(/mutually exclusive/);
  });

  it("allows --fallback-runner together with --runner (not mutually exclusive)", () => {
    const f = parseRunFlags(["--runner", "codex", "--fallback-runner"]);
    expect(f.runnerFlag).toBe("codex");
    expect(f.fallbackRunner).toBe(true);
  });

  it("parses --prd into a prd filter", () => {
    expect(parseRunFlags(["--prd", "42"]).filter).toEqual({ kind: "prd", prd: 42 });
    expect(parseRunFlags(["--prd=7"]).filter).toEqual({ kind: "prd", prd: 7 });
  });

  it("parses --issues into an ordered number list", () => {
    expect(parseRunFlags(["--issues", "3,1,2"]).filter).toEqual({ kind: "issues", numbers: [3, 1, 2] });
    expect(parseRunFlags(["--issues=10, 20"]).filter).toEqual({ kind: "issues", numbers: [10, 20] });
  });

  it("throws RunFlagError on an all-invalid --issues value instead of selecting zero (#589)", () => {
    expect(() => parseRunFlags(["--issues", "banana"])).toThrow(RunFlagError);
    expect(() => parseRunFlags(["--issues", "banana,kiwi"])).toThrow(/at least one valid issue number/);
    // A partially-valid list still parses (the valid numbers survive).
    expect(parseRunFlags(["--issues", "banana,7"]).filter).toEqual({ kind: "issues", numbers: [7] });
  });

  it("parses -n cap, --once, --runner, --request", () => {
    const f = parseRunFlags(["-n", "0", "--once", "--runner", "codex", "--request", "do it"]);
    expect(f.iterCap).toBe(0);
    expect(f.once).toBe(true);
    expect(f.runnerFlag).toBe("codex");
    expect(f.request).toBe("do it");
  });

  it("throws when a value flag is missing its argument", () => {
    expect(() => parseRunFlags(["--prd"])).toThrow();
  });
});
