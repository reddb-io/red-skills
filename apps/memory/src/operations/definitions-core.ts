import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { renderToonOutput } from "../toon-output.js";
import { toEdge } from "../export.js";
import {
  buildMemoryAssetInventory,
  type MemoryAssetInventoryReport,
} from "../asset-inventory.js";
import {
  buildMemoryAssetInventoryViewerArtifact,
  type MemoryAssetInventoryViewerArtifact,
} from "../asset-inventory-viewer.js";
import {
  buildMemoryAgentIntegrationStatus,
  type MemoryAgentIntegrationStatus,
} from "../agent-integration-status.js";
import {
  buildMemoryAgentIntegrationStatusViewerArtifact,
  type MemoryAgentIntegrationStatusViewerArtifact,
} from "../agent-integration-status-viewer.js";
import {
  buildMemoryCapabilityCatalog,
  type MemoryCapabilityCatalog,
} from "../capability-catalog.js";
import { claimCheck, type ClaimCheckResult } from "../claim-check.js";
import {
  buildMemoryReferenceRadar,
  type MemoryReferenceRadar,
} from "../references-radar.js";
import {
  buildCommunityAnalytics,
  type CommunityAnalyticsReport,
  type CommunityCacheMode,
} from "../communities.js";
import {
  buildCommunitiesViewerArtifact,
  type CommunitiesViewerArtifact,
} from "../communities-viewer.js";
import {
  buildCommunityDigest,
  type CommunityDigestProviderStatus,
  type CommunityDigestReport,
} from "../community-digest.js";
import {
  buildHubReport,
  type HubRankBy,
  type HubReport,
} from "../hub-report.js";
import {
  buildSuggestedQuestions,
  type SuggestedQuestionReference,
  type SuggestedQuestionSignalType,
  type SuggestedQuestionsReport,
} from "../suggested-questions.js";
import {
  buildMemoryGlobalSearch,
  type MemoryGlobalSearchReport,
} from "../global-search.js";
import {
  buildGraphContract,
  GraphContractZ,
  type GraphContract,
} from "../graph-contract.js";
import { buildContextPack, type ContextPack } from "../context-pack.js";
import {
  buildContextPackViewerArtifact,
  type ContextPackViewerArtifact,
} from "../context-pack-viewer.js";
import { appendContextPackGenerationEvent } from "../memory-events.js";
import { buildDocBrief, type DocBrief } from "../doc-brief.js";
import {
  buildDocBriefViewerArtifact,
  type DocBriefViewerArtifact,
} from "../doc-brief-viewer.js";
import { buildDocBundle, type DocBundle } from "../doc-bundle.js";
import {
  buildDocBundleViewerArtifact,
  type DocBundleViewerArtifact,
} from "../doc-bundle-viewer.js";
import {
  buildDocCoverageReport,
  type DocCoverageReport,
} from "../doc-coverage.js";
import {
  buildDocCoverageViewerArtifact,
  type DocCoverageViewerArtifact,
} from "../doc-coverage-viewer.js";
import {
  buildDocEvidencePack,
  type DocEvidencePack,
} from "../doc-evidence-pack.js";
import {
  buildDocEvidencePackViewerArtifact,
  type DocEvidencePackViewerArtifact,
} from "../doc-evidence-pack-viewer.js";
import {
  buildDocBacklinksReport,
  type DocBacklinksReport,
} from "../doc-backlinks.js";
import {
  buildDocBacklinksViewerArtifact,
  type DocBacklinksViewerArtifact,
} from "../doc-backlinks-viewer.js";
import {
  buildDocReferenceGraphReport,
  type DocReferenceGraphReport,
} from "../doc-reference-graph.js";
import {
  buildDocReferenceGraphViewerArtifact,
  type DocReferenceGraphViewerArtifact,
} from "../doc-reference-graph-viewer.js";
import { buildDocRelatedReport, type DocRelatedReport } from "../doc-related.js";
import {
  buildDocRelatedViewerArtifact,
  type DocRelatedViewerArtifact,
} from "../doc-related-viewer.js";
import {
  readDoc,
  searchDocs,
  type DocReadResult,
  type DocSearchReport,
} from "../doc-search.js";
import {
  buildDocSearchViewerArtifact,
  type DocSearchViewerArtifact,
} from "../doc-search-viewer.js";
import { ask, type AskResult } from "../engine.js";
import type { MemoryConfig } from "../config.js";
import type { AiProviderConfig } from "../extract-conversation.js";
import { graphRecallResult, type GraphRecallResult } from "../graph-recall.js";
import {
  buildMemoryExtractionStatus,
  type MemoryExtractionStatus,
} from "../extraction-status.js";
import {
  buildMemoryExtractionStatusViewerArtifact,
  type MemoryExtractionStatusViewerArtifact,
} from "../extraction-status-viewer.js";
import {
  buildMemoryMapFreshnessReport,
  type MemoryMapFreshnessReport,
} from "../map-freshness.js";
import type { MemoryStore, StoredNode, VectorStatusReport } from "../graph-store.js";
import { buildMemoryHandoff, type MemoryHandoffReport } from "../handoff.js";
import {
  buildMemoryHandoffViewerArtifact,
  type MemoryHandoffViewerArtifact,
} from "../handoff-viewer.js";
import {
  buildMemoryGovernanceReport,
  type MemoryGovernanceReport,
} from "../governance.js";
import {
  buildMemoryGovernanceViewerArtifact,
  type MemoryGovernanceViewerArtifact,
} from "../governance-viewer.js";
import {
  buildHookCoverageReport,
  type HookCoverageReport,
} from "../hook-coverage.js";
import {
  buildHookCoverageViewerArtifact,
  type HookCoverageViewerArtifact,
} from "../hook-coverage-viewer.js";
import { buildLearningDebtReport, type LearningDebtReport } from "../learning-debt.js";
import {
  buildLearningDebtViewerArtifact,
  type LearningDebtViewerArtifact,
} from "../learning-debt-viewer.js";
import {
  buildLintRuleSuggestions,
  lintMemoryRecords,
  type LintMemoryRecord,
  type LintReport,
} from "../lint.js";
import {
  buildMemoryHealthReport,
  type MemoryHealthReport,
} from "../memory-health.js";
import {
  buildMemoryHealthViewerArtifact,
  type MemoryHealthViewerArtifact,
} from "../memory-health-viewer.js";
import {
  buildMemoryDecayReport,
  type MemoryDecayReport,
} from "../memory-decay.js";
import {
  buildMemoryDecayViewerArtifact,
  type MemoryDecayViewerArtifact,
} from "../memory-decay-viewer.js";
import {
  buildMemoryMergePassReport,
  type MemoryMergePassReport,
} from "../memory-merge-pass.js";
import { buildMemoryLayersReport, type MemoryLayersReport } from "../memory-layers.js";
import {
  buildMemoryLayersViewerArtifact,
  type MemoryLayersViewerArtifact,
} from "../memory-layers-viewer.js";
import { buildOnboardingMap, type OnboardingMap } from "../onboarding-map.js";
import {
  buildOnboardingMapViewerArtifact,
  type OnboardingMapViewerArtifact,
} from "../onboarding-map-viewer.js";
import {
  buildMemoryOperationalDashboard,
  buildMemoryOperationalDashboardArtifact,
  type MemoryOperationalDashboardArtifact,
} from "../operational-dashboard.js";
import {
  buildConfidenceReport,
  type ConfidenceReport,
} from "../confidence.js";
import {
  buildPathExplainReport,
  type PathExplainReport,
} from "../path-explain.js";
import {
  buildPathExplainViewerArtifact,
  type PathExplainViewerArtifact,
} from "../path-explain-viewer.js";
import {
  buildPrePrMemoryReview,
  type PrePrMemoryReview,
} from "../pre-pr-review.js";
import {
  buildPrePrReviewViewerArtifact,
  type PrePrReviewViewerArtifact,
} from "../pre-pr-review-viewer.js";
import {
  privacyReport,
  type PrivacyMemoryRecord,
  type PrivacyReport,
} from "../privacy.js";
import {
  buildProvenanceReport,
  findNodeForProvenance,
  type ProvenanceReport,
} from "../provenance.js";
import { buildReadinessEnvelope, type MemoryReadinessEnvelope } from "../readiness.js";
import {
  buildReadinessViewerArtifact,
  type ReadinessViewerArtifact,
} from "../readiness-viewer.js";
import {
  buildMemoryRoutingGuide,
  type MemoryRoutingAgent,
  type MemoryRoutingGuide,
} from "../routing-guide.js";
import {
  buildMemoryMapContextSlice,
  type MemoryMapContextSlice,
} from "../map-context.js";
import {
  buildMemoryRoutingGuideViewerArtifact,
  type MemoryRoutingGuideViewerArtifact,
} from "../routing-guide-viewer.js";
import {
  buildReasoningReplay,
  type ReasoningReplayReport,
} from "../reasoning/reasoning-replay.js";
import {
  buildFederationReport,
  type FederationReport,
} from "../federation.js";
import {
  buildSessionTimeline,
  type SessionTimeline,
} from "../session-timeline.js";
import {
  buildSessionTimelineViewerArtifact,
  type SessionTimelineViewerArtifact,
} from "../session-timeline-viewer.js";
import type { MemoryScope, Tier } from "../schema.js";
import {
  buildSkillRecommendations,
  type SkillRecommendationReport,
} from "../skill-recommendations.js";
import { readSkillRollups, type SkillRollup } from "../skill-events.js";
import {
  buildMemorySmartSearch,
  type MemorySmartSearchReport,
} from "../smart-search.js";
import {
  buildMemorySmartSearchViewerArtifact,
  type MemorySmartSearchViewerArtifact,
} from "../smart-search-viewer.js";
import {
  structuralImpactReader,
  type StructuralImpact,
} from "../structural-impact-reader.js";
import {
  buildWhatifReport,
  parseWhatifChange,
  type WhatifChange,
  type WhatifReport,
} from "../whatif.js";
import {
  buildStructuralImpactViewerArtifact,
  type StructuralImpactViewerArtifact,
} from "../structural-impact-viewer.js";
import {
  buildVectorSearchReport,
  type VectorSearchReport,
} from "../vector-search.js";
import {
  buildVectorStatusViewerArtifact,
  type VectorStatusViewerArtifact,
} from "../vector-status-viewer.js";
import { buildWorkFrontier, type WorkFrontierReport } from "../work-frontier.js";
import {
  buildWorkFrontierViewerArtifact,
  type WorkFrontierViewerArtifact,
} from "../work-frontier-viewer.js";
import {
  buildMemoryWorkbench,
  buildMemoryWorkbenchArtifact,
  type MemoryWorkbenchArtifact,
} from "../workbench.js";

