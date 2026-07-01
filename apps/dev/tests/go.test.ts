import { describe, expect, it, vi } from "vitest";
import {
  GO_GATE_CONTEXT,
  GO_ORIGIN,
  GO_WORKERS_SEGMENT,
  LABEL_GO_LANE,
  buildDisposableIssue,
  buildGoEngineArgs,
  dispatchGo,
  goWorkersRoot,
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
