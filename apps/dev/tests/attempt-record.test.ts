import { describe, expect, it } from "vitest";
import {
  buildAttemptRecordPayload,
  deriveAttemptOutcomeRecord,
  deriveIssueType,
  filterAttemptOutcomeRecords,
  memoryConfiguredInYaml,
  toMemoryPayload,
  resolveMemoryCli,
  type AttemptContext,
  type MemoryCliProbes,
} from "../src/core/attempt-record.js";

const ROOT = "/repo";
const CONFIG = "/repo/.red/memory/config.json";
const YAML = "/repo/.red/config.yaml";

/** Build an exists-probe over an explicit allow-set of existing paths. */
function existsOver(present: Iterable<string>): (p: string) => boolean {
  const set = new Set(present);
  return (p) => set.has(p);
}

/** Probes that say only the opt-in config exists (and optionally more). */
function probes(present: Iterable<string>, version?: string): MemoryCliProbes {
  return {
    exists: existsOver(present),
    readJsonVersion: version ? () => version : () => undefined,
  };
}

const base: AttemptContext = {
  repo: "reddb-io/red-skills",
  issue: 42,
  attempt: 2,
  outcome: "done",
};

describe("buildAttemptRecordPayload — identity + status mapping", () => {
  it("maps the required identity fields verbatim", () => {
    const p = buildAttemptRecordPayload(base);
    expect(p.repository).toBe("reddb-io/red-skills");
    expect(p.issueNumber).toBe(42);
    expect(p.attemptNumber).toBe(2);
    expect(p.status).toBe("done");
  });

  it.each(["done", "blocked", "no-sentinel", "merge-conflict"] as const)(
    "passes the known terminal status %s through verbatim",
    (outcome) => {
      expect(buildAttemptRecordPayload({ ...base, outcome }).status).toBe(outcome);
    },
  );

  it("forwards an unknown outcome as its string status", () => {
    expect(buildAttemptRecordPayload({ ...base, outcome: "exhausted" }).status).toBe("exhausted");
  });

  it("emits queryable issue type, model tier, and coarse outcome", () => {
    const p = buildAttemptRecordPayload({
      ...base,
      labels: ["ready-for-agent", "type:bug"],
      modelTier: "simple",
    });
    expect(p.issueType).toBe("bug");
    expect(p.modelTier).toBe("simple");
    expect(p.outcome).toBe("success");
  });

  it("derives issue type from canonical type labels with an unknown bucket", () => {
    expect(deriveIssueType(["ready-for-agent", "type:spec"])).toBe("spec");
    expect(deriveIssueType(["ready-for-agent"])).toBe("unknown");
  });

  it("maps terminal AFK statuses to success/failure/escalated", () => {
    expect(deriveAttemptOutcomeRecord("done")).toBe("success");
    expect(deriveAttemptOutcomeRecord("feedback-failed")).toBe("failure");
    expect(deriveAttemptOutcomeRecord("review-requested")).toBe("escalated");
  });

  it("filters outcome records by issue type and model tier", () => {
    const records = [
      buildAttemptRecordPayload({ ...base, attempt: 1, labels: ["type:bug"], modelTier: "simple" }),
      buildAttemptRecordPayload({ ...base, attempt: 2, labels: ["type:spec"], modelTier: "think" }),
      buildAttemptRecordPayload({ ...base, attempt: 3, labels: ["type:bug"], modelTier: "complex" }),
    ];

    expect(filterAttemptOutcomeRecords(records, { issueType: "bug", modelTier: "simple" })).toEqual([records[0]]);
    expect(filterAttemptOutcomeRecords(records, { issueType: "bug" }).map((r) => r.attemptNumber)).toEqual([1, 3]);
  });
});