import type { MemoryOperationDefinition } from "./types.js";
import * as OperationSchemas from "./schemas.js";
import * as OperationHelpers from "./helpers.js";

const ASK_OPERATION: MemoryOperationDefinition<OperationSchemas.AskInput, AskResult> = {
  id: "memory.ask",
  title: "Evidence-backed Memory ask",
  description:
    "Grounded ASK over Memory evidence with citations, gap analysis, and provider cost metadata.",
  inputSchema: OperationSchemas.AskInputSchema,
  outputSchema: OperationSchemas.AskOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "cache-write",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "ask", supportsJson: true },
    mcp: {
      toolName: "memory_ask",
      description:
        "Read-only evidence-backed ASK over Memory evidence. Returns grounded answer status, citations, active/superseded/contradictory evidence, gap analysis, and provider cost metadata when available.",
    },
  },
  execute: (ctx, input) => ask(ctx.store, input.question, { rootDir: ctx.rootDir }),
};

const ASSET_INVENTORY_OPERATION: MemoryOperationDefinition<
  OperationSchemas.AssetInventoryInput,
  MemoryAssetInventoryReport
> = {
  id: "memory.asset-inventory",
  title: "Memory asset inventory",
  description: "Read-only inventory of binary document and media assets indexed in RedDB.",
  inputSchema: OperationSchemas.AssetInventoryInputSchema,
  outputSchema: OperationSchemas.AssetInventoryOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "none",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "assets", supportsJson: true },
    mcp: {
      toolName: "memory_asset_inventory",
      description:
        "Read-only inventory of binary document/media assets indexed by memory ingest. Returns asset kind, media type, size, hash, rid, and source path without reading binary bodies or claiming OCR/transcripts.",
    },
  },
  execute: (ctx, input) => buildMemoryAssetInventory(ctx.store, input),
};

