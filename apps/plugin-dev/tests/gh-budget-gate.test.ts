import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { GITHUB_BUDGET_GATE_ENV } from "@reddb-io/github";
import { resolveGithubBudgetGateMode } from "../src/runtime/gh/budget-gate-config.js";
import { createDaemonQuotaResetProbe } from "../src/runtime/gh/quota-reset-probe.js";
import { defaultGhQuotaBackoff, MAX_FALLBACK_WAIT_MS } from "../src/runtime/gh/quota.js";
import type { GithubBalance } from "@reddb-io/github";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function repoWith(configYaml: string | null): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "gh-budget-gate-"));
  roots.push(root);
  if (configYaml !== null) {
    await mkdir(join(root, ".red"), { recursive: true });
    await writeFile(join(root, ".red", "config.yaml"), configYaml, "utf8");
  }
  return root;
}

function balanceWith(resetAt: Partial<Record<"rest" | "graphql" | "search", string>>): GithubBalance {
  const pool = (name: "rest" | "graphql" | "search") =>
    resetAt[name] === undefined ? null : {
      pool: name,
      resource: name,
      limit: 100,
      remaining: 0,
      used: 100,
      reset_at: resetAt[name]!,
      fraction: 0,
    };
  return {
    version: 1,
    origin: "asked",
    outcome: "asked",
    source: "GET /rate_limit",
    asked_at: "2026-08-12T17:38:03.795Z",
    request_count: 1,
    pools: { rest: pool("rest"), graphql: pool("graphql"), search: pool("search") },
    unreported_pools: [],
    detail: "test balance",
  } as GithubBalance;
}

describe("the GitHub budget gate is opt-in (#3768)", () => {
  it("is off when the project declared nothing — the quota is the operator's", async () => {
    const root = await repoWith(null);
    expect(resolveGithubBudgetGateMode({ root, env: {}, fresh: true })).toBe("off");
  });

  it("is off when the config file mentions other things", async () => {
    const root = await repoWith("plugins:\n  dev:\n    enabled: true\n");
    expect(resolveGithubBudgetGateMode({ root, env: {}, fresh: true })).toBe("off");
  });

  it("turns on when the project declares github.budget_gate", async () => {
    const root = await repoWith("github:\n  budget_gate: on\n");
    expect(resolveGithubBudgetGateMode({ root, env: {}, fresh: true })).toBe("on");
  });

  it("lets the env override one run without touching the file", async () => {
    const root = await repoWith("github:\n  budget_gate: on\n");
    expect(resolveGithubBudgetGateMode({
      root,
      env: { [GITHUB_BUDGET_GATE_ENV]: "off" },
      fresh: true,
    })).toBe("off");
  });

  it("reads an unparseable config as off rather than as a refusal", async () => {
    const root = await repoWith("github: [this is not: valid yaml\n");
    expect(resolveGithubBudgetGateMode({ root, env: {}, fresh: true })).toBe("off");
  });
});

describe("a quota wait aims at the real reset (#3768)", () => {
  it("is installed by default, so no production wait paces blind", () => {
    expect(defaultGhQuotaBackoff().probeResetMs).toBeTypeOf("function");
  });

  it("keeps a blind fallback rung short enough to read as a wait, not a hang", () => {
    expect(MAX_FALLBACK_WAIT_MS).toBeLessThanOrEqual(60_000);
  });

  it("answers with the soonest reset across the pools", async () => {
    const probe = createDaemonQuotaResetProbe(async () => balanceWith({
      search: "2026-08-12T17:39:04.000Z",
      rest: "2026-08-12T17:47:42.000Z",
    }));
    expect(await probe()).toBe(Date.parse("2026-08-12T17:39:04.000Z"));
  });

  it("answers null when no daemon holds a balance, so the fallback still paces", async () => {
    const probe = createDaemonQuotaResetProbe(async () => null);
    expect(await probe()).toBeNull();
  });
});
