import { buildDocCoverageReport, type DocCoverageReport } from "./doc-coverage.js";
import {
  buildMemoryExtractionStatus,
  type MemoryExtractionStatus,
} from "./extraction-status.js";
import type { MemoryStore, VectorStatusReport } from "./graph-store.js";
import { buildHookCoverageReport, type HookCoverageReport } from "./hook-coverage.js";

export type CapabilityCategory =
  | "retrieval"
  | "docs"
  | "extraction"
  | "vectors"
  | "ui"
  | "hooks"
  | "code-graph"
  | "governance"
  | "telemetry"
  | "interop"
  | "intelligence";

export type CapabilityStatus = "ready" | "available" | "degraded" | "not-configured";

export interface MemoryCapability {
  id: string;
  title: string;
  category: CapabilityCategory;
  status: CapabilityStatus;
  red_db_backed: boolean;
  cli: string[];
  mcp: string[];
  evidence: string[];
  reference_relevance: string[];
  notes: string[];
}

export interface MemoryCapabilityCatalog {
  schema_version: "memory.capability_catalog.v1";
  read_only: true;
  root: string;
  generated_at: string;
  summary: {
    total: number;
    ready: number;
    available: number;
    degraded: number;
    not_configured: number;
    red_db_backed: number;
    categories: Record<CapabilityCategory, number>;
  };
  runtime: {
    stats: {
      nodes: number;
      edges: number;
    };
    docs: {
      total: number;
      grounded: number;
      with_references: number;
    };
    vector: Pick<
      VectorStatusReport,
      "overall" | "total" | "ready" | "stale" | "unavailable" | "failed"
    > & { error?: string };
    hooks: {
      mode: HookCoverageReport["mode"];
      enabled_events: number;
      wired_events: number;
      effective_events: number;
      total_events: number;
      gaps: number;
      actionable_gaps: number;
    };
    extraction: {
      inferred_available: boolean;
      inferred_facts: number;
      egress: string | null;
    };
  };
  categories: Array<{
    id: CapabilityCategory;
    title: string;
    capabilities: MemoryCapability[];
  }>;
  capabilities: MemoryCapability[];
  recommended_next_actions: string[];
}

interface CapabilityFacts {
  docs: {
    docs: number;
    grounded: number;
    withReferences: number;
  };
  vector: Pick<
    VectorStatusReport,
    "overall" | "total" | "ready" | "stale" | "unavailable" | "failed"
  > & { error?: string };
    hooks: {
      enabledEvents: number;
      wiredEvents: number;
      effectiveEvents: number;
      totalEvents: number;
      gaps: string[];
      actionableGaps: string[];
      mode: HookCoverageReport["mode"];
    };
  extraction: MemoryExtractionStatus;
}

type RuntimeVector = MemoryCapabilityCatalog["runtime"]["vector"];

const CATEGORY_TITLES: Record<CapabilityCategory, string> = {
  retrieval: "Retrieval",
  docs: "Documentation",
  extraction: "Extraction",
  vectors: "Vectors",
  ui: "Operator UI",
  hooks: "Lifecycle hooks",
  "code-graph": "Code graph",
  governance: "Governance",
  telemetry: "Telemetry",
  interop: "Interop",
  intelligence: "Intelligence",
};

const CATEGORY_ORDER = Object.keys(CATEGORY_TITLES) as CapabilityCategory[];