const ASSET_INVENTORY_VIEWER_OPERATION: MemoryOperationDefinition<
  OperationSchemas.AssetInventoryInput,
  MemoryAssetInventoryViewerArtifact
> = {
  id: "memory.asset-inventory-viewer",
  title: "Memory asset inventory viewer",
  description: "Self-contained HTML viewer for the RedDB asset inventory.",
  inputSchema: OperationSchemas.AssetInventoryInputSchema,
  outputSchema: OperationSchemas.AssetInventoryViewerOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "none",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "assets-viewer", supportsJson: false },
    mcp: {
      toolName: "memory_asset_inventory_viewer",
      description:
        "Read-only self-contained HTML viewer for indexed binary document/media assets. Returns embedded JSON and HTML without reading asset bodies.",
    },
  },
  execute: async (ctx, input) =>
    buildMemoryAssetInventoryViewerArtifact(
      await buildMemoryAssetInventory(ctx.store, input),
    ),
};

const READINESS_OPERATION: MemoryOperationDefinition<OperationSchemas.ReadinessInput, MemoryReadinessEnvelope> = {
  id: "memory.readiness",
  title: "Memory readiness",
  description: "Stable readiness envelope for an implementation goal.",
  inputSchema: OperationSchemas.ReadinessInputSchema,
  outputSchema: OperationSchemas.ReadinessOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "cache-write",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "readiness", supportsJson: true },
    mcp: {
      toolName: "memory_readiness",
      description:
        "Read-only Memory readiness envelope (memory.readiness.v1) for a goal, including evidence, retrieval, trust, privacy, claim-check, skill, learning-debt, and next-action signals.",
    },
  },
  execute: (ctx, input) =>
    buildReadinessEnvelope(ctx.store, input.goal, {
      limit: input.limit,
      minEvidence: input.min_evidence,
      staleDays: input.stale_days,
      now: ctx.now,
      scope: OperationHelpers.scopeFromInput(input),
    }),
};

const CONTEXT_PACK_OPERATION: MemoryOperationDefinition<OperationSchemas.ContextPackInput, ContextPack> = {
  id: "memory.context-pack",
  title: "Memory context pack",
  description: "Agent-ready context pack for a goal from active Memory evidence.",
  inputSchema: OperationSchemas.ContextPackInputSchema,
  outputSchema: OperationSchemas.ContextPackOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "cache-write",
  capabilities: ["graph-store"],
  renderer: {
    cli: {
      command: "context-pack",
      supportsJson: true,
      presentation: {
        render: (output) => {
          const pack = output as ContextPack;
          return renderToonOutput({
            rowsKey: "entries",
            rows: pack.entries.map((entry) => ({
              section: entry.section,
              title: entry.title,
              nodeType: entry.nodeType,
              importance: entry.importance,
              confidence: entry.confidence,
              trust: entry.trust,
              citation: entry.citation.urn,
              reason: entry.reason,
              excerpt: entry.excerpt,
              expandHandle: entry.expandHandle,
            })),
            fields: [
              "section",
              "title",
              "nodeType",
              "importance",
              "confidence",
              "trust",
              "citation",
              "reason",
              "excerpt",
              "expandHandle",
            ],
            summary: {
              status: pack.status,
              goal: pack.goal,
              entries: pack.entries.length,
              coreContext: pack.coreContext.length,
              warnings: pack.warnings.length,
              omittedEntries: pack.omittedEntries,
              budgetChars: pack.budgetChars,
              usedChars: pack.usedChars,
            },
            extra: {
              warnings: pack.warnings.map((warning) => ({
                kind: warning.kind,
                message: warning.message,
              })),
              ...(pack.entries.length === 0
                ? {
                    next:
                      'run `memory store "..." --root <root>` or `memory ingest . --root <root>`, then rerun context-pack',
                  }
                : {}),
            },
          });
        },
      },
    },
    mcp: {
      toolName: "memory_context_pack",
      description:
        "Read-only agent context pack for a goal. Returns grouped evidence, warnings, citations, markdown, and skill recommendations without writing graph facts.",
    },
  },
  execute: async (ctx, input) => {
    const pack = await buildContextPack(ctx.store, input.goal, {
      budgetChars: input.budget_chars,
      limit: input.limit,
      depth: input.depth,
      now: ctx.now,
      scope: OperationHelpers.scopeFromInput(input),
    });
    await appendContextPackGenerationEvent(ctx.store, {
      pack,
      surface: ctx.transportSurface ?? "operation",
      metadata: { operation_id: "memory.context-pack" },
    });
    return pack;
  },
};

