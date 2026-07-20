import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { decode } from "@reddb-io/toon";
import { expect } from "vitest";
import type { ToolResult } from "./mcp-server-test-fixtures.js";

export async function runRegistryReadinessAndContextPackTools(client: Client): Promise<void> {
  const readinessRes = (await client.callTool({
    name: "memory_readiness",
    arguments: { goal: "jwt rotation", min_evidence: 1 },
  })) as ToolResult;
  const readiness = decode(readinessRes.content[0]?.text ?? "{}") as {
    contract: { version: string };
    request: { goal: string };
  };
  expect(readiness.contract.version).toBe("memory.readiness.v1");
  expect(readiness.request.goal).toBe("jwt rotation");
  expect(readinessRes.structuredContent).toMatchObject({
    operation_id: "memory.readiness",
    contract_version: "memory.readiness.v1",
  });

  const claimRes = (await client.callTool({
    name: "memory_claim_check",
    arguments: { assertion: "jwt tokens rotate every 90 days" },
  })) as ToolResult;
  const claim = decode(claimRes.content[0]?.text ?? "{}") as { status: string };
  expect(claim.status).toBe("supported");
  expect(claimRes.structuredContent).toMatchObject({
    operation_id: "memory.claim-check",
    status: "supported",
  });

  const contextPackRes = (await client.callTool({
    name: "memory_context_pack",
    arguments: { goal: "jwt rotation", budget_chars: 2_000 },
  })) as ToolResult;
  const contextPack = decode(contextPackRes.content[0]?.text ?? "{}") as {
    markdown: string;
    entries: unknown[];
  };
  expect(contextPack.markdown).toContain("Memory context pack");
  expect(contextPack.entries.length).toBeGreaterThan(0);

  const contextPackViewerRes = (await client.callTool({
    name: "memory_context_pack_viewer",
    arguments: { goal: "jwt rotation", budget_chars: 2_000 },
  })) as ToolResult;
  const contextPackViewer = decode(contextPackViewerRes.content[0]?.text ?? "{}") as {
    contract: { version: string; consumes: string };
    pack: { status: string; entries: unknown[] };
    html: string;
  };
  expect(contextPackViewer.contract).toMatchObject({
    version: "memory.context_pack.viewer.v1",
    consumes: "memory.context_pack.v1",
  });
  expect(contextPackViewer.pack.entries.length).toBeGreaterThan(0);
  expect(contextPackViewer.html).toContain("Memory Context Pack");
  expect(contextPackViewer.html).toContain('id="memory-context-pack-data"');
  expect(contextPackViewerRes.structuredContent).toMatchObject({
    operation_id: "memory.context-pack-viewer",
    consumes: "memory.context_pack.v1",
    html_bytes: expect.any(Number),
  });
}
