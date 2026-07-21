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

const GLOBAL_SEARCH_OPERATION: MemoryOperationDefinition<
  OperationSchemas.GlobalSearchInput,
  MemoryGlobalSearchReport
> = {
  id: "memory.global-search",
  title: "Memory global search",
  description:
    "Read-only opt-in broad search over Community digest evidence; never enters or re-ranks canonical memory recall.",
  inputSchema: OperationSchemas.GlobalSearchInputSchema,
  outputSchema: OperationSchemas.GlobalSearchOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "none",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "global-search", supportsJson: true },
    mcp: {
      toolName: "memory_global_search",
      description:
        "Read-only opt-in broad search over Community digest evidence for zoom-out questions. Returns digest-level evidence, matched terms, source graph hash/provider metadata, and markdown. It is separate from canonical governed recall and never alters recall ranking.",
    },
  },
  execute: (ctx, input) =>
    buildMemoryGlobalSearch(ctx.store, input.query, {
      cache: input.cache,
      limit: input.limit,
      providerConfig: ctx.providerConfig,
    }),
};

const RECALL_RANKING_OPERATION: MemoryOperationDefinition<
  OperationSchemas.RecallRankingInput,
  GraphRecallResult
> = {
  id: "memory.recall-ranking",
  title: "Memory recall ranking",
  description:
    "Read-only governed recall through the deterministic ranking pipeline: candidate retrieval, query-variant RRF, recency decay, MMR diversity, and session round-robin interleaving.",
  inputSchema: OperationSchemas.RecallRankingInputSchema,
  outputSchema: OperationSchemas.RecallRankingOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "none",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "recall-ranked", supportsJson: true },
    mcp: {
      toolName: "memory_recall_ranked",
      description:
        "Read-only governed recall through the deterministic ranking pipeline. Returns ranked hits plus diagnostics; uses plugins.memory.recallRanking defaults and overrides when available.",
    },
  },
  execute: (ctx, input) =>
    graphRecallResult(ctx.store, input.query, input.limit ?? 10, {
      includeSuperseded: input.include_superseded,
      scope: OperationHelpers.scopeFromInput(input),
      now: ctx.now,
      ranking: ctx.memoryConfig?.recallRanking,
    }),
};

const ONBOARDING_MAP_OPERATION: MemoryOperationDefinition<OperationSchemas.OnboardingMapInput, OnboardingMap> = {
  id: "memory.onboarding-map",
  title: "Memory onboarding map",
  description: "Read-only map-first onboarding summary from the Memory graph.",
  inputSchema: OperationSchemas.OnboardingMapInputSchema,
  outputSchema: OperationSchemas.OnboardingMapOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "none",
  capabilities: ["graph-store"],
  renderer: {
    cli: {
      command: "onboarding-map",
      supportsJson: true,
      reservedSubcommands: ["export"],
    },
    mcp: {
      toolName: "memory_onboarding_map",
      description:
        "Read-only map-first onboarding summary from Memory graph evidence. Returns concepts, workflows, decisions, risks, validations, suggested skills, warnings, and markdown.",
    },
  },
  execute: async (ctx, input) =>
    buildOnboardingMap(ctx.store, {
      staleDays: input.stale_days,
      rollups: await OperationHelpers.safeSkillRollups(ctx.store),
    }),
};

const ONBOARDING_MAP_VIEWER_OPERATION: MemoryOperationDefinition<
  OperationSchemas.OnboardingMapInput,
  OnboardingMapViewerArtifact
> = {
  id: "memory.onboarding-map-viewer",
  title: "Memory onboarding map viewer",
  description: "Self-contained HTML map-first onboarding viewer from Memory graph evidence.",
  inputSchema: OperationSchemas.OnboardingMapInputSchema,
  outputSchema: OperationSchemas.OnboardingMapViewerOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "none",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "onboarding-map-viewer", supportsJson: false },
    mcp: {
      toolName: "memory_onboarding_map_viewer",
      description:
        "Read-only self-contained HTML viewer for Memory onboarding maps. Returns concepts, workflows, decisions, risks, validations, suggested skills, warnings, embedded JSON, and HTML.",
    },
  },
  execute: async (ctx, input) =>
    buildOnboardingMapViewerArtifact(
      await buildOnboardingMap(ctx.store, {
        staleDays: input.stale_days,
        rollups: await OperationHelpers.safeSkillRollups(ctx.store),
      }),
    ),
};