const CONTEXT_PACK_VIEWER_OPERATION: MemoryOperationDefinition<
  OperationSchemas.ContextPackInput,
  ContextPackViewerArtifact
> = {
  id: "memory.context-pack-viewer",
  title: "Memory context pack viewer",
  description: "Self-contained HTML viewer for agent-ready Memory context packs.",
  inputSchema: OperationSchemas.ContextPackInputSchema,
  outputSchema: OperationSchemas.ContextPackViewerOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "cache-write",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "context-pack-viewer", supportsJson: false },
    mcp: {
      toolName: "memory_context_pack_viewer",
      description:
        "Read-only self-contained HTML viewer for agent context packs. Returns grouped evidence, warnings, citations, skill recommendations, ready-to-inject markdown, embedded JSON, and HTML.",
    },
  },
  execute: async (ctx, input) => {
    const pack = await buildContextPack(ctx.store, input.goal, {
      budgetChars: input.budget_chars,
      limit: input.limit,
      depth: input.depth,
      now: ctx.now,
      scope: OperationHelpers.scopeFromInput(input),
    });
    await appendContextPackGenerationEvent(ctx.store, {
      pack,
      surface: ctx.transportSurface ?? "operation-viewer",
      metadata: { operation_id: "memory.context-pack-viewer" },
    });
    return buildContextPackViewerArtifact(pack);
  },
};

const MAP_CONTEXT_OPERATION: MemoryOperationDefinition<
  OperationSchemas.MapContextInput,
  MemoryMapContextSlice
> = {
  id: "memory.map-context",
  title: "Memory map context",
  description:
    "Graphify-style compact graph slice for orienting code agents before broad source reads.",
  inputSchema: OperationSchemas.MapContextInputSchema,
  outputSchema: OperationSchemas.MapContextOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "none",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "map-context", supportsJson: true },
    mcp: {
      toolName: "memory_map_context",
      description:
        "Read-only RedDB graph context slice for code agents. Scores node seeds from a query, traverses typed edges, returns compact NODE/EDGE markdown plus JSON metadata with edge weight, salience, confidence, and diagnostics.",
    },
  },
  execute: (ctx, input) =>
    buildMemoryMapContextSlice(ctx.store, input.query, {
      depth: input.depth,
      mode: input.mode,
      tokenBudget: input.budget,
      contextFilters:
        typeof input.context === "string"
          ? input.context.split(",").map((part) => part.trim()).filter(Boolean)
          : input.context,
      now: ctx.now,
    }),
};

const CLAIM_CHECK_OPERATION: MemoryOperationDefinition<OperationSchemas.ClaimCheckInput, ClaimCheckResult> = {
  id: "memory.claim-check",
  title: "Memory claim-check",
  description: "Verify an assertion against local Memory evidence.",
  inputSchema: OperationSchemas.ClaimCheckInputSchema,
  outputSchema: OperationSchemas.ClaimCheckOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "cache-write",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "claim-check", supportsJson: true },
    mcp: {
      toolName: "memory_claim_check",
      description:
        "Read-only claim-check against local Memory evidence. Returns supported/contradicted/superseded/insufficient status with citations and conflicting evidence.",
    },
  },
  execute: (ctx, input) => claimCheck(ctx.store, input.assertion),
};

const MAP_CONTRACT_OPERATION: MemoryOperationDefinition<OperationSchemas.MapContractInput, GraphContract> = {
  id: "memory.map-contract",
  title: "Memory map consumer contract",
  description:
    "Read-only RedDB Memory map contract for graph consumers. Returns canonical nodes, edges, stats, provenance, confidence, source location, freshness, weight, and salience without UI layout or styling decisions.",
  inputSchema: OperationSchemas.MapContractInputSchema,
  outputSchema: OperationSchemas.MapContractOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "none",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "map-contract", supportsJson: true, defaultFormat: "json" },
    mcp: {
      toolName: "memory_map_contract",
      description:
        "Read-only Memory map consumer contract over RedDB. Returns the versioned graph contract with canonical node/edge data, provenance, confidence, source locations, freshness, edge weight, and edge salience. It intentionally excludes layout, palette, opacity, label visibility, and interaction decisions.",
    },
  },
  execute: (ctx, input) => OperationHelpers.buildMemoryMapContract(ctx.store, input),
};

