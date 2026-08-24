// A drain that carries no registration records intent nothing acts on (#4101),
// and the registration is built from a ROOT. The dead end this closes: the MCP
// server enriched from its own launch cwd while the ACP session bound to the
// resolved project root, so a coder CLI launched from anywhere built the
// registration against the wrong checkout, `repositoryOf` failed, and the
// drain silently degraded to orphan intent.
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRedskilledMcpServer } from "../src/mcp-server.js";

const ROOT = join(import.meta.dirname, "..", "..", "..");

describe("drain enrichment resolves the session's project root", () => {
  const close: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(close.splice(0).map((shutdown) => shutdown()));
  });

  async function serve(root: string | (() => string | Promise<string>)) {
    const acpInvoke = vi.fn(async (method: string, input: Record<string, unknown>) => ({ method, input }));
    const server = createRedskilledMcpServer(root, acpInvoke);
    const client = new Client({ name: "drain-enrich-root-test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    close.push(() => client.close(), () => server.close());
    return { client, acpInvoke };
  }

  it("builds the registration from the supplied session root, not the launcher's cwd", async () => {
    const supplier = vi.fn(async () => ROOT);
    const { client, acpInvoke } = await serve(supplier);

    await client.callTool({ name: "drain", arguments: {} });

    expect(supplier).toHaveBeenCalled();
    const [, input] = acpInvoke.mock.calls[0] as [string, Record<string, unknown>];
    const registration = input.registration as { workspace_path?: string } | undefined;
    expect(registration?.workspace_path).toBe(ROOT);
    expect(registration?.workspace_path).not.toBe(process.cwd());
  });

  it("a root supplier that rejects refuses the drain loudly instead of enriching from cwd", async () => {
    const { client, acpInvoke } = await serve(() => {
      throw new Error("no ACP session root");
    });

    const result = await client.callTool({ name: "drain", arguments: {} });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("the session's project root did not resolve");
    expect(acpInvoke).not.toHaveBeenCalled();
  });
});