const DASHBOARD_OPERATION: MemoryOperationDefinition<
  OperationSchemas.DashboardInput,
  MemoryOperationalDashboardArtifact
> = {
  id: "memory.dashboard",
  title: "Memory operational dashboard",
  description: "Self-contained HTML dashboard over Memory operational readiness.",
  inputSchema: OperationSchemas.DashboardInputSchema,
  outputSchema: OperationSchemas.DashboardOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "none",
  capabilities: ["graph-store"],
  renderer: {
    cli: {
      command: "dashboard",
      supportsJson: true,
      presentation: {
        viewerSink: "explicit",
        jsonOutput: (output) => (output as MemoryOperationalDashboardArtifact).dashboard,
        render: (output) => {
          const dashboard = (output as MemoryOperationalDashboardArtifact).dashboard;
          const sections = [
            {
              area: "stats",
              status: dashboard.state,
              metric: "nodes",
              value: dashboard.stats.nodes,
              detail: `${dashboard.stats.docs} docs; ${dashboard.stats.edges} edges`,
            },
            {
              area: "vector",
              status: dashboard.vector.overall,
              metric: "ready",
              value: dashboard.vector.ready,
              detail: `${dashboard.vector.total} total; ${dashboard.vector.unavailable} unavailable; ${dashboard.vector.failed} failed`,
            },
            {
              area: "docs",
              status: dashboard.docs.ungrounded > 0 ? "attention" : "ready",
              metric: "grounded",
              value: dashboard.docs.grounded,
              detail: `${dashboard.docs.total} total; ${dashboard.docs.warnings} warning(s)`,
            },
            {
              area: "hooks",
              status: dashboard.hooks.actionable_gaps > 0 ? "attention" : "ready",
              metric: "wired_events",
              value: dashboard.hooks.wired_events,
              detail: `${dashboard.hooks.enabled_events} enabled; ${dashboard.hooks.actionable_gaps} actionable gap(s)`,
            },
            {
              area: "extraction",
              status: dashboard.extraction.inferred_available ? "ready" : "unavailable",
              metric: "inferred_facts",
              value: dashboard.extraction.inferred_facts,
              detail: dashboard.extraction.egress ?? "no inferred extraction egress",
            },
            {
              area: "stale",
              status: dashboard.stale.stale_nodes > 0 ? "attention" : "ready",
              metric: "stale_nodes",
              value: dashboard.stale.stale_nodes,
              detail: `${dashboard.stale.total_nodes} total; ${dashboard.stale.stale_days} day policy`,
            },
            {
              area: "decay",
              status: dashboard.decay.status,
              metric: "review",
              value: dashboard.decay.review,
              detail: `${dashboard.decay.keep} keep; ${dashboard.decay.deprecate} deprecate; ${dashboard.decay.expire} expire`,
            },
          ];
          const empty = dashboard.stats.nodes === 0 && dashboard.stats.docs === 0;
          return renderToonOutput({
            rowsKey: "sections",
            rows: sections,
            fields: ["area", "status", "metric", "value", "detail"],
            summary: {
              status: empty ? "empty" : dashboard.state,
              state: dashboard.state,
              nodes: dashboard.stats.nodes,
              edges: dashboard.stats.edges,
              docs: dashboard.stats.docs,
              warnings: dashboard.warnings.length,
              actions: dashboard.recommended_next_actions.length + (empty ? 1 : 0),
              schema: dashboard.schema_version,
            },
            extra: {
              warnings: dashboard.warnings.map((message) => ({ message })),
              next: [
                ...dashboard.recommended_next_actions.map((action) => ({ action })),
                ...(empty
                  ? [
                      {
                        action:
                          "run `memory ingest . --root <root>` to populate dashboard evidence",
                      },
                    ]
                  : []),
              ],
            },
          });
        },
      },
    },
    mcp: {
      toolName: "memory_dashboard",
      description:
        "Read-only self-contained operational dashboard. Returns graph stats, document coverage, vector readiness, hook coverage, stale-node summary, recommendations, embedded JSON, and HTML without writing a file.",
    },
  },
  execute: async (ctx, input) =>
    buildMemoryOperationalDashboardArtifact(
      await buildMemoryOperationalDashboard(ctx.store, ctx.rootDir ?? process.cwd(), {
        staleDays: input.stale_days,
      }),
    ),
};