const CAPABILITY_CATALOG_OPERATION: MemoryOperationDefinition<
  OperationSchemas.CapabilityCatalogInput,
  MemoryCapabilityCatalog
> = {
  id: "memory.capability-catalog",
  title: "Memory capability catalog",
  description: "Read-only catalog of Memory reference capabilities and agent surfaces.",
  inputSchema: OperationSchemas.CapabilityCatalogInputSchema,
  outputSchema: OperationSchemas.CapabilityCatalogOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "none",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "capabilities", supportsJson: true },
    mcp: {
      toolName: "memory_capability_catalog",
      description:
        "Read-only capability catalog. Groups Memory features across retrieval, docs, vectors, UI, hooks, code graph, governance, telemetry, and interop with CLI/MCP entry points and reference evidence IDs.",
    },
  },
  execute: (ctx) => buildMemoryCapabilityCatalog(ctx.store, ctx.rootDir ?? process.cwd()),
};

const REFERENCE_RADAR_OPERATION: MemoryOperationDefinition<
  OperationSchemas.ReferenceRadarInput,
  MemoryReferenceRadar
> = {
  id: "memory.references-radar",
  title: "Memory references radar",
  description:
    "Read-only internal references posture report derived from the Memory capability catalog.",
  inputSchema: OperationSchemas.ReferenceRadarInputSchema,
  outputSchema: OperationSchemas.ReferenceRadarOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "none",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "references-radar", supportsJson: true },
    mcp: {
      toolName: "memory_references_radar",
      description:
        "Read-only internal references radar. Maps capability catalog evidence to respectful reference axes, highlights degraded/not-configured gaps, and returns next actions without making public benchmark claims.",
    },
  },
  execute: (ctx) => buildMemoryReferenceRadar(ctx.store, ctx.rootDir ?? process.cwd(), { now: ctx.now }),
};

const HANDOFF_OPERATION: MemoryOperationDefinition<OperationSchemas.HandoffInput, MemoryHandoffReport> = {
  id: "memory.handoff",
  title: "Memory handoff",
  description: "Read-only cross-agent handoff brief generated from recent Memory graph evidence.",
  inputSchema: OperationSchemas.HandoffInputSchema,
  outputSchema: OperationSchemas.HandoffOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "none",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "handoff", supportsJson: true },
    mcp: {
      toolName: "memory_handoff",
      description:
        "Read-only cross-agent handoff brief. Returns active work, recent decisions, validation evidence, risks, relevant context, citations, and ready-to-inject markdown without reading raw transcripts or mutating Memory.",
    },
  },
  execute: (ctx, input) =>
    buildMemoryHandoff(ctx.store, {
      focus: input.focus,
      limit: input.limit,
      now: ctx.now,
    }),
};

const HANDOFF_VIEWER_OPERATION: MemoryOperationDefinition<
  OperationSchemas.HandoffInput,
  MemoryHandoffViewerArtifact
> = {
  id: "memory.handoff-viewer",
  title: "Memory handoff viewer",
  description: "Self-contained HTML viewer for cross-agent Memory handoff evidence.",
  inputSchema: OperationSchemas.HandoffInputSchema,
  outputSchema: OperationSchemas.HandoffViewerOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "none",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "handoff-viewer", supportsJson: false },
    mcp: {
      toolName: "memory_handoff_viewer",
      description:
        "Read-only self-contained HTML viewer for cross-agent Memory handoffs. Returns active work, decisions, validations, risks, context, ready-to-inject markdown, embedded JSON, and HTML.",
    },
  },
  execute: async (ctx, input) =>
    buildMemoryHandoffViewerArtifact(
      await buildMemoryHandoff(ctx.store, {
        focus: input.focus,
        limit: input.limit,
        now: ctx.now,
      }),
    ),
};

const WORK_FRONTIER_OPERATION: MemoryOperationDefinition<
  OperationSchemas.WorkFrontierInput,
  WorkFrontierReport
> = {
  id: "memory.work-frontier",
  title: "Memory work frontier",
  description: "Read-only ready/blocked work frontier derived from Memory graph evidence.",
  inputSchema: OperationSchemas.WorkFrontierInputSchema,
  outputSchema: OperationSchemas.WorkFrontierOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "none",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "frontier", supportsJson: true },
    mcp: {
      toolName: "memory_work_frontier",
      description:
        "Read-only work frontier over Memory task/goal/issue/PRD evidence. Returns ready, blocked, completed, dependency blockers, priorities, citations, markdown, and next actions without mutating work state.",
    },
  },
  execute: (ctx, input) =>
    buildWorkFrontier(ctx.store, {
      focus: input.focus,
      limit: input.limit,
      now: ctx.now,
    }),
};

const WORK_FRONTIER_VIEWER_OPERATION: MemoryOperationDefinition<
  OperationSchemas.WorkFrontierInput,
  WorkFrontierViewerArtifact