describe("buildAttemptRecordPayload — optional-field omission", () => {
  it("omits every optional field AFK has no value for", () => {
    const p = buildAttemptRecordPayload(base);
    expect(p).toEqual({
      repository: "reddb-io/red-skills",
      issueNumber: 42,
      attemptNumber: 2,
      status: "done",
      issueType: "unknown",
      modelTier: "unknown",
      outcome: "success",
    });
    expect("issueTitle" in p).toBe(false);
    expect("branch" in p).toBe(false);
    expect("durationMs" in p).toBe(false);
    expect("mergeCommit" in p).toBe(false);
    expect("validationSummary" in p).toBe(false);
  });

  it("drops empty / whitespace-only strings instead of carrying blanks", () => {
    const p = buildAttemptRecordPayload({
      ...base,
      title: "   ",
      branch: "",
      notes: "",
      validationSummary: "  ",
    });
    expect("issueTitle" in p).toBe(false);
    expect("branch" in p).toBe(false);
    expect("notes" in p).toBe(false);
    expect("validationSummary" in p).toBe(false);
  });

  it("carries every field present, mapping seconds → milliseconds", () => {
    const p = buildAttemptRecordPayload({
      ...base,
      title: "Wire the memory bridge",
      url: "https://github.com/reddb-io/red-skills/issues/42",
      body: "## brief\nspec: #7",
      workerId: "wABCD",
      branch: "afk/wABCD/42-wire-the-memory-bridge",
      durationS: 12,
      diffstat: "+10 -2 files=3",
      mergeSha: "deadbee",
      envelopeRef: "https://github.com/o/r/issues/42#issuecomment-1",
      notes: "landed clean",
      validationSummary: "tests pass",
    });
    expect(p.issueTitle).toBe("Wire the memory bridge");
    expect(p.issueUrl).toBe("https://github.com/reddb-io/red-skills/issues/42");
    expect(p.issueBody).toContain("spec: #7");
    expect(p.workerId).toBe("wABCD");
    expect(p.branch).toBe("afk/wABCD/42-wire-the-memory-bridge");
    expect(p.durationMs).toBe(12_000);
    expect(p.diffstat).toBe("+10 -2 files=3");
    expect(p.mergeCommit).toBe("deadbee");
    expect(p.envelopeRef).toBe("https://github.com/o/r/issues/42#issuecomment-1");
    expect(p.notes).toBe("landed clean");
    expect(p.validationSummary).toBe("tests pass");
  });

  it("drops a negative / non-finite duration rather than emitting a bad durationMs", () => {
    expect("durationMs" in buildAttemptRecordPayload({ ...base, durationS: -1 })).toBe(false);
    expect("durationMs" in buildAttemptRecordPayload({ ...base, durationS: Number.NaN })).toBe(false);
    expect(buildAttemptRecordPayload({ ...base, durationS: 0 }).durationMs).toBe(0);
  });
});

describe("resolveMemoryCli — gating + candidate order (mirrors memory-bridge.sh)", () => {
  it("Gate 1: returns undefined when the opt-in config.json is absent", () => {
    // RED_MEMORY_CLI is present + its file exists, but no config → still undefined.
    const env = { RED_MEMORY_CLI: "/abs/cli.js" } as NodeJS.ProcessEnv;
    expect(resolveMemoryCli(ROOT, env, probes(["/abs/cli.js"]))).toBeUndefined();
  });

  it("honours RED_MEMORY_CLI when the config exists and the file exists", () => {
    const env = { RED_MEMORY_CLI: "/abs/cli.js" } as NodeJS.ProcessEnv;
    expect(resolveMemoryCli(ROOT, env, probes([CONFIG, "/abs/cli.js"]))).toEqual(["node", "/abs/cli.js"]);
  });

  it("RED_MEMORY_CLI set but missing STOPS resolution (undefined, no fallback)", () => {
    // A `memory` bin also exists on PATH, but the pinned override wins → undefined.
    const env = { RED_MEMORY_CLI: "/abs/cli.js", PATH: "/usr/bin" } as NodeJS.ProcessEnv;
    expect(resolveMemoryCli(ROOT, env, probes([CONFIG, "/usr/bin/memory"]))).toBeUndefined();
  });

  it("falls through to a `memory` bin on PATH when no override is set", () => {
    const env = { PATH: "/x:/usr/bin:/y" } as NodeJS.ProcessEnv;
    expect(resolveMemoryCli(ROOT, env, probes([CONFIG, "/usr/bin/memory"]))).toEqual(["memory"]);
  });

  it("falls through to the dynamic-fetch cache bundle (version-keyed)", () => {
    const env = {
      CLAUDE_PLUGIN_ROOT: "/plugins/dev",
      RED_MEMORY_CACHE_DIR: "/cache",
    } as NodeJS.ProcessEnv;
    const manifest = "/plugins/dev/../memory/.claude-plugin/plugin.json";
    const cacheCli = "/cache/reddb-memory/9.9.9/memory-cli.mjs";
    expect(resolveMemoryCli(ROOT, env, probes([CONFIG, manifest, cacheCli], "9.9.9"))).toEqual([
      "node",
      cacheCli,
    ]);
  });

  it("falls through to the sibling plugin dist (CLAUDE_PLUGIN_ROOT)", () => {
    const env = { CLAUDE_PLUGIN_ROOT: "/plugins/dev" } as NodeJS.ProcessEnv;
    const dist = "/plugins/dev/../memory/dist/cli.js";
    expect(resolveMemoryCli(ROOT, env, probes([CONFIG, dist]))).toEqual(["node", dist]);
  });

  it("falls through to the in-repo plugin dist (MEMORY_REPO_ROOT)", () => {
    const env = { MEMORY_REPO_ROOT: "/repo" } as NodeJS.ProcessEnv;
    const dist = "/repo/plugins/memory/dist/cli.js";
    expect(resolveMemoryCli(ROOT, env, probes([CONFIG, dist]))).toEqual(["node", dist]);
  });

  it("Gate 2: returns undefined when nothing in the candidate chain resolves", () => {
    const env = {
      PATH: "/usr/bin",
      CLAUDE_PLUGIN_ROOT: "/plugins/dev",
      MEMORY_REPO_ROOT: "/repo",
    } as NodeJS.ProcessEnv;
    // Only the config exists; no bin, no cache, no dist → undefined.
    expect(resolveMemoryCli(ROOT, env, probes([CONFIG]))).toBeUndefined();
  });
});

