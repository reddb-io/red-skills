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
  type HubReportRow,
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

const SMART_SEARCH_OPERATION: MemoryOperationDefinition<
  OperationSchemas.SmartSearchInput,
  MemorySmartSearchReport
> = {
  id: "memory.smart-search",
  title: "Memory smart search",
  description: "Unified governed recall, document search, and vector diagnostics.",
  inputSchema: OperationSchemas.SmartSearchInputSchema,
  outputSchema: OperationSchemas.SmartSearchOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "cache-write",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "smart-search", supportsJson: true },
    mcp: {
      toolName: "memory_smart_search",
      description:
        "Read-only smart search over Memory. Composes governed recall, ingested document search, and vector diagnostics into one result without making vector search the source of truth.",
    },
    http: { aliases: ["/api/search"] },
  },
  execute: (ctx, input) =>
    buildMemorySmartSearch(ctx.store, input.query, {
      limit: input.limit,
      depth: input.depth,
      recall: {
        scope: OperationHelpers.scopeFromInput(input),
        includeSuperseded: input.include_superseded,
      },
      now: ctx.now,
    }),
};

const SMART_SEARCH_VIEWER_OPERATION: MemoryOperationDefinition<
  OperationSchemas.SmartSearchInput,
  MemorySmartSearchViewerArtifact
> = {
  id: "memory.smart-search-viewer",
  title: "Memory smart search viewer",
  description: "Self-contained HTML viewer for fused Memory smart search results.",
  inputSchema: OperationSchemas.SmartSearchInputSchema,
  outputSchema: OperationSchemas.SmartSearchViewerOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "cache-write",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "smart-search-viewer", supportsJson: false },
    mcp: {
      toolName: "memory_smart_search_viewer",
      description:
        "Read-only self-contained HTML viewer for smart search. Returns fused recall/doc/asset/vector results, counts, recommendations, embedded JSON, and HTML without writing Memory.",
    },
    http: { aliases: ["/search"] },
  },
  execute: async (ctx, input) =>
    buildMemorySmartSearchViewerArtifact(
      await buildMemorySmartSearch(ctx.store, input.query, {
        limit: input.limit,
        depth: input.depth,
        recall: {
          scope: OperationHelpers.scopeFromInput(input),
          includeSuperseded: input.include_superseded,
        },
        now: ctx.now,
      }),
    ),
};

const DOC_COVERAGE_OPERATION: MemoryOperationDefinition<
  OperationSchemas.DocCoverageInput,
  DocCoverageReport
> = {
  id: "memory.doc-coverage",
  title: "Memory doc coverage",
  description: "Read-only coverage report for ingested docs, graph grounding, and vectors.",
  inputSchema: OperationSchemas.DocCoverageInputSchema,
  outputSchema: OperationSchemas.DocCoverageOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "none",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "docs coverage", supportsJson: true },
    mcp: {
      toolName: "memory_doc_coverage",
      description:
        "Read-only coverage report for ingested memory_docs chunks. Returns graph grounding, extracted REFERENCES coverage, vector projection status, document byte sizes, and warnings.",
    },
  },
  execute: (ctx) => buildDocCoverageReport(ctx.store),
};

const DOC_COVERAGE_VIEWER_OPERATION: MemoryOperationDefinition<
  OperationSchemas.DocCoverageInput,
  DocCoverageViewerArtifact
> = {
  id: "memory.doc-coverage-viewer",
  title: "Memory doc coverage viewer",
  description: "Self-contained HTML viewer for document graph/vector coverage.",
  inputSchema: OperationSchemas.DocCoverageInputSchema,
  outputSchema: OperationSchemas.DocCoverageViewerOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "none",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "docs coverage-viewer", supportsJson: false },
    mcp: {
      toolName: "memory_doc_coverage_viewer",
      description:
        "Read-only self-contained HTML viewer for ingested document coverage. Returns graph grounding, extracted references, vector coverage, warnings, embedded JSON, and HTML without writing a file.",
    },
  },
  execute: async (ctx) =>
    buildDocCoverageViewerArtifact(await buildDocCoverageReport(ctx.store)),
};

const DOC_REFERENCE_GRAPH_OPERATION: MemoryOperationDefinition<
  OperationSchemas.DocReferenceGraphInput,
  DocReferenceGraphReport