> = {
  id: "memory.work-frontier-viewer",
  title: "Memory work frontier viewer",
  description: "Self-contained HTML viewer for the Memory work frontier.",
  inputSchema: OperationSchemas.WorkFrontierInputSchema,
  outputSchema: OperationSchemas.WorkFrontierViewerOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "none",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "frontier-viewer", supportsJson: false },
    mcp: {
      toolName: "memory_work_frontier_viewer",
      description:
        "Read-only self-contained HTML viewer for ready/blocked Memory work. Returns priorities, blockers, citations, markdown, embedded JSON, and HTML without mutating work state.",
    },
  },
  execute: async (ctx, input) =>
    buildWorkFrontierViewerArtifact(
      await buildWorkFrontier(ctx.store, {
        focus: input.focus,
        limit: input.limit,
        now: ctx.now,
      }),
    ),
};

const CONFIDENCE_OPERATION: MemoryOperationDefinition<OperationSchemas.ConfidenceInput, ConfidenceReport> = {
  id: "memory.confidence",
  title: "Memory confidence breakdown",
  description:
    "Read-only composed confidence (0..1) plus per-signal breakdown for a Memory node (issue #167).",
  inputSchema: OperationSchemas.ConfidenceInputSchema,
  outputSchema: OperationSchemas.ConfidenceOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "none",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "confidence", supportsJson: true },
    mcp: {
      toolName: "memory_confidence",
      description:
        "Read-only composed confidence breakdown for a Memory node. Returns the [0,1] score, per-signal components (provenance, recency, supersession, validation), and raw signals.",
    },
  },
  execute: async (ctx, input) => {
    const report = await buildConfidenceReport(ctx.store, input.node);
    if (!report) throw new Error(`memory: no node with rid=${input.node}`);
    return report;
  },
};

const PATH_EXPLAIN_OPERATION: MemoryOperationDefinition<OperationSchemas.PathExplainInput, PathExplainReport> = {
  id: "memory.path-explain",
  title: "Memory path explanation",
  description: "Read-only explained graph path between two Memory labels.",
  inputSchema: OperationSchemas.PathExplainInputSchema,
  outputSchema: OperationSchemas.PathExplainOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "none",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "path-explain", supportsJson: true },
    mcp: {
      toolName: "memory_path_explain",
      description:
        "Read-only explained graph path between two Memory labels. Returns reachable status, hop count, node sequence, edge labels, citations, and markdown for agent reasoning.",
    },
  },
  execute: (ctx, input) =>
    buildPathExplainReport(ctx.store, {
      from: input.from,
      to: input.to,
      maxDepth: input.max_depth,
    }),
};

const PATH_EXPLAIN_VIEWER_OPERATION: MemoryOperationDefinition<
  OperationSchemas.PathExplainInput,
  PathExplainViewerArtifact
> = {
  id: "memory.path-explain-viewer",
  title: "Memory path explanation viewer",
  description: "Self-contained HTML viewer for a Memory graph path explanation.",
  inputSchema: OperationSchemas.PathExplainInputSchema,
  outputSchema: OperationSchemas.PathExplainViewerOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "none",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "path-explain-viewer", supportsJson: false },
    mcp: {
      toolName: "memory_path_explain_viewer",
      description:
        "Read-only self-contained HTML viewer for a Memory graph path explanation. Returns path nodes, edge labels, recommendations, embedded JSON, and HTML without writing a file.",
    },
  },
  execute: async (ctx, input) =>
    buildPathExplainViewerArtifact(
      await buildPathExplainReport(ctx.store, {
        from: input.from,
        to: input.to,
        maxDepth: input.max_depth,
      }),
    ),
};

const DOC_SEARCH_OPERATION: MemoryOperationDefinition<OperationSchemas.DocSearchInput, DocSearchReport> = {
  id: "memory.doc-search",
  title: "Memory doc search",
  description: "Zero-token search over ingested Memory document chunks.",
  inputSchema: OperationSchemas.DocSearchInputSchema,
  outputSchema: OperationSchemas.DocSearchOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "none",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "docs search", supportsJson: true },
    mcp: {
      toolName: "memory_doc_search",
      description:
        "Read-only zero-token search over ingested memory_docs chunks. Returns matching document paths, titles, short excerpts, matched fields, and scores without calling an LLM.",
    },
  },
  execute: (ctx, input) => searchDocs(ctx.store, input.query, { limit: input.limit }),
};

const DOC_SEARCH_VIEWER_OPERATION: MemoryOperationDefinition<
  OperationSchemas.DocSearchInput,
  DocSearchViewerArtifact
> = {
  id: "memory.doc-search-viewer",
  title: "Memory doc search viewer",
  description: "Self-contained HTML viewer for doc search results.",
  inputSchema: OperationSchemas.DocSearchInputSchema,
  outputSchema: OperationSchemas.DocSearchViewerOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "none",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "docs search-viewer", supportsJson: false },
    mcp: {
      toolName: "memory_doc_search_viewer",
      description:
        "Read-only self-contained HTML viewer for ingested docs search results. Returns embedded JSON and links to read, brief, bundle, and evidence-pack viewers.",
    },
  },
  execute: async (ctx, input) =>
    buildDocSearchViewerArtifact(
      await searchDocs(ctx.store, input.query, { limit: input.limit }),
    ),
};

