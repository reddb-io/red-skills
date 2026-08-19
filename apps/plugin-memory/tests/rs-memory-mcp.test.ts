import { createRequire } from "node:module";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";

import {
  REDSKILLED_MEMORY_CORE_TOOLS,
  type RedskilledMemoryAnswer,
  type RedskilledMemoryCall,
} from "@reddb-io/protocol-acp";

import {
  createRsMemoryCoreTools,
  createRsMemoryMcpServer,
  RS_MEMORY_CORE_TOOL_NAMES,
  RS_MEMORY_MCP_SERVER_NAME,
  RS_MEMORY_SURFACE_TOOL,
} from "../src/rs-memory/index.js";

const ROOT = "/home/stub/.red/memory/github-1-abcdef01";

interface Harness {
  readonly client: Client;
  readonly calls: RedskilledMemoryCall[];
}

async function connected(options: {
  mode?: string;
  invoke?: (call: RedskilledMemoryCall) => Promise<RedskilledMemoryAnswer>;
} = {}): Promise<Harness> {
  const calls: RedskilledMemoryCall[] = [];
  const server = createRsMemoryMcpServer({
    version: "0.0.0-test",
    ...(options.mode == null ? {} : { mode: () => options.mode }),
    invoke: async (call) => {
      calls.push(call);
      if (options.invoke != null) return await options.invoke(call);
      return { tool: call.tool, root: ROOT, scope: "project", result: { echoed: call.arguments } };
    },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, calls };
}

// Acceptance criteria of #4027: `rs_memory` names the adapter, every call is
// forwarded to the daemon carrying the caller's mode, and nothing behind it is
// a store.
describe("the `rs_memory` adapter", () => {
  it("names itself rs_memory and publishes the core surface the wire declares", () => {
    expect(RS_MEMORY_MCP_SERVER_NAME).toBe("rs_memory");
    expect([...RS_MEMORY_CORE_TOOL_NAMES].sort())
      .toEqual([...REDSKILLED_MEMORY_CORE_TOOLS].sort());
  });

  it("lists the daemon's whole surface when one answers", async () => {
    const { client } = await connected({
      invoke: async (call) => ({
        tool: call.tool,
        root: ROOT,
        scope: "project",
        result: call.tool === RS_MEMORY_SURFACE_TOOL
          ? { tools: [{ name: "memory_doc_search", description: "generated", inputSchema: {} }] }
          : {},
      }),
    });

    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name)).toEqual(["memory_doc_search"]);
    await client.close();
  });

  // A host that cannot enumerate a surface reports the whole server as failed,
  // so listing survives a daemon that does not; only CALLS fail.
  it("falls back to the core surface when no daemon answers", async () => {
    const { client } = await connected({
      invoke: async () => {
        throw new Error("no daemon on this host");
      },
    });

    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name)).toEqual([...RS_MEMORY_CORE_TOOL_NAMES]);
    await client.close();
  });

  it("forwards a call to the daemon and reports which memory answered", async () => {
    const { client, calls } = await connected();

    const answer = await client.callTool({
      name: "memory_recall",
      arguments: { query: "adr 0152" },
    });

    expect(calls.at(-1)).toEqual({ tool: "memory_recall", arguments: { query: "adr 0152" } });
    expect(answer.structuredContent).toMatchObject({
      memory_root: ROOT,
      memory_scope: "project",
    });
    await client.close();
  });

  it("carries the caller's RED_MODE, and nothing when the caller exports none", async () => {
    const worker = await connected({ mode: "spec-driven" });
    await worker.client.callTool({ name: "memory_stats", arguments: {} });
    expect(worker.calls.at(-1)?.mode).toBe("spec-driven");
    await worker.client.close();

    const human = await connected();
    await human.client.callTool({ name: "memory_stats", arguments: {} });
    expect(human.calls.at(-1)).not.toHaveProperty("mode");
    await human.client.close();
  });

  it("reports a failed call as a tool error rather than opening a store of its own", async () => {
    const { client } = await connected({
      invoke: async () => {
        throw new Error("redskilled is not running on this host");
      },
    });

    const answer = await client.callTool({ name: "memory_stats", arguments: {} });

    expect(answer.isError).toBe(true);
    expect(JSON.stringify(answer.content)).toContain("redskilled is not running");
    await client.close();
  });

  it("declares every core tool with a description and an object input schema", () => {
    for (const tool of createRsMemoryCoreTools()) {
      expect(tool.description.length, tool.name).toBeGreaterThan(0);
      expect(tool.inputSchema, tool.name).toMatchObject({ type: "object" });
    }
  });
});

/**
 * The second half of the acceptance criterion: the tokenizer ranks are ~1.7 MB
 * of data the memory app loads for ONE thing, and it used to be reachable from
 * the MCP surface a host mounts per session. The adapter no longer imports it
 * at all (pinned by the ACP adapter ownership guard); this pins the other
 * direction — the module that DOES tokenise still defers the load until a call
 * actually needs it, so importing it costs nothing.
 */
describe("the tokenizer asset loads only when tokenising", () => {
  const loadedTokenizer = (): boolean =>
    Object.keys(createRequire(import.meta.url).cache)
      .some((path) => path.includes("js-tiktoken"));

  it("stays unloaded through import and through a call that tokenises nothing", async () => {
    expect(loadedTokenizer(), "something loaded the tokenizer before this test ran").toBe(false);

    const { countCl100kTokens } = await import("../src/token-count.js");
    expect(loadedTokenizer(), "importing the counter loaded the ranks").toBe(false);

    expect(countCl100kTokens("")).toBe(0);
    expect(loadedTokenizer(), "counting an empty string loaded the ranks").toBe(false);

    expect(countCl100kTokens("memory is per Project")).toBeGreaterThan(0);
    expect(loadedTokenizer(), "counting real text did not load the ranks").toBe(true);
  });
});