> = {
  id: "memory.doc-reference-graph",
  title: "Memory doc reference graph",
  description: "Read-only graph of ingested docs and extracted REFERENCES edges.",
  inputSchema: OperationSchemas.DocReferenceGraphInputSchema,
  outputSchema: OperationSchemas.DocReferenceGraphOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "none",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "docs reference-graph", supportsJson: true },
    mcp: {
      toolName: "memory_doc_reference_graph",
      description:
        "Read-only graph of ingested memory_docs chunks and extracted REFERENCES edges. Returns doc nodes, referenced entity nodes, top references, graph edges, grounding counts, and warnings without mutating Memory.",
    },
  },
  execute: (ctx) => buildDocReferenceGraphReport(ctx.store),
};

const DOC_REFERENCE_GRAPH_VIEWER_OPERATION: MemoryOperationDefinition<
  OperationSchemas.DocReferenceGraphInput,
  DocReferenceGraphViewerArtifact
> = {
  id: "memory.doc-reference-graph-viewer",
  title: "Memory doc reference graph viewer",
  description: "Self-contained HTML viewer for the documentation reference graph.",
  inputSchema: OperationSchemas.DocReferenceGraphInputSchema,
  outputSchema: OperationSchemas.DocReferenceGraphViewerOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "none",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "docs reference-graph-viewer", supportsJson: false },
    mcp: {
      toolName: "memory_doc_reference_graph_viewer",
      description:
        "Read-only self-contained HTML viewer for the documentation reference graph. Returns doc/reference nodes, REFERENCES edges, top references, embedded JSON, and HTML without writing Memory.",
    },
  },
  execute: async (ctx) =>
    buildDocReferenceGraphViewerArtifact(await buildDocReferenceGraphReport(ctx.store)),
};

const PRE_PR_REVIEW_OPERATION: MemoryOperationDefinition<OperationSchemas.PrePrReviewInput, PrePrMemoryReview> = {
  id: "memory.pre-pr-review",
  title: "Memory pre-PR review",
  description: "Read-only pre-PR review over changed files using graph evidence.",
  inputSchema: OperationSchemas.PrePrReviewInputSchema,
  outputSchema: OperationSchemas.PrePrReviewOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "none",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "pre-pr-review", supportsJson: true },
    mcp: {
      toolName: "memory_pre_pr_review",
      description:
        "Read-only pre-PR review over explicit changed files. Returns impacted concepts, related decisions, known failures, suggested validations, risks, and evidence markers without invoking git or mutating Memory.",
    },
  },
  execute: async (ctx, input) =>
    buildPrePrMemoryReview(ctx.store, {
      changedFiles:
        input.changed_files ?? (await OperationHelpers.readChangedFiles(ctx.rootDir ?? process.cwd(), input.comparison)),
      comparison: input.comparison,
    }),
};

const PRE_PR_REVIEW_VIEWER_OPERATION: MemoryOperationDefinition<
  OperationSchemas.PrePrReviewInput,
  PrePrReviewViewerArtifact
> = {
  id: "memory.pre-pr-review-viewer",
  title: "Memory pre-PR review viewer",
  description: "Self-contained HTML pre-PR Memory review viewer.",
  inputSchema: OperationSchemas.PrePrReviewInputSchema,
  outputSchema: OperationSchemas.PrePrReviewViewerOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "none",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "pre-pr-review-viewer", supportsJson: false },
    mcp: {
      toolName: "memory_pre_pr_review_viewer",
      description:
        "Read-only self-contained HTML pre-PR review viewer. Returns impacted concepts, related decisions, failures, validations, risks, evidence, and embedded JSON without invoking git or writing a file.",
    },
  },
  execute: async (ctx, input) =>
    buildPrePrReviewViewerArtifact(
      await buildPrePrMemoryReview(ctx.store, {
        changedFiles:
          input.changed_files ?? (await OperationHelpers.readChangedFiles(ctx.rootDir ?? process.cwd(), input.comparison)),
        comparison: input.comparison,
      }),
    ),
};