const DOC_BUNDLE_OPERATION: MemoryOperationDefinition<OperationSchemas.DocBundleInput, DocBundle> = {
  id: "memory.doc-bundle",
  title: "Memory doc bundle",
  description: "Agent-ready bundle of top docs for a query with evidence packs.",
  inputSchema: OperationSchemas.DocBundleInputSchema,
  outputSchema: OperationSchemas.DocBundleOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "none",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "docs bundle", supportsJson: true },
    mcp: {
      toolName: "memory_doc_bundle",
      description:
        "Read-only agent-ready documentation bundle for a query. Searches ingested memory_docs, builds evidence packs for top hits, and returns consolidated markdown without calling an LLM.",
    },
  },
  execute: (ctx, input) => buildDocBundle(ctx.store, input),
};

const DOC_BRIEF_OPERATION: MemoryOperationDefinition<OperationSchemas.DocBundleInput, DocBrief> = {
  id: "memory.doc-brief",
  title: "Memory doc brief",
  description: "Citation-first docs evidence brief with gap analysis.",
  inputSchema: OperationSchemas.DocBundleInputSchema,
  outputSchema: OperationSchemas.DocBriefOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "none",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "docs brief", supportsJson: true },
    mcp: {
      toolName: "memory_doc_brief",
      description:
        "Read-only citation-first brief over ingested memory_docs. Searches docs, composes bundle evidence, emits [D#] citations, gaps, next actions, and ready-to-inject markdown without calling an LLM.",
    },
  },
  execute: (ctx, input) => buildDocBrief(ctx.store, input),
};

const DOC_BRIEF_VIEWER_OPERATION: MemoryOperationDefinition<
  OperationSchemas.DocBundleInput,
  DocBriefViewerArtifact
> = {
  id: "memory.doc-brief-viewer",
  title: "Memory doc brief viewer",
  description: "Self-contained HTML viewer for a citation-first docs brief.",
  inputSchema: OperationSchemas.DocBundleInputSchema,
  outputSchema: OperationSchemas.DocBriefViewerOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "none",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "docs brief-viewer", supportsJson: false },
    mcp: {
      toolName: "memory_doc_brief_viewer",
      description:
        "Read-only self-contained HTML viewer for a citation-first documentation brief. Returns embedded JSON, [D#] citations, gaps, next actions, and ready-to-inject markdown.",
    },
  },
  execute: async (ctx, input) =>
    buildDocBriefViewerArtifact(await buildDocBrief(ctx.store, input)),
};

const DOC_BUNDLE_VIEWER_OPERATION: MemoryOperationDefinition<
  OperationSchemas.DocBundleInput,
  DocBundleViewerArtifact
> = {
  id: "memory.doc-bundle-viewer",
  title: "Memory doc bundle viewer",
  description: "Self-contained HTML viewer for a query-level document bundle.",
  inputSchema: OperationSchemas.DocBundleInputSchema,
  outputSchema: OperationSchemas.DocBundleViewerOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "none",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "docs bundle-viewer", supportsJson: false },
    mcp: {
      toolName: "memory_doc_bundle_viewer",
      description:
        "Read-only self-contained HTML viewer for a query-level documentation bundle. Searches ingested memory_docs, builds evidence packs for top hits, and returns embedded JSON plus agent-ready markdown.",
    },
  },
  execute: async (ctx, input) =>
    buildDocBundleViewerArtifact(await buildDocBundle(ctx.store, input)),
};

const DOC_READ_OPERATION: MemoryOperationDefinition<OperationSchemas.DocReadInput, DocReadResult> = {
  id: "memory.doc-read",
  title: "Memory doc read",
  description: "Read an ingested Memory document chunk by path or rid.",
  inputSchema: OperationSchemas.DocReadInputSchema,
  outputSchema: OperationSchemas.DocReadOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "none",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "docs read", supportsJson: true },
    mcp: {
      toolName: "memory_doc_read",
      description:
        "Read-only access to an ingested memory_docs chunk by path or rid. Returns body text, metadata, and truncation status without calling an LLM.",
    },
  },
  execute: (ctx, input) => readDoc(ctx.store, input),
};

const DOC_EVIDENCE_PACK_OPERATION: MemoryOperationDefinition<
  OperationSchemas.DocEvidencePackInput,
  DocEvidencePack
> = {
  id: "memory.doc-evidence-pack",
  title: "Memory doc evidence pack",
  description: "Agent-ready document context pack with body, references, and related docs.",
  inputSchema: OperationSchemas.DocEvidencePackInputSchema,
  outputSchema: OperationSchemas.DocEvidencePackOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "none",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "docs evidence-pack", supportsJson: true },
    mcp: {
      toolName: "memory_doc_evidence_pack",
      description:
        "Read-only agent-ready context pack for one ingested memory_docs chunk. Returns the indexed body, extracted REFERENCES, related docs, warnings, and ready-to-inject markdown.",
    },
  },
  execute: (ctx, input) => buildDocEvidencePack(ctx.store, input),
};

const DOC_EVIDENCE_PACK_VIEWER_OPERATION: MemoryOperationDefinition<
  OperationSchemas.DocEvidencePackInput,
  DocEvidencePackViewerArtifact
> = {
  id: "memory.doc-evidence-pack-viewer",
  title: "Memory doc evidence pack viewer",
  description: "Self-contained HTML viewer for one document evidence pack.",
  inputSchema: OperationSchemas.DocEvidencePackInputSchema,
  outputSchema: OperationSchemas.DocEvidencePackViewerOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "none",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "docs evidence-pack-viewer", supportsJson: false },
    mcp: {
      toolName: "memory_doc_evidence_pack_viewer",
      description:
        "Read-only self-contained HTML viewer for one ingested doc evidence pack. Returns embedded JSON, indexed body markdown, extracted references, related docs, and warnings.",
    },
  },
  execute: async (ctx, input) =>
    buildDocEvidencePackViewerArtifact(await buildDocEvidencePack(ctx.store, input)),
};