export async function buildMemoryCapabilityCatalog(
  store: MemoryStore,
  rootDir: string,
  opts: { now?: number } = {},
): Promise<MemoryCapabilityCatalog> {
  const [stats, docCoverage, hooks, extraction] = await Promise.all([
    store.stats(),
    buildDocCoverageReport(store),
    buildHookCoverageReport(rootDir),
    buildMemoryExtractionStatus(store, rootDir, opts),
  ]);
  const facts: CapabilityFacts = {
    docs: {
      docs: docCoverage.total_docs,
      grounded: docCoverage.grounded_docs,
      withReferences: docCoverage.docs_with_references,
    },
    vector: docCoverage.vector,
    hooks: {
      enabledEvents: hooks.summary.enabled_events,
      wiredEvents: hooks.summary.wired_events,
      effectiveEvents: hooks.summary.effective_events,
      totalEvents: hooks.summary.total_events,
      gaps: hooks.gaps,
      actionableGaps: hooks.actionable_gaps,
      mode: hooks.mode,
    },
    extraction,
  };
  const capabilities = capabilityDefinitions(facts);
  return {
    schema_version: "memory.capability_catalog.v1",
    read_only: true,
    root: rootDir,
    generated_at: new Date(opts.now ?? Date.now()).toISOString(),
    summary: summarize(capabilities),
    runtime: {
      stats: { nodes: stats.nodes, edges: stats.edges },
      docs: {
        total: docCoverage.total_docs,
        grounded: docCoverage.grounded_docs,
        with_references: docCoverage.docs_with_references,
      },
      vector: docCoverage.vector,
      hooks: {
        mode: hooks.mode,
        enabled_events: hooks.summary.enabled_events,
        wired_events: hooks.summary.wired_events,
        effective_events: hooks.summary.effective_events,
        total_events: hooks.summary.total_events,
        gaps: hooks.gaps.length,
        actionable_gaps: hooks.actionable_gaps.length,
      },
      extraction: {
        inferred_available: extraction.inferred.available,
        inferred_facts: extraction.inferred.facts,
        egress: extraction.inferred.egress,
      },
    },
    categories: groupByCategory(capabilities),
    capabilities,
    recommended_next_actions: recommendedActions(docCoverage, hooks, extraction),
  };
}

