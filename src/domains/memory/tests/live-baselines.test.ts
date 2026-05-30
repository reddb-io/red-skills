import { describe, expect, test } from "vitest";
import {
  createAgentmemoryCliBaselineAdapter,
  createNeo4jAgentMemoryCliBaselineAdapter,
  neo4jAgentMemoryBaselineCommandFromEnv,
} from "../src/live-baseline-adapters.js";

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

  test("Neo4j Agent Memory CLI adapter advertises recall latency and normalizes JSON metrics", async () => {
    const adapter = createNeo4jAgentMemoryCliBaselineAdapter({
      command: ["agent-memory-baseline", "--json"],
      executor: async () => ({
        status: 0,
        stdout: JSON.stringify({
          summary: "Neo4j Agent Memory p50 42ms",
          metrics: {
            p50_ms: 42,
            recall_at_5: 0.88,
            ignored_text: "not numeric",
          },
          evidence: ["neo4j-agent-memory:recall", "neo4j-agent-memory:cypher"],
        }),
        stderr: "",
      }),
    });

    expect(adapter.capabilities()).toEqual([
      {
        id: "recall latency",
        competitor: "agent-memory",
        transport: "cli",
        description:
          "Run a live neo4j-labs/agent-memory recall-latency baseline through a JSON-emitting CLI command.",
      },
    ]);

    const result = await adapter.run({ enabled: true, now: 1_700_000_000_000 });

    expect(result).toMatchObject({
      competitor: "agent-memory",
      adapter: "neo4j-agent-memory-cli",
      state: "measured",
      configured: true,
      capabilityId: "recall latency",
      metrics: {
        p50_ms: 42,
        recall_at_5: 0.88,
      },
      evidence: ["neo4j-agent-memory:recall", "neo4j-agent-memory:cypher"],
      summary: "Neo4j Agent Memory p50 42ms",
    });
  });

  test("Neo4j Agent Memory baseline command reads JSON env configuration", () => {
    expect(
      neo4jAgentMemoryBaselineCommandFromEnv({
        MEMORY_NEO4J_AGENT_MEMORY_BASELINE_CMD: '["node","scripts/neo4j-agent-memory-baseline.mjs"]',
      }),
    ).toEqual(["node", "scripts/neo4j-agent-memory-baseline.mjs"]);
  });
});