const PROVENANCE_OPERATION: MemoryOperationDefinition<OperationSchemas.ProvenanceInput, ProvenanceReport> = {
  id: "memory.provenance",
  title: "Memory provenance",
  description: "Inspect provenance for a Memory node.",
  inputSchema: OperationSchemas.ProvenanceInputSchema,
  outputSchema: OperationSchemas.ProvenanceOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "none",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "provenance", supportsJson: true },
    mcp: {
      toolName: "memory_provenance",
      description:
        "Read-only provenance audit for a Memory node by rid or label. Returns writer, source kind, scope, timestamps, confidence, and evidence references.",
    },
  },
  execute: async (ctx, input) => {
    const node = await findNodeForProvenance(ctx.store, input.target);
    if (!node) throw new Error(`memory provenance target not found: ${input.target}`);
    return buildProvenanceReport(node);
  },
};

const PRIVACY_OPERATION: MemoryOperationDefinition<object, PrivacyReport> = {
  id: "memory.privacy-scan",
  title: "Memory privacy scan",
  description: "Read-only sensitive-data scan over graph Memory records.",
  inputSchema: z.object({}),
  outputSchema: OperationSchemas.PrivacyOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "none",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "privacy scan", supportsJson: true },
    mcp: {
      toolName: "memory_privacy_scan",
      description:
        "Read-only privacy scan over graph Memory nodes and edges. Returns sensitive-looking findings and never writes redacted exports or graph updates.",
    },
  },
  execute: async (ctx) => {
    const records = await OperationHelpers.graphPrivacyRecords(ctx.store);
    return privacyReport("graph", records);
  },
};

const GOVERNANCE_OPERATION: MemoryOperationDefinition<OperationSchemas.GovernanceInput, MemoryGovernanceReport> = {
  id: "memory.governance",
  title: "Memory governance",
  description:
    "Read-only governance report over provenance, privacy, lint, contradictions, supersession, and provider-backed tidy recommendations.",
  inputSchema: OperationSchemas.GovernanceInputSchema,
  outputSchema: OperationSchemas.GovernanceOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "none",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "governance", supportsJson: true },
    mcp: {
      toolName: "memory_governance",
      description:
        "Read-only governance report over local Memory evidence. Returns provenance coverage, privacy findings, lint findings, contradiction/supersession counts, provider-backed duplicate or near-duplicate tidy recommendations, and recommended next actions without mutating Memory.",
    },
  },
  execute: (ctx, input) =>
    buildMemoryGovernanceReport(ctx.store, {
      staleProgressDays: input.stale_progress_days,
      now: ctx.now,
      providerConfig: ctx.providerConfig,
    }),
};

const GOVERNANCE_VIEWER_OPERATION: MemoryOperationDefinition<
  OperationSchemas.GovernanceInput,
  MemoryGovernanceViewerArtifact
> = {
  id: "memory.governance-viewer",
  title: "Memory governance viewer",
  description: "Self-contained HTML viewer for Memory governance evidence and provider tidy recommendations.",
  inputSchema: OperationSchemas.GovernanceInputSchema,
  outputSchema: OperationSchemas.GovernanceViewerOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "none",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "governance-viewer", supportsJson: false },
    mcp: {
      toolName: "memory_governance_viewer",
      description:
        "Read-only self-contained HTML viewer for provenance, privacy, lint, contradictions, supersession, provider tidy recommendations, recommended actions, and embedded governance JSON.",
    },
  },
  execute: async (ctx, input) =>
    buildMemoryGovernanceViewerArtifact(
      await buildMemoryGovernanceReport(ctx.store, {
        staleProgressDays: input.stale_progress_days,
        now: ctx.now,
        providerConfig: ctx.providerConfig,
      }),
    ),
};

const LINT_OPERATION: MemoryOperationDefinition<OperationSchemas.LintInput, LintReport> = {
  id: "memory.lint",
  title: "Memory lint",
  description: "Read-only policy hygiene lint over graph Memory records.",
  inputSchema: OperationSchemas.LintInputSchema,
  outputSchema: OperationSchemas.LintOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "none",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "lint", supportsJson: true },
    mcp: {
      toolName: "memory_lint",
      description:
        "Read-only policy hygiene lint over graph Memory nodes. Returns stale-progress, imperative-memory, missing-scope/tier, duplicate-like, and likely-secret findings.",
    },
  },
  execute: async (ctx, input) => {
    const records = (await ctx.store.listNodes()).map(OperationHelpers.graphNodeToLintRecord);
    const findings = lintMemoryRecords(records, {
      staleProgressDays: input.stale_progress_days,
      now: ctx.now,
    });
    return {
      status: "ok",
      mode: "graph",
      readOnly: true,
      totalMemories: records.length,
      findings,
      ruleSuggestions: buildLintRuleSuggestions(findings),
      warnings: [],
    };
  },
};

