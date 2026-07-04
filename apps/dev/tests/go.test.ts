import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_GO_MODE,
  DEFAULT_GO_VERIFY_RETRIES,
  GO_NO_HARNESS_ITER_CAP,
  GO_GATE_CONTEXT,
  GO_MODES,
  GO_ORIGIN,
  GO_WORKERS_SEGMENT,
  LABEL_GO_LANE,
  buildDisposableIssue,
  buildGoEngineArgs,
  dispatchGo,
  goWorkersRoot,
  parseGoMode,
  type DisposableIssueSpec,
} from "../src/core/go.js";

describe("buildDisposableIssue", () => {
  it("labels the issue only with the isolated lane, never ready-for-agent", () => {
    const spec = buildDisposableIssue("fix the flaky login test");
    expect(spec.labels).toEqual([LABEL_GO_LANE]);
    expect(spec.labels).not.toContain("ready-for-agent");
  });

  it("titles from the first line and embeds the full demand in the body", () => {
    const spec = buildDisposableIssue("add a retry to the uploader\nwith backoff");
    expect(spec.title).toBe("/go: add a retry to the uploader");
    expect(spec.body).toContain("add a retry to the uploader\nwith backoff");
    expect(spec.body).toContain("auto-closes");
  });

  it("records the approved Task, semantic DoD, and machine gate on the disposable issue", () => {
    const spec = buildDisposableIssue("short demand", {
      task: "Detailed approved task with implementation boundaries.",
      dod: "The command stops once the login retry is implemented and covered by tests.",
      verifyCommand: "npm run test -- login",
    });

    expect(spec.body).toContain("## Task");
    expect(spec.body).toContain("Detailed approved task with implementation boundaries.");
    expect(spec.body).toContain("## Acceptance Criteria");
    expect(spec.body).toContain("The command stops once the login retry is implemented");
    expect(spec.body).toContain("## Machine Gate");
    expect(spec.body).toContain("npm run test -- login");
  });

  it("truncates an overlong title to 72 chars", () => {
    const long = "x".repeat(200);
    const spec = buildDisposableIssue(long);
    expect(spec.title.length).toBe("/go: ".length + 72);
  });

  it("rejects an empty demand", () => {
    expect(() => buildDisposableIssue("   ")).toThrow(/non-empty/);
  });
});

describe("goWorkersRoot", () => {
  it("namespaces under go-workers, separate from the fleet's workers", () => {
    expect(goWorkersRoot("/repo/.red/tmp")).toBe("/repo/.red/tmp/go-workers");
    expect(goWorkersRoot("/repo/.red/tmp/")).toBe("/repo/.red/tmp/go-workers");
    expect(GO_WORKERS_SEGMENT).toBe("go-workers");
  });
});

describe("buildGoEngineArgs", () => {
  it("reuses the engine single-shot, single-issue, origin=go, lane:go", () => {
    expect(buildGoEngineArgs({ issue: 938 })).toEqual([
      "--once",
      "--issues",
      "938",
      "--origin",
      "go",
      "--lane",
      "lane:go",
    ]);
    expect(GO_ORIGIN).toBe("go");
    expect(GO_GATE_CONTEXT).toBe("interactive");
  });

  it("pins the runner when given", () => {
    expect(buildGoEngineArgs({ issue: 7, runner: "codex" })).toContain("--runner");
    expect(buildGoEngineArgs({ issue: 7, runner: "codex" })).toContain("codex");
  });

  it("rejects a non-positive issue so a failed mint never spawns at issue 0", () => {
    expect(() => buildGoEngineArgs({ issue: 0 })).toThrow(/invalid issue/);
    expect(() => buildGoEngineArgs({ issue: -1 })).toThrow(/invalid issue/);
  });

  it("defaults to direct-PR: the standard path appends no mode flag", () => {
    expect(buildGoEngineArgs({ issue: 7, mode: "direct-PR" })).toEqual(
      buildGoEngineArgs({ issue: 7 }),
    );
    expect(buildGoEngineArgs({ issue: 7 })).not.toContain("--pre-pr");
    expect(buildGoEngineArgs({ issue: 7 })).not.toContain("--local-merge");
  });

  it("no-mistakes routes through the hardened pre-PR pipeline (--pre-pr)", () => {
    const args = buildGoEngineArgs({ issue: 7, mode: "no-mistakes" });
    expect(args).toContain("--pre-pr");
    expect(args).not.toContain("--local-merge");
  });

  it("local-only lands via an approved local fast-forward (--local-merge, no PR flag)", () => {
    const args = buildGoEngineArgs({ issue: 7, mode: "local-only" });
    expect(args).toContain("--local-merge");
    expect(args).not.toContain("--pre-pr");
  });

  it("the opt-in +yolo autonomy bump appends --yolo, and composes with a mode", () => {
    expect(buildGoEngineArgs({ issue: 7 })).not.toContain("--yolo");
    expect(buildGoEngineArgs({ issue: 7, yolo: true })).toContain("--yolo");
    const both = buildGoEngineArgs({ issue: 7, mode: "no-mistakes", yolo: true });
    expect(both).toContain("--pre-pr");
    expect(both).toContain("--yolo");
  });

  it("threads an ephemeral inline verification command into the reused engine", () => {
    const args = buildGoEngineArgs({ issue: 7, verifyCommand: "npm run test -- login" });
    expect(args).toContain("--verify");
    expect(args).toContain("npm run test -- login");
  });

  it("tightens the iteration cap when no harness exists and no inline check was approved", () => {
    const args = buildGoEngineArgs({ issue: 7, hasHarness: false });
    expect(args).toContain("-n");
    expect(args).toContain(String(GO_NO_HARNESS_ITER_CAP));
    expect(DEFAULT_GO_VERIFY_RETRIES).toBe(2);
  });

  it("keeps --runner last after the mode/yolo flags", () => {
    const args = buildGoEngineArgs({ issue: 7, mode: "local-only", yolo: true, runner: "codex" });
    expect(args.slice(-2)).toEqual(["--runner", "codex"]);
  });
});