const WORKBENCH_OPERATION: MemoryOperationDefinition<OperationSchemas.WorkbenchInput, MemoryWorkbenchArtifact> = {
  id: "memory.workbench",
  title: "Memory workbench",
  description: "Self-contained HTML workbench combining Memory dashboard, capabilities, and session timeline.",
  transports: ["cli", "mcp"],
  inputSchema: OperationSchemas.WorkbenchInputSchema,
  outputSchema: OperationSchemas.WorkbenchOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "none",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "workbench", supportsJson: false },
    mcp: {
      toolName: "memory_workbench",
      description:
        "Read-only self-contained Memory workbench. Returns a unified local UI over operational dashboard, capability catalog, session timeline replay evidence, embedded JSON, and HTML without writing a file.",
    },
  },
  execute: async (ctx, input) =>
    buildMemoryWorkbenchArtifact(
      await buildMemoryWorkbench(ctx.store, ctx.rootDir ?? process.cwd(), {
        staleDays: input.stale_days,
        sessionId: input.session_id,
        limit: input.limit,
        now: ctx.now,
      }),
    ),
};

const READINESS_VIEWER_OPERATION: MemoryOperationDefinition<
  OperationSchemas.ReadinessInput,
  ReadinessViewerArtifact
> = {
  id: "memory.readiness-viewer",
  title: "Memory readiness viewer",
  description: "Self-contained HTML readiness viewer generated from memory.readiness.v1.",
  inputSchema: OperationSchemas.ReadinessInputSchema,
  outputSchema: OperationSchemas.ReadinessViewerOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "cache-write",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "readiness-viewer", supportsJson: false },
    mcp: {
      toolName: "memory_readiness_viewer",
      description:
        "Read-only self-contained HTML readiness viewer. Returns the memory.readiness.viewer.v1 artifact, embedded readiness envelope, and HTML without writing a file.",
    },
  },
  execute: async (ctx, input) =>
    buildReadinessViewerArtifact(
      await buildReadinessEnvelope(ctx.store, input.goal, {
        limit: input.limit,
        minEvidence: input.min_evidence,
        staleDays: input.stale_days,
        now: ctx.now,
        scope: OperationHelpers.scopeFromInput(input),
      }),
    ),
};

const ROUTING_GUIDE_OPERATION: MemoryOperationDefinition<OperationSchemas.RoutingGuideInput, MemoryRoutingGuide> = {
  id: "memory.routing-guide",
  title: "Memory routing guide",
  description:
    "Agent-ready Memory routing instructions for AGENTS.md or CLAUDE.md, including map context that narrows source reads before broad grep.",
  inputSchema: OperationSchemas.RoutingGuideInputSchema,
  outputSchema: OperationSchemas.RoutingGuideOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "none",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "routing-guide", supportsJson: true },
    mcp: {
      toolName: "memory_routing_guide",
      description:
        "Read-only Memory routing guide for agent rule files. Returns target files, recommended MCP tools, CLI fallbacks, map-context examples for relation-filtered source-read routing, safety notes, and an installable AGENTS.md/CLAUDE.md snippet. The map context is agent context, not a generated answer.",
    },
  },
  execute: async (_ctx, input) =>
    buildMemoryRoutingGuide({ agent: input.agent as MemoryRoutingAgent | undefined }),
};

const ROUTING_GUIDE_VIEWER_OPERATION: MemoryOperationDefinition<
  OperationSchemas.RoutingGuideInput,
  MemoryRoutingGuideViewerArtifact
> = {
  id: "memory.routing-guide-viewer",
  title: "Memory routing guide viewer",
  description: "Self-contained HTML viewer for multi-agent Memory routing instructions.",
  inputSchema: OperationSchemas.RoutingGuideInputSchema,
  outputSchema: OperationSchemas.RoutingGuideViewerOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "none",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "routing-guide-viewer", supportsJson: false },
    mcp: {
      toolName: "memory_routing_guide_viewer",
      description:
        "Read-only self-contained HTML Memory routing guide viewer. Returns target files, recommended MCP tools, CLI fallbacks, safety notes, config snippets, and embedded JSON for a selected agent.",
    },
  },
  execute: async (_ctx, input) =>
    buildMemoryRoutingGuideViewerArtifact(
      buildMemoryRoutingGuide({ agent: input.agent as MemoryRoutingAgent | undefined }),
    ),
};