const SKILL_RECOMMENDATIONS_OPERATION: MemoryOperationDefinition<
  OperationSchemas.SkillRecommendationsInput,
  SkillRecommendationReport
> = {
  id: "memory.skill-recommendations",
  title: "Memory skill recommendations",
  description: "Recommend RedSkills from recalled Memory evidence and skill telemetry.",
  inputSchema: OperationSchemas.SkillRecommendationsInputSchema,
  outputSchema: OperationSchemas.SkillRecommendationsOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "cache-write",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "recommend skills", supportsJson: true },
    mcp: {
      toolName: "memory_skill_recommendations",
      description:
        "Read-only RedSkills recommendations for a task from Memory evidence and skill telemetry rollups. Returns ranked recommendations, reasons, citations, and missing evidence.",
    },
  },
  execute: async (ctx, input) =>
    buildSkillRecommendations(ctx.store, input.task, {
      limit: input.limit,
      depth: input.depth,
      now: ctx.now,
      scope: OperationHelpers.scopeFromInput(input),
      skillRollups: await OperationHelpers.safeSkillRollups(ctx.store),
    }),
};

const LEARNING_DEBT_OPERATION: MemoryOperationDefinition<OperationSchemas.LearningDebtInput, LearningDebtReport> = {
  id: "memory.learning-debt",
  title: "Memory learning debt",
  description: "Read-only report of repeated failures, stale guidance, validation gaps, and telemetry gaps.",
  inputSchema: OperationSchemas.LearningDebtInputSchema,
  outputSchema: OperationSchemas.LearningDebtOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "none",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "learning-debt", supportsJson: true },
    mcp: {
      toolName: "memory_learning_debt",
      description:
        "Read-only learning debt report: repeated failure patterns, stale or contradicted guidance, missing validation evidence, and Skill telemetry gaps.",
    },
  },
  execute: async (ctx, input) =>
    buildLearningDebtReport(ctx.store, {
      staleDays: input.stale_days,
      minRepeatedFailures: input.min_repeated_failures,
      rollups: await OperationHelpers.safeSkillRollups(ctx.store),
      skillTelemetryEnabled: true,
    }),
};

const LEARNING_DEBT_VIEWER_OPERATION: MemoryOperationDefinition<
  OperationSchemas.LearningDebtInput,
  LearningDebtViewerArtifact
> = {
  id: "memory.learning-debt-viewer",
  title: "Memory learning debt viewer",
  description: "Self-contained HTML viewer for Memory learning debt evidence.",
  inputSchema: OperationSchemas.LearningDebtInputSchema,
  outputSchema: OperationSchemas.LearningDebtViewerOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "none",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "learning-debt-viewer", supportsJson: false },
    mcp: {
      toolName: "memory_learning_debt_viewer",
      description:
        "Read-only self-contained HTML viewer for Memory learning debt: repeated failure patterns, stale or contradicted guidance, missing validation evidence, Skill telemetry gaps, embedded JSON, and agent markdown.",
    },
  },
  execute: async (ctx, input) =>
    buildLearningDebtViewerArtifact(
      await buildLearningDebtReport(ctx.store, {
        staleDays: input.stale_days,
        minRepeatedFailures: input.min_repeated_failures,
        rollups: await OperationHelpers.safeSkillRollups(ctx.store),
        skillTelemetryEnabled: true,
      }),
    ),
};

const MEMORY_LAYERS_OPERATION: MemoryOperationDefinition<OperationSchemas.MemoryLayersInput, MemoryLayersReport> = {
  id: "memory.layers",
  title: "Memory layers",
  description:
    "Read-only layered Memory architecture report over session, durable, reasoning, docs/code, and vector evidence.",
  inputSchema: OperationSchemas.MemoryLayersInputSchema,
  outputSchema: OperationSchemas.MemoryLayersOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "none",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "layers", supportsJson: true },
    mcp: {
      toolName: "memory_layers",
      description:
        "Read-only Memory layers report. Summarizes short-term session events, long-term durable graph facts, reasoning traces, docs/code graph evidence, and vector projection over the embedded RedDB store.",
    },
  },
  execute: (ctx) => buildMemoryLayersReport(ctx.store, { now: ctx.now }),
};