describe("parseGoMode", () => {
  it("accepts every canonical mode", () => {
    for (const mode of GO_MODES) {
      expect(parseGoMode(mode)).toBe(mode);
    }
    expect(DEFAULT_GO_MODE).toBe("direct-PR");
  });

  it("is case-insensitive and trims whitespace", () => {
    expect(parseGoMode("NO-MISTAKES")).toBe("no-mistakes");
    expect(parseGoMode("  Direct-PR  ")).toBe("direct-PR");
    expect(parseGoMode("local-ONLY")).toBe("local-only");
  });

  it("throws loudly on an unknown mode rather than falling through to default", () => {
    expect(() => parseGoMode("yolo")).toThrow(/invalid --mode/);
    expect(() => parseGoMode("")).toThrow(/invalid --mode/);
  });
});

describe("dispatchGo", () => {
  it("ensures the lane, mints in it, then runs the reused engine on that issue", async () => {
    const ensureLabel = vi.fn(async () => {});
    const createIssue = vi.fn(async (_spec: DisposableIssueSpec) => 1234);
    const runEngine = vi.fn(async (_args: string[]) => 0);

    const result = await dispatchGo({ ensureLabel, createIssue, runEngine }, "do the thing");

    expect(ensureLabel).toHaveBeenCalledWith(LABEL_GO_LANE);
    expect(createIssue).toHaveBeenCalledOnce();
    expect(createIssue.mock.calls[0]![0].labels).toEqual([LABEL_GO_LANE]);
    expect(runEngine).toHaveBeenCalledWith(buildGoEngineArgs({ issue: 1234 }));
    expect(result).toEqual({ issue: 1234, engineExit: 0 });
  });

  it("ensures the lane BEFORE minting into it", async () => {
    const order: string[] = [];
    await dispatchGo(
      {
        ensureLabel: async () => { order.push("ensure"); },
        createIssue: async () => { order.push("create"); return 9; },
        runEngine: async () => { order.push("run"); return 0; },
      },
      "demand",
    );
    expect(order).toEqual(["ensure", "create", "run"]);
  });

  it("threads the dispatch mode + yolo bump into the reused-engine argv", async () => {
    const runEngine = vi.fn(async (_args: string[]) => 0);
    await dispatchGo(
      { ensureLabel: async () => {}, createIssue: async () => 42, runEngine },
      "ship it",
      { mode: "local-only", yolo: true },
    );
    expect(runEngine).toHaveBeenCalledWith(
      buildGoEngineArgs({ issue: 42, mode: "local-only", yolo: true }),
    );
    const args = runEngine.mock.calls[0]![0];
    expect(args).toContain("--local-merge");
    expect(args).toContain("--yolo");
  });

  it("mints the issue with the approved Task + DoD before running the reused engine", async () => {
    const createIssue = vi.fn(async (_spec: DisposableIssueSpec) => 77);
    const runEngine = vi.fn(async (_args: string[]) => 0);
    await dispatchGo(
      { ensureLabel: async () => {}, createIssue, runEngine },
      "ship it",
      {
        task: "Approved detailed task",
        dod: "Done when the approved acceptance statement is satisfied.",
        verifyCommand: "npm run test -- go",
      },
    );

    const spec = createIssue.mock.calls[0]![0];
    expect(spec.body).toContain("Approved detailed task");
    expect(spec.body).toContain("Done when the approved acceptance statement is satisfied.");
    expect(runEngine).toHaveBeenCalledWith(
      buildGoEngineArgs({ issue: 77, verifyCommand: "npm run test -- go" }),
    );
  });

  it("propagates a non-zero engine exit", async () => {
    const result = await dispatchGo(
      {
        ensureLabel: async () => {},
        createIssue: async () => 5,
        runEngine: async () => 1,
      },
      "demand",
      { runner: "claude" },
    );
    expect(result.engineExit).toBe(1);
  });
});