const AGENT_INTEGRATION_STATUS_OPERATION: MemoryOperationDefinition<
  OperationSchemas.RoutingGuideInput,
  MemoryAgentIntegrationStatus
> = {
  id: "memory.agent-integration-status",
  title: "Memory agent integration status",
  description: "Read-only audit of agent rule files, routing snippets, and hook coverage.",
  inputSchema: OperationSchemas.RoutingGuideInputSchema,
  outputSchema: OperationSchemas.AgentIntegrationStatusOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "none",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "integration-status", supportsJson: true },
    mcp: {
      toolName: "memory_agent_integration_status",
      description:
        "Read-only Memory agent integration status. Audits rule files, routing snippets, MCP/HTTP guidance, and hook coverage for supported agents.",
    },
  },
  execute: (ctx, input) =>
    buildMemoryAgentIntegrationStatus(ctx.rootDir ?? process.cwd(), {
      agent: input.agent as MemoryRoutingAgent | undefined,
      now: ctx.now,
    }),
};

const AGENT_INTEGRATION_STATUS_VIEWER_OPERATION: MemoryOperationDefinition<
  OperationSchemas.RoutingGuideInput,
  MemoryAgentIntegrationStatusViewerArtifact
> = {
  id: "memory.agent-integration-status-viewer",
  title: "Memory agent integration status viewer",
  description: "Self-contained HTML viewer for Memory agent integration status.",
  inputSchema: OperationSchemas.RoutingGuideInputSchema,
  outputSchema: OperationSchemas.AgentIntegrationStatusViewerOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "none",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "integration-status-viewer", supportsJson: false },
    mcp: {
      toolName: "memory_agent_integration_status_viewer",
      description:
        "Read-only self-contained HTML viewer for Memory agent integration status with embedded JSON.",
    },
  },
  execute: async (ctx, input) =>
    buildMemoryAgentIntegrationStatusViewerArtifact(
      await buildMemoryAgentIntegrationStatus(ctx.rootDir ?? process.cwd(), {
        agent: input.agent as MemoryRoutingAgent | undefined,
        now: ctx.now,
      }),
    ),
};

const SESSION_TIMELINE_OPERATION: MemoryOperationDefinition<OperationSchemas.SessionTimelineInput, SessionTimeline> = {
  id: "memory.session-timeline",
  title: "Memory session timeline",
  description: "Read-only replay-style timeline over Memory hook and skill telemetry events.",
  inputSchema: OperationSchemas.SessionTimelineInputSchema,
  outputSchema: OperationSchemas.SessionTimelineOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "none",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "session timeline", supportsJson: true },
    mcp: {
      toolName: "memory_session_timeline",
      description:
        "Read-only replay-style timeline over Memory session events. Returns hook lifecycle events, skill telemetry, per-session summaries, outcomes, and next actions without exposing raw transcripts.",
    },
  },
  execute: (ctx, input) =>
    buildSessionTimeline(ctx.store, {
      sessionId: input.session_id,
      limit: input.limit,
      now: ctx.now,
    }),
};

const SESSION_TIMELINE_VIEWER_OPERATION: MemoryOperationDefinition<
  OperationSchemas.SessionTimelineInput,
  SessionTimelineViewerArtifact
> = {
  id: "memory.session-timeline-viewer",
  title: "Memory session timeline viewer",
  description: "Self-contained HTML replay viewer over Memory hook and skill telemetry events.",
  inputSchema: OperationSchemas.SessionTimelineInputSchema,
  outputSchema: OperationSchemas.SessionTimelineViewerOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "none",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "session timeline-viewer", supportsJson: false },
    mcp: {
      toolName: "memory_session_timeline_viewer",
      description:
        "Read-only self-contained HTML session timeline viewer. Returns hook lifecycle events, skill telemetry, per-session summaries, outcomes, and embedded JSON without exposing raw transcripts.",
    },
  },
  execute: async (ctx, input) =>
    buildSessionTimelineViewerArtifact(
      await buildSessionTimeline(ctx.store, {
        sessionId: input.session_id,
        limit: input.limit,
        now: ctx.now,
      }),
    ),
};

