import { describe, expect, test } from "vitest";
import { z } from "zod";
import {
  createReadOnlyMemoryOperationRegistry,
  executeReadOnlyMemoryOperation,
  getReadOnlyMemoryOperation,
  listReadOnlyMemoryOperations,
  type MemoryOperation,
} from "../src/operations.js";

describe("read-only Memory operations registry", () => {
  test("declares contract metadata for the communities operation", () => {
    const operation = getReadOnlyMemoryOperation("memory.communities");

    expect(operation).toMatchObject({
      id: "memory.communities",
      safetyClass: "read-only",
      sideEffectClass: "cache-write",
      capabilities: ["graph-store"],
      renderer: {
        cli: { command: "communities", supportsJson: true },
        mcp: { toolName: "memory_communities" },
      },
    });
    expect(listReadOnlyMemoryOperations().map((op) => op.id)).toContain("memory.communities");
  });

  test("declares read-only contracts for agent-native readiness and trust operations", () => {
    const operations = listReadOnlyMemoryOperations();

    expect(operations.map((op) => op.id).sort()).toEqual(
      [
        "memory.ask",
        "memory.asset-inventory",
        "memory.asset-inventory-viewer",
        "memory.agent-integration-status",
        "memory.agent-integration-status-viewer",
        "memory.capability-catalog",
        "memory.claim-check",
        "memory.communities",
        "memory.communities-viewer",
        "memory.competitive-eval",
        "memory.competitive-eval-viewer",
        "memory.competitive-radar",
        "memory.confidence",
        "memory.context-pack",
        "memory.context-pack-viewer",
        "memory.dashboard",
        "memory.decay",
        "memory.decay-viewer",
        "memory.doc-brief",
        "memory.doc-brief-viewer",
        "memory.doc-bundle",
        "memory.doc-bundle-viewer",
        "memory.doc-coverage",
        "memory.doc-coverage-viewer",
        "memory.doc-backlinks",
        "memory.doc-backlinks-viewer",
        "memory.doc-evidence-pack",
        "memory.doc-evidence-pack-viewer",
        "memory.doc-reference-graph",
        "memory.doc-reference-graph-viewer",
        "memory.doc-read",
        "memory.doc-related",
        "memory.doc-related-viewer",
        "memory.doc-search",
        "memory.doc-search-viewer",
        "memory.extraction-status",
        "memory.extraction-status-viewer",
        "memory.governance",
        "memory.governance-viewer",
        "memory.health",
        "memory.health-viewer",
        "memory.handoff",
        "memory.handoff-viewer",
        "memory.work-frontier",
        "memory.work-frontier-viewer",
        "memory.hook-coverage",
        "memory.hook-coverage-viewer",
        "memory.learning-debt",
        "memory.learning-debt-viewer",
        "memory.layers",
        "memory.layers-viewer",
        "memory.lint",
        "memory.onboarding-map",
        "memory.onboarding-map-viewer",
        "memory.path-explain",
        "memory.path-explain-viewer",
        "memory.pre-pr-review",
        "memory.pre-pr-review-viewer",
        "memory.privacy-scan",
        "memory.provenance",
        "memory.federation",
        "memory.reasoning-replay",
        "memory.readiness",
        "memory.readiness-viewer",
        "memory.routing-guide",
        "memory.routing-guide-viewer",
        "memory.session-timeline",
        "memory.session-timeline-viewer",
        "memory.skill-recommendations",
        "memory.smart-search",
        "memory.smart-search-viewer",
        "memory.structural-impact",
        "memory.structural-impact-viewer",
        "memory.vector-search",
        "memory.vector-status",
        "memory.vector-status-viewer",
        "memory.workbench",
      ].sort(),
    );
    expect(operations.map((op) => op.renderer.mcp.toolName).sort()).toEqual(
      [
        "memory_ask",
        "memory_asset_inventory",
        "memory_asset_inventory_viewer",
        "memory_agent_integration_status",
        "memory_agent_integration_status_viewer",
        "memory_capability_catalog",
        "memory_claim_check",
        "memory_communities",
        "memory_communities_viewer",
        "memory_competitive_eval",
        "memory_competitive_eval_viewer",
        "memory_competitive_radar",
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
        "memory_extraction_status",
        "memory_extraction_status_viewer",
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
        "memory_onboarding_map",
        "memory_onboarding_map_viewer",
        "memory_path_explain",
        "memory_path_explain_viewer",
        "memory_pre_pr_review",
        "memory_pre_pr_review_viewer",
        "memory_privacy_scan",
        "memory_provenance",
        "memory_federate",
        "memory_reasoning_replay",
        "memory_readiness",
        "memory_readiness_viewer",
        "memory_routing_guide",
        "memory_routing_guide_viewer",
        "memory_session_timeline",
        "memory_session_timeline_viewer",
        "memory_skill_recommendations",
        "memory_smart_search",
        "memory_smart_search_viewer",
        "memory_structural_impact",
        "memory_structural_impact_viewer",
        "memory_vector_search",
        "memory_vector_status",
        "memory_vector_status_viewer",
        "memory_workbench",
      ].sort(),
    );
    expect(operations.every((op) => op.safetyClass === "read-only")).toBe(true);
    expect(operations.map((op) => op.sideEffectClass)).not.toContain("writes-memory");
    expect(operations.map((op) => op.id)).not.toContain("memory.store");
    expect(operations.map((op) => op.id)).not.toContain("memory.supersede");

    expect(getReadOnlyMemoryOperation("memory.readiness").outputSchema.parse).toBeTypeOf(
      "function",
    );
    expect(getReadOnlyMemoryOperation("memory.ask").outputSchema.parse).toBeTypeOf("function");
  });

  test("validates operation input before execution", async () => {
    await expect(
      executeReadOnlyMemoryOperation(
        "memory.communities",
        { store: {} as never },
        { cache: "writes-memory" },
      ),
    ).rejects.toThrow();
  });

  test("rejects mutating operations from the read-only registry path", () => {
    const mutating = {
      id: "memory.store",
      title: "Store memory",
      description: "Persists a memory fact.",
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      safetyClass: "mutating",
      sideEffectClass: "writes-memory",
      capabilities: ["graph-store"],
      renderer: {
        cli: { command: "store", supportsJson: false },
        mcp: { toolName: "memory_store", description: "Store memory" },
      },
      execute: async () => ({}),
    } satisfies MemoryOperation<object, object>;

    expect(() => createReadOnlyMemoryOperationRegistry([mutating])).toThrow(
      /not read-only/i,
    );
  });
});