function capabilityDefinitions(facts: CapabilityFacts): MemoryCapability[] {
  const vectorStatus = vectorCapabilityStatus(facts.vector);
  const docsReady = facts.docs.docs > 0 ? "ready" : "available";
  const hooksReady =
    facts.hooks.effectiveEvents > 0
      ? facts.hooks.actionableGaps.length > 0
        ? "degraded"
        : "ready"
      : facts.hooks.wiredEvents > 0
        ? "available"
        : "not-configured";
  return [
    capability({
      id: "governed-hybrid-recall",
      title: "Governed recall",
      category: "retrieval",
      status: vectorStatus === "ready" ? "ready" : "available",
      red_db_backed: true,
      cli: [
        "memory smart-search <query>",
        "memory recall <query>",
        "memory context-pack <goal>",
        "memory context-pack-viewer <goal>",
        "memory readiness <goal>",
      ],
      mcp: [
        "memory_smart_search",
        "memory_recall",
        "memory_context_pack",
        "memory_context_pack_viewer",
        "memory_readiness",
      ],
      evidence: ["dimension:retrieval", "foundation:hybrid-recall", "foundation:readiness-envelope"],
      reference_relevance: ["agentmemory", "neo4j-agent-memory", "ai-memory"],
      notes: [
        "Smart search composes governed recall, ingested docs, and vector diagnostics; default recall still owns graph, scope, supersession, trust, and tier ranking.",
      ],
    }),
    capability({
      id: "federation",
      title: "Cross-root memory federation",
      category: "intelligence",
      status: "available",
      red_db_backed: false,
      cli: ["memory federate --query \"<topic>\" [--json]"],
      mcp: ["memory_federate"],
      evidence: ["dimension:retrieval", "foundation:federation"],
      reference_relevance: ["agentmemory", "ai-memory"],
      notes: [
        "Read-only merge of memory notes across roots listed in .red/memory/federation.yaml. Each result carries origin_repo plus local/remote confidence; redaction policy is applied at read time, and malformed policy falls back to default-deny.",
      ],
    }),
    capability({
      id: "autocure",
      title: "Auto-curation orchestrator (opt-in)",
      category: "intelligence",
      status: "available",
      red_db_backed: true,
      cli: ["memory autocure [--apply] [--stale-days N] [--json]"],
      mcp: ["memory_autocure"],
      evidence: ["dimension:intelligence", "foundation:autocure"],
      reference_relevance: ["agentmemory", "ai-memory"],
      notes: [
        "memory.autocure.v1 composes doctor + decay + supersession into one pass: dedupe-supersede, supersede-contradiction, expire-stale, promote-edge, archive-untouched.",
        "Dry-run by default; --apply mutates. Claim-guarded nodes (properties.claim_guard === true) are never mutated and surface in skipped_claim_guarded.",
        "Each run stamps entropy_before/entropy_after; recent runs persist in KV and surface in the workbench Autocure Health panel.",
      ],
    }),
    capability({
      id: "confidence-scoring",
      title: "Composed confidence scoring",
      category: "intelligence",
      status: "ready",
      red_db_backed: true,
      cli: ["memory confidence --node <rid>"],
      mcp: ["memory_confidence"],
      evidence: ["foundation:confidence-scoring", "dimension:intelligence"],
      reference_relevance: ["agentmemory", "ai-memory"],
      notes: [
        "Pure composer turns provenance depth, recency, supersession, and validation edges into a [0,1] confidence score with a per-signal breakdown.",
        "Recall, traverse, path-explain, and ask now carry confidence inline; path-explain uses weakest-link min along the path.",
      ],
    }),
    capability({
      id: "agent-ask",
      title: "Evidence-backed agent answers",
      category: "retrieval",
      status: "available",
      red_db_backed: true,
      cli: [
        "memory frontier [focus]",
        "memory frontier-viewer [focus]",
        "memory handoff [focus]",
        "memory handoff-viewer [focus]",
        "memory ask <question>",
        "memory claim-check <assertion>",
      ],
      mcp: [
        "memory_work_frontier",
        "memory_work_frontier_viewer",
        "memory_handoff",
        "memory_handoff_viewer",
        "memory_ask",
        "memory_claim_check",
      ],
      evidence: ["foundation:claim-check", "foundation:readiness-envelope"],
      reference_relevance: ["agentmemory", "gbrain", "ai-memory"],
      notes: [
        "Handoffs are deterministic over graph evidence; LLM answering returns citations plus structured gap analysis over confidence, supersession, and contradictions.",
      ],
    }),
    capability({
      id: "corpus-knowledge-graph",
      title: "Corpus to knowledge graph",
      category: "intelligence",
      status: docsReady,
      red_db_backed: true,
      cli: [
        "memory ingest <path>",
        "memory docs reference-graph",
        "memory docs reference-graph-viewer",
        "memory communities",
        "memory communities-viewer",
        "memory dashboard",
        "memory capabilities",
        "memory export [<out-dir>]",
        "memory export [<out-dir>] --interop",
      ],
      mcp: [
        "memory_asset_inventory",
        "memory_doc_reference_graph",
        "memory_doc_reference_graph_viewer",
        "memory_communities",
        "memory_communities_viewer",
        "memory_dashboard",
        "memory_capability_catalog",
        "memory_export",
      ],
      evidence: [
        "dimension:intelligence",
        "dimension:operator-surface",
        "foundation:doc-coverage",
        "foundation:communities",
      ],
      reference_relevance: ["agentmemory", "ai-memory"],
      notes: [
        "Repo and document corpora route to Memory graph mode: deterministic ingest creates RedDB-backed file, symbol, concept, doc, asset, and relationship evidence.",
        "Use reference-graph, communities, dashboard, and capability catalog surfaces to query or analyze the graph; export emits a portable graph bundle for offline inspection or interop.",
      ],
    }),
    capability({
      id: "documents",
      title: "Ingested documentation search and coverage",
      category: "docs",
      status: docsReady,
      red_db_backed: true,
      cli: [
        "memory bootstrap",
        "memory docs search <query>",
        "memory docs search-viewer <query>",
        "memory docs brief <query>",
        "memory docs brief-viewer <query>",
        "memory docs bundle <query>",
        "memory docs bundle-viewer <query>",
        "memory docs read <path|rid>",
        "memory docs evidence-pack <path|rid>",
        "memory docs evidence-pack-viewer <path|rid>",
        "memory docs backlinks <label|rid>",
        "memory docs backlinks-viewer <label|rid>",
        "memory docs related <path|rid>",
        "memory docs related-viewer <path|rid>",
        "memory docs restore [path|rid] --yes",
        "memory docs coverage",
        "memory docs reference-graph",
        "memory docs reference-graph-viewer",
        "memory assets",
        "memory assets-viewer",
      ],
      mcp: [
        "memory_asset_inventory",
        "memory_asset_inventory_viewer",
        "memory_doc_search",
        "memory_doc_search_viewer",
        "memory_doc_brief",
        "memory_doc_brief_viewer",
        "memory_doc_bundle",
        "memory_doc_bundle_viewer",
        "memory_doc_read",
        "memory_doc_evidence_pack",
        "memory_doc_evidence_pack_viewer",
        "memory_doc_backlinks",
        "memory_doc_backlinks_viewer",
        "memory_doc_related",
        "memory_doc_related_viewer",
        "memory_doc_coverage",
        "memory_doc_reference_graph",
        "memory_doc_reference_graph_viewer",
      ],
      evidence: ["foundation:doc-coverage", "dimension:operator-surface"],
      reference_relevance: ["gbrain", "graphify", "neo4j-agent-memory"],
      notes: [
        facts.docs.docs > 0
          ? `${facts.docs.grounded}/${facts.docs.docs} docs are grounded; ${facts.docs.withReferences} doc roots expose REFERENCES edges.`
          : "No ingested docs yet; run memory ingest to populate memory_docs.",
        "Doc reference graph exposes indexed docs, referenced nodes, and REFERENCES edges for Graphify-style inspection without a second graph store.",
        "Ingest also inventories PDFs, images, audio/video, and Office files as RedDB file metadata nodes without claiming OCR or multimodal extraction.",
        "Indexed docs can be explicitly restored from RedDB into a safe output directory or back in-place with --yes.",
      ],
    }),
    capability({
      id: "extraction-status",
      title: "Deterministic and inferred extraction",
      category: "extraction",
      status: facts.extraction.inferred.available ? "ready" : "available",
      red_db_backed: true,
      cli: [
        "memory ingest <path>",
        "memory extraction status",
        "memory extraction status-viewer",
        "memory extract <transcript>",
        "memory extract <transcript> --local",
      ],
      mcp: ["memory_extraction_status", "memory_extraction_status_viewer"],
      evidence: ["dimension:trust-governance", "dimension:operator-surface"],
      reference_relevance: ["graphify", "neo4j-agent-memory", "ai-memory"],
      notes: [
        facts.extraction.inferred.available
          ? `Inferred extraction is configured via ${facts.extraction.inferred.mode}/${facts.extraction.inferred.model} with ${facts.extraction.inferred.egress} egress; ${facts.extraction.inferred.facts} inferred facts are stored.`
          : `Deterministic markdown/code/SQL/dev-workflow/structured-transcript extraction is available; free-form provider inference is not configured (${facts.extraction.inferred.error ?? "no provider"}).`,
      ],
    }),
    capability({
      id: "vectors",
      title: "RedDB-native vector projection",
      category: "vectors",
      status: vectorStatus,
      red_db_backed: true,
      cli: [
        "memory vector status",
        "memory vector status-viewer",
        "memory vector maintain",
        "memory vector search <query>",
      ],
      mcp: ["memory_vector_status", "memory_vector_status_viewer", "memory_vector_search"],
      evidence: ["foundation:hybrid-recall", "foundation:doc-coverage"],
      reference_relevance: ["agentmemory", "neo4j-agent-memory", "gbrain"],
      notes: [
        `Vector projection is ${facts.vector.overall}; writes degrade gracefully when no provider is configured, local-dev projection is available via RED_MEMORY_VECTOR_PROVIDER=local or --local, and asset vector hits preserve path/kind/media metadata.`,
      ],
    }),
    capability({
      id: "local-ui",
      title: "Self-contained local UI artifacts",
      category: "ui",
      status: "ready",
      red_db_backed: true,
      cli: [
        "memory workbench",
        "memory serve",
        "memory dashboard",
        "memory context-pack-viewer <goal>",
        "memory frontier-viewer [focus]",
        "memory handoff-viewer [focus]",
        "memory decay-viewer",
        "memory governance-viewer",
        "memory health-viewer",
        "memory layers-viewer",
        "memory learning-debt-viewer",
        "memory smart-search-viewer <query>",
        "memory vector status-viewer",
        "memory communities-viewer",
        "memory onboarding-map-viewer",
        "memory export",
        "memory export --interop",
        "memory session timeline",
        "memory session timeline-viewer",
        "memory readiness-viewer <goal>",
        "memory docs coverage-viewer",
        "memory docs search-viewer <query>",
        "memory docs reference-graph-viewer",
        "memory docs backlinks-viewer <label|rid>",
        "memory docs brief-viewer <query>",
        "memory docs bundle-viewer <query>",
        "memory docs evidence-pack-viewer <path|rid>",
        "memory docs related-viewer <path|rid>",
        "memory assets-viewer",
        "memory structural-impact-viewer",
        "memory pre-pr-review-viewer",
        "memory routing-guide-viewer --agent codex",
        "memory integration-status-viewer",
        "benchmark-memory references viewer",
      ],
      mcp: [
        "memory_workbench",
        "memory_dashboard",
        "memory_context_pack_viewer",
        "memory_work_frontier_viewer",
        "memory_handoff_viewer",
        "memory_decay_viewer",
        "memory_governance_viewer",
        "memory_health_viewer",
        "memory_layers_viewer",
        "memory_learning_debt_viewer",
        "memory_smart_search_viewer",
        "memory_vector_status_viewer",
        "memory_communities_viewer",
        "memory_onboarding_map_viewer",
        "memory_session_timeline",
        "memory_session_timeline_viewer",
        "memory_readiness_viewer",
        "memory_doc_coverage_viewer",
        "memory_doc_search_viewer",
        "memory_doc_reference_graph_viewer",
        "memory_doc_backlinks_viewer",
        "memory_doc_brief_viewer",
        "memory_doc_bundle_viewer",
        "memory_doc_evidence_pack_viewer",
        "memory_doc_related_viewer",
        "memory_asset_inventory_viewer",
        "memory_structural_impact_viewer",
        "memory_pre_pr_review_viewer",
        "memory_routing_guide_viewer",
        "memory_agent_integration_status_viewer",
      ],
      evidence: ["foundation:operational-dashboard", "dimension:operator-surface"],
      reference_relevance: ["gbrain", "graphify", "agentmemory"],
      notes: ["HTML artifacts are self-contained and embed their source JSON contracts; the operational dashboard composes docs, vectors, hooks, extraction, stale evidence, and decay posture; routing-guide and references viewers turn multi-agent adoption and executable claim guards into local HTML; export interop can also emit JSONL, GraphML, and Neo4j Cypher from the RedDB source graph."],
    }),
    capability({
      id: "lifecycle-hooks",
      title: "Agent lifecycle hooks",
      category: "hooks",
      status: hooksReady,
      red_db_backed: true,
      cli: ["memory hooks coverage", "memory hooks coverage-viewer", "memory hook <event> --runner <runner>"],
      mcp: ["memory_hook_coverage", "memory_hook_coverage_viewer", "memory_session_timeline"],
      evidence: ["foundation:hook-coverage", "baseline:memory-lifecycle-beats-agent-memory"],
      reference_relevance: ["agentmemory", "ai-memory"],
      notes: [
        `Hook mode is ${facts.hooks.mode}; ${facts.hooks.enabledEvents}/${facts.hooks.totalEvents} runner events are enabled and ${facts.hooks.effectiveEvents}/${facts.hooks.totalEvents} are effectively covered. Stop/PreCompact can persist structured Problem/Fix/Validation facts with inferred graph edges before falling back to decision / why-note extraction. Session timeline replays hook and Skill telemetry events without raw transcripts.`,
      ],
    }),
    capability({
      id: "code-graph-impact",
      title: "Code graph and impact queries",
      category: "code-graph",
      status: "ready",
      red_db_backed: true,
      cli: [
        "memory ingest <path>",
        "memory path-explain <from> <to>",
        "memory path-explain-viewer <from> <to>",
        "memory structural-impact",
        "memory pre-pr-review",
      ],
      mcp: [
        "memory_path_explain",
        "memory_path_explain_viewer",
        "memory_structural_impact",
        "memory_pre_pr_review",
      ],
      evidence: ["foundation:operational-dashboard"],
      reference_relevance: ["graphify", "neo4j-agent-memory"],
      notes: [
        "Deterministic extraction records files, symbols, imports, calls, type uses, SQL tables/columns/FKs, package scripts, Docker steps, GitHub Actions jobs, shell functions, and changed-file review evidence.",
      ],
    }),
    capability({
      id: "trust-governance",
      title: "Trust, provenance, privacy, and supersession",
      category: "governance",
      status: "ready",
      red_db_backed: true,
      cli: [
        "memory claim-check",
        "memory governance",
        "memory governance-viewer",
        "memory decay --json",
        "memory decay-viewer",
        "memory provenance",
        "memory privacy scan",
        "memory backup create",
        "memory backup restore <name> --yes",
        "memory conflicts",
        "memory timeline",
      ],
      mcp: [
        "memory_claim_check",
        "memory_governance",
        "memory_governance_viewer",
        "memory_decay",
        "memory_decay_viewer",
        "memory_provenance",
        "memory_privacy_scan",
      ],
      evidence: ["dimension:trust-governance", "foundation:claim-check", "foundation:vcs-time-travel"],
      reference_relevance: ["neo4j-agent-memory", "agentmemory", "ai-memory"],
      notes: ["Governed memory keeps old evidence auditable through supersession, exposes a local governance viewer over provenance/privacy/lint/conflict evidence, turns lint findings into read-only agent-rule/context promotion suggestions, classifies retention evidence into keep/review/deprecate/expire without deleting anything, and can snapshot/restore project-local RedDB persistence with a hash manifest."],
    }),
    capability({
      id: "skill-telemetry",
      title: "Skill telemetry and self-improvement loop",
      category: "telemetry",
      status: "ready",
      red_db_backed: true,
      cli: [
        "memory status skills",
        "memory learning-debt",
        "memory learning-debt-viewer",
        "memory health-viewer",
        "memory communities",
        "memory communities-viewer",
        "memory improve skills",
      ],
      mcp: [
        "memory_skill_recommendations",
        "memory_learning_debt",
        "memory_learning_debt_viewer",
        "memory_health_viewer",
        "memory_communities",
        "memory_communities_viewer",
        "memory_health",
      ],
      evidence: ["dimension:skill-evolution", "foundation:skill-telemetry", "foundation:communities"],
      reference_relevance: ["agentmemory", "ai-memory"],
      notes: ["Telemetry stays report/proposal-gated; mutating skill changes require explicit apply/archive workflows."],
    }),
    capability({
      id: "multi-agent-integration",
      title: "Multi-agent Memory integration guide",
      category: "interop",
      status: "ready",
      red_db_backed: true,
      cli: ["memory routing-guide --agent codex", "memory routing-guide-viewer --agent cursor", "memory integration-status --json", "memory-mcp", "memory serve", "memory frontier [focus]"],
      mcp: ["memory_routing_guide", "memory_routing_guide_viewer", "memory_agent_integration_status", "memory_agent_integration_status_viewer", "memory_onboarding_map", "memory_onboarding_map_viewer", "memory_work_frontier"],
      evidence: ["dimension:operator-surface", "foundation:hook-coverage"],
      reference_relevance: ["agentmemory", "gbrain", "ai-memory"],
      notes: [
        "Routing guide emits agent-rule targets, MCP stdio config, loopback HTTP command, and hook guidance for Codex, Claude, Cursor, Gemini, Aider, OpenCode, and generic MCP/HTTP agents; integration status audits whether rule files and hook coverage are actually present.",
      ],
    }),
    capability({
      id: "whatif-pre-action-blast-radius",
      title: "What-if pre-action blast radius",
      category: "intelligence",
      status: "available",
      red_db_backed: true,
      cli: ["memory whatif --change \"<descriptor>\" [--change \"<descriptor>\" ...] [--limit N] [--json]"],
      mcp: ["memory_whatif"],
      evidence: [
        "dimension:intelligence",
        "foundation:structural-impact",
        "foundation:reasoning-replay",
      ],
      reference_relevance: ["gbrain", "ai-memory"],
      notes: [
        "memory.whatif.v1: composes structural-impact-reader (syntactic blast) with reasoning-replay (semantic blast from similar past attempts). Returns affected files/symbols/tests, historical_attempts, breakage_likelihood [0,1], and self_confidence [0,1].",
      ],
    }),
    capability({
      id: "reasoning-replay",
      title: "Reasoning replay over past attempts",
      category: "intelligence",
      status: "available",
      red_db_backed: true,
      cli: ["memory reasoning-replay --task \"<descriptor>\" [--json] [--limit N]"],
      mcp: ["memory_reasoning_replay"],
      evidence: ["dimension:retrieval", "foundation:reasoning-attempt"],
      reference_relevance: ["agentmemory", "ai-memory", "gbrain"],
      notes: [
        "Slice 1a: ranks reasoning-tier attempt nodes by token similarity to a task descriptor. Returns attempt_id, similarity, when, and summary; outcome attachment and gap detection land in slice 1b.",
      ],
    }),
    capability({
      id: "federation-cross-root-read",
      title: "Federated recall read",
      category: "retrieval",
      status: "available",
      red_db_backed: false,
      cli: ["memory federate --query \"<topic>\" [--root <dir>] [--limit N] [--per-root-limit N] [--json]"],
      mcp: ["memory_federate"],
      evidence: ["dimension:retrieval", "dimension:operator-surface"],
      reference_relevance: ["agentmemory", "gbrain"],
      notes: [
        "Reads memory notes across the roots listed in .red/memory/federation.yaml, merges hits, tags each with origin_repo, and applies read-time redaction/trust policy before returning results.",
      ],
    }),
    capability({
      id: "layered-memory-architecture",
      title: "Layered RedDB memory architecture",
      category: "interop",
      status: "ready",
      red_db_backed: true,
      cli: ["memory layers --json", "memory layers-viewer"],
      mcp: ["memory_layers", "memory_layers_viewer"],
      evidence: ["dimension:retrieval", "dimension:operator-surface", "foundation:hybrid-recall"],
      reference_relevance: ["neo4j-agent-memory", "agentmemory", "gbrain"],
      notes: [
        "Layers report maps short-term session events, long-term graph facts, reasoning traces, docs/code evidence, and vector projection into one RedDB-backed contract with a self-contained local viewer.",
      ],
    }),
    capability({
      id: "reference-interop",
      title: "Reference eval and interop reports",
      category: "interop",
      status: "ready",
      red_db_backed: false,
      cli: ["benchmark-memory references eval --json", "benchmark-memory references viewer", "pnpm --filter @reddb-io/benchmark-memory references:eval:v2", "pnpm --filter @reddb-io/benchmark-memory references:interop"],
      mcp: [],
      evidence: ["dimension:operator-surface", "dimension:multi-agent-integration", "fixture:recall"],
      reference_relevance: ["agentmemory", "neo4j-agent-memory", "graphify"],
      notes: ["Public comparison claims are guarded by checked-in executable evidence and optional live baselines."],
    }),
  ];
}

