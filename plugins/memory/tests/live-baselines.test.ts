import { describe, expect, test } from "vitest";
import { createAgentmemoryCliBaselineAdapter } from "../src/live-baseline-adapters.js";

describe("live competitor baseline adapters", () => {
  test("Agentmemory CLI adapter advertises capabilities and skips unless explicitly enabled", async () => {
    let executed = false;
    const adapter = createAgentmemoryCliBaselineAdapter({
      command: ["agentmemory", "baseline", "--json"],
      executor: async () => {
        executed = true;
        return { status: 0, stdout: "{}", stderr: "" };
      },
    });

    expect(adapter.capabilities()).toEqual([
      {
        id: "agentmemory.cli.recall",
        competitor: "agentmemory",
        transport: "cli",
        description: "Run a live rohitg00/agentmemory recall baseline through a JSON-emitting CLI command.",
      },
    ]);

    const result = await adapter.run({ enabled: false, now: 1_700_000_000_000 });

    expect(executed).toBe(false);
    expect(result).toMatchObject({
      competitor: "agentmemory",
      adapter: "agentmemory-cli",
      state: "skipped",
      source: "live-cli",
      configured: false,
      metrics: {},
    });
  });

  test("Agentmemory CLI adapter reports unavailable when the competitor command cannot run", async () => {
    const adapter = createAgentmemoryCliBaselineAdapter({
      command: ["agentmemory", "baseline", "--json"],
      executor: async () => ({
        status: 127,
        stdout: "",
        stderr: "agentmemory: command not found",
      }),
    });

    const result = await adapter.run({ enabled: true, now: 1_700_000_000_000 });

    expect(result).toMatchObject({
      state: "unavailable",
      configured: false,
      metrics: {},
      error: "agentmemory: command not found",
    });
  });

  test("Agentmemory CLI adapter reports unavailable when no baseline command is configured", async () => {
    let executed = false;
    const adapter = createAgentmemoryCliBaselineAdapter({
      executor: async () => {
        executed = true;
        return { status: 0, stdout: "{}", stderr: "" };
      },
    });

    const result = await adapter.run({ enabled: true, now: 1_700_000_000_000 });

    expect(executed).toBe(false);
    expect(result).toMatchObject({
      state: "unavailable",
      configured: false,
      command: [],
      error: "missing MEMORY_AGENTMEMORY_BASELINE_CMD",
    });
  });

  test("Agentmemory CLI adapter normalizes JSON metrics from a live baseline command", async () => {
    const adapter = createAgentmemoryCliBaselineAdapter({
      command: ["agentmemory", "baseline", "--json"],
      executor: async () => ({
        status: 0,
        stdout: JSON.stringify({
          schema_version: "agentmemory.baseline.v1",
          summary: "R@5 0.952, p50 18ms",
          metrics: {
            recall_at_5: 0.952,
            p50_ms: 18,
            memories_returned: 5,
            ignored_text: "not numeric",
          },
          evidence: ["agentmemory:longmemeval", "agentmemory:smart-search"],
        }),
        stderr: "",
      }),
    });

    const result = await adapter.run({ enabled: true, now: 1_700_000_000_000 });

    expect(result).toMatchObject({
      state: "measured",
      configured: true,
      metrics: {
        recall_at_5: 0.952,
        p50_ms: 18,
        memories_returned: 5,
      },
      evidence: ["agentmemory:longmemeval", "agentmemory:smart-search"],
      summary: "R@5 0.952, p50 18ms",
    });
  });
});
