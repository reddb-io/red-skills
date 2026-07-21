import { afterEach, describe, expect, test } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { decode } from "@reddb-io/toon";
import { GRAPH_CONTRACT_VERSION } from "../src/graph-contract.js";
import {
  getReadOnlyMemoryOperation,
  listReadOnlyMemoryOperations,
} from "../src/operations.js";
import {
  cleanupMcpServerTest,
  connect,
  seedStore,
  seedWritableStore,
  TIMEOUT,
  toolText,
  type ToolResult,
} from "./mcp-server-test-helpers.js";

afterEach(cleanupMcpServerTest);

describe("MCP server over stdio", () => {
  test(
    "MCP tool text bodies use shared TOON serialization",
    async () => {
      const client = await connect(await seedStore());

      const statsRes = (await client.callTool({
        name: "memory_stats",
        arguments: {},
      })) as ToolResult;
      expect(toolText(statsRes)).toBe(["nodes: 3", "edges: 2"].join("\n"));
      expect(decode(toolText(statsRes))).toEqual({ nodes: 3, edges: 2 });

      const neighborsRes = (await client.callTool({
        name: "memory_neighbors",
        arguments: { label: "jwt-rotation", depth: 1, direction: "both" },
      })) as ToolResult;
      expect(toolText(neighborsRes)).toMatch(
        /^rows\[3\]\{rid,label,node_type,score,depth,excerpt\}:\n  \d+,jwt-rotation,concept,1,0,jwt tokens rotate every 90 days\n  \d+,auth-service,concept,0\.5,1,the auth service issues jwt tokens\n  \d+,cache-ttl,concept,0\.5,1,redis cache ttl is 300 seconds$/,
      );
      expect(decode(toolText(neighborsRes))).toMatchObject({
        rows: [
          { label: "jwt-rotation" },
          { label: "auth-service" },
          { label: "cache-ttl" },
        ],
      });

      const recallRes = (await client.callTool({
        name: "memory_recall",
        arguments: { query: "jwt rotation", k: 2, depth: 1 },
      })) as ToolResult;
      expect(toolText(recallRes)).toContain("nodes[3]{rid,label,node_type,score,depth,excerpt}:");
      expect(toolText(recallRes)).toContain("diagnostics:");
      expect(toolText(recallRes)).toContain("summary:");
      expect(decode(toolText(recallRes))).toMatchObject({
        nodes: [
          { label: "jwt-rotation" },
          { label: "cache-ttl" },
          { label: "auth-service" },
        ],
        summary: { query: "jwt rotation", nodes: 3, format: "toon" },
      });

      const readinessRes = (await client.callTool({
        name: "memory_readiness",
        arguments: { goal: "jwt rotation", min_evidence: 1 },
      })) as ToolResult;
      expect(() => decode(toolText(readinessRes))).not.toThrow();
      expect(toolText(readinessRes)).not.toContain("{\n");
      expect(toolText(readinessRes)).not.toContain('":');
    },
    TIMEOUT,
  );


  test(
    "MCP tool errors return structured TOON with a next step",
    async () => {
      const client = await connect(await seedStore());

      const res = (await client.callTool({
        name: "memory_neighbors",
        arguments: { label: "" },
      })) as ToolResult;

      expect(res.isError).toBe(true);
      expect(toolText(res)).toBe(
        [
          "error:",
          "  tool: memory_neighbors",
          '  message: "[ { \\"code\\": \\"too_small\\", \\"minimum\\": 1, \\"type\\": \\"string\\", \\"inclusive\\": true, \\"exact\\": false, \\"message\\": \\"String must contain at least 1 character(s)\\", \\"path\\": [ \\"label\\" ] } ]"',
          "  next: check the tool arguments and retry with values matching the input schema",
        ].join("\n"),
      );
      expect(decode(toolText(res))).toMatchObject({
        error: {
          tool: "memory_neighbors",
          next: "check the tool arguments and retry with values matching the input schema",
        },
      });
    },
    TIMEOUT,
  );


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
          "memory_global_search",
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
          "memory_map_context",
          "memory_map_contract",
          "memory_map_freshness",
          "memory_merge_pass",
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
          "memory_recall_ranked",
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
          "memory_store_evidence",
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
        getReadOnlyMemoryOperation("memory.communities").description,
      );
      for (const operation of listReadOnlyMemoryOperations()) {
        const tool = tools.find((item) => item.name === operation.renderer.mcp.toolName);
        expect(tool?.description).toBe(operation.description);
        expect(tool?.inputSchema).toEqual(expect.objectContaining({ type: "object" }));
      }
      const storeTool = tools.find((tool) => tool.name === "memory_store");
      const storeEvidenceTool = tools.find((tool) => tool.name === "memory_store_evidence");
      const supersedeTool = tools.find((tool) => tool.name === "memory_supersede");
      expect(storeTool?.description?.toLowerCase()).toContain("mutating");
      expect(storeEvidenceTool?.description?.toLowerCase()).toContain("mutating");
      expect(storeEvidenceTool?.description?.toLowerCase()).toContain("governed");
      expect(storeEvidenceTool?.description?.toLowerCase()).toContain("stored");
      expect(storeEvidenceTool?.description?.toLowerCase()).toContain("proposed");
      expect(storeEvidenceTool?.description?.toLowerCase()).toContain("rejected");
      expect(supersedeTool?.description?.toLowerCase()).toContain("mutating");
    },
    TIMEOUT,
  );


  test(
    "memory_store_evidence returns stored, proposed, and rejected governed-write outcomes",
    async () => {
      const { uri, root } = await seedWritableStore();
      const client = await connect(uri, { MEMORY_ROOT: root });

      const storedRes = (await client.callTool({
        name: "memory_store_evidence",
        arguments: {
          claim: "MCP governed evidence stores low-risk validation facts.",
          source_ref: "tests/mcp-server.test.ts",
          citation_excerpt: "stores low-risk validation facts",
          intent: "validation",
          observer: "mcp-test",
        },
      })) as ToolResult;
      const stored = decode(storedRes.content[0]?.text ?? "{}") as {
        outcome: string;
        memory: { id: number; urn: string };
        provenance: { source_ref: string; citation_excerpt: string; evidence: string[] };
      };
      expect(stored).toMatchObject({
        outcome: "stored",
        provenance: {
          source_ref: "tests/mcp-server.test.ts",
          citation_excerpt: "stores low-risk validation facts",
          evidence: ["tests/mcp-server.test.ts", "stores low-risk validation facts"],
        },
      });
      expect(stored.memory.urn).toBe(`memory_nodes:${stored.memory.id}`);
      expect(storedRes.structuredContent).toMatchObject({
        outcome: "stored",
        artifact_id: stored.memory.urn,
        artifact_path: null,
        policy_reason: "low_risk_validation_evidence_stored",
        provenance: {
          source_ref: "tests/mcp-server.test.ts",
          citation_excerpt: "stores low-risk validation facts",
        },
      });

      const proposedRes = (await client.callTool({
        name: "memory_store_evidence",
        arguments: {
          claim: "Always remember this human-facing deployment preference.",
          source_ref: "agent transcript:9",
          citation_excerpt: "The instruction-like claim should route through review.",
          intent: "instruction capture",
          observer: "mcp-test",
          blast_radius: "medium",
        },
      })) as ToolResult;
      const proposed = decode(proposedRes.content[0]?.text ?? "{}") as {
        outcome: string;
        memory: { id: null; urn: null };
        review_artifact: { id: string; path: string };
      };
      expect(proposed).toMatchObject({
        outcome: "proposed",
        memory: { id: null, urn: null },
        review_artifact: {
          id: expect.stringMatching(/^evidence-[a-f0-9]{12}$/),
          path: expect.stringMatching(/^\.red\/memory\/inbox\/evidence\/evidence-[a-f0-9]{12}\.yaml$/),
        },
      });
      expect(proposedRes.structuredContent).toMatchObject({
        outcome: "proposed",
        artifact_id: proposed.review_artifact.id,
        artifact_path: proposed.review_artifact.path,
        policy_reason: "risk_requires_evidence_review:medium_blast_radius",
      });
      await expect(readFile(join(root, proposed.review_artifact.path), "utf8")).resolves.toContain(
        proposed.review_artifact.id,
      );

      const rejectedRes = (await client.callTool({
        name: "memory_store_evidence",
        arguments: {
          claim: "Missing provenance must return a governed rejection.",
          intent: "validation",
          observer: "mcp-test",
        },
      })) as ToolResult;
      const rejected = decode(rejectedRes.content[0]?.text ?? "{}") as {
        outcome: string;
        reason: string;
        memory: { id: null; urn: null };
        review_artifact: null;
      };
      expect(rejected).toMatchObject({
        outcome: "rejected",
        reason: "missing_required_fields:sourceRef,citationExcerpt",
        memory: { id: null, urn: null },
        review_artifact: null,
      });
      expect(rejectedRes.structuredContent).toMatchObject({
        outcome: "rejected",
        artifact_id: null,
        artifact_path: null,
        policy_reason: "missing_required_fields:sourceRef,citationExcerpt",
        provenance: {
          source_ref: null,
          citation_excerpt: null,
          evidence: [],
        },
      });
    },
    TIMEOUT,
  );


  test(
    "memory_export returns the graph contract inline without writing a bundle",
    async () => {
      const client = await connect(await seedStore());
      const res = (await client.callTool({
        name: "memory_export",
        arguments: {},
      })) as ToolResult;
      const body = decode(res.content[0]?.text ?? "{}") as {
        contract: {
          version: string;
          nodes: Array<{ id: number; confidence: string | null; source_location: string | null }>;
          edges: Array<{ id: number; weight: number; salience: number | null; kind: string }>;
        };
      };

      expect(body.contract.version).toBe(GRAPH_CONTRACT_VERSION);
      expect(body.contract.nodes.length).toBeGreaterThan(0);
      expect(body.contract.edges.length).toBeGreaterThan(0);
      expect(body.contract.nodes[0]).toHaveProperty("confidence");
      expect(body.contract.nodes[0]).toHaveProperty("source_location");
      expect(body.contract.nodes[0]).toHaveProperty("freshness");
      expect(body.contract.nodes[0]).toHaveProperty("provenance");
      expect(body.contract.edges[0]).toMatchObject({
        weight: expect.any(Number),
        freshness: expect.any(Object),
      });
      expect(body.contract.edges[0]).toHaveProperty("salience");
    },
    TIMEOUT,
  );

});
