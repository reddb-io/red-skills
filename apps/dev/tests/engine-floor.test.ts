// Dispatch refuses a superseded engine (#3031, Spec #3022).
//
// All three forensic recoveries on 2026-08-01 were the same shape: the fix
// merged, main went green, and every dispatched Worker kept running the engine
// from before the fix. The skew was measurable the whole time — nobody asked at
// the one moment it decides what runs. These cases pose the registry (stale,
// current, unreachable, hearsay) and pin what each one costs a dispatch.

import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  evaluateEngineFloor,
  parseEngineFloorPolicy,
  DEFAULT_ENGINE_FLOOR_POLICY,
  ENGINE_FLOOR_CONFIG_KEY,
  engineFloorRepair,
  type EngineFloorVerdict,
} from "../src/core/engine-floor.js";
import {
  checkDispatchEngineFloor,
  resolveEngineFloorPolicy,
  ENGINE_FLOOR_ENV,
} from "../src/runtime/engine-floor-check.js";
import type { PublishedVersionObservation } from "../src/core/published-version.js";
import { CONFIG_DEFAULTS } from "../src/core/config.js";
import { invokeProjectMcp } from "../src/project-acp-adapter.js";
import type { RedskillsProjectAcpSession } from "@reddb-io/redskilled/acp-client";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "engine-floor-"));
  roots.push(root);
  return root;
}

/** A FRESH registry read — the only evidence that can earn a hard refusal. */
function fromRegistry(version: string): PublishedVersionObservation {
  return {
    version,
    source: "registry",
    age_ms: 0,
    stale_after_ms: 1_800_000,
    stale: false,
    reason: "fresh",
  };
}

/** Hearsay: the newest version this HOST knows about, not the newest published. */
function fromCache(version: string): PublishedVersionObservation {
  return {
    version,
    source: "bundle-cache",
    age_ms: -1,
    stale_after_ms: 1_800_000,
    stale: true,
    reason: "cache-only",
  };
}

const UNRESOLVED: PublishedVersionObservation = {
  version: null,
  source: "unresolved",
  age_ms: -1,
  stale_after_ms: 1_800_000,
  stale: true,
  reason: "never-observed",
};

describe("the engine floor judges the engine a dispatch would run", () => {
  it("hands the operator one executable repair command with the exact version", () => {
    const repair = engineFloorRepair("3.4.1");
    expect(repair).toContain("@reddb-io/red-skills@3.4.1");
    expect(repair).toContain("red-skills-redskilled provision");
    expect(repair).not.toContain("<version>");
  });

  it("refuses a superseded engine under `refuse`, naming both versions", () => {
    const verdict = evaluateEngineFloor({
      engineVersion: "3.2.0",
      published: fromRegistry("3.4.1"),
      policy: "refuse",
    });

    expect(verdict.decision).toBe("refuse");
    expect(verdict.code).toBe("superseded");
    expect(verdict.message).toContain("3.2.0");
    expect(verdict.message).toContain("3.4.1");
    // The forfeit is the point: a version pair with no consequence attached is
    // the silence this closes.
    expect(verdict.message).toMatch(/forfeits/);
  });

  it("dispatches loudly under `warn`, naming both versions", () => {
    const verdict = evaluateEngineFloor({
      engineVersion: "3.2.0",
      published: fromRegistry("3.4.1"),
      policy: "warn",
    });

    expect(verdict.decision).toBe("warn");
    expect(verdict.code).toBe("superseded");
    expect(verdict.message).toContain("3.2.0");
    expect(verdict.message).toContain("3.4.1");
    expect(verdict.message).toContain(ENGINE_FLOOR_CONFIG_KEY);
  });

  it("reads nothing and says nothing under `off`", () => {
    const verdict = evaluateEngineFloor({
      engineVersion: "3.2.0",
      published: fromRegistry("3.4.1"),
      policy: "off",
    });

    expect(verdict.decision).toBe("proceed");
    expect(verdict.code).toBe("disabled");
    expect(verdict.message).toBe("");
  });

  // Offline dispatch must not die: a registry it cannot reach is a fact about
  // the network, never about the engine.
  it("warns and proceeds when the registry is unreachable, even under `refuse`", () => {
    const verdict = evaluateEngineFloor({
      engineVersion: "3.2.0",
      published: null,
      registryError: "getaddrinfo ENOTFOUND registry.npmjs.org",
      policy: "refuse",
    });

    expect(verdict.decision).toBe("warn");
    expect(verdict.code).toBe("registry-unreachable");
    expect(verdict.message).toContain("ENOTFOUND");
    expect(verdict.message).toContain("3.2.0");
  });

  it("treats an unresolved published answer the same as an unreachable one", () => {
    const verdict = evaluateEngineFloor({
      engineVersion: "3.2.0",
      published: UNRESOLVED,
      policy: "refuse",
    });

    expect(verdict.decision).toBe("warn");
    expect(verdict.code).toBe("registry-unreachable");
  });

  // A refusal on hearsay would be worse than the disease: the newest version
  // this host happens to know about is not the registry's answer.
  it("never refuses on unverified evidence — it warns instead", () => {
    const verdict = evaluateEngineFloor({
      engineVersion: "3.2.0",
      published: fromCache("3.4.1"),
      policy: "refuse",
    });

    expect(verdict.decision).toBe("warn");
    expect(verdict.code).toBe("superseded-unverified");
    expect(verdict.message).toContain("3.2.0");
    expect(verdict.message).toContain("3.4.1");
    expect(verdict.message).toContain("bundle-cache");
  });

  it("proceeds silently when the engine matches the published dist-tag", () => {
    const verdict = evaluateEngineFloor({
      engineVersion: "3.4.1",
      published: fromRegistry("3.4.1"),
      policy: "refuse",
    });

    expect(verdict).toMatchObject({ decision: "proceed", code: "current", message: "" });
  });

  it("proceeds when the engine is AHEAD of the dist-tag — a canary is not a stall", () => {
    const verdict = evaluateEngineFloor({
      engineVersion: "3.5.0",
      published: fromRegistry("3.4.1"),
      policy: "refuse",
    });

    expect(verdict).toMatchObject({ decision: "proceed", code: "ahead" });
  });

  it("proceeds for a source checkout — no release supersedes a local build", () => {
    const verdict = evaluateEngineFloor({
      engineVersion: "0.0.0-dev",
      published: fromRegistry("3.4.1"),
      policy: "refuse",
    });

    expect(verdict).toMatchObject({ decision: "proceed", code: "local-build" });
  });

  it("warns when the engine reports no version at all", () => {
    const verdict = evaluateEngineFloor({
      engineVersion: "",
      published: fromRegistry("3.4.1"),
      policy: "refuse",
    });

    expect(verdict).toMatchObject({ decision: "warn", code: "engine-unknown" });
  });
});