const DOC_BACKLINKS_OPERATION: MemoryOperationDefinition<OperationSchemas.DocBacklinksInput, DocBacklinksReport> = {
  id: "memory.doc-backlinks",
  title: "Memory doc backlinks",
  description: "Find indexed docs that reference one Memory node.",
  inputSchema: OperationSchemas.DocBacklinksInputSchema,
  outputSchema: OperationSchemas.DocBacklinksOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "none",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "docs backlinks", supportsJson: true },
    mcp: {
      toolName: "memory_doc_backlinks",
      description:
        "Read-only inverse documentation reference report. Given a referenced node rid, label, title, or query, returns ingested memory_docs chunks that point at it through extracted REFERENCES edges.",
    },
  },
  execute: (ctx, input) => buildDocBacklinksReport(ctx.store, input),
};

const DOC_BACKLINKS_VIEWER_OPERATION: MemoryOperationDefinition<
  OperationSchemas.DocBacklinksInput,
  DocBacklinksViewerArtifact
> = {
  id: "memory.doc-backlinks-viewer",
  title: "Memory doc backlinks viewer",
  description: "Self-contained HTML viewer for document backlinks.",
  inputSchema: OperationSchemas.DocBacklinksInputSchema,
  outputSchema: OperationSchemas.DocBacklinksViewerOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "none",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "docs backlinks-viewer", supportsJson: false },
    mcp: {
      toolName: "memory_doc_backlinks_viewer",
      description:
        "Read-only self-contained HTML viewer for inverse documentation references. Given a referenced node rid, label, title, or query, returns embedded JSON and HTML for docs pointing at it.",
    },
  },
  execute: async (ctx, input) =>
    buildDocBacklinksViewerArtifact(await buildDocBacklinksReport(ctx.store, input)),
};

const DOC_RELATED_OPERATION: MemoryOperationDefinition<OperationSchemas.DocRelatedInput, DocRelatedReport> = {
  id: "memory.doc-related",
  title: "Memory doc related",
  description: "Find references and related docs for one ingested Memory document.",
  inputSchema: OperationSchemas.DocRelatedInputSchema,
  outputSchema: OperationSchemas.DocRelatedOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "none",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "docs related", supportsJson: true },
    mcp: {
      toolName: "memory_doc_related",
      description:
        "Read-only related-document report for an ingested memory_docs chunk by path or rid. Returns extracted references and other docs that share those references.",
    },
  },
  execute: (ctx, input) => buildDocRelatedReport(ctx.store, input),
};

const DOC_RELATED_VIEWER_OPERATION: MemoryOperationDefinition<
  OperationSchemas.DocRelatedInput,
  DocRelatedViewerArtifact
> = {
  id: "memory.doc-related-viewer",
  title: "Memory doc related viewer",
  description: "Self-contained HTML viewer for references and related docs.",
  inputSchema: OperationSchemas.DocRelatedInputSchema,
  outputSchema: OperationSchemas.DocRelatedViewerOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "none",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "docs related-viewer", supportsJson: false },
    mcp: {
      toolName: "memory_doc_related_viewer",
      description:
        "Read-only self-contained HTML viewer for one ingested doc's extracted references and related docs. Returns embedded JSON and HTML without writing Memory.",
    },
  },
  execute: async (ctx, input) =>
    buildDocRelatedViewerArtifact(await buildDocRelatedReport(ctx.store, input)),
};

export const CORE_MEMORY_OPERATIONS = [
  ASK_OPERATION,
  ASSET_INVENTORY_OPERATION,
  ASSET_INVENTORY_VIEWER_OPERATION,
  READINESS_OPERATION,
  CONTEXT_PACK_OPERATION,
  CONTEXT_PACK_VIEWER_OPERATION,
  MAP_CONTEXT_OPERATION,
  CLAIM_CHECK_OPERATION,
  MAP_CONTRACT_OPERATION,
  CAPABILITY_CATALOG_OPERATION,
  REFERENCE_RADAR_OPERATION,
  HANDOFF_OPERATION,
  HANDOFF_VIEWER_OPERATION,
  WORK_FRONTIER_OPERATION,
  WORK_FRONTIER_VIEWER_OPERATION,
  CONFIDENCE_OPERATION,
  PATH_EXPLAIN_OPERATION,
  PATH_EXPLAIN_VIEWER_OPERATION,
  DOC_SEARCH_OPERATION,
  DOC_SEARCH_VIEWER_OPERATION,
  DOC_BUNDLE_OPERATION,
  DOC_BRIEF_OPERATION,
  DOC_BRIEF_VIEWER_OPERATION,
  DOC_BUNDLE_VIEWER_OPERATION,
  DOC_READ_OPERATION,
  DOC_EVIDENCE_PACK_OPERATION,
  DOC_EVIDENCE_PACK_VIEWER_OPERATION,
  DOC_BACKLINKS_OPERATION,
  DOC_BACKLINKS_VIEWER_OPERATION,
  DOC_RELATED_OPERATION,
  DOC_RELATED_VIEWER_OPERATION,
] as const;
