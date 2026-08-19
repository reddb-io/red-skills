import { describe, expect, it } from "vitest";

import { buildRunEnv, nextBackoffSeconds, resolveConfig } from "../src/config.mjs";

const base = { GH_TOKEN: "gh-token", RED_AFK_TARGET_REPOS: "owner/name", ANTHROPIC_API_KEY: "a" };

describe("resolveConfig", () => {
  it("reads a single target repo", () => {
    expect(resolveConfig(base).repos).toEqual(["owner/name"]);
  });

  it("reads a comma-separated repo list, trimming blanks", () => {
    const config = resolveConfig({ ...base, RED_AFK_TARGET_REPOS: " a/one , b/two ,, " });
    expect(config.repos).toEqual(["a/one", "b/two"]);
  });

  it("accepts GITHUB_TOKEN as an alias for GH_TOKEN", () => {
    const config = resolveConfig({ RED_AFK_TARGET_REPOS: "o/n", GITHUB_TOKEN: "t" });
    expect(config.token).toBe("t");
  });

  it("requires a token", () => {
    expect(() => resolveConfig({ RED_AFK_TARGET_REPOS: "o/n" })).toThrow(/GH_TOKEN/);
  });

  it("requires at least one target repo", () => {
    expect(() => resolveConfig({ GH_TOKEN: "t" })).toThrow(/RED_AFK_TARGET_REPOS/);
  });

  it("rejects a malformed repo slug", () => {
    expect(() => resolveConfig({ ...base, RED_AFK_TARGET_REPOS: "not-a-slug" })).toThrow(/not-a-slug/);
    expect(() => resolveConfig({ ...base, RED_AFK_TARGET_REPOS: "https://github.com/o/n" })).toThrow(/slug/);
  });

  it("defaults the cadence, queue label and loop mode", () => {
    const config = resolveConfig(base);
    expect(config.cadence).toEqual(["claude", "codex", "opencode"]);
    expect(config.label).toBe("ready-for-agent");
    expect(config.loop).toBe(false);
  });

  it("honours an explicit cadence and loop mode", () => {
    const config = resolveConfig({
      ...base,
      RED_AFK_RUNNER_CADENCE: "opencode,claude-minimax",
      RED_AFK_LOOP: "TRUE",
      RED_AFK_QUEUE_LABEL: "agent-ready",
    });
    expect(config.cadence).toEqual(["opencode", "claude-minimax"]);
    expect(config.loop).toBe(true);
    expect(config.label).toBe("agent-ready");
  });

  it("carries the model/effort overrides through unchanged", () => {
    const config = resolveConfig({ ...base, RED_AFK_MODEL: "MiniMax-M3", RED_AFK_EFFORT: "low" });
    expect(config.model).toBe("MiniMax-M3");
    expect(config.effort).toBe("low");
  });

  it("clamps the idle backoff bounds to sane numbers", () => {
    const config = resolveConfig({ ...base, RED_AFK_LOOP_IDLE_SECONDS: "5", RED_AFK_LOOP_MAX_IDLE_SECONDS: "0" });
    expect(config.idleSeconds).toBe(5);
    expect(config.maxIdleSeconds).toBeGreaterThanOrEqual(config.idleSeconds);
  });

  it("ignores a non-numeric backoff and uses the default", () => {
    expect(resolveConfig({ ...base, RED_AFK_LOOP_IDLE_SECONDS: "soon" }).idleSeconds).toBe(60);
  });
});

describe("buildRunEnv", () => {
  it("forces the no-sandbox lane and tags the container lane", () => {
    const env = buildRunEnv({ ...base, RED_AFK_SANDBOX: "docker" }, {});
    expect(env.RED_AFK_SANDBOX).toBe("none");
    expect(env.RED_AFK_LANE).toBe("container");
  });

  it("passes RED_AFK_MODEL and RED_AFK_EFFORT through when set", () => {
    const env = buildRunEnv(base, { model: "MiniMax-M3", effort: "low" });
    expect(env.RED_AFK_MODEL).toBe("MiniMax-M3");
    expect(env.RED_AFK_EFFORT).toBe("low");
  });

  it("omits an empty model/effort so the target repo config stays in charge", () => {
    const env = buildRunEnv({ ...base, RED_AFK_MODEL: "inherited" }, { model: "", effort: undefined });
    expect(env.RED_AFK_MODEL).toBeUndefined();
    expect(env.RED_AFK_EFFORT).toBeUndefined();
  });

  it("keeps the credential env vars the runner CLIs read", () => {
    const env = buildRunEnv({ ...base, MINIMAX_API_KEY: "m" }, {});
    expect(env.ANTHROPIC_API_KEY).toBe("a");
    expect(env.MINIMAX_API_KEY).toBe("m");
    expect(env.GH_TOKEN).toBe("gh-token");
  });
});

describe("nextBackoffSeconds", () => {
  it("doubles up to the ceiling", () => {
    expect(nextBackoffSeconds(60, 900)).toBe(120);
    expect(nextBackoffSeconds(600, 900)).toBe(900);
    expect(nextBackoffSeconds(900, 900)).toBe(900);
  });
});