const STRUCTURAL_IMPACT_OPERATION: MemoryOperationDefinition<
  OperationSchemas.StructuralImpactInput,
  StructuralImpact
> = {
  id: "memory.structural-impact",
  title: "Memory structural impact",
  description:
    "Read-only file/symbol impact query over ingested code graph evidence for agent map context before broad source reads.",
  inputSchema: OperationSchemas.StructuralImpactInputSchema,
  outputSchema: OperationSchemas.StructuralImpactOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "none",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "structural-impact", supportsJson: false },
    mcp: {
      toolName: "memory_structural_impact",
      description:
        "Read-only file/symbol impact query over ingested code graph evidence. Returns agent context for imports, imported-by edges, call/called-by edges, type-use edges, references, symbols defined by a file, and the file defining a symbol; use it to choose source reads, not as a generated answer.",
    },
  },
  execute: (ctx, input) =>
    structuralImpactReader(ctx.store)({
      file: input.file,
      symbol: input.symbol,
    }),
};

const STRUCTURAL_IMPACT_VIEWER_OPERATION: MemoryOperationDefinition<
  OperationSchemas.StructuralImpactInput,
  StructuralImpactViewerArtifact
> = {
  id: "memory.structural-impact-viewer",
  title: "Memory structural impact viewer",
  description: "Self-contained HTML structural impact viewer over code graph evidence.",
  inputSchema: OperationSchemas.StructuralImpactInputSchema,
  outputSchema: OperationSchemas.StructuralImpactViewerOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "none",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "structural-impact-viewer", supportsJson: false },
    mcp: {
      toolName: "memory_structural_impact_viewer",
      description:
        "Read-only self-contained HTML viewer for file/symbol impact. Returns imports, call edges, type-use edges, definitions, and embedded JSON without writing a file.",
    },
  },
  execute: async (ctx, input) =>
    buildStructuralImpactViewerArtifact(
      { file: input.file, symbol: input.symbol },
      await structuralImpactReader(ctx.store)({
        file: input.file,
        symbol: input.symbol,
      }),
    ),
};

const EXTRACTION_STATUS_OPERATION: MemoryOperationDefinition<
  OperationSchemas.ExtractionStatusInput,
  MemoryExtractionStatus
> = {
  id: "memory.extraction-status",
  title: "Memory extraction status",
  description: "Read-only status for deterministic and inferred Memory extraction paths.",
  inputSchema: OperationSchemas.ExtractionStatusInputSchema,
  outputSchema: OperationSchemas.ExtractionStatusOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "none",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "extraction status", supportsJson: true },
    mcp: {
      toolName: "memory_extraction_status",
      description:
        "Read-only status for Memory extraction. Returns deterministic extractor availability, local structured-transcript fallback readiness, inferred provider mode/model/egress, Stop hook readiness, inferred fact count, and next actions.",
    },
  },
  execute: (ctx) =>
    buildMemoryExtractionStatus(ctx.store, ctx.rootDir ?? process.cwd(), { now: ctx.now }),
};

const EXTRACTION_STATUS_VIEWER_OPERATION: MemoryOperationDefinition<
  OperationSchemas.ExtractionStatusInput,
  MemoryExtractionStatusViewerArtifact
> = {
  id: "memory.extraction-status-viewer",
  title: "Memory extraction status viewer",
  description: "Self-contained HTML viewer for deterministic and inferred extraction readiness.",
  inputSchema: OperationSchemas.ExtractionStatusInputSchema,
  outputSchema: OperationSchemas.ExtractionStatusViewerOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "none",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "extraction status-viewer", supportsJson: false },
    mcp: {
      toolName: "memory_extraction_status_viewer",
      description:
        "Read-only self-contained HTML viewer for extraction readiness. Returns deterministic extractor coverage, inferred provider status, Stop hook readiness, inferred fact counts, next actions, embedded JSON, and HTML without running extraction.",
    },
  },
  execute: async (ctx) =>
    buildMemoryExtractionStatusViewerArtifact(
      await buildMemoryExtractionStatus(ctx.store, ctx.rootDir ?? process.cwd(), { now: ctx.now }),
    ),
};