function vectorCapabilityStatus(vector: RuntimeVector): CapabilityStatus {
  if (vector.overall === "ready") return "ready";
  if (vector.overall === "unavailable") return "not-configured";
  return "degraded";
}

function capability(input: MemoryCapability): MemoryCapability {
  return input;
}

function groupByCategory(
  capabilities: MemoryCapability[],
): MemoryCapabilityCatalog["categories"] {
  return CATEGORY_ORDER.map((id) => ({
    id,
    title: CATEGORY_TITLES[id],
    capabilities: capabilities.filter((item) => item.category === id),
  }));
}

function recommendedActions(
  docs: DocCoverageReport,
  hooks: HookCoverageReport,
  extraction?: MemoryExtractionStatus,
): string[] {
  const actions: string[] = [];
  if (docs.total_docs === 0) actions.push("run `memory ingest . --root .` to populate documentation coverage");
  if (docs.ungrounded_docs > 0) actions.push("run `memory ingest . --root .` to refresh graph grounding for docs");
  if (docs.vector.overall !== "ready") {
    actions.push("run `memory vector maintain --local` for local-dev vectors or configure `RED_MEMORY_VECTOR_PROVIDER` for provider embeddings");
  }
  actions.push(...hooks.recommended_next_actions.filter(isActionableRecommendation));
  if (extraction) {
    actions.push(
      ...extraction.recommended_next_actions.filter(isActionableRecommendation),
    );
  }
  if (actions.length === 0) actions.push("Memory capability catalog is ready");
  return [...new Set(actions)];
}

function isActionableRecommendation(action: string): boolean {
  return !(/\bis ready; no action required\b/i.test(action) || /\bare ready\b/i.test(action));
}

function summarize(capabilities: MemoryCapability[]): MemoryCapabilityCatalog["summary"] {
  const categories = {
    retrieval: 0,
    docs: 0,
    extraction: 0,
    vectors: 0,
    ui: 0,
    hooks: 0,
    "code-graph": 0,
    governance: 0,
    telemetry: 0,
    interop: 0,
    intelligence: 0,
  } satisfies Record<CapabilityCategory, number>;
  for (const item of capabilities) categories[item.category]++;
  return {
    total: capabilities.length,
    ready: capabilities.filter((item) => item.status === "ready").length,
    available: capabilities.filter((item) => item.status === "available").length,
    degraded: capabilities.filter((item) => item.status === "degraded").length,
    not_configured: capabilities.filter((item) => item.status === "not-configured").length,
    red_db_backed: capabilities.filter((item) => item.red_db_backed).length,
    categories,
  };
}
