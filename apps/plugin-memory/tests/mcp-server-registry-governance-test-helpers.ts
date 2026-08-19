import { expect } from "vitest";
import { decode } from "@reddb-io/toon";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { ToolResult } from "./mcp-server-test-fixtures.js";

export async function runRegistryGovernanceTools(client: Client): Promise<void> {
  const provenanceRes = (await client.callTool({
    name: "memory_provenance",
    arguments: { target: "jwt-rotation" },
  })) as ToolResult;
  const provenance = decode(provenanceRes.content[0]?.text ?? "{}") as {
    node: { label: string };
    provenance: { missing: boolean };
  };
  expect(provenance.node.label).toBe("jwt-rotation");
  expect(provenance.provenance.missing).toBe(true);

  const privacyRes = (await client.callTool({
    name: "memory_privacy_scan",
    arguments: {},
  })) as ToolResult;
  expect(decode(privacyRes.content[0]?.text ?? "{}")).toMatchObject({
    readOnly: true,
    mutated: false,
    mode: "graph",
  });

  const lintRes = (await client.callTool({
    name: "memory_lint",
    arguments: {},
  })) as ToolResult;
  expect(decode(lintRes.content[0]?.text ?? "{}")).toMatchObject({
    readOnly: true,
    mode: "graph",
    totalMemories: 3,
    ruleSuggestions: expect.any(Array),
  });
  expect(lintRes.structuredContent).toMatchObject({
    operation_id: "memory.lint",
    rule_suggestions: expect.any(Number),
  });

  const governanceRes = (await client.callTool({
    name: "memory_governance",
    arguments: {},
  })) as ToolResult;
  const governance = decode(governanceRes.content[0]?.text ?? "{}") as {
    schema_version: string;
    read_only: boolean;
    summary: { total_nodes: number };
    tidy_availability: { status: string; reason: string };
  };
  expect(governance).toMatchObject({
    schema_version: "memory.governance.v1",
    read_only: true,
    summary: { total_nodes: 3 },
    tidy_availability: {
      status: "unavailable",
      reason: "no AI provider configured for governance tidy",
    },
  });
  expect(governanceRes.structuredContent).toMatchObject({
    operation_id: "memory.governance",
    schema_version: "memory.governance.v1",
    read_only: true,
    tidy_status: "unavailable",
    tidy_reason: "no AI provider configured for governance tidy",
  });

  const decayRes = (await client.callTool({
    name: "memory_decay",
    arguments: {},
  })) as ToolResult;
  expect(decode(decayRes.content[0]?.text ?? "{}")).toMatchObject({
    schema_version: "memory.decay_plan.v1",
    read_only: true,
  });
  expect(decayRes.structuredContent).toMatchObject({
    operation_id: "memory.decay",
    schema_version: "memory.decay_plan.v1",
  });

  const governanceViewerRes = (await client.callTool({
    name: "memory_governance_viewer",
    arguments: {},
  })) as ToolResult;
  const governanceViewer = decode(
    governanceViewerRes.content[0]?.text ?? "{}",
  ) as {
    contract: { version: string; consumes: string };
    html: string;
  };
  expect(governanceViewer.contract).toMatchObject({
    version: "memory.governance.viewer.v1",
    consumes: "memory.governance.v1",
  });
  expect(governanceViewer.html).toContain("Memory Governance");
  expect(governanceViewer.html).toContain('id="memory-governance-data"');
  expect(governanceViewer.html).toContain("Tidy availability");
  expect(governanceViewerRes.structuredContent).toMatchObject({
    operation_id: "memory.governance-viewer",
    consumes: "memory.governance.v1",
    tidy_status: "unavailable",
    tidy_reason: "no AI provider configured for governance tidy",
    html_bytes: expect.any(Number),
  });

  const recommendationsRes = (await client.callTool({
    name: "memory_skill_recommendations",
    arguments: { task: "jwt rotation", limit: 3 },
  })) as ToolResult;
  expect(decode(recommendationsRes.content[0]?.text ?? "{}")).toHaveProperty(
    "recommendations",
  );

  const learningDebtRes = (await client.callTool({
    name: "memory_learning_debt",
    arguments: {},
  })) as ToolResult;
  const learningDebt = decode(learningDebtRes.content[0]?.text ?? "{}") as {
    schema_version: string;
    summary: Record<string, number>;
  };
  expect(learningDebt.schema_version).toBe("memory.learning_debt.v1");
  expect(learningDebt).toHaveProperty("summary");
  expect(learningDebtRes.structuredContent).toMatchObject({
    operation_id: "memory.learning-debt",
    schema_version: "memory.learning_debt.v1",
    read_only: true,
    status: expect.any(String),
  });

  const learningDebtViewerRes = (await client.callTool({
    name: "memory_learning_debt_viewer",
    arguments: {},
  })) as ToolResult;
  const learningDebtViewer = decode(learningDebtViewerRes.content[0]?.text ?? "{}") as {
    contract: { version: string; consumes: string };
    report: { schema_version: string; summary: Record<string, number> };
    html: string;
  };
  expect(learningDebtViewer.contract).toMatchObject({
    version: "memory.learning_debt.viewer.v1",
    consumes: "memory.learning_debt.v1",
  });
  expect(learningDebtViewer.report.schema_version).toBe("memory.learning_debt.v1");
  expect(learningDebtViewer.html).toContain("Learning Debt");
  expect(learningDebtViewer.html).toContain('id="learning-debt-data"');
  expect(learningDebtViewerRes.structuredContent).toMatchObject({
    operation_id: "memory.learning-debt-viewer",
    contract: "memory.learning_debt.viewer.v1",
    consumes: "memory.learning_debt.v1",
    html_bytes: expect.any(Number),
  });

}
