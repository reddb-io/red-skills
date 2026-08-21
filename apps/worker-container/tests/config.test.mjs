import { describe, expect, it } from "vitest";

import { buildRunEnv, resolveConfig } from "../src/config.mjs";

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

  it("defaults the cadence, queue label, width and loop mode", () => {
    const config = resolveConfig(base);
    expect(config.cadence).toEqual(["claude", "codex", "opencode"]);
    expect(config.label).toBe("ready-for-agent");
    expect(config.lane).toBe("");
    expect(config.target).toBe(1);
    expect(config.pollSeconds).toBe(15);
    expect(config.loop).toBe(false);
  });

  it("honours an explicit cadence, lane, width and loop mode", () => {
    const config = resolveConfig({
      ...base,
      RED_AFK_RUNNER_CADENCE: "opencode,claude-minimax",
      RED_AFK_LOOP: "TRUE",
      RED_AFK_QUEUE_LABEL: "agent-ready",
      RED_AFK_QUEUE_LANE: "go",
      RED_AFK_TARGET: "4",
      RED_AFK_POLL_SECONDS: "5",
    });
    expect(config.cadence).toEqual(["opencode", "claude-minimax"]);
    expect(config.loop).toBe(true);
    expect(config.label).toBe("agent-ready");
    expect(config.lane).toBe("go");
    expect(config.target).toBe(4);
    expect(config.pollSeconds).toBe(5);
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
  it("tags the container lane for observability", () => {
    expect(buildRunEnv(base, {}).RED_AFK_LANE).toBe("container");
  });

  it("keeps the credential env vars the daemon and the coder Agents read", () => {
    const env = buildRunEnv({ ...base, MINIMAX_API_KEY: "m" }, { token: "gh-token" });
    expect(env.ANTHROPIC_API_KEY).toBe("a");
    expect(env.MINIMAX_API_KEY).toBe("m");
    expect(env.GH_TOKEN).toBe("gh-token");
  });
});