const MAP_FRESHNESS_OPERATION: MemoryOperationDefinition<
  OperationSchemas.MapFreshnessInput,
  MemoryMapFreshnessReport
> = {
  id: "memory.map-freshness",
  title: "Memory map freshness",
  description:
    "Read-only diagnostic report for whether the Memory map is fresh enough to trust.",
  inputSchema: OperationSchemas.MapFreshnessInputSchema,
  outputSchema: OperationSchemas.MapFreshnessOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "none",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "map freshness", supportsJson: true },
    mcp: {
      toolName: "memory_map_freshness",
      description:
        "Read-only Memory map freshness diagnostic. Returns source revision identity, changed/stale source inputs, extraction coverage by language/source kind, low-confidence or missing relationship classes, and concise next actions. Does not generate a visualization.",
    },
  },
  execute: (ctx) =>
    buildMemoryMapFreshnessReport(ctx.store, ctx.rootDir ?? process.cwd(), { now: ctx.now }),
};

const VECTOR_STATUS_OPERATION: MemoryOperationDefinition<OperationSchemas.VectorStatusInput, VectorStatusReport> = {
  id: "memory.vector-status",
  title: "Memory vector status",
  description: "Read-only vector projection readiness for hybrid recall.",
  inputSchema: OperationSchemas.VectorStatusInputSchema,
  outputSchema: OperationSchemas.VectorStatusOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "none",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "vector status", supportsJson: true },
    mcp: {
      toolName: "memory_vector_status",
      description:
        "Read-only vector projection readiness for hybrid recall. Returns ready/stale/unavailable/failed counts for provider embeddings or opt-in local-dev vectors.",
    },
  },
  execute: (ctx) => ctx.store.vectorStatus(),
};

const VECTOR_STATUS_VIEWER_OPERATION: MemoryOperationDefinition<
  OperationSchemas.VectorStatusInput,
  VectorStatusViewerArtifact
> = {
  id: "memory.vector-status-viewer",
  title: "Memory vector status viewer",
  description: "Self-contained HTML viewer for RedDB vector projection readiness.",
  inputSchema: OperationSchemas.VectorStatusInputSchema,
  outputSchema: OperationSchemas.VectorStatusViewerOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "none",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "vector status-viewer", supportsJson: false },
    mcp: {
      toolName: "memory_vector_status_viewer",
      description:
        "Read-only self-contained HTML viewer for RedDB vector projection readiness. Returns ready/stale/unavailable/failed counts, node and document target statuses, embedded JSON, and HTML without maintaining embeddings.",
    },
  },
  execute: async (ctx) => buildVectorStatusViewerArtifact(await ctx.store.vectorStatus()),
};

const VECTOR_SEARCH_OPERATION: MemoryOperationDefinition<OperationSchemas.VectorSearchInput, VectorSearchReport> = {
  id: "memory.vector-search",
  title: "Memory vector search",
  description: "Read-only diagnostic search over grounded vector candidates.",
  inputSchema: OperationSchemas.VectorSearchInputSchema,
  outputSchema: OperationSchemas.VectorSearchOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "none",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "vector search", supportsJson: true },
    mcp: {
      toolName: "memory_vector_search",
      description:
        "Read-only diagnostic search over grounded vector candidates. Returns vector-backed Memory node hits, scores, confidence, and excerpts, or an unavailable status when vector projection is not ready. Set RED_MEMORY_VECTOR_PROVIDER=local for deterministic local-dev vectors. Governed recall remains memory_recall.",
    },
  },
  execute: (ctx, input) =>
    buildVectorSearchReport(ctx.store, input.query, { limit: input.limit }),
};

const REASONING_REPLAY_OPERATION: MemoryOperationDefinition<
  OperationSchemas.ReasoningReplayInput,
  ReasoningReplayReport
