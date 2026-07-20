import { expect } from "vitest";
import { connect, seedStore, type ToolResult } from "./mcp-server-test-fixtures.js";
import { runRegistryDiscoveryAndDocumentationTools } from "./mcp-server-registry-discovery-test-helpers.js";
import { runRegistryGovernanceTools } from "./mcp-server-registry-governance-test-helpers.js";
import { runRegistryReadinessAndContextPackTools } from "./mcp-server-registry-readiness-test-helpers.js";
import { runRegistryRoutingAndDiagnosticsTools } from "./mcp-server-registry-routing-test-helpers.js";
import { runRegistryWorkflowTools } from "./mcp-server-registry-workflow-test-helpers.js";

export async function runRegistryBackedReadinessAndTrustTools(): Promise<void> {
  const client = await connect(await seedStore());
  const before = (await client.callTool({
    name: "memory_stats",
    arguments: {},
  })) as ToolResult;

  await runRegistryReadinessAndContextPackTools(client);
  await runRegistryDiscoveryAndDocumentationTools(client);
  await runRegistryGovernanceTools(client);
  await runRegistryWorkflowTools(client);
  await runRegistryRoutingAndDiagnosticsTools(client);

  const after = (await client.callTool({
    name: "memory_stats",
    arguments: {},
  })) as ToolResult;
  expect(after.structuredContent).toEqual(before.structuredContent);
}
