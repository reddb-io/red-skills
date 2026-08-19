import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";

import { REDSKILLED_BRAIN_TOOLS, type RedskilledBrainAnswer } from "@reddb-io/protocol-acp";

import {
  createRsBrainMcpServer,
  createRsBrainTools,
  rsBrainCallArguments,
  rsBrainToolCoverage,
  RS_BRAIN_MCP_SERVER_NAME,
} from "../src/rs-brain/index.js";

interface RecordedCall {
  readonly tool: string;
  readonly args: Record<string, unknown>;
}

async function connected(calls: RecordedCall[], root = "/home/stub/.red/brain"): Promise<Client> {
  const server = createRsBrainMcpServer({
    version: "0.0.0-test",
    sourcePath: () => "/checkout/service",
    invoke: async (tool, args): Promise<RedskilledBrainAnswer> => {
      calls.push({ tool, args });
      return { tool, root, result: { echoed: args } };
    },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

// Acceptance criteria of #4026: `rs_brain` names the adapter, every tool call
// it publishes is forwarded to the daemon, and nothing behind it is a store.
describe("the `rs_brain` adapter", () => {
  it("publishes exactly the tool surface the wire declares", () => {
    const coverage = rsBrainToolCoverage(createRsBrainTools());

    expect(coverage.missing, "a published-but-unserved tool fails on the far side of a socket")
      .toEqual([]);
    expect(coverage.extra).toEqual([]);
  });

  it("names itself rs_brain and keeps the tool names the surface always had", async () => {
    const client = await connected([]);

    const { tools } = await client.listTools();

    expect(RS_BRAIN_MCP_SERVER_NAME).toBe("rs_brain");
    expect(tools.map((tool) => tool.name)).toEqual([...REDSKILLED_BRAIN_TOOLS]);
    await client.close();
  });

  it("forwards every tool to the daemon and reports which brain answered", async () => {
    const calls: RecordedCall[] = [];
    const client = await connected(calls);

    const answer = await client.callTool({ name: "brain_search", arguments: { query: "adr 0152" } });

    expect(calls).toEqual([{ tool: "brain_search", args: { query: "adr 0152" } }]);
    expect(answer.structuredContent).toMatchObject({
      tool: "brain_search",
      root: "/home/stub/.red/brain",
    });
    await client.close();
  });

  it("contributes the one fact the daemon cannot know — where the session stands", () => {
    const provenance = () => "/checkout/service";

    expect(rsBrainCallArguments("brain_capture", { title: "t", content: "c" }, provenance))
      .toEqual({ title: "t", content: "c", source_path: "/checkout/service" });
    expect(
      rsBrainCallArguments("brain_capture", { title: "t", content: "c", source_path: "/elsewhere" }, provenance),
      "a caller that spelled source_path meant it",
    ).toEqual({ title: "t", content: "c", source_path: "/elsewhere" });
    expect(rsBrainCallArguments("brain_search", { query: "q" }, provenance)).toEqual({ query: "q" });
  });
});
