import { describe, expect, it } from "vitest";
import { parseRunFlags, RunFlagError, deriveActivity } from "../src/commands/run.js";
import type { AgentStreamEvent } from "../src/core/execution.js";

describe("deriveActivity (native-path monitor stage detection)", () => {
  const tool = (name: string, formattedArgs: string): AgentStreamEvent => ({
    type: "toolCall",
    name,
    formattedArgs,
    iteration: 1,
    timestamp: new Date(0),
  });

  const reasoning = (message = "Thinking through the next change"): AgentStreamEvent => ({
    type: "reasoning",
    message,
    iteration: 1,
    timestamp: new Date(0),
  });

  it("returns undefined for text chunks (no stage signal)", () => {
    expect(deriveActivity({ type: "text", message: "thinking…", iteration: 1, timestamp: new Date(0) })).toBeUndefined();
  });

  it("returns undefined for reasoning events (never overwrites a concrete stage)", () => {
    expect(deriveActivity(reasoning())).toBeUndefined();
  });

  it("reasoning after a concrete tool call does not clobber the concrete stage (#1389)", () => {
    // Simulate: reasoning → toolCall(Edit) → reasoning
    // The derived stage after the sequence must end at "impl", not "plan".
    const stages = [reasoning(), tool("Edit", "src/foo.ts"), reasoning()].map(deriveActivity);
    expect(stages).toEqual([undefined, "impl", undefined]);
    // The last non-undefined stage in the stream is "impl", not "plan".
    const lastConcrete = stages.filter(Boolean).at(-1);
    expect(lastConcrete).toBe("impl");
  });

  it("maps Edit/Write tools to impl", () => {
    expect(deriveActivity(tool("Edit", "src/foo.ts"))).toBe("impl");
    expect(deriveActivity(tool("Write", "src/bar.ts"))).toBe("impl");
  });

  it("maps a git commit to commit (before the generic test/explore checks)", () => {
    expect(deriveActivity(tool("Bash", "git commit -m 'feat: x'"))).toBe("commit");
  });

  it("maps a vitest / pnpm test run to tests", () => {
    expect(deriveActivity(tool("Bash", "pnpm -C pkg test"))).toBe("tests");
    expect(deriveActivity(tool("Bash", "./node_modules/.bin/vitest run"))).toBe("tests");
    expect(deriveActivity(tool("Bash", "cargo test --all"))).toBe("tests");
  });

  it("maps typecheck commands across JS/TS and Rust", () => {
    expect(deriveActivity(tool("Bash", "pnpm typecheck"))).toBe("typecheck");
    expect(deriveActivity(tool("Bash", "cargo check --workspace"))).toBe("typecheck");
  });

  it("maps lint commands across JS/TS and Rust", () => {
    expect(deriveActivity(tool("Bash", "eslint ."))).toBe("lint");
    expect(deriveActivity(tool("Bash", "cargo clippy --all-targets"))).toBe("lint");
  });

  it("maps build commands across JS/TS and Rust", () => {
    expect(deriveActivity(tool("Bash", "pnpm build"))).toBe("build");
    expect(deriveActivity(tool("Bash", "cargo build --release"))).toBe("build");
  });

  it("maps push and review commands", () => {
    expect(deriveActivity(tool("Bash", "git push origin HEAD"))).toBe("push");
    expect(deriveActivity(tool("Bash", "git diff --stat"))).toBe("review");
    expect(deriveActivity(tool("Bash", "git log --oneline -5"))).toBe("review");
  });

  it("maps Read/Grep and git ls-files/find to explore", () => {
    expect(deriveActivity(tool("Read", "src/foo.ts"))).toBe("explore");
    expect(deriveActivity(tool("Grep", "needle"))).toBe("explore");
    expect(deriveActivity(tool("Bash", "git ls-files"))).toBe("explore");
    expect(deriveActivity(tool("Bash", "find . -name '*.ts'"))).toBe("explore");
  });

  it("does not mislabel an explore/read of a 'test'-containing path as tests (#589)", () => {
    expect(deriveActivity(tool("Read", "src/components/test-utils.ts"))).toBe("explore");
    expect(deriveActivity(tool("Read", "src/foo.test.ts"))).toBe("explore");
    expect(deriveActivity(tool("Glob", "**/*.test.ts"))).toBe("explore");
    // Editing a test file is implementation work, not a test run.
    expect(deriveActivity(tool("Edit", "src/foo.test.ts"))).toBe("impl");
    // A real test-runner invocation is still tests.
    expect(deriveActivity(tool("Bash", "pnpm test src/foo.test.ts"))).toBe("tests");
  });

  it("returns undefined for an unrecognised tool with no stage signal", () => {
    expect(deriveActivity(tool("WebFetch", "https://example.com"))).toBeUndefined();
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
      prePr: false,
      localMerge: false,
      yolo: false,
      verifyCommand: undefined,
      goVerifyRetries: undefined,
      force: false,
    });
  });

  it("parses the /go dispatch-mode flags --pre-pr / --local-merge / --yolo", () => {
    const f = parseRunFlags(["--pre-pr", "--local-merge", "--yolo"]);
    expect(f.prePr).toBe(true);
    expect(f.localMerge).toBe(true);
    expect(f.yolo).toBe(true);
    const d = parseRunFlags([]);
    expect(d.prePr).toBe(false);
    expect(d.localMerge).toBe(false);
    expect(d.yolo).toBe(false);
  });

  it("parses the /go inline verify command and bounded verify retry cap", () => {
    const f = parseRunFlags(["--verify", "npm run test -- go", "--go-verify-retries", "3"]);
    expect(f.verifyCommand).toBe("npm run test -- go");
    expect(f.goVerifyRetries).toBe(3);
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
    const f = parseRunFlags(["--spec", "7"]);
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

  it("parses --spec into a spec filter", () => {
    expect(parseRunFlags(["--spec", "42"]).filter).toEqual({ kind: "spec", spec: 42 });
    expect(parseRunFlags(["--spec=7"]).filter).toEqual({ kind: "spec", spec: 7 });
  });

  it("parses --origin and --lane (the /go provenance + isolated lane), undefined by default", () => {
    expect(parseRunFlags([]).origin).toBeUndefined();
    expect(parseRunFlags([]).lane).toBeUndefined();
    const f = parseRunFlags(["--origin", "go", "--lane", "lane:go"]);
    expect(f.origin).toBe("go");
    expect(f.lane).toBe("lane:go");
  });

  it("parses --run-mode (the scout read-only enforcement flag), undefined by default", () => {
    expect(parseRunFlags([]).runMode).toBeUndefined();
    const f = parseRunFlags(["--run-mode", "scout"]);
    expect(f.runMode).toBe("scout");
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
    expect(() => parseRunFlags(["--spec"])).toThrow();
  });

  it("parses --force as a boolean, defaulting to false (#1027)", () => {
    expect(parseRunFlags(["--force"]).force).toBe(true);
    expect(parseRunFlags([]).force).toBe(false);
  });
});