const MEMORY_LAYERS_VIEWER_OPERATION: MemoryOperationDefinition<
  OperationSchemas.MemoryLayersInput,
  MemoryLayersViewerArtifact
> = {
  id: "memory.layers-viewer",
  title: "Memory layers viewer",
  description:
    "Self-contained HTML viewer for layered Memory architecture over RedDB evidence.",
  inputSchema: OperationSchemas.MemoryLayersInputSchema,
  outputSchema: OperationSchemas.MemoryLayersViewerOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "none",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "layers-viewer", supportsJson: false },
    mcp: {
      toolName: "memory_layers_viewer",
      description:
        "Read-only self-contained HTML viewer for Memory layers. Returns short-term, long-term, reasoning, docs/code, and vector layer readiness, reference alignment, recommended actions, embedded JSON, and HTML.",
    },
  },
  execute: async (ctx) =>
    buildMemoryLayersViewerArtifact(await buildMemoryLayersReport(ctx.store, { now: ctx.now })),
};

const HEALTH_OPERATION: MemoryOperationDefinition<OperationSchemas.HealthInput, MemoryHealthReport> = {
  id: "memory.health",
  title: "Memory health",
  description: "Read-only graph health summary for MCP agents.",
  inputSchema: OperationSchemas.HealthInputSchema,
  outputSchema: OperationSchemas.HealthOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "none",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "health", supportsJson: true },
    mcp: {
      toolName: "memory_health",
      description:
        "Read-only Memory health summary for MCP agents. Returns graph stats, vector readiness, stale-node diagnostics, Skill telemetry availability, and recommended next actions.",
    },
    http: { route: "/api/memory/health" },
  },
  execute: (ctx, input) => buildMemoryHealthReport(ctx.store, input),
};

const HEALTH_VIEWER_OPERATION: MemoryOperationDefinition<
  OperationSchemas.HealthInput,
  MemoryHealthViewerArtifact
> = {
  id: "memory.health-viewer",
  title: "Memory health viewer",
  description: "Self-contained HTML viewer for Memory operational health.",
  inputSchema: OperationSchemas.HealthInputSchema,
  outputSchema: OperationSchemas.HealthViewerOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "none",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "health-viewer", supportsJson: false },
    mcp: {
      toolName: "memory_health_viewer",
      description:
        "Read-only self-contained HTML viewer for Memory health. Returns graph stats, vector readiness, stale-node diagnostics, Skill telemetry availability, recommended actions, embedded JSON, and HTML.",
    },
    http: { route: "/memory/health" },
  },
  execute: async (ctx, input) =>
    buildMemoryHealthViewerArtifact(await buildMemoryHealthReport(ctx.store, input)),
};

const MEMORY_DECAY_OPERATION: MemoryOperationDefinition<
  OperationSchemas.MemoryDecayInput,
  MemoryDecayReport
> = {
  id: "memory.decay",
  title: "Memory decay plan",
  description:
    "Read-only retention planner over Memory nodes, access evidence, supersession, contradictions, and TTL horizons.",
  inputSchema: OperationSchemas.MemoryDecayInputSchema,
  outputSchema: OperationSchemas.MemoryDecayOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "none",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "decay", supportsJson: true },
    mcp: {
      toolName: "memory_decay",
      description:
        "Read-only Memory decay/retention plan. Classifies nodes as keep, review, deprecate, or expire using access evidence, stale thresholds, supersession, contradictions, TTL horizons, and pinned importance without deleting anything.",
    },
  },
  execute: (ctx, input) => buildMemoryDecayReport(ctx.store, { ...input, now: ctx.now }),
};

const MEMORY_DECAY_VIEWER_OPERATION: MemoryOperationDefinition<
  OperationSchemas.MemoryDecayInput,
  MemoryDecayViewerArtifact
