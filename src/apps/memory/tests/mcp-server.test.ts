import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { MemoryStore } from "../src/graph-store.js";
import {
  getReadOnlyMemoryOperation,
  listReadOnlyMemoryOperations,
} from "../src/operations.js";

// Spawning tsx + booting RedDB twice (seed, then server) is slow; be generous.
const TIMEOUT = 40_000;

const pkgRoot = resolve(__dirname, "..");
const tsx = join(pkgRoot, "node_modules", ".bin", "tsx");
const serverEntry = join(pkgRoot, "src", "mcp-server.ts");

const roots: string[] = [];
const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => {})));
  await Promise.all(roots.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** Seed a graph in a fresh store, close it, and return its file:// URI so the
 *  server can reopen the same store (file:// is single-writer). */
async function seedStore(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "memory-mcp-"));
  roots.push(dir);
  const uri = `file://${join(dir, "graph.rdb")}`;
  const store = await MemoryStore.open({ uri, project: "test" });
  try {
    const auth = await store.upsertNode({
      label: "auth-service",
      node_type: "concept",
      properties: { title: "auth service", content: "the auth service issues jwt tokens" },
    });
    const jwt = await store.upsertNode({
      label: "jwt-rotation",
      node_type: "concept",
      properties: {
        title: "jwt rotation",
        content: "jwt tokens rotate every 90 days",
        hash: "jwt-doc",
      },
    });
    const cache = await store.upsertNode({
      label: "cache-ttl",
      node_type: "concept",
      properties: { title: "cache ttl", content: "redis cache ttl is 300 seconds" },
    });
    await store.upsertDoc({
      path: "docs/jwt.md",
      title: "JWT docs",
      body: "jwt tokens rotate every 90 days. Cache TTL details live elsewhere.",
      hash: "jwt-doc",
      updated_at: 123,
    });
    await store.upsertEdge({ label: "REFERENCES", from_rid: auth, to_rid: jwt });
    await store.upsertEdge({ label: "REFERENCES", from_rid: jwt, to_rid: cache });
  } finally {
    await store.close();
  }
  return uri;
}

async function seedConfiguredStore(): Promise<{ uri: string; root: string }> {
  const dir = await mkdtemp(join(tmpdir(), "memory-mcp-configured-"));
  roots.push(dir);
  const uri = `file://${join(dir, "graph.rdb")}`;
  const store = await MemoryStore.open({ uri, project: "test" });
  try {
    await store.upsertNode({
      label: "configured-memory",
      node_type: "concept",
      properties: { title: "configured memory", content: "hook coverage root" },
    });
  } finally {
    await store.close();
  }
  await mkdir(join(dir, ".red", "memory"), { recursive: true });
  await writeFile(
    join(dir, ".red", "memory", "config.json"),
    JSON.stringify(
      {
        version: 1,
        mode: "graph",
        notesDir: ".red/memory/notes",
        storePath: "graph.rdb",
        hooks: {
          sessionStart: true,
          postToolUse: true,
          stop: true,
          preCompact: true,
        },
        mcp: true,
        reddb: true,
      },
      null,
      2,
    ),
    "utf8",
  );
  return { uri, root: dir };
}

async function seedConflictStore(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "memory-mcp-conflict-"));
  roots.push(dir);
  const uri = `file://${join(dir, "graph.rdb")}`;
  const store = await MemoryStore.open({ uri, project: "test" });
  try {
    const oldRid = await store.upsertNode({
      label: "deploy-friday",
      node_type: "decision",
      properties: { title: "deploy friday", content: "deploys happen friday" },
    });
    const newRid = await store.upsertNode({
      label: "deploy-tuesday",
      node_type: "decision",
      properties: { title: "deploy tuesday", content: "deploys happen tuesday" },
    });
    await store.upsertEdge({
      label: "CONTRADICTS",
      from_rid: oldRid,
      to_rid: newRid,
      properties: { reason: "date changed" },
    });
  } finally {
    await store.close();
  }
  return uri;
}

async function connect(uri: string, env: Record<string, string> = {}): Promise<Client> {
  const transport = new StdioClientTransport({
    command: tsx,
    args: [serverEntry],
    cwd: pkgRoot,
    env: { ...process.env, RED_MEMORY_URI: uri, ...env } as Record<string, string>,
  });
  const client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
  clients.push(client);
  await client.connect(transport);
  return client;
}

interface ToolResult {
  content: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
}

