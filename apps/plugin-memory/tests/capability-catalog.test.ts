import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { buildMemoryCapabilityCatalog } from "../src/capability-catalog.js";
import { MemoryStore } from "../src/graph-store.js";
import { indexFile } from "../src/ingest.js";
import { initGraph } from "../src/init.js";

const TIMEOUT = 40_000;
const pkgRoot = resolve(__dirname, "..");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "memory-capability-catalog-"));
  roots.push(root);
  return root;
}

async function seedDoc(root: string): Promise<string> {
  const doc = join(root, "docs", "security.md");
  await mkdir(join(root, "docs"), { recursive: true });
  await writeFile(
    doc,
    "# Security\n\nJWT rotation references `JWT_SECRET` and signed fixtures.\n",
    "utf8",
  );
  return doc;
}

function runMemory(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: pkgRoot,
    encoding: "utf8",
    timeout: TIMEOUT,
  });
}

describe("Memory capability catalog", () => {
  test("groups read-only Memory surfaces by competitive capability", async () => {
    const root = await tempRoot();
    await initGraph(root, { hooks: true, skillTelemetry: true });
    const doc = await seedDoc(root);
    const store = await MemoryStore.open({ uri: `file://${join(root, ".red/memory/graph.rdb")}` });
    try {
      await indexFile(store, doc);

      const catalog = await buildMemoryCapabilityCatalog(store, root, {
        now: 1_700_000_000_000,
      });

      expect(catalog).toMatchObject({
        schema_version: "memory.capability_catalog.v1",
        read_only: true,
        runtime: {
          docs: { total: 1, grounded: 1, with_references: 1 },
          hooks: {
            mode: "graph",
            enabled_events: 7,
            wired_events: 7,
            effective_events: 8,
            total_events: 8,
            actionable_gaps: 0,
          },
          extraction: {
            inferred_available: false,
            inferred_facts: 0,
          },
        },
      });
      expect(catalog.summary.total).toBe(catalog.capabilities.length);
      expect(catalog.summary.red_db_backed).toBeGreaterThanOrEqual(8);
      expect(catalog.summary.not_configured).toBeGreaterThanOrEqual(1);
      expect(catalog.categories.map((category) => category.id)).toEqual([
        "retrieval",
        "docs",
        "extraction",
        "vectors",
        "ui",
        "hooks",
        "code-graph",
        "governance",
        "telemetry",
        "interop",
        "intelligence",
      ]);
      expect(catalog.capabilities.map((item) => item.id)).toEqual(
        expect.arrayContaining([
          "governed-hybrid-recall",
          "corpus-knowledge-graph",
          "documents",
          "extraction-status",
          "vectors",
          "local-ui",
          "lifecycle-hooks",
          "code-graph-impact",
          "trust-governance",
          "skill-telemetry",
          "multi-agent-integration",
          "layered-memory-architecture",
          "reference-interop",
        ]),
      );
      expect(catalog.capabilities.find((item) => item.id === "local-ui")?.mcp).toContain(
        "memory_workbench",
      );
      expect(catalog.capabilities.find((item) => item.id === "local-ui")?.mcp).toContain(
        "memory_dashboard",
      );
      expect(catalog.capabilities.find((item) => item.id === "local-ui")?.cli).toContain(
        "memory serve",
      );
      expect(catalog.capabilities.find((item) => item.id === "local-ui")?.cli).toContain(
        "memory export --interop",
      );
      expect(catalog.capabilities.find((item) => item.id === "governed-hybrid-recall")?.cli).toContain(
        "memory smart-search <query>",
      );
      expect(catalog.capabilities.find((item) => item.id === "governed-hybrid-recall")?.cli).toContain(
        "memory context-pack-viewer <goal>",
      );
      expect(catalog.capabilities.find((item) => item.id === "governed-hybrid-recall")?.mcp).toContain(
        "memory_context_pack_viewer",
      );
      expect(catalog.capabilities.find((item) => item.id === "corpus-knowledge-graph")).toMatchObject({
        title: "Corpus to knowledge graph",
        category: "intelligence",
        red_db_backed: true,
      });
      expect(catalog.capabilities.find((item) => item.id === "corpus-knowledge-graph")?.cli).toEqual(
        expect.arrayContaining([
          "memory ingest <path>",
          "memory docs reference-graph",
          "memory communities",
          "memory dashboard",
          "memory capabilities",
          "memory export [<out-dir>]",
        ]),
      );
      expect(catalog.capabilities.find((item) => item.id === "corpus-knowledge-graph")?.mcp).toEqual(
        expect.arrayContaining([
          "memory_asset_inventory",
          "memory_doc_reference_graph",
          "memory_communities",
          "memory_dashboard",
          "memory_capability_catalog",
          "memory_export",
        ]),
      );
      expect(catalog.capabilities.find((item) => item.id === "documents")?.cli).toContain(
        "memory docs search-viewer <query>",
      );
      expect(catalog.capabilities.find((item) => item.id === "documents")?.mcp).toContain(
        "memory_doc_search_viewer",
      );
      expect(catalog.capabilities.find((item) => item.id === "documents")?.cli).toContain(
        "memory docs brief <query>",
      );
      expect(catalog.capabilities.find((item) => item.id === "documents")?.cli).toContain(
        "memory docs brief-viewer <query>",
      );
      expect(catalog.capabilities.find((item) => item.id === "documents")?.mcp).toContain(
        "memory_doc_brief",
      );
      expect(catalog.capabilities.find((item) => item.id === "documents")?.mcp).toContain(
        "memory_doc_brief_viewer",
      );
      expect(catalog.capabilities.find((item) => item.id === "documents")?.cli).toContain(
        "memory docs restore [path|rid] --yes",
      );
      expect(catalog.capabilities.find((item) => item.id === "documents")?.cli).toContain(
        "memory docs related-viewer <path|rid>",
      );
      expect(catalog.capabilities.find((item) => item.id === "documents")?.cli).toContain(
        "memory docs bundle-viewer <query>",
      );
      expect(catalog.capabilities.find((item) => item.id === "documents")?.cli).toContain(
        "memory docs evidence-pack-viewer <path|rid>",
      );
      expect(catalog.capabilities.find((item) => item.id === "documents")?.mcp).toContain(
        "memory_doc_evidence_pack_viewer",
      );
      expect(catalog.capabilities.find((item) => item.id === "documents")?.cli).toContain(
        "memory assets",
      );
      expect(catalog.capabilities.find((item) => item.id === "documents")?.mcp).toContain(
        "memory_asset_inventory",
      );
      expect(catalog.capabilities.find((item) => item.id === "documents")?.notes).toContain(
        "Ingest also inventories PDFs, images, audio/video, and Office files as RedDB file metadata nodes without claiming OCR or multimodal extraction.",
      );
      expect(catalog.capabilities.find((item) => item.id === "vectors")?.cli).toContain(
        "memory vector status-viewer",
      );
      expect(catalog.capabilities.find((item) => item.id === "vectors")?.mcp).toContain(
        "memory_vector_status_viewer",
      );
      expect(catalog.capabilities.find((item) => item.id === "local-ui")?.cli).toContain(
        "memory docs search-viewer <query>",
      );
      expect(catalog.capabilities.find((item) => item.id === "local-ui")?.cli).toContain(
        "memory docs related-viewer <path|rid>",
      );
      expect(catalog.capabilities.find((item) => item.id === "local-ui")?.cli).toContain(
        "memory docs backlinks-viewer <label|rid>",
      );
      expect(catalog.capabilities.find((item) => item.id === "local-ui")?.cli).toContain(
        "memory docs brief-viewer <query>",
      );
      expect(catalog.capabilities.find((item) => item.id === "local-ui")?.cli).toContain(
        "memory docs evidence-pack-viewer <path|rid>",
      );
      expect(catalog.capabilities.find((item) => item.id === "local-ui")?.cli).toContain(
        "memory assets-viewer",
      );
      expect(catalog.capabilities.find((item) => item.id === "local-ui")?.cli).toContain(
        "memory vector status-viewer",
      );
      expect(catalog.capabilities.find((item) => item.id === "local-ui")?.cli).toContain(
        "memory communities-viewer",
      );
      expect(catalog.capabilities.find((item) => item.id === "local-ui")?.cli).toContain(
        "memory onboarding-map-viewer",
      );
      expect(catalog.capabilities.find((item) => item.id === "local-ui")?.cli).toContain(
        "memory layers-viewer",
      );
      expect(catalog.capabilities.find((item) => item.id === "local-ui")?.cli).toContain(
        "memory learning-debt-viewer",
      );
      expect(catalog.capabilities.find((item) => item.id === "local-ui")?.cli).toContain(
        "memory health-viewer",
      );
      expect(catalog.capabilities.find((item) => item.id === "local-ui")?.cli).toContain(
        "memory governance-viewer",
      );
      expect(catalog.capabilities.find((item) => item.id === "local-ui")?.cli).toContain(
        "memory decay-viewer",
      );
      expect(catalog.capabilities.find((item) => item.id === "local-ui")?.cli).toContain(
        "memory context-pack-viewer <goal>",
      );
      expect(catalog.capabilities.find((item) => item.id === "local-ui")?.cli).toContain(
        "memory frontier-viewer [focus]",
      );
      expect(catalog.capabilities.find((item) => item.id === "local-ui")?.cli).toContain(
        "memory handoff-viewer [focus]",
      );
      expect(catalog.capabilities.find((item) => item.id === "local-ui")?.cli).toContain(
        "memory routing-guide-viewer --agent codex",
      );
      expect(catalog.capabilities.find((item) => item.id === "local-ui")?.cli).toContain(
        "memory integration-status-viewer",
      );
      expect(catalog.capabilities.find((item) => item.id === "local-ui")?.mcp).toContain(
        "memory_doc_bundle_viewer",
      );
      expect(catalog.capabilities.find((item) => item.id === "local-ui")?.mcp).toContain(
        "memory_asset_inventory_viewer",
      );
      expect(catalog.capabilities.find((item) => item.id === "local-ui")?.mcp).toContain(
        "memory_vector_status_viewer",
      );
      expect(catalog.capabilities.find((item) => item.id === "local-ui")?.mcp).toContain(
        "memory_communities_viewer",
      );
      expect(catalog.capabilities.find((item) => item.id === "local-ui")?.mcp).toContain(
        "memory_onboarding_map_viewer",
      );
      expect(catalog.capabilities.find((item) => item.id === "local-ui")?.mcp).toContain(
        "memory_layers_viewer",
      );
      expect(catalog.capabilities.find((item) => item.id === "local-ui")?.mcp).toContain(
        "memory_learning_debt_viewer",
      );
      expect(catalog.capabilities.find((item) => item.id === "local-ui")?.mcp).toContain(
        "memory_health_viewer",
      );
      expect(catalog.capabilities.find((item) => item.id === "local-ui")?.mcp).toContain(
        "memory_governance_viewer",
      );
      expect(catalog.capabilities.find((item) => item.id === "local-ui")?.mcp).toContain(
        "memory_decay_viewer",
      );
      expect(catalog.capabilities.find((item) => item.id === "local-ui")?.mcp).toContain(
        "memory_context_pack_viewer",
      );
      expect(catalog.capabilities.find((item) => item.id === "local-ui")?.mcp).toContain(
        "memory_work_frontier_viewer",
      );
      expect(catalog.capabilities.find((item) => item.id === "local-ui")?.mcp).toContain(
        "memory_handoff_viewer",
      );
      expect(catalog.capabilities.find((item) => item.id === "local-ui")?.mcp).toContain(
        "memory_routing_guide_viewer",
      );
      expect(catalog.capabilities.find((item) => item.id === "local-ui")?.mcp).toContain(
        "memory_agent_integration_status_viewer",
      );
      expect(catalog.capabilities.find((item) => item.id === "agent-ask")?.cli).toContain(
        "memory frontier [focus]",
      );
      expect(catalog.capabilities.find((item) => item.id === "agent-ask")?.cli).toContain(
        "memory frontier-viewer [focus]",
      );
      expect(catalog.capabilities.find((item) => item.id === "agent-ask")?.mcp).toContain(
        "memory_work_frontier",
      );
      expect(catalog.capabilities.find((item) => item.id === "agent-ask")?.mcp).toContain(
        "memory_work_frontier_viewer",
      );
      expect(catalog.capabilities.find((item) => item.id === "agent-ask")?.cli).toContain(
        "memory handoff-viewer [focus]",
      );
      expect(catalog.capabilities.find((item) => item.id === "agent-ask")?.mcp).toContain(
        "memory_handoff_viewer",
      );
      expect(catalog.capabilities.find((item) => item.id === "extraction-status")?.mcp).toContain(
        "memory_extraction_status",
      );
      expect(catalog.capabilities.find((item) => item.id === "extraction-status")?.mcp).toContain(
        "memory_extraction_status_viewer",
      );
      expect(catalog.capabilities.find((item) => item.id === "extraction-status")?.cli).toContain(
        "memory extract <transcript> --local",
      );
      expect(catalog.capabilities.find((item) => item.id === "extraction-status")?.cli).toContain(
        "memory extraction status-viewer",
      );
      expect(catalog.capabilities.find((item) => item.id === "extraction-status")?.notes[0]).toContain(
        "structured-transcript",
      );
      expect(catalog.capabilities.find((item) => item.id === "code-graph-impact")?.notes[0]).toContain(
        "GitHub Actions jobs",
      );
      expect(catalog.capabilities.find((item) => item.id === "trust-governance")?.cli).toContain(
        "memory backup create",
      );
      expect(catalog.capabilities.find((item) => item.id === "trust-governance")?.cli).toContain(
        "memory governance-viewer",
      );
      expect(catalog.capabilities.find((item) => item.id === "trust-governance")?.cli).toContain(
        "memory decay --json",
      );
      expect(catalog.capabilities.find((item) => item.id === "trust-governance")?.mcp).toContain(
        "memory_governance",
      );
      expect(catalog.capabilities.find((item) => item.id === "trust-governance")?.mcp).toContain(
        "memory_decay",
      );
      expect(catalog.capabilities.find((item) => item.id === "multi-agent-integration")?.cli).toContain(
        "memory routing-guide-viewer --agent cursor",
      );
      expect(catalog.capabilities.find((item) => item.id === "multi-agent-integration")?.mcp).toContain(
        "memory_routing_guide",
      );
      expect(catalog.capabilities.find((item) => item.id === "multi-agent-integration")?.mcp).toContain(
        "memory_routing_guide_viewer",
      );
      expect(catalog.capabilities.find((item) => item.id === "multi-agent-integration")?.mcp).toContain(
        "memory_agent_integration_status",
      );
      expect(catalog.capabilities.find((item) => item.id === "multi-agent-integration")?.mcp).toContain(
        "memory_onboarding_map_viewer",
      );
      expect(catalog.capabilities.find((item) => item.id === "layered-memory-architecture")?.mcp).toContain(
        "memory_layers",
      );
      expect(catalog.capabilities.find((item) => item.id === "layered-memory-architecture")?.mcp).toContain(
        "memory_layers_viewer",
      );
      expect(catalog.capabilities.find((item) => item.id === "layered-memory-architecture")?.cli).toContain(
        "memory layers-viewer",
      );
      expect(catalog.capabilities.find((item) => item.id === "lifecycle-hooks")?.status).toBe(
        "ready",
      );
      expect(catalog.capabilities.find((item) => item.id === "skill-telemetry")?.cli).toContain(
        "memory communities-viewer",
      );
      expect(catalog.capabilities.find((item) => item.id === "skill-telemetry")?.cli).toContain(
        "memory learning-debt-viewer",
      );
      expect(catalog.capabilities.find((item) => item.id === "skill-telemetry")?.cli).toContain(
        "memory health-viewer",
      );
      expect(catalog.capabilities.find((item) => item.id === "skill-telemetry")?.mcp).toContain(
        "memory_communities_viewer",
      );
      expect(catalog.capabilities.find((item) => item.id === "skill-telemetry")?.mcp).toContain(
        "memory_learning_debt_viewer",
      );
      expect(catalog.capabilities.find((item) => item.id === "skill-telemetry")?.mcp).toContain(
        "memory_health_viewer",
      );
      expect(catalog.capabilities.find((item) => item.id === "lifecycle-hooks")?.notes[0]).toContain(
        "8/8 are effectively covered",
      );
      expect(catalog.recommended_next_actions).toContain(
        "run `memory vector maintain --local` for local-dev vectors or configure `RED_MEMORY_VECTOR_PROVIDER` for provider embeddings",
      );
      expect(catalog.recommended_next_actions).not.toContain(
        "hook coverage is ready; no action required",
      );
    } finally {
      await store.close();
    }
  });

  test("treats persisted local-dev vectors as ready without requiring repeated --local flags", async () => {
    const root = await tempRoot();
    await initGraph(root, { hooks: true });
    const doc = await seedDoc(root);
    const store = await MemoryStore.open({ uri: `file://${join(root, ".red/memory/graph.rdb")}` });
    const previousProvider = process.env.RED_MEMORY_VECTOR_PROVIDER;
    try {
      await indexFile(store, doc);
      process.env.RED_MEMORY_VECTOR_PROVIDER = "local";
      await store.maintainVectorProjection();
      if (previousProvider == null) delete process.env.RED_MEMORY_VECTOR_PROVIDER;
      else process.env.RED_MEMORY_VECTOR_PROVIDER = previousProvider;

      const catalog = await buildMemoryCapabilityCatalog(store, root, {
        now: 1_700_000_000_000,
      });

      expect(catalog.runtime.vector.overall).toBe("ready");
      expect(catalog.runtime.vector.total).toBeGreaterThan(0);
      expect(catalog.runtime.vector.ready).toBe(catalog.runtime.vector.total);
      expect(catalog.capabilities.find((item) => item.id === "vectors")?.status).toBe("ready");
      expect(catalog.recommended_next_actions).not.toContain(
        "run `memory vector maintain --local` for local-dev vectors or configure `RED_MEMORY_VECTOR_PROVIDER` for provider embeddings",
      );
    } finally {
      if (previousProvider == null) delete process.env.RED_MEMORY_VECTOR_PROVIDER;
      else process.env.RED_MEMORY_VECTOR_PROVIDER = previousProvider;
      await store.close();
    }
  });

  test(
    "CLI emits the catalog as JSON",
    async () => {
      const root = await tempRoot();
      await initGraph(root, { hooks: true });
      await seedDoc(root);

      const ingest = runMemory(["ingest", root, "--root", root]);
      expect(ingest.status, ingest.stderr).toBe(0);

      const result = runMemory(["capabilities", "--root", root, "--json"]);
      expect(result.status, result.stderr).toBe(0);
      const catalog = JSON.parse(result.stdout) as {
        schema_version: string;
        categories: Array<{ id: string }>;
        capabilities: Array<{ id: string; cli: string[] }>;
      };
      expect(catalog.schema_version).toBe("memory.capability_catalog.v1");
      expect(catalog.categories.map((category) => category.id)).toContain("ui");
      expect(catalog.capabilities.find((item) => item.id === "documents")?.cli).toContain(
        "memory docs coverage",
      );
      expect(catalog.capabilities.find((item) => item.id === "documents")?.cli).toContain(
        "memory docs search-viewer <query>",
      );
      expect(catalog.capabilities.find((item) => item.id === "documents")?.cli).toContain(
        "memory docs bundle <query>",
      );
      expect(catalog.capabilities.find((item) => item.id === "documents")?.cli).toContain(
        "memory docs brief <query>",
      );
      expect(catalog.capabilities.find((item) => item.id === "documents")?.cli).toContain(
        "memory docs brief-viewer <query>",
      );
      expect(catalog.capabilities.find((item) => item.id === "documents")?.cli).toContain(
        "memory docs bundle-viewer <query>",
      );
      expect(catalog.capabilities.find((item) => item.id === "documents")?.cli).toContain(
        "memory docs evidence-pack <path|rid>",
      );
      expect(catalog.capabilities.find((item) => item.id === "documents")?.cli).toContain(
        "memory docs evidence-pack-viewer <path|rid>",
      );
      expect(catalog.capabilities.find((item) => item.id === "documents")?.cli).toContain(
        "memory docs backlinks <label|rid>",
      );
      expect(catalog.capabilities.find((item) => item.id === "documents")?.cli).toContain(
        "memory docs backlinks-viewer <label|rid>",
      );
      expect(catalog.capabilities.find((item) => item.id === "documents")?.cli).toContain(
        "memory docs related <path|rid>",
      );
      expect(catalog.capabilities.find((item) => item.id === "documents")?.cli).toContain(
        "memory docs reference-graph",
      );
      expect(catalog.capabilities.find((item) => item.id === "documents")?.cli).toContain(
        "memory docs reference-graph-viewer",
      );
    },
    TIMEOUT,
  );
});
