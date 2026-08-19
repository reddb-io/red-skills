import { expect } from "vitest";
import { decode } from "@reddb-io/toon";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { ToolResult } from "./mcp-server-test-fixtures.js";

export async function runRegistryRoutingAndDiagnosticsTools(client: Client): Promise<void> {
  const vectorRes = (await client.callTool({
    name: "memory_vector_status",
    arguments: {},
  })) as ToolResult;
  const vector = decode(vectorRes.content[0]?.text ?? "{}") as {
    schema_version: string;
    overall: string;
    total: number;
    nodes: unknown[];
    docs: unknown[];
  };
  expect(vector.schema_version).toBe("memory.vector_status.v1");
  expect(vector.total).toBe(4);
  expect(vector.nodes).toHaveLength(3);
  expect(vector.docs).toHaveLength(1);
  expect(vectorRes.structuredContent).toMatchObject({
    operation_id: "memory.vector-status",
    schema_version: "memory.vector_status.v1",
    total: 4,
  });

  const vectorViewerRes = (await client.callTool({
    name: "memory_vector_status_viewer",
    arguments: {},
  })) as ToolResult;
  const vectorViewer = decode(vectorViewerRes.content[0]?.text ?? "{}") as {
    contract: { version: string; consumes: string };
    report: { schema_version: string; total: number };
    html: string;
  };
  expect(vectorViewer.contract).toMatchObject({
    version: "memory.vector_status.viewer.v1",
    consumes: "memory.vector_status.v1",
  });
  expect(vectorViewer.report.schema_version).toBe("memory.vector_status.v1");
  expect(vectorViewer.report.total).toBe(4);
  expect(vectorViewer.html).toContain("Vector Status");
  expect(vectorViewer.html).toContain('id="vector-status-data"');
  expect(vectorViewerRes.structuredContent).toMatchObject({
    operation_id: "memory.vector-status-viewer",
    contract: "memory.vector_status.viewer.v1",
    consumes: "memory.vector_status.v1",
    total: 4,
  });

  const vectorSearchRes = (await client.callTool({
    name: "memory_vector_search",
    arguments: { query: "jwt rotation", limit: 3 },
  })) as ToolResult;
  const vectorSearch = decode(vectorSearchRes.content[0]?.text ?? "{}") as {
    status: string;
    hits: unknown[];
    read_only: boolean;
    error?: string;
  };
  expect(vectorSearch).toMatchObject({
    status: "unavailable",
    hits: [],
    read_only: true,
  });
  expect(vectorSearch.error).toContain("RED_MEMORY_VECTOR_PROVIDER");
  expect(vectorSearchRes.structuredContent).toMatchObject({
    operation_id: "memory.vector-search",
    status: "unavailable",
    query: "jwt rotation",
    hits: 0,
    read_only: true,
  });

  const viewerRes = (await client.callTool({
    name: "memory_readiness_viewer",
    arguments: { goal: "jwt rotation", min_evidence: 1 },
  })) as ToolResult;
  const viewer = decode(viewerRes.content[0]?.text ?? "{}") as {
    contract: { version: string };
    envelope: { request: { goal: string } };
    html: string;
  };
  expect(viewer.contract.version).toBe("memory.readiness.viewer.v1");
  expect(viewer.envelope.request.goal).toBe("jwt rotation");
  expect(viewer.html).toContain("Task Readiness");
  expect(viewerRes.structuredContent).toMatchObject({
    operation_id: "memory.readiness-viewer",
    consumes: "memory.readiness.v1",
  });

  const routingRes = (await client.callTool({
    name: "memory_routing_guide",
    arguments: { agent: "codex" },
  })) as ToolResult;
  const routing = decode(routingRes.content[0]?.text ?? "{}") as {
    schemaVersion: string;
    supportedAgents: string[];
    integration: { transports: string[]; configSnippets: unknown[] };
    targetFiles: string[];
    installSnippet: string;
  };
  expect(routing.schemaVersion).toBe("memory.routing_guide.v1");
  expect(routing.supportedAgents).toContain("cursor");
  expect(routing.integration.transports).toContain("hooks");
  expect(routing.targetFiles).toEqual(["AGENTS.md"]);
  expect(routing.installSnippet).toContain("memory_context_pack");
  expect(routingRes.structuredContent).toMatchObject({
    operation_id: "memory.routing-guide",
    schema_version: "memory.routing_guide.v1",
    agent: "codex",
    supported_agents: expect.any(Number),
    transports: expect.any(Number),
    target_files: 1,
    config_snippets: expect.any(Number),
  });

  const routingViewerRes = (await client.callTool({
    name: "memory_routing_guide_viewer",
    arguments: { agent: "cursor" },
  })) as ToolResult;
  const routingViewer = decode(routingViewerRes.content[0]?.text ?? "{}") as {
    contract: { version: string; consumes: string };
    guide: { agent: string };
    html: string;
  };
  expect(routingViewer.contract.version).toBe("memory.routing_guide.viewer.v1");
  expect(routingViewer.contract.consumes).toBe("memory.routing_guide.v1");
  expect(routingViewer.guide.agent).toBe("cursor");
  expect(routingViewer.html).toContain("Memory Routing Guide");
  expect(routingViewerRes.structuredContent).toMatchObject({
    operation_id: "memory.routing-guide-viewer",
    consumes: "memory.routing_guide.v1",
    agent: "cursor",
    html_bytes: expect.any(Number),
  });

  const integrationRes = (await client.callTool({
    name: "memory_agent_integration_status",
    arguments: { agent: "codex" },
  })) as ToolResult;
  const integration = decode(integrationRes.content[0]?.text ?? "{}") as {
    schema_version: string;
    summary: { agents: number };
  };
  expect(integration.schema_version).toBe("memory.agent_integration_status.v1");
  expect(integration.summary.agents).toBe(1);
  expect(integrationRes.structuredContent).toMatchObject({
    operation_id: "memory.agent-integration-status",
    schema_version: "memory.agent_integration_status.v1",
    agents: 1,
  });

  const pathExplainRes = (await client.callTool({
    name: "memory_path_explain",
    arguments: { from: "auth-service", to: "cache-ttl" },
  })) as ToolResult;
  const pathExplain = decode(pathExplainRes.content[0]?.text ?? "{}") as {
    schema_version: string;
    reachable: boolean;
    hop_count: number;
    markdown: string;
  };
  expect(pathExplain.schema_version).toBe("memory.path_explain.v1");
  expect(pathExplain.reachable).toBe(true);
  expect(pathExplain.hop_count).toBe(2);
  expect(pathExplain.markdown).toContain("Memory path explanation");
  expect(pathExplainRes.structuredContent).toMatchObject({
    operation_id: "memory.path-explain",
    schema_version: "memory.path_explain.v1",
    reachable: true,
    hop_count: 2,
    read_only: true,
  });

  const pathExplainViewerRes = (await client.callTool({
    name: "memory_path_explain_viewer",
    arguments: { from: "auth-service", to: "cache-ttl" },
  })) as ToolResult;
  const pathExplainViewer = decode(pathExplainViewerRes.content[0]?.text ?? "{}") as {
    contract: { version: string };
    html: string;
  };
  expect(pathExplainViewer.contract.version).toBe("memory.path_explain.viewer.v1");
  expect(pathExplainViewer.html).toContain("Path Explanation");
  expect(pathExplainViewer.html).toContain('id="path-explain-data"');
  expect(pathExplainViewerRes.structuredContent).toMatchObject({
    operation_id: "memory.path-explain-viewer",
    consumes: "memory.path_explain.v1",
    reachable: true,
    hop_count: 2,
  });

  const impactRes = (await client.callTool({
    name: "memory_structural_impact",
    arguments: { file: "missing.ts" },
  })) as ToolResult;
  expect(decode(impactRes.content[0]?.text ?? "{}")).toMatchObject({
    imports: [],
    importedBy: [],
    calls: [],
    calledBy: [],
    usesTypes: [],
    usedByTypes: [],
    defines: [],
    definedIn: null,
  });
  expect(impactRes.structuredContent).toMatchObject({
    operation_id: "memory.structural-impact",
    calls: 0,
    called_by: 0,
    uses_types: 0,
    used_by_types: 0,
    defines: 0,
  });

  const impactViewerRes = (await client.callTool({
    name: "memory_structural_impact_viewer",
    arguments: { file: "missing.ts" },
  })) as ToolResult;
  const impactViewer = decode(impactViewerRes.content[0]?.text ?? "{}") as {
    contract: { version: string };
    html: string;
  };
  expect(impactViewer.contract.version).toBe("memory.structural_impact.viewer.v1");
  expect(impactViewer.html).toContain("Structural Impact");
  expect(impactViewer.html).toContain('id="structural-impact-data"');
  expect(impactViewerRes.structuredContent).toMatchObject({
    operation_id: "memory.structural-impact-viewer",
    consumes: "memory.structural-impact",
  });

}
