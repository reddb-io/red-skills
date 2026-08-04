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
import { goCommand, type GoRuntime } from "../src/commands/go.js";
import { createDefaultDevAfkMcpOperations } from "../src/mcp-adapter.js";
import type { DispatchedWorkerBirth } from "../src/runtime/mcp-worker-birth.js";

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
    expect(repair).toContain("red-skills-dev reconcile-engine");
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

const GRANTED: DispatchedWorkerBirth = {
  worker_id: "worker-3031",
  pid: 424_242,
  log: "/tmp/red/logs/2026-08-02/dispatch-3031.log",
  warnings: [],
  admission: "admitted: 1 of 3 workers",
};

const SUPERSEDED = evaluateEngineFloor({
  engineVersion: "3.2.0",
  published: fromRegistry("3.4.1"),
  policy: "refuse",
});

const SUPERSEDED_WARNING = evaluateEngineFloor({
  engineVersion: "3.2.0",
  published: fromRegistry("3.4.1"),
  policy: "warn",
});

interface RecordedGo {
  runtime: GoRuntime;
  born: string[][];
  minted: number;
  output: string[];
}

function goRuntime(verdict: EngineFloorVerdict): RecordedGo {
  const born: string[][] = [];
  const output: string[] = [];
  const recorded: RecordedGo = {
    born,
    output,
    minted: 0,
    runtime: {
      ensureLabel: async () => undefined,
      createGoIssue: async () => (recorded.minted += 1, 3031),
      createScoutIssue: async () => (recorded.minted += 1, 3031),
      birthWorker: async (args) => {
        born.push([...args]);
        return GRANTED;
      },
      runEngineAttached: async () => 0,
      checkEngineFloor: async () => verdict,
      hasHarness: false,
      write: (text) => output.push(text),
    },
  };
  return recorded;
}

describe("/go carries the floor", () => {
  it("refuses before minting the issue, so a refused dispatch leaves nothing behind", async () => {
    const recorded = goRuntime(SUPERSEDED);
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((text: unknown) => {
      errors.push(String(text));
    });

    try {
      const code = await goCommand(["fix the flaky login test"], "/workspace", recorded.runtime);

      expect(code).toBe(1);
      expect(recorded.minted).toBe(0);
      expect(recorded.born).toEqual([]);
      expect(errors.join("")).toContain("3.2.0");
      expect(errors.join("")).toContain("3.4.1");
    } finally {
      spy.mockRestore();
    }
  });

  it("refuses a scout dispatch on the same reading", async () => {
    const recorded = goRuntime(SUPERSEDED);
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      expect(await goCommand(["--scout", "why did it die?"], "/workspace", recorded.runtime)).toBe(1);
      expect(recorded.born).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it("dispatches under `warn` and prints both versions", async () => {
    const recorded = goRuntime(SUPERSEDED_WARNING);
    const code = await goCommand(["fix the flaky login test"], "/workspace", recorded.runtime);

    expect(code).toBe(0);
    expect(recorded.born).toHaveLength(1);
    const answer = recorded.output.join("");
    expect(answer).toContain("3.2.0");
    expect(answer).toContain("3.4.1");
  });
});

describe("worker_dispatch carries the same floor", () => {
  it("refuses an issue dispatch and asks the host for nothing", async () => {
    const root = await scratch();
    const birthWorker = vi.fn(async () => GRANTED);
    const operations = createDefaultDevAfkMcpOperations(root, {
      birthWorker,
      checkEngineFloor: async () => SUPERSEDED,
    });

    await expect(operations.dispatchIssue(root, { issue: 3031 })).rejects.toThrow(/3\.4\.1/);
    expect(birthWorker).not.toHaveBeenCalled();
  });

  it("refuses a demand dispatch before any issue is minted", async () => {
    const root = await scratch();
    const birthWorker = vi.fn(async () => GRANTED);
    const createIssue = vi.fn(async () => 3031);
    const operations = createDefaultDevAfkMcpOperations(root, {
      birthWorker,
      createIssue,
      ensureLabel: async () => undefined,
      checkEngineFloor: async () => SUPERSEDED,
    });

    await expect(operations.dispatchDemand(root, { demand: "fix it" })).rejects.toThrow(/3\.2\.0/);
    expect(createIssue).not.toHaveBeenCalled();
    expect(birthWorker).not.toHaveBeenCalled();
  });

  it("dispatches under `warn` and returns the warning with the birth", async () => {
    const root = await scratch();
    const operations = createDefaultDevAfkMcpOperations(root, {
      birthWorker: async () => GRANTED,
      checkEngineFloor: async () => SUPERSEDED_WARNING,
    });

    const answer = (await operations.dispatchIssue(root, { issue: 3031 })) as {
      status: string;
      warnings?: string[];
    };
    expect(answer.status).toBe("dispatched");
    expect(answer.warnings?.join("")).toContain("3.2.0");
    expect(answer.warnings?.join("")).toContain("3.4.1");
  });
});
