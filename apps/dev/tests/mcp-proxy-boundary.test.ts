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

  it("keeps Project authority off the stateless stdio ACP adapter", async () => {
    const source = await readFile(join(ROOT, "apps/dev/src/mcp-server.ts"), "utf8");

    expect(source).toContain('from "@reddb-io/redskilled/acp-client"');
    expect(source).toContain("connectRedskillsProjectAcp");

    for (const forbidden of [
      "./castle-resident.js",
      "@reddb-io/red-castle/engine",
      "./mcp-adapter.js",
      "./resident-cron.js",
      "./resident-self-update.js",
      "./resident-unblock.js",
      "./resident-webhook.js",
      "./runtime/gh.js",
    ]) {
      expect(source, `stdio serve path statically imported ${forbidden}`)
        .not.toContain(`from \"${forbidden}\"`);
    }
  });

  it("lists static tools locally and sends invocation through ACP", async () => {
    const acpInvoke = vi.fn(async (method: string, input: Record<string, unknown>) => ({
      method,
      input,
      owner: "redskilled",
    }));
    const server = createRedskilledMcpServer(ROOT, acpInvoke);
    const client = new Client({ name: "proxy-boundary-test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    close.push(() => client.close(), () => server.close());

    const tools = await client.listTools();
    expect(tools.tools.length).toBeGreaterThan(20);
    expect(acpInvoke).not.toHaveBeenCalled();

    const result = await client.callTool({ name: "runner_list", arguments: {} });
    expect(acpInvoke).toHaveBeenCalledWith("runner_list", {});
    expect(result.content).toEqual([
      expect.objectContaining({ type: "text", text: expect.stringContaining("redskilled") }),
    ]);
  });
});
