import { describe, expect, it, vi } from "vitest";
import {
  SCOUT_ORIGIN,
  SCOUT_WORKERS_SEGMENT,
  SCOUT_RUN_MODE,
  LABEL_SCOUT_LANE,
  buildScoutIssueSpec,
  buildScoutEngineArgs,
  dispatchScout,
  scoutWorkersRoot,
  type ScoutIssueSpec,
} from "../src/core/scout.js";

describe("buildScoutIssueSpec", () => {
  it("labels the issue only with the scout lane, never ready-for-agent or lane:go", () => {
    const spec = buildScoutIssueSpec("how does the dispatch engine work?");
    expect(spec.labels).toEqual([LABEL_SCOUT_LANE]);
    expect(spec.labels).not.toContain("ready-for-agent");
    expect(spec.labels).not.toContain("lane:go");
  });

  it("titles from the first line and embeds the full question in the body", () => {
    const spec = buildScoutIssueSpec("what is the fleet size limit?\nexplain in detail");
    expect(spec.title).toBe("/scout: what is the fleet size limit?");
    expect(spec.body).toContain("what is the fleet size limit?\nexplain in detail");
  });

  it("truncates an overlong title to 70 chars", () => {
    const long = "x".repeat(200);
    const spec = buildScoutIssueSpec(long);
    expect(spec.title.length).toBe("/scout: ".length + 70);
  });

  it("rejects an empty question", () => {
    expect(() => buildScoutIssueSpec("   ")).toThrow(/non-empty/);
  });

  it("body states read-only mandate so the agent never commits", () => {
    const spec = buildScoutIssueSpec("any question");
    expect(spec.body).toContain("read-only");
    expect(spec.body).toContain("NOT commit");
  });
});

describe("scoutWorkersRoot", () => {
  it("namespaces under scout-workers, separate from go-workers and workers", () => {
    expect(scoutWorkersRoot("/repo/.red/tmp")).toBe("/repo/.red/tmp/scout-workers");
    expect(scoutWorkersRoot("/repo/.red/tmp/")).toBe("/repo/.red/tmp/scout-workers");
    expect(SCOUT_WORKERS_SEGMENT).toBe("scout-workers");
  });
});

describe("buildScoutEngineArgs", () => {
  it("passes run-mode=scout so process-issue skips all mutations", () => {
    const args = buildScoutEngineArgs({ issue: 922 });
    expect(args).toContain("--run-mode");
    expect(args).toContain("scout");
    expect(SCOUT_RUN_MODE).toBe("scout");
  });

  it("reuses the engine single-shot, single-issue, origin=scout, lane:scout", () => {
    expect(buildScoutEngineArgs({ issue: 922 })).toEqual([
      "--once",
      "--issues",
      "922",
      "--origin",
      "scout",
      "--lane",
      "lane:scout",
      "--run-mode",
      "scout",
    ]);
    expect(SCOUT_ORIGIN).toBe("scout");
  });

  it("pins the runner when given", () => {
    const args = buildScoutEngineArgs({ issue: 1, runner: "codex" });
    expect(args).toContain("--runner");
    expect(args).toContain("codex");
  });

  it("rejects a non-positive issue so a failed mint never spawns at issue 0", () => {
    expect(() => buildScoutEngineArgs({ issue: 0 })).toThrow(/invalid issue/);
    expect(() => buildScoutEngineArgs({ issue: -1 })).toThrow(/invalid issue/);
  });
});

describe("dispatchScout", () => {
  it("ensures the lane, mints in it, then runs the engine on that issue", async () => {
    const ensureLabel = vi.fn(async () => {});
    const createIssue = vi.fn(async (_spec: ScoutIssueSpec) => 9001);
    const runEngine = vi.fn(async (_args: string[]) => 0);

    const result = await dispatchScout({ ensureLabel, createIssue, runEngine }, "what does scout do?");

    expect(ensureLabel).toHaveBeenCalledWith(LABEL_SCOUT_LANE);
    expect(createIssue).toHaveBeenCalledOnce();
    expect(createIssue.mock.calls[0]![0].labels).toEqual([LABEL_SCOUT_LANE]);
    expect(runEngine).toHaveBeenCalledWith(buildScoutEngineArgs({ issue: 9001 }));
    expect(result).toEqual({ issue: 9001, engineExit: 0 });
  });

  it("ensures the lane BEFORE minting into it", async () => {
    const order: string[] = [];
    await dispatchScout(
      {
        ensureLabel: async () => { order.push("ensure"); },
        createIssue: async () => { order.push("create"); return 9; },
        runEngine: async () => { order.push("run"); return 0; },
      },
      "question",
    );
    expect(order).toEqual(["ensure", "create", "run"]);
  });

  it("propagates a non-zero engine exit", async () => {
    const result = await dispatchScout(
      {
        ensureLabel: async () => {},
        createIssue: async () => 5,
        runEngine: async () => 1,
      },
      "question",
      { runner: "claude" },
    );
    expect(result.engineExit).toBe(1);
  });

  it("disposes the minted scout Ticket when Worker admission fails (#3175)", async () => {
    const disposeIssue = vi.fn(async (_issue: number) => undefined);
    await expect(
      dispatchScout(
        {
          ensureLabel: async () => undefined,
          createIssue: async () => 67,
          runEngine: async () => {
            throw new Error("host refused Worker birth");
          },
          disposeIssue,
        },
        "question",
      ),
    ).rejects.toThrow("host refused Worker birth");
    expect(disposeIssue).toHaveBeenCalledWith(67);
  });

  it("passes --run-mode scout in engine args so process-issue enforces read-only", async () => {
    const runEngine = vi.fn(async (_args: string[]) => 0);
    await dispatchScout({ ensureLabel: async () => {}, createIssue: async () => 7, runEngine }, "q");
    const args = runEngine.mock.calls[0]![0] as string[];
    const idx = args.indexOf("--run-mode");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("scout");
  });
});
