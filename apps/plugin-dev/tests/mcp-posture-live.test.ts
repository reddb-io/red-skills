// The danger posture guards the path that RUNS. `createCastleMcpTools` wired
// `applyDangerPosture` around each tool's own invoke, but the stdio adapter
// replaces every invocation with the ACP call — so a MUTATING `gate_run` or
// `land_branch` executed on the daemon with no confirmation asked, while the
// gate guarded a body that never ran. These tests drive the REAL server over
// the SDK's linked transport, because the schema augmentation is part of the
// claim: an argument absent from the published schema never reaches a handler.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRedskilledMcpServer, RS_DEV_DANGER_POSTURE } from "../src/mcp-server.js";

describe("the danger posture wraps the live ACP invoke", () => {
  const close: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(close.splice(0).map((shutdown) => shutdown()));
  });

  async function serve() {
    const acpInvoke = vi.fn(async (method: string, input: Record<string, unknown>) => ({ method, input }));
    const server = createRedskilledMcpServer(process.cwd(), acpInvoke);
    const client = new Client({ name: "mcp-posture-live-test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    close.push(() => client.close(), () => server.close());
    return { client, acpInvoke };
  }

  it("the adapter serves the confirm posture, not the allow default", () => {
    expect(RS_DEV_DANGER_POSTURE).toBe("confirm");
  });

  it("a MUTATING tool without confirmation is refused before the daemon hears of it", async () => {
    const { client, acpInvoke } = await serve();

    const result = await client.callTool({ name: "gate_run", arguments: { branch: "fix/x" } });

    const text = JSON.stringify(result.content);
    expect(text).toContain("refused");
    expect(text).toContain("confirmation");
    expect(acpInvoke).not.toHaveBeenCalled();
  });

  it("confirmation reaches the handler through the published schema and is stripped before ACP", async () => {
    const { client, acpInvoke } = await serve();

    await client.callTool({
      name: "land_branch",
      arguments: { issue: 42, branch: "fix/x", confirmation: true },
    });

    expect(acpInvoke).toHaveBeenCalledTimes(1);
    const [method, input] = acpInvoke.mock.calls[0] as [string, Record<string, unknown>];
    expect(method).toBe("land_branch");
    expect(input.branch).toBe("fix/x");
    expect(input).not.toHaveProperty("confirmation");
  });

  it("a tool with no dangerClass rides the ACP path unwrapped", async () => {
    const { client, acpInvoke } = await serve();

    await client.callTool({ name: "status", arguments: { scope: "project" } });

    expect(acpInvoke).toHaveBeenCalledTimes(1);
    const [method] = acpInvoke.mock.calls[0] as [string, Record<string, unknown>];
    expect(method).toBe("status");
  });
});
