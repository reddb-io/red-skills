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

  // The resident is a ROLE of this bundle now, so the engine is physically in the
  // same FILE — the boundary this suite protects was never the file, it is the
  // stdio SERVE PATH. Two things keep it: nothing here is imported statically
  // (so serving cannot construct it), and the role runs in a process the proxy
  // spawns rather than in the stdio process itself. ADR 0143's "no client hosts
  // an in-process fallback" is the rule at stake.
  it("keeps engine, GitHub adapters and background belts off the stdio serve path", async () => {
    const source = await readFile(join(ROOT, "apps/dev/src/mcp-server.ts"), "utf8");

    // The role reaches the engine, and reaches it lazily — a static import would
    // put it on the path `connect` runs.
    expect(source).toContain('await import("./castle-resident.js")');
    expect(source, "the resident must be spawned, never served in-process").toContain(
      'serverArgs: [fileURLToPath(import.meta.url), "__castle-resident"]',
    );

    for (const forbidden of [
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
