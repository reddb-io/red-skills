import { expect } from "vitest";
import { decode } from "@reddb-io/toon";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { ToolResult } from "./mcp-server-test-fixtures.js";

export async function runRegistryWorkflowTools(client: Client): Promise<void> {
  const onboardingRes = (await client.callTool({
    name: "memory_onboarding_map",
    arguments: {},
  })) as ToolResult;
  const onboarding = decode(onboardingRes.content[0]?.text ?? "{}") as {
    schema_version: string;
    status: string;
    summary: { concepts: number };
    markdown: string;
  };
  expect(onboarding.schema_version).toBe("memory.onboarding_map.v1");
  expect(onboarding.status).toBe("ready");
  expect(onboarding.summary.concepts).toBe(3);
  expect(onboarding.markdown).toContain("Memory onboarding map");
  expect(onboardingRes.structuredContent).toMatchObject({
    operation_id: "memory.onboarding-map",
    schema_version: "memory.onboarding_map.v1",
    status: "ready",
  });

  const onboardingViewerRes = (await client.callTool({
    name: "memory_onboarding_map_viewer",
    arguments: {},
  })) as ToolResult;
  const onboardingViewer = decode(onboardingViewerRes.content[0]?.text ?? "{}") as {
    contract: { version: string; consumes: string };
    map: { schema_version: string; summary: { concepts: number } };
    html: string;
  };
  expect(onboardingViewer.contract).toMatchObject({
    version: "memory.onboarding_map.viewer.v1",
    consumes: "memory.onboarding_map.v1",
  });
  expect(onboardingViewer.map.schema_version).toBe("memory.onboarding_map.v1");
  expect(onboardingViewer.map.summary.concepts).toBe(3);
  expect(onboardingViewer.html).toContain("Onboarding Map");
  expect(onboardingViewer.html).toContain('id="onboarding-map-data"');
  expect(onboardingViewerRes.structuredContent).toMatchObject({
    operation_id: "memory.onboarding-map-viewer",
    contract: "memory.onboarding_map.viewer.v1",
    consumes: "memory.onboarding_map.v1",
  });

  const healthRes = (await client.callTool({
    name: "memory_health",
    arguments: {},
  })) as ToolResult;
  expect(decode(healthRes.content[0]?.text ?? "{}")).toMatchObject({
    schema_version: "memory.health.v1",
    read_only: true,
    stats: { nodes: 3, edges: 2 },
  });
  expect(healthRes.structuredContent).toMatchObject({
    operation_id: "memory.health",
    schema_version: "memory.health.v1",
    read_only: true,
    state: expect.any(String),
  });

  const healthViewerRes = (await client.callTool({
    name: "memory_health_viewer",
    arguments: {},
  })) as ToolResult;
  const healthViewer = decode(healthViewerRes.content[0]?.text ?? "{}") as {
    contract: { version: string; consumes: string };
    report: { schema_version: string; state: string };
    html: string;
  };
  expect(healthViewer.contract).toMatchObject({
    version: "memory.health.viewer.v1",
    consumes: "memory.health.v1",
  });
  expect(healthViewer.report.schema_version).toBe("memory.health.v1");
  expect(healthViewer.html).toContain("Memory Health");
  expect(healthViewer.html).toContain('id="memory-health-data"');
  expect(healthViewerRes.structuredContent).toMatchObject({
    operation_id: "memory.health-viewer",
    contract: "memory.health.viewer.v1",
    consumes: "memory.health.v1",
    html_bytes: expect.any(Number),
  });

  const handoffRes = (await client.callTool({
    name: "memory_handoff",
    arguments: { focus: "jwt", limit: 5 },
  })) as ToolResult;
  const handoff = decode(handoffRes.content[0]?.text ?? "{}") as {
    schema_version: string;
    status: string;
    markdown: string;
    summary: { returned_items: number };
  };
  expect(handoff.schema_version).toBe("memory.handoff.v1");
  expect(handoff.status).toBe("ready");
  expect(handoff.markdown).toContain("Memory handoff");
  expect(handoff.summary.returned_items).toBeGreaterThan(0);
  expect(handoffRes.structuredContent).toMatchObject({
    operation_id: "memory.handoff",
    schema_version: "memory.handoff.v1",
    status: "ready",
    read_only: true,
  });

  const handoffViewerRes = (await client.callTool({
    name: "memory_handoff_viewer",
    arguments: { focus: "jwt", limit: 5 },
  })) as ToolResult;
  const handoffViewer = decode(handoffViewerRes.content[0]?.text ?? "{}") as {
    contract: { version: string; consumes: string };
    report: { schema_version: string; status: string };
    html: string;
  };
  expect(handoffViewer.contract).toMatchObject({
    version: "memory.handoff.viewer.v1",
    consumes: "memory.handoff.v1",
  });
  expect(handoffViewer.report.schema_version).toBe("memory.handoff.v1");
  expect(handoffViewer.html).toContain("Memory Handoff");
  expect(handoffViewer.html).toContain('id="memory-handoff-data"');
  expect(handoffViewerRes.structuredContent).toMatchObject({
    operation_id: "memory.handoff-viewer",
    consumes: "memory.handoff.v1",
    html_bytes: expect.any(Number),
  });

  const prePrRes = (await client.callTool({
    name: "memory_pre_pr_review",
    arguments: { changed_files: ["src/auth.ts"], comparison: "main...HEAD" },
  })) as ToolResult;
  const prePr = decode(prePrRes.content[0]?.text ?? "{}") as {
    changedFiles: string[];
    comparison: string | null;
    readOnly: boolean;
    missingEvidence: string[];
  };
  expect(prePr).toMatchObject({
    changedFiles: ["src/auth.ts"],
    comparison: "main...HEAD",
    readOnly: true,
  });
  expect(prePr.missingEvidence).toContain("impacted concepts");
  expect(prePrRes.structuredContent).toMatchObject({
    operation_id: "memory.pre-pr-review",
    changed_files: 1,
    evidence: 0,
    read_only: true,
  });

  const prePrViewerRes = (await client.callTool({
    name: "memory_pre_pr_review_viewer",
    arguments: { changed_files: ["src/auth.ts"], comparison: "main...HEAD" },
  })) as ToolResult;
  const prePrViewer = decode(prePrViewerRes.content[0]?.text ?? "{}") as {
    contract: { version: string };
    html: string;
  };
  expect(prePrViewer.contract.version).toBe("memory.pre_pr_review.viewer.v1");
  expect(prePrViewer.html).toContain("Pre-PR Memory Review");
  expect(prePrViewer.html).toContain('id="pre-pr-review-data"');
  expect(prePrViewerRes.structuredContent).toMatchObject({
    operation_id: "memory.pre-pr-review-viewer",
    consumes: "memory.pre-pr-review",
    changed_files: 1,
  });

}