> = {
  id: "memory.decay-viewer",
  title: "Memory decay viewer",
  description: "Self-contained HTML viewer for Memory decay planning evidence.",
  inputSchema: OperationSchemas.MemoryDecayInputSchema,
  outputSchema: OperationSchemas.MemoryDecayViewerOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "none",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "decay-viewer", supportsJson: false },
    mcp: {
      toolName: "memory_decay_viewer",
      description:
        "Read-only self-contained HTML viewer for Memory decay planning. Returns keep/review/deprecate/expire sections, recommendations, embedded JSON, and HTML without mutating Memory.",
    },
  },
  execute: async (ctx, input) =>
    buildMemoryDecayViewerArtifact(await buildMemoryDecayReport(ctx.store, { ...input, now: ctx.now })),
};

const MEMORY_MERGE_PASS_OPERATION: MemoryOperationDefinition<
  OperationSchemas.MemoryMergePassInput,
  MemoryMergePassReport
> = {
  id: "memory.merge-pass",
  title: "Memory merge pass",
  description:
    "Read-only advisory report of near-duplicate Memory node pairs proposed for human-approved merge.",
  inputSchema: OperationSchemas.MemoryMergePassInputSchema,
  outputSchema: OperationSchemas.MemoryMergePassOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "none",
  capabilities: ["graph-store"],
  renderer: {
    cli: {
      command: "merge-pass",
      supportsJson: true,
      reservedSubcommands: ["execute", "unmerge"],
    },
    mcp: {
      toolName: "memory_merge_pass",
      description:
        "Read-only advisory report of near-duplicate Memory node pairs. Returns ranked candidate pairs, similarity scores, evidence terms, proposed SAME_AS direction, and recommendations without mutating Memory.",
    },
  },
  execute: (ctx, input) => buildMemoryMergePassReport(ctx.store, input),
};

const HOOK_COVERAGE_OPERATION: MemoryOperationDefinition<OperationSchemas.HookCoverageInput, HookCoverageReport> = {
  id: "memory.hook-coverage",
  title: "Memory hook coverage",
  description: "Read-only hook manifest and project config coverage report.",
  inputSchema: OperationSchemas.HookCoverageInputSchema,
  outputSchema: OperationSchemas.HookCoverageOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "none",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "hooks coverage", supportsJson: true },
    mcp: {
      toolName: "memory_hook_coverage",
      description:
        "Read-only hook coverage report. Returns Claude/Codex hook manifest wiring, config-enabled lifecycle events, known runner gaps such as Codex PreCompact absence, and recommended next actions without enabling hooks.",
    },
  },
  execute: (ctx) => buildHookCoverageReport(ctx.rootDir ?? process.cwd()),
};

const HOOK_COVERAGE_VIEWER_OPERATION: MemoryOperationDefinition<
  OperationSchemas.HookCoverageInput,
  HookCoverageViewerArtifact
> = {
  id: "memory.hook-coverage-viewer",
  title: "Memory hook coverage viewer",
  description: "Self-contained HTML viewer for lifecycle hook coverage.",
  inputSchema: OperationSchemas.HookCoverageInputSchema,
  outputSchema: OperationSchemas.HookCoverageViewerOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "none",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "hooks coverage-viewer", supportsJson: false },
    mcp: {
      toolName: "memory_hook_coverage_viewer",
      description:
        "Read-only self-contained HTML viewer for hook coverage. Returns Claude/Codex manifest wiring, enabled/effective lifecycle events, gaps, recommended actions, embedded JSON, and HTML without enabling hooks.",
    },
  },
  execute: async (ctx) =>
    buildHookCoverageViewerArtifact(await buildHookCoverageReport(ctx.rootDir ?? process.cwd())),
};

const COMMUNITIES_OPERATION: MemoryOperationDefinition<OperationSchemas.CommunitiesInput, CommunityAnalyticsReport> = {
  id: "memory.communities",
  title: "Memory communities",
  description: "Read-only Memory graph community analytics.",
  inputSchema: OperationSchemas.CommunitiesInputSchema,
  outputSchema: OperationSchemas.CommunitiesOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "cache-write",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "communities", supportsJson: true },
    mcp: {
      toolName: "memory_communities",
      description:
        "Read-only Memory graph community analytics: native Louvain assignments, node degree/centrality ranking metadata, weighted inter-community edges, bridge node/edge rankings, per-community cohesion scores, top labels/titles, and graph-hash cache metadata. Does not write derived clusters into Memory graph evidence.",
    },
  },
  execute: (ctx, input) => buildCommunityAnalytics(ctx.store, { cache: input.cache }),
};

