import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRedskilledMcpServer } from "../src/mcp-server.js";

const ROOT = join(import.meta.dirname, "..", "..", "..");

describe("redskilled MCP lightweight proxy boundary", () => {
  const close: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(close.splice(0).map((shutdown) => shutdown()));
  });

  it("keeps engine, GitHub adapters and background belts out of the stdio entry", async () => {
    const source = await readFile(join(ROOT, "apps/dev/src/mcp-server.ts"), "utf8");

    for (const forbidden of [
      "@reddb-io/red-castle/engine",
      "./mcp-adapter.js",
      "./resident-cron.js",
      "./resident-self-update.js",
      "./resident-unblock.js",
      "./resident-webhook.js",
      "./runtime/gh.js",
    ]) {
      expect(source, `stdio entry imported ${forbidden}`).not.toContain(`from \"${forbidden}\"`);
    }
  });

  it("lists static tools locally and sends invocation through the resident wire", async () => {
    const residentInvoke = vi.fn(async (method: string, input: Record<string, unknown>) => ({
      method,
      input,
      owner: "castle-resident",
    }));
    const server = createRedskilledMcpServer(ROOT, residentInvoke);
    const client = new Client({ name: "proxy-boundary-test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    close.push(() => client.close(), () => server.close());

    const tools = await client.listTools();
    expect(tools.tools.length).toBeGreaterThan(20);
    expect(residentInvoke).not.toHaveBeenCalled();

    const result = await client.callTool({ name: "runner_list", arguments: {} });
    expect(residentInvoke).toHaveBeenCalledWith("runner_list", {});
    expect(result.content).toEqual([
      expect.objectContaining({ type: "text", text: expect.stringContaining("castle-resident") }),
    ]);
  });
});