describe("MCP server over stdio", () => {
  test(
    "lists the full tool surface",
    async () => {
      const client = await connect(await seedStore());
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual(
        [
          "memory_ask",
          "memory_asset_inventory",
          "memory_asset_inventory_viewer",
          "memory_agent_integration_status",
          "memory_agent_integration_status_viewer",
          "memory_autocure",
          "memory_capability_catalog",
          "memory_claim_check",
          "memory_conflicts",
          "memory_communities",
          "memory_communities_viewer",
          "memory_community_digest",
          "memory_references_radar",
          "memory_confidence",
          "memory_context_pack",
          "memory_context_pack_viewer",
          "memory_dashboard",
          "memory_decay",
          "memory_decay_viewer",
          "memory_doc_brief",
          "memory_doc_brief_viewer",
          "memory_doc_bundle",
          "memory_doc_bundle_viewer",
          "memory_doc_coverage",
          "memory_doc_coverage_viewer",
          "memory_doc_backlinks",
          "memory_doc_backlinks_viewer",
          "memory_doc_evidence_pack",
          "memory_doc_evidence_pack_viewer",
          "memory_doc_reference_graph",
          "memory_doc_reference_graph_viewer",
          "memory_doc_read",
          "memory_doc_related",
          "memory_doc_related_viewer",
          "memory_doc_search",
          "memory_doc_search_viewer",
          "memory_doctor",
          "memory_export",
          "memory_extraction_status",
          "memory_extraction_status_viewer",
          "memory_federate",
          "memory_governance",
          "memory_governance_viewer",
          "memory_health",
          "memory_health_viewer",
          "memory_handoff",
          "memory_handoff_viewer",
          "memory_work_frontier",
          "memory_work_frontier_viewer",
          "memory_hook_coverage",
          "memory_hook_coverage_viewer",
          "memory_learning_debt",
          "memory_learning_debt_viewer",
          "memory_layers",
          "memory_layers_viewer",
          "memory_lint",
          "memory_neighbors",
          "memory_onboarding_map",
          "memory_onboarding_map_viewer",
          "memory_path",
          "memory_path_explain",
          "memory_path_explain_viewer",
          "memory_pre_pr_review",
          "memory_pre_pr_review_viewer",
          "memory_privacy_scan",
          "memory_promote",
          "memory_provenance",
          "memory_readiness",
          "memory_readiness_viewer",
          "memory_reasoning_replay",
          "memory_recall",
          "memory_routing_guide",
          "memory_routing_guide_viewer",
          "memory_search",
          "memory_session_end",
          "memory_session_start",
          "memory_session_timeline",
          "memory_session_timeline_viewer",
          "memory_skill_recommendations",
          "memory_smart_search",
          "memory_smart_search_viewer",
          "memory_stats",
          "memory_store",
          "memory_structural_impact",
          "memory_structural_impact_viewer",
          "memory_supersede",
          "memory_timeline",
          "memory_traverse",
          "memory_vector_search",
          "memory_vector_status",
          "memory_vector_status_viewer",
          "memory_whatif",
          "memory_workbench",
          "memory_working_get",
          "memory_working_set",
        ].sort(),
      );
      const recallTool = tools.find((t) => t.name === "memory_recall");
      expect(JSON.stringify(recallTool?.inputSchema)).toContain("as_of");
      expect(names).not.toContain("memory_commit");
      const communities = tools.find((tool) => tool.name === "memory_communities");
      expect(communities?.description).toBe(
        getReadOnlyMemoryOperation("memory.communities").renderer.mcp.description,
      );
      for (const operation of listReadOnlyMemoryOperations()) {
        const tool = tools.find((item) => item.name === operation.renderer.mcp.toolName);
        expect(tool?.description).toBe(operation.renderer.mcp.description);
        expect(tool?.inputSchema).toEqual(expect.objectContaining({ type: "object" }));
      }
      const storeTool = tools.find((tool) => tool.name === "memory_store");
      const supersedeTool = tools.find((tool) => tool.name === "memory_supersede");
      expect(storeTool?.description?.toLowerCase()).toContain("mutating");
      expect(supersedeTool?.description?.toLowerCase()).toContain("mutating");
    },
    TIMEOUT,
  );

  test(
    "registry-backed readiness and trust tools return representative read-only outputs",
    async () => {
      const client = await connect(await seedStore());
      const before = (await client.callTool({
        name: "memory_stats",
        arguments: {},
      })) as ToolResult;

      const readinessRes = (await client.callTool({
        name: "memory_readiness",
        arguments: { goal: "jwt rotation", min_evidence: 1 },
      })) as ToolResult;
      const readiness = JSON.parse(readinessRes.content[0]?.text ?? "{}") as {
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
      const claim = JSON.parse(claimRes.content[0]?.text ?? "{}") as { status: string };
      expect(claim.status).toBe("supported");
      expect(claimRes.structuredContent).toMatchObject({
        operation_id: "memory.claim-check",
        status: "supported",
      });

      const contextPackRes = (await client.callTool({
        name: "memory_context_pack",
        arguments: { goal: "jwt rotation", budget_chars: 2_000 },
      })) as ToolResult;
      const contextPack = JSON.parse(contextPackRes.content[0]?.text ?? "{}") as {
        markdown: string;
        entries: unknown[];
      };
      expect(contextPack.markdown).toContain("Memory context pack");
      expect(contextPack.entries.length).toBeGreaterThan(0);

      const contextPackViewerRes = (await client.callTool({
        name: "memory_context_pack_viewer",
        arguments: { goal: "jwt rotation", budget_chars: 2_000 },
      })) as ToolResult;
      const contextPackViewer = JSON.parse(
        contextPackViewerRes.content[0]?.text ?? "{}",
      ) as {
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

      const dashboardRes = (await client.callTool({
        name: "memory_dashboard",
        arguments: {},
      })) as ToolResult;
      const dashboard = JSON.parse(dashboardRes.content[0]?.text ?? "{}") as {
        contract: { version: string };
        dashboard: { schema_version: string; stats: { nodes: number; docs: number } };
        html: string;
      };
      expect(dashboard.contract.version).toBe("memory.operational_dashboard.viewer.v1");
      expect(dashboard.dashboard.schema_version).toBe("memory.operational_dashboard.v1");
      expect(dashboard.dashboard.stats).toMatchObject({ nodes: 3, docs: 1 });
      expect(dashboard.html).toContain("Memory Operational Dashboard");
      expect(dashboard.html).toContain('id="memory-dashboard-data"');
      expect(dashboardRes.structuredContent).toMatchObject({
        operation_id: "memory.dashboard",
        consumes: "memory.operational_dashboard.v1",
        nodes: 3,
        docs: 1,
      });

      const capabilityRes = (await client.callTool({
        name: "memory_capability_catalog",
        arguments: {},
      })) as ToolResult;
      const capabilityCatalog = JSON.parse(capabilityRes.content[0]?.text ?? "{}") as {
        schema_version: string;
        runtime: { stats: { nodes: number; edges: number }; docs: { total: number } };
        categories: Array<{ id: string }>;
        capabilities: Array<{ id: string; mcp: string[] }>;
      };
      expect(capabilityCatalog.schema_version).toBe("memory.capability_catalog.v1");
      expect(capabilityCatalog.runtime.stats).toMatchObject({ nodes: 3, edges: 2 });
      expect(capabilityCatalog.runtime.docs.total).toBe(1);
      expect(capabilityCatalog.categories.map((category) => category.id)).toContain("ui");
      expect(
        capabilityCatalog.capabilities.find((item) => item.id === "local-ui")?.mcp,
      ).toContain("memory_dashboard");
      expect(
        capabilityCatalog.capabilities.find((item) => item.id === "layered-memory-architecture")?.mcp,
      ).toContain("memory_layers");
      expect(
        capabilityCatalog.capabilities.find((item) => item.id === "layered-memory-architecture")?.mcp,
      ).toContain("memory_layers_viewer");
      expect(capabilityRes.structuredContent).toMatchObject({
        operation_id: "memory.capability-catalog",
        schema_version: "memory.capability_catalog.v1",
        total: capabilityCatalog.capabilities.length,
        nodes: 3,
        read_only: true,
      });

      const extractionStatusRes = (await client.callTool({
        name: "memory_extraction_status",
        arguments: {},
      })) as ToolResult;
      const extractionStatus = JSON.parse(extractionStatusRes.content[0]?.text ?? "{}") as {
        schema_version: string;
        deterministic: { markdown_entities: boolean };
        inferred: { available: boolean; facts: number };
      };
      expect(extractionStatus.schema_version).toBe("memory.extraction_status.v1");
      expect(extractionStatus.deterministic.markdown_entities).toBe(true);
      expect(extractionStatusRes.structuredContent).toMatchObject({
        operation_id: "memory.extraction-status",
        schema_version: "memory.extraction_status.v1",
        deterministic_ready: expect.any(Number),
        inferred_available: false,
      });

      const extractionViewerRes = (await client.callTool({
        name: "memory_extraction_status_viewer",
        arguments: {},
      })) as ToolResult;
      const extractionViewer = JSON.parse(extractionViewerRes.content[0]?.text ?? "{}") as {
        contract: { version: string; consumes: string };
        status: { schema_version: string; inferred: { available: boolean } };
        html: string;
      };
      expect(extractionViewer.contract).toMatchObject({
        version: "memory.extraction_status.viewer.v1",
        consumes: "memory.extraction_status.v1",
      });
      expect(extractionViewer.status.schema_version).toBe("memory.extraction_status.v1");
      expect(extractionViewer.html).toContain("Extraction Status");
      expect(extractionViewer.html).toContain('id="extraction-status-data"');
      expect(extractionViewerRes.structuredContent).toMatchObject({
        operation_id: "memory.extraction-status-viewer",
        contract: "memory.extraction_status.viewer.v1",
        consumes: "memory.extraction_status.v1",
        html_bytes: expect.any(Number),
      });

      const layersRes = (await client.callTool({
        name: "memory_layers",
        arguments: {},
      })) as ToolResult;
      const layers = JSON.parse(layersRes.content[0]?.text ?? "{}") as {
        schema_version: string;
        layers: Array<{ id: string }>;
      };
      expect(layers.schema_version).toBe("memory.memory_layers.v1");
      expect(layers.layers.map((layer) => layer.id)).toEqual(
        expect.arrayContaining(["short-term", "long-term", "reasoning", "docs-code", "vectors"]),
      );
      expect(layersRes.structuredContent).toMatchObject({
        operation_id: "memory.layers",
        schema_version: "memory.memory_layers.v1",
        total_layers: 5,
        layers: 5,
        read_only: true,
      });

      const layersViewerRes = (await client.callTool({
        name: "memory_layers_viewer",
        arguments: {},
      })) as ToolResult;
      const layersViewer = JSON.parse(layersViewerRes.content[0]?.text ?? "{}") as {
        contract: { version: string; consumes: string };
        report: { schema_version: string; summary: { total_layers: number } };
        html: string;
      };
      expect(layersViewer.contract).toMatchObject({
        version: "memory.layers.viewer.v1",
        consumes: "memory.memory_layers.v1",
      });
      expect(layersViewer.report.summary.total_layers).toBe(5);
      expect(layersViewer.html).toContain("Memory Layers");
      expect(layersViewer.html).toContain('id="memory-layers-data"');
      expect(layersViewerRes.structuredContent).toMatchObject({
        operation_id: "memory.layers-viewer",
        contract: "memory.layers.viewer.v1",
        consumes: "memory.memory_layers.v1",
        total_layers: 5,
        html_bytes: expect.any(Number),
      });

      const radarRes = (await client.callTool({
        name: "memory_references_radar",
        arguments: {},
      })) as ToolResult;
      const radar = JSON.parse(radarRes.content[0]?.text ?? "{}") as {
        schema_version: string;
        summary: { references: number };
        references: Array<{ id: string; repository: string }>;
      };
      expect(radar.schema_version).toBe("memory.reference_radar.v1");
      expect(radar.summary.references).toBe(5);
      expect(radar.references.find((item) => item.id === "agentmemory")?.repository).toBe(
        "rohitg00/agentmemory",
      );
      expect(radarRes.structuredContent).toMatchObject({
        operation_id: "memory.references-radar",
        schema_version: "memory.reference_radar.v1",
        references: 5,
        read_only: true,
      });

      const docSearchRes = (await client.callTool({
        name: "memory_doc_search",
        arguments: { query: "jwt rotation", limit: 3 },
      })) as ToolResult;
      const docSearch = JSON.parse(docSearchRes.content[0]?.text ?? "{}") as {
        total_docs: number;
        hits: Array<{ path: string; excerpt: string; matched_fields: string[] }>;
      };
      expect(docSearch.total_docs).toBe(1);
      expect(docSearch.hits[0]).toMatchObject({
        path: "docs/jwt.md",
        matched_fields: expect.arrayContaining(["body"]),
      });
      expect(docSearch.hits[0].excerpt).toContain("jwt tokens rotate");
      expect(docSearchRes.structuredContent).toMatchObject({
        operation_id: "memory.doc-search",
        query: "jwt rotation",
        total_docs: 1,
        hits: 1,
      });

      const docSearchViewerRes = (await client.callTool({
        name: "memory_doc_search_viewer",
        arguments: { query: "jwt rotation", limit: 2 },
      })) as ToolResult;
      const docSearchViewer = JSON.parse(
        docSearchViewerRes.content[0]?.text ?? "{}",
      ) as {
        contract: { version: string; consumes: string };
        report: { query: string; hits: unknown[] };
        html: string;
      };
      expect(docSearchViewer.contract).toMatchObject({
        version: "memory.doc_search.viewer.v1",
        consumes: "memory.doc_search.v1",
      });
      expect(docSearchViewer.report.hits.length).toBe(1);
      expect(docSearchViewer.html).toContain("Documentation Search");
      expect(docSearchViewer.html).toContain('id="doc-search-data"');
      expect(docSearchViewerRes.structuredContent).toMatchObject({
        operation_id: "memory.doc-search-viewer",
        contract: "memory.doc_search.viewer.v1",
        consumes: "memory.doc_search.v1",
        hits: 1,
      });

      const docBriefRes = (await client.callTool({
        name: "memory_doc_brief",
        arguments: { query: "jwt rotation", limit: 2, max_bytes: 120 },
      })) as ToolResult;
      const docBrief = JSON.parse(docBriefRes.content[0]?.text ?? "{}") as {
        schema_version: string;
        status: string;
        citations: Array<{ marker: string; path: string }>;
        markdown: string;
      };
      expect(docBrief).toMatchObject({
        schema_version: "memory.doc_brief.v1",
        status: "partial",
        citations: [expect.objectContaining({ marker: "[D1]", path: "docs/jwt.md" })],
      });
      expect(docBrief.markdown).toContain("Memory Docs Brief");
      expect(docBrief.markdown).toContain("[D1]");
      expect(docBriefRes.structuredContent).toMatchObject({
        operation_id: "memory.doc-brief",
        schema_version: "memory.doc_brief.v1",
        citations: 1,
        read_only: true,
      });

      const docBriefViewerRes = (await client.callTool({
        name: "memory_doc_brief_viewer",
        arguments: { query: "jwt rotation", limit: 2, max_bytes: 120 },
      })) as ToolResult;
      const docBriefViewer = JSON.parse(docBriefViewerRes.content[0]?.text ?? "{}") as {
        contract: { version: string; consumes: string };
        brief: { schema_version: string; citations: unknown[]; status: string };
        html: string;
      };
      expect(docBriefViewer.contract).toMatchObject({
        version: "memory.doc_brief.viewer.v1",
        consumes: "memory.doc_brief.v1",
      });
      expect(docBriefViewer.brief.citations.length).toBe(1);
      expect(docBriefViewer.html).toContain("Documentation Brief");
      expect(docBriefViewer.html).toContain('id="doc-brief-data"');
      expect(docBriefViewerRes.structuredContent).toMatchObject({
        operation_id: "memory.doc-brief-viewer",
        contract: "memory.doc_brief.viewer.v1",
        consumes: "memory.doc_brief.v1",
        citations: 1,
        read_only: true,
      });

      const docBundleRes = (await client.callTool({
        name: "memory_doc_bundle",
        arguments: { query: "jwt rotation", limit: 2, max_bytes: 120 },
      })) as ToolResult;
      const docBundle = JSON.parse(docBundleRes.content[0]?.text ?? "{}") as {
        schema_version: string;
        query: string;
        hits: unknown[];
        packs: unknown[];
        markdown: string;
      };
      expect(docBundle).toMatchObject({
        schema_version: "memory.doc_bundle.v1",
        query: "jwt rotation",
      });
      expect(docBundle.hits.length).toBe(1);
      expect(docBundle.packs.length).toBe(1);
      expect(docBundle.markdown).toContain("Memory Docs Bundle");
      expect(docBundle.markdown).toContain("Memory Doc Evidence Pack");
      expect(docBundleRes.structuredContent).toMatchObject({
        operation_id: "memory.doc-bundle",
        schema_version: "memory.doc_bundle.v1",
        hits: 1,
        packs: 1,
        read_only: true,
      });

      const docBundleViewerRes = (await client.callTool({
        name: "memory_doc_bundle_viewer",
        arguments: { query: "jwt rotation", limit: 2, max_bytes: 120 },
      })) as ToolResult;
      const docBundleViewer = JSON.parse(
        docBundleViewerRes.content[0]?.text ?? "{}",
      ) as {
        contract: { version: string; consumes: string };
        bundle: { schema_version: string; hits: unknown[]; packs: unknown[] };
        html: string;
      };
      expect(docBundleViewer.contract).toMatchObject({
        version: "memory.doc_bundle.viewer.v1",
        consumes: "memory.doc_bundle.v1",
      });
      expect(docBundleViewer.bundle.hits.length).toBe(1);
      expect(docBundleViewer.bundle.packs.length).toBe(1);
      expect(docBundleViewer.html).toContain("Documentation Bundle");
      expect(docBundleViewer.html).toContain('id="doc-bundle-data"');
      expect(docBundleViewerRes.structuredContent).toMatchObject({
        operation_id: "memory.doc-bundle-viewer",
        contract: "memory.doc_bundle.viewer.v1",
        consumes: "memory.doc_bundle.v1",
        hits: 1,
        packs: 1,
        read_only: true,
      });

      const smartSearchRes = (await client.callTool({
        name: "memory_smart_search",
        arguments: { query: "jwt rotation", limit: 3 },
      })) as ToolResult;
      const smartSearch = JSON.parse(smartSearchRes.content[0]?.text ?? "{}") as {
        schema_version: string;
        summary: { recall_hits: number; doc_hits: number };
        top_results: unknown[];
      };
      expect(smartSearch.schema_version).toBe("memory.smart_search.v1");
      expect(smartSearch.summary.recall_hits).toBeGreaterThan(0);
      expect(smartSearch.summary.doc_hits).toBe(1);
      expect(smartSearch.top_results.length).toBeGreaterThan(0);
      expect(smartSearchRes.structuredContent).toMatchObject({
        operation_id: "memory.smart-search",
        schema_version: "memory.smart_search.v1",
        doc_hits: 1,
        top_results: smartSearch.top_results.length,
      });

      const smartSearchViewerRes = (await client.callTool({
        name: "memory_smart_search_viewer",
        arguments: { query: "jwt rotation", limit: 3 },
      })) as ToolResult;
      const smartSearchViewer = JSON.parse(
        smartSearchViewerRes.content[0]?.text ?? "{}",
      ) as {
        contract: { version: string };
        report: { query: string; top_results: unknown[] };
        html: string;
      };
      expect(smartSearchViewer.contract.version).toBe("memory.smart_search.viewer.v1");
      expect(smartSearchViewer.report.query).toBe("jwt rotation");
      expect(smartSearchViewer.html).toContain("Smart Search");
      expect(smartSearchViewerRes.structuredContent).toMatchObject({
        operation_id: "memory.smart-search-viewer",
        contract: "memory.smart_search.viewer.v1",
        query: "jwt rotation",
        top_results: smartSearchViewer.report.top_results.length,
      });

      const docReadRes = (await client.callTool({
        name: "memory_doc_read",
        arguments: { path: "docs/jwt.md", max_bytes: 20 },
      })) as ToolResult;
      const docRead = JSON.parse(docReadRes.content[0]?.text ?? "{}") as {
        found: boolean;
        path: string;
        body: string;
        truncated: boolean;
      };
      expect(docRead).toMatchObject({
        found: true,
        path: "docs/jwt.md",
        truncated: true,
      });
      expect(docRead.body).toContain("jwt tokens");
      expect(docReadRes.structuredContent).toMatchObject({
        operation_id: "memory.doc-read",
        found: true,
        path: "docs/jwt.md",
        truncated: true,
      });

      const docRelatedRes = (await client.callTool({
        name: "memory_doc_related",
        arguments: { path: "docs/jwt.md" },
      })) as ToolResult;
      const docRelated = JSON.parse(docRelatedRes.content[0]?.text ?? "{}") as {
        schema_version: string;
        found: boolean;
        references: unknown[];
        related_docs: unknown[];
      };
      expect(docRelated).toMatchObject({
        schema_version: "memory.doc_related.v1",
        found: true,
      });
      expect(Array.isArray(docRelated.references)).toBe(true);
      expect(Array.isArray(docRelated.related_docs)).toBe(true);
      expect(docRelatedRes.structuredContent).toMatchObject({
        operation_id: "memory.doc-related",
        schema_version: "memory.doc_related.v1",
        found: true,
        read_only: true,
      });

      const docEvidencePackRes = (await client.callTool({
        name: "memory_doc_evidence_pack",
        arguments: { path: "docs/jwt.md", max_bytes: 120 },
      })) as ToolResult;
      const docEvidencePack = JSON.parse(
        docEvidencePackRes.content[0]?.text ?? "{}",
      ) as {
        schema_version: string;
        found: boolean;
        markdown: string;
        related: { references: unknown[] };
      };
      expect(docEvidencePack).toMatchObject({
        schema_version: "memory.doc_evidence_pack.v1",
        found: true,
      });
      expect(docEvidencePack.markdown).toContain("Memory Doc Evidence Pack");
      expect(docEvidencePack.markdown).toContain("docs/jwt.md");
      expect(Array.isArray(docEvidencePack.related.references)).toBe(true);
      expect(docEvidencePackRes.structuredContent).toMatchObject({
        operation_id: "memory.doc-evidence-pack",
        schema_version: "memory.doc_evidence_pack.v1",
        found: true,
        read_only: true,
      });

      const docEvidencePackViewerRes = (await client.callTool({
        name: "memory_doc_evidence_pack_viewer",
        arguments: { path: "docs/jwt.md", max_bytes: 120 },
      })) as ToolResult;
      const docEvidencePackViewer = JSON.parse(
        docEvidencePackViewerRes.content[0]?.text ?? "{}",
      ) as {
        contract: { version: string; consumes: string };
        pack: { schema_version: string; found: boolean };
        html: string;
      };
      expect(docEvidencePackViewer.contract).toMatchObject({
        version: "memory.doc_evidence_pack.viewer.v1",
        consumes: "memory.doc_evidence_pack.v1",
      });
      expect(docEvidencePackViewer.pack).toMatchObject({
        schema_version: "memory.doc_evidence_pack.v1",
        found: true,
      });
      expect(docEvidencePackViewer.html).toContain("Doc Evidence Pack");
      expect(docEvidencePackViewer.html).toContain('id="doc-evidence-pack-data"');
      expect(docEvidencePackViewerRes.structuredContent).toMatchObject({
        operation_id: "memory.doc-evidence-pack-viewer",
        contract: "memory.doc_evidence_pack.viewer.v1",
        consumes: "memory.doc_evidence_pack.v1",
        references: 1,
        read_only: true,
      });

      const docRelatedViewerRes = (await client.callTool({
        name: "memory_doc_related_viewer",
        arguments: { path: "docs/jwt.md" },
      })) as ToolResult;
      const docRelatedViewer = JSON.parse(docRelatedViewerRes.content[0]?.text ?? "{}") as {
        contract: { version: string; consumes: string };
        html: string;
      };
      expect(docRelatedViewer.contract).toMatchObject({
        version: "memory.doc_related.viewer.v1",
        consumes: "memory.doc_related.v1",
      });
      expect(docRelatedViewer.html).toContain("Related Documentation");
      expect(docRelatedViewer.html).toContain('id="doc-related-data"');
      expect(docRelatedViewerRes.structuredContent).toMatchObject({
        operation_id: "memory.doc-related-viewer",
        consumes: "memory.doc_related.v1",
        found: true,
      });

      const docBacklinksRes = (await client.callTool({
        name: "memory_doc_backlinks",
        arguments: { query: "cache-ttl" },
      })) as ToolResult;
      const docBacklinks = JSON.parse(docBacklinksRes.content[0]?.text ?? "{}") as {
        schema_version: string;
        found: boolean;
        references: unknown[];
        docs: unknown[];
      };
      expect(docBacklinks).toMatchObject({
        schema_version: "memory.doc_backlinks.v1",
        found: true,
      });
      expect(Array.isArray(docBacklinks.references)).toBe(true);
      expect(Array.isArray(docBacklinks.docs)).toBe(true);
      expect(docBacklinksRes.structuredContent).toMatchObject({
        operation_id: "memory.doc-backlinks",
        schema_version: "memory.doc_backlinks.v1",
        found: true,
        read_only: true,
      });

      const docBacklinksViewerRes = (await client.callTool({
        name: "memory_doc_backlinks_viewer",
        arguments: { query: "cache-ttl" },
      })) as ToolResult;
      const docBacklinksViewer = JSON.parse(
        docBacklinksViewerRes.content[0]?.text ?? "{}",
      ) as {
        contract: { version: string; consumes: string };
        html: string;
      };
      expect(docBacklinksViewer.contract).toMatchObject({
        version: "memory.doc_backlinks.viewer.v1",
        consumes: "memory.doc_backlinks.v1",
      });
      expect(docBacklinksViewer.html).toContain("Documentation Backlinks");
      expect(docBacklinksViewer.html).toContain('id="doc-backlinks-data"');
      expect(docBacklinksViewerRes.structuredContent).toMatchObject({
        operation_id: "memory.doc-backlinks-viewer",
        consumes: "memory.doc_backlinks.v1",
        found: true,
      });

      const docCoverageRes = (await client.callTool({
        name: "memory_doc_coverage",
        arguments: {},
      })) as ToolResult;
      const docCoverage = JSON.parse(docCoverageRes.content[0]?.text ?? "{}") as {
        schema_version: string;
        total_docs: number;
        grounded_docs: number;
        docs_with_references: number;
        docs: Array<{ path: string; graph_status: string; vector_status: string }>;
      };
      expect(docCoverage).toMatchObject({
        schema_version: "memory.doc_coverage.v1",
        total_docs: 1,
        grounded_docs: 1,
        docs_with_references: 1,
      });
      expect(docCoverage.docs[0]).toMatchObject({
        path: "docs/jwt.md",
        graph_status: "grounded",
        vector_status: "unavailable",
      });
      expect(docCoverageRes.structuredContent).toMatchObject({
        operation_id: "memory.doc-coverage",
        schema_version: "memory.doc_coverage.v1",
        total_docs: 1,
        grounded_docs: 1,
        read_only: true,
      });

      const docCoverageViewerRes = (await client.callTool({
        name: "memory_doc_coverage_viewer",
        arguments: {},
      })) as ToolResult;
      const docCoverageViewer = JSON.parse(docCoverageViewerRes.content[0]?.text ?? "{}") as {
        contract: { version: string };
        html: string;
      };
      expect(docCoverageViewer.contract.version).toBe("memory.doc_coverage.viewer.v1");
      expect(docCoverageViewer.html).toContain("Documentation Coverage");
      expect(docCoverageViewer.html).toContain('id="doc-coverage-data"');
      expect(docCoverageViewerRes.structuredContent).toMatchObject({
        operation_id: "memory.doc-coverage-viewer",
        consumes: "memory.doc_coverage.v1",
        total_docs: 1,
        grounded_docs: 1,
      });

      const docReferenceGraphRes = (await client.callTool({
        name: "memory_doc_reference_graph",
        arguments: {},
      })) as ToolResult;
      const docReferenceGraph = JSON.parse(docReferenceGraphRes.content[0]?.text ?? "{}") as {
        schema_version: string;
        total_docs: number;
        reference_edges: number;
      };
      expect(docReferenceGraph).toMatchObject({
        schema_version: "memory.doc_reference_graph.v1",
        total_docs: 1,
      });
      expect(docReferenceGraph.reference_edges).toBeGreaterThanOrEqual(0);
      expect(docReferenceGraphRes.structuredContent).toMatchObject({
        operation_id: "memory.doc-reference-graph",
        schema_version: "memory.doc_reference_graph.v1",
        total_docs: 1,
        read_only: true,
      });

      const docReferenceGraphViewerRes = (await client.callTool({
        name: "memory_doc_reference_graph_viewer",
        arguments: {},
      })) as ToolResult;
      const docReferenceGraphViewer = JSON.parse(
        docReferenceGraphViewerRes.content[0]?.text ?? "{}",
      ) as {
        contract: { version: string; consumes: string };
        html: string;
      };
      expect(docReferenceGraphViewer.contract).toMatchObject({
        version: "memory.doc_reference_graph.viewer.v1",
        consumes: "memory.doc_reference_graph.v1",
      });
      expect(docReferenceGraphViewer.html).toContain("Documentation Reference Graph");
      expect(docReferenceGraphViewer.html).toContain('id="doc-reference-graph-data"');
      expect(docReferenceGraphViewerRes.structuredContent).toMatchObject({
        operation_id: "memory.doc-reference-graph-viewer",
        consumes: "memory.doc_reference_graph.v1",
        total_docs: 1,
      });

      const provenanceRes = (await client.callTool({
        name: "memory_provenance",
        arguments: { target: "jwt-rotation" },
      })) as ToolResult;
      const provenance = JSON.parse(provenanceRes.content[0]?.text ?? "{}") as {
        node: { label: string };
        provenance: { missing: boolean };
      };
      expect(provenance.node.label).toBe("jwt-rotation");
      expect(provenance.provenance.missing).toBe(true);

      const privacyRes = (await client.callTool({
        name: "memory_privacy_scan",
        arguments: {},
      })) as ToolResult;
      expect(JSON.parse(privacyRes.content[0]?.text ?? "{}")).toMatchObject({
        readOnly: true,
        mutated: false,
        mode: "graph",
      });

      const lintRes = (await client.callTool({
        name: "memory_lint",
        arguments: {},
      })) as ToolResult;
      expect(JSON.parse(lintRes.content[0]?.text ?? "{}")).toMatchObject({
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
      const governance = JSON.parse(governanceRes.content[0]?.text ?? "{}") as {
        schema_version: string;
        read_only: boolean;
        summary: { total_nodes: number };
      };
      expect(governance).toMatchObject({
        schema_version: "memory.governance.v1",
        read_only: true,
        summary: { total_nodes: 3 },
      });
      expect(governanceRes.structuredContent).toMatchObject({
        operation_id: "memory.governance",
        schema_version: "memory.governance.v1",
        read_only: true,
      });

      const decayRes = (await client.callTool({
        name: "memory_decay",
        arguments: {},
      })) as ToolResult;
      expect(JSON.parse(decayRes.content[0]?.text ?? "{}")).toMatchObject({
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
      const governanceViewer = JSON.parse(
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
      expect(governanceViewerRes.structuredContent).toMatchObject({
        operation_id: "memory.governance-viewer",
        consumes: "memory.governance.v1",
        html_bytes: expect.any(Number),
      });

      const recommendationsRes = (await client.callTool({
        name: "memory_skill_recommendations",
        arguments: { task: "jwt rotation", limit: 3 },
      })) as ToolResult;
      expect(JSON.parse(recommendationsRes.content[0]?.text ?? "{}")).toHaveProperty(
        "recommendations",
      );

      const learningDebtRes = (await client.callTool({
        name: "memory_learning_debt",
        arguments: {},
      })) as ToolResult;
      const learningDebt = JSON.parse(learningDebtRes.content[0]?.text ?? "{}") as {
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
      const learningDebtViewer = JSON.parse(learningDebtViewerRes.content[0]?.text ?? "{}") as {
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

      const onboardingRes = (await client.callTool({
        name: "memory_onboarding_map",
        arguments: {},
      })) as ToolResult;
      const onboarding = JSON.parse(onboardingRes.content[0]?.text ?? "{}") as {
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
      const onboardingViewer = JSON.parse(onboardingViewerRes.content[0]?.text ?? "{}") as {
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
      expect(JSON.parse(healthRes.content[0]?.text ?? "{}")).toMatchObject({
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
      const healthViewer = JSON.parse(healthViewerRes.content[0]?.text ?? "{}") as {
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
      const handoff = JSON.parse(handoffRes.content[0]?.text ?? "{}") as {
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
      const handoffViewer = JSON.parse(handoffViewerRes.content[0]?.text ?? "{}") as {
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
      const prePr = JSON.parse(prePrRes.content[0]?.text ?? "{}") as {
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
      const prePrViewer = JSON.parse(prePrViewerRes.content[0]?.text ?? "{}") as {
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

      const vectorRes = (await client.callTool({
        name: "memory_vector_status",
        arguments: {},
      })) as ToolResult;
      const vector = JSON.parse(vectorRes.content[0]?.text ?? "{}") as {
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
      const vectorViewer = JSON.parse(vectorViewerRes.content[0]?.text ?? "{}") as {
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
      const vectorSearch = JSON.parse(vectorSearchRes.content[0]?.text ?? "{}") as {
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
      const viewer = JSON.parse(viewerRes.content[0]?.text ?? "{}") as {
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
      const routing = JSON.parse(routingRes.content[0]?.text ?? "{}") as {
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
      const routingViewer = JSON.parse(routingViewerRes.content[0]?.text ?? "{}") as {
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
      const integration = JSON.parse(integrationRes.content[0]?.text ?? "{}") as {
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
      const pathExplain = JSON.parse(pathExplainRes.content[0]?.text ?? "{}") as {
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
      const pathExplainViewer = JSON.parse(pathExplainViewerRes.content[0]?.text ?? "{}") as {
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
      expect(JSON.parse(impactRes.content[0]?.text ?? "{}")).toMatchObject({
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
      const impactViewer = JSON.parse(impactViewerRes.content[0]?.text ?? "{}") as {
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

      const after = (await client.callTool({
        name: "memory_stats",
        arguments: {},
      })) as ToolResult;
      expect(after.structuredContent).toEqual(before.structuredContent);
    },
    TIMEOUT,
  );

  test(
    "memory_communities exposes read-only community analytics",
    async () => {
      const client = await connect(await seedStore());
      const before = (await client.callTool({
        name: "memory_stats",
        arguments: {},
      })) as ToolResult;

      const result = (await client.callTool({
        name: "memory_communities",
        arguments: {},
      })) as ToolResult;

      const analytics = JSON.parse(result.content[0]?.text ?? "{}") as {
        schema_version: string;
        graph_hash: string;
        communities: Array<{ count: number; labels: string[]; titles: string[] }>;
        assignments: Array<{ label: string; title: string; community_id: string }>;
      };
      expect(analytics.schema_version).toBe("memory.communities.v1");
      expect(analytics.graph_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(analytics.assignments.map((item) => item.label).sort()).toEqual([
        "auth-service",
        "cache-ttl",
        "jwt-rotation",
      ]);
      expect(analytics.communities.reduce((sum, item) => sum + item.count, 0)).toBe(3);
      expect(analytics.communities.some((item) => item.titles.includes("jwt rotation"))).toBe(
        true,
      );
      expect(result.structuredContent).toMatchObject({
        operation_id: "memory.communities",
        schema_version: "memory.communities.v1",
        assignments: 3,
        nodes: 3,
        edges: 2,
      });

      const viewerResult = (await client.callTool({
        name: "memory_communities_viewer",
        arguments: {},
      })) as ToolResult;
      const viewer = JSON.parse(viewerResult.content[0]?.text ?? "{}") as {
        contract: { version: string; consumes: string };
        report: { schema_version: string; assignments: unknown[] };
        html: string;
      };
      expect(viewer.contract).toMatchObject({
        version: "memory.communities.viewer.v1",
        consumes: "memory.communities.v1",
      });
      expect(viewer.report.schema_version).toBe("memory.communities.v1");
      expect(viewer.report.assignments).toHaveLength(3);
      expect(viewer.html).toContain("Graph Communities");
      expect(viewer.html).toContain('id="communities-data"');
      expect(viewerResult.structuredContent).toMatchObject({
        operation_id: "memory.communities-viewer",
        contract: "memory.communities.viewer.v1",
        consumes: "memory.communities.v1",
        assignments: 3,
      });

      const after = (await client.callTool({
        name: "memory_stats",
        arguments: {},
      })) as ToolResult;
      expect(after.structuredContent).toEqual(before.structuredContent);
    },
    TIMEOUT,
  );

  test(
    "memory_hook_coverage exposes read-only runner manifest and config coverage",
    async () => {
      const seeded = await seedConfiguredStore();
      const client = await connect(seeded.uri, { MEMORY_ROOT: seeded.root });

      const result = (await client.callTool({
        name: "memory_hook_coverage",
        arguments: {},
      })) as ToolResult;

      const coverage = JSON.parse(result.content[0]?.text ?? "{}") as {
        schema_version: string;
        mode: string;
        hooks_enabled: string[];
        runners: Array<{ runner: string; coverage: { enabled: number }; gaps: string[] }>;
      };
      expect(coverage.schema_version).toBe("memory.hook_coverage.v1");
      expect(coverage.mode).toBe("graph");
      expect(coverage.hooks_enabled).toEqual([
        "sessionStart",
        "postToolUse",
        "stop",
        "preCompact",
      ]);
      expect(coverage.runners.find((runner) => runner.runner === "claude")?.coverage.enabled).toBe(4);
      expect(coverage.runners.find((runner) => runner.runner === "codex")?.coverage.enabled).toBe(3);
      expect(coverage.runners.find((runner) => runner.runner === "codex")?.gaps).toContain(
        "codex has no PreCompact equivalent; flush relies on Stop plus SessionStart",
      );
      expect(result.structuredContent).toMatchObject({
        operation_id: "memory.hook-coverage",
        schema_version: "memory.hook_coverage.v1",
        mode: "graph",
        config_found: true,
        enabled_events: 7,
        read_only: true,
      });

      const viewerResult = (await client.callTool({
        name: "memory_hook_coverage_viewer",
        arguments: {},
      })) as ToolResult;
      const viewer = JSON.parse(viewerResult.content[0]?.text ?? "{}") as {
        contract: { version: string };
        report: { mode: string; summary: { effective_events: number } };
        html: string;
      };
      expect(viewer.contract.version).toBe("memory.hook_coverage.viewer.v1");
      expect(viewer.report.mode).toBe("graph");
      expect(viewer.report.summary.effective_events).toBe(8);
      expect(viewer.html).toContain("Hook Coverage");
      expect(viewerResult.structuredContent).toMatchObject({
        operation_id: "memory.hook-coverage-viewer",
        contract: "memory.hook_coverage.viewer.v1",
        mode: "graph",
        effective_events: 8,
      });
    },
    TIMEOUT,
  );

  test(
    "memory_recall returns ranked nodes + neighborhood context",
    async () => {
      const client = await connect(await seedStore());
      const result = (await client.callTool({
        name: "memory_recall",
        arguments: { query: "rotate 90 days", depth: 1 },
      })) as ToolResult;

      const md = result.content[0]?.text ?? "";
      expect(md).toContain("Memory recall");
      expect(md).toContain("jwt rotation");

      const nodes = result.structuredContent?.nodes as { label: string; score: number }[];
      expect(nodes.length).toBeGreaterThanOrEqual(1);
      expect(nodes[0].label).toBe("jwt-rotation");
      // auth-service surfaces as a one-hop neighbor of the jwt seed.
      expect(nodes.some((n) => n.label === "auth-service")).toBe(true);
      expect(result.structuredContent?.diagnostics).toMatchObject({
        vector: { status: "unavailable" },
      });
    },
    TIMEOUT,
  );

  test(
    "traverse and path return correct results over the seed graph",
    async () => {
      const client = await connect(await seedStore());

      const traverseRes = (await client.callTool({
        name: "memory_traverse",
        arguments: { start: "auth-service", depth: 3, direction: "outgoing" },
      })) as ToolResult;
      const walked = JSON.parse(traverseRes.content[0]?.text ?? "[]") as { label: string }[];
      expect(walked.map((n) => n.label)).toEqual([
        "auth-service",
        "jwt-rotation",
        "cache-ttl",
      ]);

      const pathRes = (await client.callTool({
        name: "memory_path",
        arguments: { from: "auth-service", to: "cache-ttl" },
      })) as ToolResult;
      const path = JSON.parse(pathRes.content[0]?.text ?? "null") as {
        reachable: boolean;
        hopCount: number;
      };
      expect(path.reachable).toBe(true);
      expect(path.hopCount).toBe(2);
    },
    TIMEOUT,
  );

  test(
    "memory_conflicts and memory_timeline expose read-only supersession audit views",
    async () => {
      const client = await connect(await seedConflictStore());

      const conflictsRes = (await client.callTool({
        name: "memory_conflicts",
        arguments: {},
      })) as ToolResult;
      const conflicts = JSON.parse(conflictsRes.content[0]?.text ?? "[]") as Array<{
        from: { label: string };
        to: { label: string };
      }>;
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].from.label).toBe("deploy-friday");
      expect(conflicts[0].to.label).toBe("deploy-tuesday");
      expect(conflictsRes.structuredContent?.count).toBe(1);

      const timelineRes = (await client.callTool({
        name: "memory_timeline",
        arguments: { topic: "deploy" },
      })) as ToolResult;
      const timeline = JSON.parse(timelineRes.content[0]?.text ?? "{}") as {
        entries: Array<{ label: string; status: string }>;
        auditLinks: Array<{ label: string }>;
      };
      expect(timeline.entries.some((entry) => entry.label === "deploy-friday")).toBe(true);
      expect(timeline.auditLinks.some((edge) => edge.label === "CONTRADICTS")).toBe(true);
      expect(timelineRes.structuredContent?.audit_links).toBeGreaterThanOrEqual(1);
    },
    TIMEOUT,
  );

  test(
    "memory_ask reports citations and cost metadata",
    async () => {
      const client = await connect(await seedStore());
      const result = (await client.callTool({
        name: "memory_ask",
        arguments: { question: "how often do jwt tokens rotate?" },
      })) as ToolResult;

      const answer = JSON.parse(result.content[0]?.text ?? "{}") as {
        status: string;
        citations: unknown[];
        evidence: { active: unknown[] };
        gap_analysis: { status: string };
        cost: unknown;
      };
      expect(answer.status).toBe("provider-unavailable");
      expect(Array.isArray(answer.citations)).toBe(true);
      expect(answer.evidence.active.length).toBeGreaterThan(0);
      expect(answer.gap_analysis.status).toBeTruthy();
      expect(answer).toHaveProperty("cost");
      expect(result.structuredContent).toHaveProperty("status");
      expect(result.structuredContent).toHaveProperty("citations");
      expect(result.structuredContent).toHaveProperty("active_evidence");
      expect(result.structuredContent).toHaveProperty("ambiguous_evidence");
      expect(result.structuredContent).toHaveProperty("gap_status");
      expect(result.structuredContent).toHaveProperty("gaps");
      expect(result.structuredContent).toHaveProperty("cost_usd");
    },
    TIMEOUT,
  );

  test(
    "tier-aware verbs drive session / working-memory / promotion",
    async () => {
      const uri = await seedStore();
      const root = await mkdtemp(join(tmpdir(), "memory-mcp-session-"));
      roots.push(root);
      const client = await connect(uri, { MEMORY_ROOT: root });

      // 1. working.get without a session errors with a clear instruction.
      await expect(
        client.callTool({ name: "memory_working_get", arguments: {} }),
      ).rejects.toThrow(/memory_session_start/);

      // 2. session.start mints + writes the id; subsequent reads see it.
      const startRes = (await client.callTool({
        name: "memory_session_start",
        arguments: {},
      })) as ToolResult;
      const startStructured = startRes.structuredContent as { session_id?: string };
      const sessionId = startStructured?.session_id;
      expect(typeof sessionId).toBe("string");
      expect(sessionId).toMatch(/[0-9a-f-]{36}/);

      // 3. working.set appends an event and working.get returns it.
      const appendRes = (await client.callTool({
        name: "memory_working_set",
        arguments: {
          type: "decision_candidate",
          value: "use postgres advisory locks for the rotation worker",
        },
      })) as ToolResult;
      expect(appendRes.structuredContent).toMatchObject({
        session_id: sessionId,
        sequence: 1,
        type: "decision_candidate",
      });

      const getRes = (await client.callTool({
        name: "memory_working_get",
        arguments: {},
      })) as ToolResult;
      const got = JSON.parse(getRes.content[0]?.text ?? "{}") as {
        events: Array<{ type: string; value: string; sequence: number }>;
      };
      expect(got.events).toHaveLength(1);
      expect(got.events[0].type).toBe("decision_candidate");
      expect(got.events[0].sequence).toBe(1);
      expect(getRes.structuredContent?.count).toBe(1);

      // 4. promote runs the engine: the decision_candidate becomes an L3 node.
      const promoteRes = (await client.callTool({
        name: "memory_promote",
        arguments: {},
      })) as ToolResult;
      const report = JSON.parse(promoteRes.content[0]?.text ?? "{}") as {
        session_id: string;
        promoted: number;
        reinforced: number;
        skipped: number;
        promoted_rids: number[];
      };
      expect(report.session_id).toBe(sessionId);
      expect(report.promoted).toBe(1);
      expect(report.promoted_rids).toHaveLength(1);
      expect(promoteRes.structuredContent).toMatchObject({
        session_id: sessionId,
        promoted: 1,
      });

      // 5. session.end drops the file; tier-aware reads error again.
      const endRes = (await client.callTool({
        name: "memory_session_end",
        arguments: {},
      })) as ToolResult;
      expect(endRes.structuredContent).toMatchObject({ ok: true });

      await expect(
        client.callTool({ name: "memory_working_set", arguments: { type: "x", value: "y" } }),
      ).rejects.toThrow(/memory_session_start/);

      // 6. The read-only surface still works after the lifecycle dance.
      const statsRes = (await client.callTool({
        name: "memory_stats",
        arguments: {},
      })) as ToolResult;
      expect(statsRes.structuredContent).toHaveProperty("nodes");
    },
    TIMEOUT,
  );
});