const COMMUNITIES_VIEWER_OPERATION: MemoryOperationDefinition<
  OperationSchemas.CommunitiesInput,
  CommunitiesViewerArtifact
> = {
  id: "memory.communities-viewer",
  title: "Memory communities viewer",
  description: "Self-contained HTML viewer for RedDB graph community analytics.",
  inputSchema: OperationSchemas.CommunitiesInputSchema,
  outputSchema: OperationSchemas.CommunitiesViewerOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "cache-write",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "communities-viewer", supportsJson: false },
    mcp: {
      toolName: "memory_communities_viewer",
      description:
        "Read-only self-contained HTML viewer for RedDB graph community analytics. Returns native Louvain community summaries, assignments, degree/centrality ranking metadata, weighted inter-community edges, cache metadata, embedded JSON, and HTML without writing derived clusters into Memory evidence.",
    },
  },
  execute: async (ctx, input) =>
    buildCommunitiesViewerArtifact(
      await buildCommunityAnalytics(ctx.store, { cache: input.cache }),
    ),
};

const COMMUNITY_DIGEST_OPERATION: MemoryOperationDefinition<
  OperationSchemas.CommunityDigestInput,
  CommunityDigestReport
> = {
  id: "memory.community-digest",
  title: "Memory community digest",
  description:
    "Read-only per-community digest over RedDB graph community assignments, with deterministic baseline and optional provider narrative enrichment.",
  inputSchema: OperationSchemas.CommunityDigestInputSchema,
  outputSchema: OperationSchemas.CommunityDigestOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "cache-write",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "community-digest", supportsJson: true },
    mcp: {
      toolName: "memory_community_digest",
      description:
        "Read-only per-community digest over RedDB native Louvain community assignments: deterministic top label, dominant node_type, ranked label/node_type histograms, provider availability, optional natural-language narrative summaries, and graph-hash cache metadata. Analytics only — never writes the digest back into Memory graph evidence as a node or edge.",
    },
  },
  execute: (ctx, input) =>
    buildCommunityDigest(ctx.store, { cache: input.cache, providerConfig: ctx.providerConfig }),
};

const HUB_REPORT_OPERATION: MemoryOperationDefinition<OperationSchemas.HubReportInput, HubReport> = {
  id: "memory.hub-report",
  title: "Memory hub report",
  description:
    "Read-only high-degree concept report over the stored graph, with community membership and seal mix.",
  inputSchema: OperationSchemas.HubReportInputSchema,
  outputSchema: OperationSchemas.HubReportOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "none",
  capabilities: ["graph-store"],
  renderer: {
    cli: {
      command: "hub-report",
      supportsJson: true,
      presentation: {
        render: (output, input) => {
          const report = output as HubReport;
          const fields: readonly (keyof HubReportRow & string)[] =
            input.flags.wide === true
              ? [
                  "rid",
                  "label",
                  "title",
                  "node_type",
                  "community_id",
                  "total_degree",
                  "in_degree",
                  "out_degree",
                  "seal_mix",
                  "seal_count",
                  "seals",
                ]
              : [
                  "label",
                  "title",
                  "community_id",
                  "total_degree",
                  "in_degree",
                  "out_degree",
                  "seal_mix",
                ];
          return renderToonOutput({
            rowsKey: "hubs",
            rows: report.hubs.map((hub) => ({ ...hub })),
            fields,
            summary: report.summary.empty
              ? {
                  state: "empty_graph",
                  message: "No graph nodes found.",
                  nodes: report.summary.nodes,
                  edges: report.summary.edges,
                  next: report.next,
                }
              : {
                  rank_by: report.rank_by,
                  reported: report.summary.reported,
                  nodes: report.summary.nodes,
                  edges: report.summary.edges,
                  max_total_degree: report.summary.max_total_degree,
                  communities: report.summary.communities,
                  next: report.next,
                },
            extra: {
              schema_version: report.schema_version,
              graph_hash: report.graph_hash,
            },
          });
        },
      },
    },
    mcp: {
      toolName: "memory_hub_report",
      description:
        "Read-only Memory graph hub report: ranks stored graph nodes by total, inbound, or outbound degree and returns each hub's community id plus edge seal mix. Computes directly from graph nodes/edges without writing analysis state.",
    },
  },
  execute: (ctx, input) =>
    buildHubReport(ctx.store, { limit: input.limit, rankBy: input.rank_by as HubRankBy }),
};