> = {
  id: "memory.reasoning-replay",
  title: "Memory reasoning replay",
  description:
    "Read-only similarity ranking over reasoning-tier attempt nodes for a task descriptor.",
  inputSchema: OperationSchemas.ReasoningReplayInputSchema,
  outputSchema: OperationSchemas.ReasoningReplayOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "none",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "reasoning-replay", supportsJson: true },
    mcp: {
      toolName: "memory_reasoning_replay",
      description:
        "Read-only reasoning replay surface. Ranks past attempt nodes by semantic similarity to a task descriptor and returns top-K with attempt_id, similarity, when, and summary. Outcome attachment lands in a follow-up slice.",
    },
  },
  execute: (ctx, input) =>
    buildReasoningReplay(ctx.store, input.task, { limit: input.limit, now: ctx.now }),
};

const WHATIF_OPERATION: MemoryOperationDefinition<OperationSchemas.WhatifInput, WhatifReport> = {
  id: "memory.whatif",
  title: "Memory what-if (pre-action blast radius)",
  description:
    "Read-only pre-action blast-radius prediction. Composes structural-impact-reader and reasoning-replay to return affected files, symbols, tests, historical similar attempts, a composite breakage_likelihood, and a self_confidence score.",
  inputSchema: OperationSchemas.WhatifInputSchema,
  outputSchema: OperationSchemas.WhatifOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "none",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "whatif", supportsJson: true },
    mcp: {
      toolName: "memory_whatif",
      description:
        "Read-only what-if surface (memory.whatif.v1). Accepts a list of proposed changes (rename/delete/edit, each with file/symbol/with/description) and returns predicted blast radius: affected.files, affected.symbols, affected.tests, historical_attempts from reasoning-replay, breakage_likelihood in [0,1], and self_confidence in [0,1]. Never mutates state.",
    },
    http: { methods: ["GET", "POST"] },
  },
  execute: (ctx, input) =>
    buildWhatifReport(ctx.store, input.changes, { limit: input.limit, now: ctx.now }),
};

const FEDERATION_OPERATION: MemoryOperationDefinition<OperationSchemas.FederationInput, FederationReport> = {
  id: "memory.federation",
  title: "Memory federation",
  description:
    "Read-only cross-root federation. Reads memory notes from each configured root in .red/memory/federation.yaml and returns merged hits tagged with origin_repo. No privacy policy applied in this slice.",
  inputSchema: OperationSchemas.FederationInputSchema,
  outputSchema: OperationSchemas.FederationOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "none",
  capabilities: [],
  renderer: {
    cli: { command: "federate", supportsJson: true },
    mcp: {
      toolName: "memory_federate",
      description:
        "Read-only federation surface. Reads memory notes from every root listed in .red/memory/federation.yaml at the active project root, merges hits, and tags each with origin_repo. Returns an empty report when no config exists. Local roots only in this slice.",
    },
  },
  execute: (ctx, input) =>
    buildFederationReport(ctx.rootDir ?? process.cwd(), input.query, {
      limit: input.limit,
      perRootLimit: input.per_root_limit,
      now: ctx.now,
    }),
};

export const SYSTEM_MEMORY_OPERATIONS = [
  GLOBAL_SEARCH_OPERATION,
  RECALL_RANKING_OPERATION,
  ONBOARDING_MAP_OPERATION,
  ONBOARDING_MAP_VIEWER_OPERATION,
  DASHBOARD_OPERATION,
  WORKBENCH_OPERATION,
  READINESS_VIEWER_OPERATION,
  ROUTING_GUIDE_OPERATION,
  ROUTING_GUIDE_VIEWER_OPERATION,
  AGENT_INTEGRATION_STATUS_OPERATION,
  AGENT_INTEGRATION_STATUS_VIEWER_OPERATION,
  SESSION_TIMELINE_OPERATION,
  SESSION_TIMELINE_VIEWER_OPERATION,
  STRUCTURAL_IMPACT_OPERATION,
  STRUCTURAL_IMPACT_VIEWER_OPERATION,
  EXTRACTION_STATUS_OPERATION,
  EXTRACTION_STATUS_VIEWER_OPERATION,
  MAP_FRESHNESS_OPERATION,
  VECTOR_STATUS_OPERATION,
  VECTOR_STATUS_VIEWER_OPERATION,
  VECTOR_SEARCH_OPERATION,
  REASONING_REPLAY_OPERATION,
  WHATIF_OPERATION,
  FEDERATION_OPERATION,
] as const;