describe("toMemoryPayload — wire format", () => {
  it("serialises to a JSON object whose keys match ReasoningAttemptPayload", () => {
    const json = toMemoryPayload(buildAttemptRecordPayload({ ...base, mergeSha: "abc1234" }));
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(parsed.repository).toBe("reddb-io/red-skills");
    expect(parsed.issueNumber).toBe(42);
    expect(parsed.attemptNumber).toBe(2);
    expect(parsed.status).toBe("done");
    expect(parsed.mergeCommit).toBe("abc1234");
  });
});

describe("memoryConfiguredInYaml — ADR 0042 opt-in detection", () => {
  it("detects a plugins.memory block", () => {
    expect(memoryConfiguredInYaml("plugins:\n  memory:\n    mode: graph\n")).toBe(true);
    expect(memoryConfiguredInYaml("plugins:\n  dev:\n    afk:\n      x: y\n  memory:\n    mode: graph\n")).toBe(true);
  });
  it("ignores a plugins block without memory, and a non-nested memory key", () => {
    expect(memoryConfiguredInYaml("plugins:\n  dev:\n    afk:\n      x: y\n")).toBe(false);
    expect(memoryConfiguredInYaml("memory:\n  mode: graph\n")).toBe(false);
    expect(memoryConfiguredInYaml("")).toBe(false);
    expect(memoryConfiguredInYaml(undefined)).toBe(false);
  });
});

describe("resolveMemoryCli — Gate 1 via .red/config.yaml (ADR 0042)", () => {
  const env = { PATH: "" } as NodeJS.ProcessEnv;

  it("opts in from a plugins.memory yaml block even when the legacy json is absent", () => {
    const p: MemoryCliProbes = {
      exists: existsOver(["/abs/cli.js"]), // note: CONFIG json NOT present
      readText: (path) => (path === YAML ? "plugins:\n  memory:\n    mode: graph\n" : undefined),
    };
    expect(resolveMemoryCli(ROOT, { ...env, RED_MEMORY_CLI: "/abs/cli.js" }, p)).toEqual([
      "node",
      "/abs/cli.js",
    ]);
  });

  it("stays opted-out when neither the yaml block nor the legacy json is present", () => {
    const p: MemoryCliProbes = {
      exists: existsOver(["/abs/cli.js"]),
      readText: (path) => (path === YAML ? "plugins:\n  dev:\n    afk:\n      x: y\n" : undefined),
    };
    expect(resolveMemoryCli(ROOT, { ...env, RED_MEMORY_CLI: "/abs/cli.js" }, p)).toBeUndefined();
  });
});