const SUGGESTED_QUESTIONS_OPERATION: MemoryOperationDefinition<
  OperationSchemas.SuggestedQuestionsInput,
  SuggestedQuestionsReport
> = {
  id: "memory.suggested-questions",
  title: "Memory suggested questions",
  description:
    "Read-only graph-structure question suggestions grounded in hubs, bridges, weak communities, and inferred edges.",
  inputSchema: OperationSchemas.SuggestedQuestionsInputSchema,
  outputSchema: OperationSchemas.SuggestedQuestionsOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "none",
  capabilities: ["graph-store"],
  renderer: {
    cli: {
      command: "suggested-questions",
      supportsJson: true,
      presentation: {
        render: (output) => {
          const report = output as SuggestedQuestionsReport;
          return renderToonOutput({
            rowsKey: "questions",
            rows: report.questions.map((question) => ({
              id: question.id,
              signal_type: question.signal_type,
              question: question.question,
              rationale: question.rationale,
              references: question.references.map((ref) => ({ ...ref })),
            })),
            fields: ["id", "signal_type", "question", "rationale", "references"],
            summary: {
              status: report.summary.status,
              nodes: report.summary.nodes,
              edges: report.summary.edges,
              signals: report.summary.signals,
              questions: report.summary.questions,
              provider_status: report.provider.status,
              provider_error: report.provider.error ?? null,
              next: report.summary.next,
            },
            extra: {
              schema_version: report.schema_version,
              graph_hash: report.graph_hash,
              signals: report.signals.map((signal) => ({
                signal_id: signal.signal_id,
                signal_type: signal.signal_type,
                title: signal.title,
                score: signal.score,
                references: signal.references.map((ref) => ({ ...ref })),
              })),
            },
          });
        },
      },
    },
    mcp: {
      toolName: "memory_suggested_questions",
      description:
        "Read-only Memory graph suggested-question report: deterministic structural signal selection over hubs, cross-community bridges, weak-cohesion communities, and high-confidence INFERRED edges; provider phrasing produces questions that retain graph references.",
    },
  },
  execute: (ctx, input) =>
    buildSuggestedQuestions(ctx.store, {
      limit: input.limit,
      providerConfig: ctx.providerConfig,
      now: ctx.now ? new Date(ctx.now) : undefined,
    }),
};

export const DOC_MEMORY_OPERATIONS = [
  SMART_SEARCH_OPERATION,
  SMART_SEARCH_VIEWER_OPERATION,
  DOC_COVERAGE_OPERATION,
  DOC_COVERAGE_VIEWER_OPERATION,
  DOC_REFERENCE_GRAPH_OPERATION,
  DOC_REFERENCE_GRAPH_VIEWER_OPERATION,
  PRE_PR_REVIEW_OPERATION,
  PRE_PR_REVIEW_VIEWER_OPERATION,
  PROVENANCE_OPERATION,
  PRIVACY_OPERATION,
  GOVERNANCE_OPERATION,
  GOVERNANCE_VIEWER_OPERATION,
  LINT_OPERATION,
  SKILL_RECOMMENDATIONS_OPERATION,
  LEARNING_DEBT_OPERATION,
  LEARNING_DEBT_VIEWER_OPERATION,
  MEMORY_LAYERS_OPERATION,
  MEMORY_LAYERS_VIEWER_OPERATION,
  HEALTH_OPERATION,
  HEALTH_VIEWER_OPERATION,
  MEMORY_DECAY_OPERATION,
  MEMORY_DECAY_VIEWER_OPERATION,
  MEMORY_MERGE_PASS_OPERATION,
  HOOK_COVERAGE_OPERATION,
  HOOK_COVERAGE_VIEWER_OPERATION,
  COMMUNITIES_OPERATION,
  COMMUNITIES_VIEWER_OPERATION,
  COMMUNITY_DIGEST_OPERATION,
  HUB_REPORT_OPERATION,
  SUGGESTED_QUESTIONS_OPERATION,
] as const;
