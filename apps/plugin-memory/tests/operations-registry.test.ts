import { describe, expect, test } from "vitest";
import { z } from "zod";
import {
  createReadOnlyMemoryOperationRegistry,
  executeReadOnlyMemoryOperation,
  getReadOnlyMemoryOperation,
  listReadOnlyMemoryOperations,
  type MemoryOperationFacets,
  type MemoryOperationDefinition,
  type MemoryOperation,
} from "../src/operations.js";

const TEST_JSON_FACETS: MemoryOperationFacets = {
  inputBinding: { fields: [] },
  outputKind: { kind: "report", format: "json" },
};

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
      inputBinding: {
        fields: [
          {
            field: "cache",
            sources: ["flag", "query"],
            type: "string",
          },
        ],
      },
      outputKind: { kind: "report", format: "json" },
    });
    expect(listReadOnlyMemoryOperations().map((op) => op.id)).toContain("memory.communities");
  });

  test("declares contract metadata for the hub report operation", () => {
    const operation = getReadOnlyMemoryOperation("memory.hub-report");

    expect(operation).toMatchObject({
      id: "memory.hub-report",
      safetyClass: "read-only",
      sideEffectClass: "none",
      capabilities: ["graph-store"],
      renderer: {
        cli: { command: "hub-report", supportsJson: true },
        mcp: { toolName: "memory_hub_report" },
      },
      inputBinding: {
        fields: [
          {
            field: "limit",
            sources: ["flag", "query"],
            type: "number",
          },
          {
            field: "rank_by",
            sources: ["flag", "query"],
            type: "string",
          },
        ],
      },
      outputKind: { kind: "report", format: "json" },
    });
  });

  test("declares contract metadata for the suggested questions operation", () => {
    const operation = getReadOnlyMemoryOperation("memory.suggested-questions");

    expect(operation).toMatchObject({
      id: "memory.suggested-questions",
      safetyClass: "read-only",
      sideEffectClass: "none",
      capabilities: ["graph-store"],
      renderer: {
        cli: { command: "suggested-questions", supportsJson: true },
        mcp: { toolName: "memory_suggested_questions" },
      },
      inputBinding: {
        fields: [
          {
            field: "limit",
            sources: ["flag", "query"],
            type: "number",
          },
        ],
      },
      outputKind: { kind: "report", format: "json" },
    });
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
        "memory.community-digest",
        "memory.references-radar",
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
        "memory.global-search",
        "memory.health",
        "memory.health-viewer",
        "memory.handoff",
        "memory.handoff-viewer",
        "memory.work-frontier",
        "memory.work-frontier-viewer",
        "memory.hook-coverage",
        "memory.hook-coverage-viewer",
        "memory.hub-report",
        "memory.learning-debt",
        "memory.learning-debt-viewer",
        "memory.layers",
        "memory.layers-viewer",
        "memory.lint",
        "memory.map-context",
        "memory.map-contract",
        "memory.map-freshness",
        "memory.merge-pass",
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
        "memory.recall-ranking",
        "memory.whatif",
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
        "memory.suggested-questions",
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
        "memory_extraction_status",
        "memory_extraction_status_viewer",
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
        "memory_hub_report",
        "memory_learning_debt",
        "memory_learning_debt_viewer",
        "memory_layers",
        "memory_layers_viewer",
        "memory_lint",
        "memory_map_context",
        "memory_map_contract",
        "memory_map_freshness",
        "memory_merge_pass",
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
        "memory_recall_ranked",
        "memory_whatif",
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
        "memory_suggested_questions",
        "memory_vector_search",
        "memory_vector_status",
        "memory_vector_status_viewer",
        "memory_workbench",
      ].sort(),
    );
    expect(operations.every((op) => op.safetyClass === "read-only")).toBe(true);
    expect(operations.map((op) => op.sideEffectClass)).not.toContain("writes-memory");
    expect(operations.map((op) => op.id)).not.toContain("memory.store");
    expect(operations.map((op) => op.id)).not.toContain("memory.store-evidence");
    expect(operations.map((op) => op.id)).not.toContain("memory.supersede");

    expect(getReadOnlyMemoryOperation("memory.readiness").outputSchema.parse).toBeTypeOf(
      "function",
    );
    expect(getReadOnlyMemoryOperation("memory.ask").outputSchema.parse).toBeTypeOf("function");
  });

  test("declares input bindings and output kinds for every registry entry", () => {
    const operations = listReadOnlyMemoryOperations();

    expect(
      operations.every((operation) => Array.isArray(operation.inputBinding.fields)),
    ).toBe(true);
    expect(operations.every((operation) => operation.outputKind.kind.length > 0)).toBe(true);

    expect(getReadOnlyMemoryOperation("memory.ask").inputBinding).toMatchObject({
      fields: [
        {
          field: "question",
          sources: ["positional", "query"],
          type: "string",
          variadic: true,
        },
      ],
      customBind: {
        id: "joined-positional-question",
      },
    });
    expect(getReadOnlyMemoryOperation("memory.dashboard").outputKind).toMatchObject({
      kind: "viewer",
      artifact: "self-contained-html",
      fileSink: { field: "out", sources: ["flag", "query"], type: "path" },
    });
    expect(getReadOnlyMemoryOperation("memory.map-context")).toMatchObject({
      renderer: {
        cli: { command: "map-context", supportsJson: true },
        mcp: { toolName: "memory_map_context" },
      },
      inputBinding: {
        fields: expect.arrayContaining([
          expect.objectContaining({ field: "query", variadic: true }),
          expect.objectContaining({ field: "context", sources: ["flag", "query"] }),
        ]),
      },
      outputKind: { kind: "report", format: "json" },
    });
    expect(
      getReadOnlyMemoryOperation("memory.smart-search-viewer").outputKind,
    ).toMatchObject({
      kind: "viewer",
      fileSink: {
        customBind: {
          id: "hashed-viewer-output-path",
        },
      },
    });
    expect(getReadOnlyMemoryOperation("memory.communities").inputBinding.customBind).toBeUndefined();
  });

  test("owns transport visibility and help in each operation registration", () => {
    const operations = listReadOnlyMemoryOperations();

    expect(
      operations.every(
        (operation) =>
          operation.description.trim().length > 0 &&
          operation.transports.length > 0 &&
          operation.transports.every((transport) => ["cli", "mcp", "http"].includes(transport)),
      ),
    ).toBe(true);
    expect(getReadOnlyMemoryOperation("memory.map-contract").transports).toEqual([
      "cli",
      "mcp",
      "http",
    ]);
    expect(getReadOnlyMemoryOperation("memory.workbench").transports).toEqual(["cli", "mcp"]);
  });

  test("does not preserve a legacy CLI dispatch escape hatch", () => {
    expect(
      listReadOnlyMemoryOperations().filter(
        (operation) => "dispatch" in operation.renderer.cli,
      ),
    ).toEqual([]);
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
      transports: ["cli", "mcp"],
      renderer: {
        cli: { command: "store", supportsJson: false },
        mcp: { toolName: "memory_store", description: "Store memory" },
      },
      inputBinding: { fields: [] },
      outputKind: { kind: "report", format: "json" },
      execute: async () => ({}),
    } satisfies MemoryOperation<object, object>;

    expect(() => createReadOnlyMemoryOperationRegistry([mutating], { [mutating.id]: TEST_JSON_FACETS })).toThrow(
      /not read-only/i,
    );
  });

  test("rejects malformed operation facets at registration time", () => {
    const operation = {
      id: "memory.test",
      title: "Test operation",
      description: "Test operation.",
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      safetyClass: "read-only",
      sideEffectClass: "none",
      capabilities: ["graph-store"],
      renderer: {
        cli: { command: "test", supportsJson: true },
        mcp: { toolName: "memory_test", description: "Test operation" },
      },
      execute: async () => ({}),
    } satisfies MemoryOperationDefinition<object, object>;

    expect(() =>
      createReadOnlyMemoryOperationRegistry([operation], {
        [operation.id]: {
          inputBinding: {
            fields: [{ field: "", sources: ["flag"], type: "string" }],
          },
          outputKind: { kind: "report", format: "json" },
        } as MemoryOperationFacets,
      }),
    ).toThrow(/input binding/i);

    expect(() =>
      createReadOnlyMemoryOperationRegistry([operation], {
        [operation.id]: {
          inputBinding: { fields: [] },
          outputKind: { kind: "report", format: "xml" },
        } as unknown as MemoryOperationFacets,
      }),
    ).toThrow(/output kind|report/i);
  });
});