describe("the declared policy", () => {
  it("parses the three declared values and falls back on anything else", () => {
    expect(parseEngineFloorPolicy("refuse")).toBe("refuse");
    expect(parseEngineFloorPolicy(" WARN ")).toBe("warn");
    expect(parseEngineFloorPolicy("off")).toBe("off");
    // A typo must not ground a dispatch.
    expect(parseEngineFloorPolicy("refuze")).toBe(DEFAULT_ENGINE_FLOOR_POLICY);
    expect(parseEngineFloorPolicy(undefined)).toBe(DEFAULT_ENGINE_FLOOR_POLICY);
  });

  it("ships the documented default in CONFIG_DEFAULTS", () => {
    expect(CONFIG_DEFAULTS[ENGINE_FLOOR_CONFIG_KEY]).toBe(DEFAULT_ENGINE_FLOOR_POLICY);
  });

  it("reads the repo's declared policy from config", async () => {
    const root = await scratch();
    await mkdir(join(root, ".red"), { recursive: true });
    await writeFile(
      join(root, ".red", "config.yaml"),
      "plugins:\n  dev:\n    enabled: true\n    dispatch:\n      engine_floor: refuse\n",
      "utf8",
    );

    expect(resolveEngineFloorPolicy(root, {})).toBe("refuse");
  });

  it("lets the env override outrank the file — an operator at a keyboard wins", async () => {
    const root = await scratch();
    await mkdir(join(root, ".red"), { recursive: true });
    await writeFile(
      join(root, ".red", "config.yaml"),
      "plugins:\n  dev:\n    enabled: true\n    dispatch:\n      engine_floor: refuse\n",
      "utf8",
    );

    expect(resolveEngineFloorPolicy(root, { [ENGINE_FLOOR_ENV]: "off" })).toBe("off");
  });
});

describe("the dispatch-time reading", () => {
  it("refuses when the posed registry answer is newer than the engine", async () => {
    const root = await scratch();
    const verdict = await checkDispatchEngineFloor(root, {
      policy: "refuse",
      engineVersion: "3.2.0",
      resolvePublished: async () => fromRegistry("3.4.1"),
    });

    expect(verdict.decision).toBe("refuse");
    expect(verdict.message).toContain("3.2.0");
    expect(verdict.message).toContain("3.4.1");
  });

  it("degrades a THROWN registry read to a warning and proceeds", async () => {
    const root = await scratch();
    const verdict = await checkDispatchEngineFloor(root, {
      policy: "refuse",
      engineVersion: "3.2.0",
      resolvePublished: async () => {
        throw new Error("socket hang up");
      },
    });

    expect(verdict.decision).toBe("warn");
    expect(verdict.code).toBe("registry-unreachable");
    expect(verdict.message).toContain("socket hang up");
  });

  it("pays for no registry call at all under `off`", async () => {
    const root = await scratch();
    const resolvePublished = vi.fn(async () => fromRegistry("3.4.1"));
    const verdict = await checkDispatchEngineFloor(root, {
      policy: "off",
      engineVersion: "3.2.0",
      resolvePublished,
    });

    expect(verdict.decision).toBe("proceed");
    expect(resolvePublished).not.toHaveBeenCalled();
  });
});

describe("worker_dispatch crosses only the public ACP Project surface", () => {
  it.each([
    [{ issue: 3031 }],
    [{ demand: "fix it" }],
  ])("hands %o to the daemon-owned workflow without a local dispatch", async (input) => {
    const prompt = vi.fn(async () => ({ stopReason: "end_turn", updates: [] }));
    const session = {
      prompt,
      control: vi.fn(),
      cancel: vi.fn(),
      permission: vi.fn(),
      close: vi.fn(),
    } as unknown as RedskillsProjectAcpSession;

    await expect(invokeProjectMcp(session, "worker_dispatch", input))
      .resolves.toMatchObject({ stopReason: "end_turn" });
    expect(prompt).toHaveBeenCalledWith(`/worker_dispatch ${JSON.stringify(input)}`);
  });
});
