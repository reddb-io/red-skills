import { describe, expect, it, vi } from "vitest";

import { runCycle } from "../src/attempt.mjs";

const config = {
  token: "gh-token",
  repos: ["owner/one"],
  cadence: ["claude", "codex", "opencode"],
  label: "ready-for-agent",
  model: "",
  effort: "",
};

const issueList = (numbers) => numbers.map((number) => ({ number, createdAt: `2026-01-0${number}`, labels: [] }));

function fakeIo(overrides = {}) {
  return {
    listIssues: vi.fn().mockResolvedValue(issueList([7])),
    makeWorkdir: vi.fn().mockResolvedValue("/tmp/afk-run"),
    clone: vi.fn().mockResolvedValue(undefined),
    runEngine: vi.fn().mockResolvedValue(0),
    cleanup: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

const env = { ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "o" };
const log = () => {};

describe("runCycle", () => {
  it("claims the queue head through the engine in an ephemeral clone", async () => {
    const io = fakeIo();
    const outcome = await runCycle({ config, cycle: 0, env, io, log });

    expect(outcome).toMatchObject({ status: "worked", repo: "owner/one", issue: 7, runner: "claude", exitCode: 0 });
    expect(io.clone).toHaveBeenCalledWith({ repo: "owner/one", dir: "/tmp/afk-run" });
    expect(io.runEngine).toHaveBeenCalledWith(
      expect.objectContaining({ dir: "/tmp/afk-run", issue: 7, runner: "claude" }),
    );
  });

  it("removes the ephemeral clone after the run", async () => {
    const io = fakeIo();
    await runCycle({ config, cycle: 0, env, io, log });
    expect(io.cleanup).toHaveBeenCalledWith("/tmp/afk-run");
  });

  it("removes the ephemeral clone even when the engine throws", async () => {
    const io = fakeIo({ runEngine: vi.fn().mockRejectedValue(new Error("engine exploded")) });
    await expect(runCycle({ config, cycle: 0, env, io, log })).rejects.toThrow(/engine exploded/);
    expect(io.cleanup).toHaveBeenCalledWith("/tmp/afk-run");
  });

  it("reports a non-zero engine exit without throwing", async () => {
    const io = fakeIo({ runEngine: vi.fn().mockResolvedValue(3) });
    const outcome = await runCycle({ config, cycle: 0, env, io, log });
    expect(outcome).toMatchObject({ status: "failed", exitCode: 3 });
    expect(io.cleanup).toHaveBeenCalled();
  });

  it("moves to the next target repo when the first queue is empty", async () => {
    const io = fakeIo({
      listIssues: vi.fn(async ({ repo }) => (repo === "owner/two" ? issueList([4]) : [])),
    });
    const outcome = await runCycle({ config: { ...config, repos: ["owner/one", "owner/two"] }, cycle: 0, env, io, log });

    expect(outcome).toMatchObject({ status: "worked", repo: "owner/two", issue: 4 });
  });

  it("rotates the repo list so no repo starves", async () => {
    const io = fakeIo();
    const outcome = await runCycle({ config: { ...config, repos: ["owner/one", "owner/two"] }, cycle: 1, env, io, log });
    expect(outcome.repo).toBe("owner/two");
  });

  it("exits clean on an empty queue without cloning anything", async () => {
    const io = fakeIo({ listIssues: vi.fn().mockResolvedValue([]) });
    const outcome = await runCycle({ config, cycle: 0, env, io, log });

    expect(outcome).toEqual({ status: "empty" });
    expect(io.clone).not.toHaveBeenCalled();
    expect(io.makeWorkdir).not.toHaveBeenCalled();
  });

  it("skips a runner whose credential is missing and uses the next in cadence", async () => {
    const io = fakeIo();
    const outcome = await runCycle({ config, cycle: 0, env: { OPENAI_API_KEY: "o" }, io, log });
    expect(outcome.runner).toBe("codex");
  });

  it("advances the runner one step per cycle", async () => {
    const io = fakeIo();
    const second = await runCycle({ config, cycle: 1, env, io, log });
    expect(second.runner).toBe("codex");
  });

  it("stops before touching the queue when no cadence runner is credentialed", async () => {
    const io = fakeIo();
    const outcome = await runCycle({ config, cycle: 0, env: {}, io, log });

    expect(outcome).toMatchObject({ status: "no-runner" });
    expect(io.listIssues).not.toHaveBeenCalled();
  });

  it("passes the model override through to the engine for the claude-minimax lane", async () => {
    const io = fakeIo();
    const minimax = { ...config, cadence: ["claude-minimax"], model: "MiniMax-M3", effort: "low" };
    const outcome = await runCycle({ config: minimax, cycle: 0, env: { MINIMAX_API_KEY: "m" }, io, log });

    expect(outcome.runner).toBe("claude-minimax");
    const runEnv = io.runEngine.mock.calls[0][0].env;
    expect(runEnv.RED_AFK_MODEL).toBe("MiniMax-M3");
    expect(runEnv.RED_AFK_EFFORT).toBe("low");
    expect(runEnv.RED_AFK_SANDBOX).toBe("none");
  });

  it("never reaches claude-minimax through a missing-credential fallback", async () => {
    const io = fakeIo();
    const outcome = await runCycle({ config, cycle: 0, env: { MINIMAX_API_KEY: "m" }, io, log });
    expect(outcome.runner).toBe("opencode");
  });
});
