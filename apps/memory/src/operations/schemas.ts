import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
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

import { objectOutputSchema } from "./schema-utils.js";

export const CommunityCacheSchema = z.enum(["read-write", "read-only", "off"]).default("read-only");

export const MEMORY_SCOPES = [
  "user",
  "project",
  "repo",
  "branch",
  "worktree",
  "session",
  "agent-run",
] as const satisfies readonly MemoryScope[];

export const ScopeInputSchema = z.object({
  scope: z.enum(MEMORY_SCOPES).optional(),
  scope_id: z.string().optional(),
  include_narrower_scopes: z.boolean().default(false),
});

export const AskInputSchema = z.object({ question: z.string().min(1) });
export type AskInput = z.infer<typeof AskInputSchema>;

export const ReadinessInputSchema = ScopeInputSchema.extend({
  goal: z.string().min(1),
  limit: z.number().int().min(1).max(50).optional(),
  min_evidence: z.number().int().min(0).max(50).optional(),
  stale_days: z.number().int().min(1).optional(),
});
export type ReadinessInput = z.infer<typeof ReadinessInputSchema>;

export const ContextPackInputSchema = ScopeInputSchema.extend({
  goal: z.string().min(1),
  budget_chars: z.number().int().min(0).max(100_000).optional(),
  limit: z.number().int().min(1).max(50).optional(),
  depth: z.number().int().min(0).max(5).optional(),
});
export type ContextPackInput = z.infer<typeof ContextPackInputSchema>;

export const MapContextInputSchema = z.object({
  query: z.string().min(1),
  depth: z.number().int().min(0).max(5).optional(),
  mode: z.enum(["bfs", "dfs"]).optional(),
  budget: z.number().int().min(100).max(20_000).optional(),
  context: z.union([z.string(), z.array(z.string())]).optional(),
});
export type MapContextInput = z.infer<typeof MapContextInputSchema>;

export const ClaimCheckInputSchema = z.object({ assertion: z.string().min(1) });
export type ClaimCheckInput = z.infer<typeof ClaimCheckInputSchema>;

export const MapContractInputSchema = z.object({
  communities: z.boolean().default(false),
});
export type MapContractInput = z.infer<typeof MapContractInputSchema>;

export const HubReportInputSchema = z.object({
  limit: z.number().int().min(1).max(100).optional(),
  rank_by: z.enum(["total", "in", "out"]).default("total"),
});
export type HubReportInput = z.infer<typeof HubReportInputSchema>;

export const SuggestedQuestionsInputSchema = z.object({
  limit: z.number().int().min(1).max(50).optional(),
});
export type SuggestedQuestionsInput = z.infer<typeof SuggestedQuestionsInputSchema>;

export const DocSearchInputSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(50).optional(),
});
export type DocSearchInput = z.infer<typeof DocSearchInputSchema>;
export const AssetInventoryInputSchema = z.object({
  kind: z.string().min(1).optional(),
  query: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});
export type AssetInventoryInput = z.infer<typeof AssetInventoryInputSchema>;
export const DocBundleInputSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(10).optional(),
  max_bytes: z.number().int().min(0).max(200_000).optional(),
});
export type DocBundleInput = z.infer<typeof DocBundleInputSchema>;

export const DocReadInputSchema = z
  .object({
    path: z.string().min(1).optional(),
    rid: z.number().int().min(1).optional(),
    max_bytes: z.number().int().min(0).max(200_000).optional(),
  })
  .refine((input) => input.path || input.rid, {
    message: "doc read requires path or rid",
  });
export type DocReadInput = z.infer<typeof DocReadInputSchema>;
export const DocEvidencePackInputSchema = DocReadInputSchema;
export type DocEvidencePackInput = z.infer<typeof DocEvidencePackInputSchema>;
export const DocBacklinksInputSchema = z
  .object({
    rid: z.number().int().min(1).optional(),
    label: z.string().min(1).optional(),
    title: z.string().min(1).optional(),
    query: z.string().min(1).optional(),
  })
  .refine((input) => input.rid || input.label || input.title || input.query, {
    message: "doc backlinks requires rid, label, title, or query",
  });
export type DocBacklinksInput = z.infer<typeof DocBacklinksInputSchema>;
export const DocRelatedInputSchema = z
  .object({
    path: z.string().min(1).optional(),
    rid: z.number().int().min(1).optional(),
  })
  .refine((input) => input.path || input.rid, {
    message: "doc related requires path or rid",
  });
export type DocRelatedInput = z.infer<typeof DocRelatedInputSchema>;

export const DocCoverageInputSchema = z.object({});
export type DocCoverageInput = z.infer<typeof DocCoverageInputSchema>;
export const DocReferenceGraphInputSchema = z.object({});
export type DocReferenceGraphInput = z.infer<typeof DocReferenceGraphInputSchema>;

export const SmartSearchInputSchema = ScopeInputSchema.extend({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(50).optional(),
  depth: z.number().int().min(0).max(5).optional(),
  include_superseded: z.boolean().default(false),
});
export type SmartSearchInput = z.infer<typeof SmartSearchInputSchema>;

export const RecallRankingInputSchema = ScopeInputSchema.extend({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(50).optional(),
  include_superseded: z.boolean().default(false),
});
export type RecallRankingInput = z.infer<typeof RecallRankingInputSchema>;

export const PrePrReviewInputSchema = z.object({
  changed_files: z.array(z.string().min(1)).optional(),
  comparison: z.string().optional(),
});
export type PrePrReviewInput = z.infer<typeof PrePrReviewInputSchema>;

export const MemoryRoutingAgentSchema = z.enum([
  "codex",
  "claude",
  "cursor",
  "gemini",
  "aider",
  "opencode",
  "generic",
]);
export const RoutingGuideInputSchema = z.object({
  agent: MemoryRoutingAgentSchema.optional(),
});
export type RoutingGuideInput = z.infer<typeof RoutingGuideInputSchema>;

export const ProvenanceInputSchema = z.object({ target: z.string().min(1) });
export type ProvenanceInput = z.infer<typeof ProvenanceInputSchema>;

export const LintInputSchema = z.object({
  stale_progress_days: z.number().int().min(1).optional(),
});
export type LintInput = z.infer<typeof LintInputSchema>;

export const SkillRecommendationsInputSchema = ScopeInputSchema.extend({
  task: z.string().min(1),
  limit: z.number().int().min(1).max(20).optional(),
  depth: z.number().int().min(0).max(5).optional(),
});
export type SkillRecommendationsInput = z.infer<typeof SkillRecommendationsInputSchema>;

export const LearningDebtInputSchema = z.object({
  stale_days: z.number().int().min(1).optional(),
  min_repeated_failures: z.number().int().min(2).optional(),
});
export type LearningDebtInput = z.infer<typeof LearningDebtInputSchema>;

export const MemoryLayersInputSchema = z.object({});
export type MemoryLayersInput = z.infer<typeof MemoryLayersInputSchema>;

export const HealthInputSchema = z.object({
  stale_days: z.number().int().min(1).default(90),
});
export type HealthInput = z.infer<typeof HealthInputSchema>;

export const MemoryDecayInputSchema = z.object({
  stale_days: z.number().int().min(1).optional(),
  deprecate_days: z.number().int().min(1).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});
export type MemoryDecayInput = z.infer<typeof MemoryDecayInputSchema>;

export const MemoryMergePassInputSchema = z.object({
  min_score: z.number().min(0).max(1).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});
export type MemoryMergePassInput = z.infer<typeof MemoryMergePassInputSchema>;

export const GovernanceInputSchema = z.object({
  stale_progress_days: z.number().int().min(1).optional(),
});
export type GovernanceInput = z.infer<typeof GovernanceInputSchema>;

export const HookCoverageInputSchema = z.object({});
export type HookCoverageInput = z.infer<typeof HookCoverageInputSchema>;

export const CapabilityCatalogInputSchema = z.object({});
export type CapabilityCatalogInput = z.infer<typeof CapabilityCatalogInputSchema>;

export const ReferenceRadarInputSchema = z.object({});
export type ReferenceRadarInput = z.infer<typeof ReferenceRadarInputSchema>;

export const HandoffInputSchema = z.object({
  focus: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});
export type HandoffInput = z.infer<typeof HandoffInputSchema>;

export const WorkFrontierInputSchema = z.object({
  focus: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});
export type WorkFrontierInput = z.infer<typeof WorkFrontierInputSchema>;

export const SessionTimelineInputSchema = z.object({
  session_id: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(500).optional(),
});
export type SessionTimelineInput = z.infer<typeof SessionTimelineInputSchema>;

export const PathExplainInputSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  max_depth: z.number().int().min(1).max(20).optional(),
});
export type PathExplainInput = z.infer<typeof PathExplainInputSchema>;

export const ConfidenceInputSchema = z.object({
  node: z.union([z.number().int(), z.string().min(1)]),
});
export type ConfidenceInput = z.infer<typeof ConfidenceInputSchema>;

export const CommunitiesInputSchema = z.object({
  cache: CommunityCacheSchema,
});
export type CommunitiesInput = z.infer<typeof CommunitiesInputSchema>;

export const CommunityDigestInputSchema = z.object({
  cache: CommunityCacheSchema,
});
export type CommunityDigestInput = z.infer<typeof CommunityDigestInputSchema>;

export const GlobalSearchInputSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(50).optional(),
  cache: CommunityCacheSchema,
});
export type GlobalSearchInput = z.infer<typeof GlobalSearchInputSchema>;

export const OnboardingMapInputSchema = z.object({
  stale_days: z.number().int().min(1).optional(),
});
export type OnboardingMapInput = z.infer<typeof OnboardingMapInputSchema>;

export const DashboardInputSchema = z.object({
  stale_days: z.number().int().min(1).optional(),
});
export type DashboardInput = z.infer<typeof DashboardInputSchema>;

export const WorkbenchInputSchema = z.object({
  stale_days: z.number().int().min(1).optional(),
  session_id: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(500).optional(),
});
export type WorkbenchInput = z.infer<typeof WorkbenchInputSchema>;

export const StructuralImpactInputSchema = z
  .object({
    file: z.string().min(1).optional(),
    symbol: z.string().min(1).optional(),
  })
  .refine((input) => input.file || input.symbol, {
    message: "structural impact requires file or symbol",
  });
export type StructuralImpactInput = z.infer<typeof StructuralImpactInputSchema>;

export const VectorStatusInputSchema = z.object({});
export type VectorStatusInput = z.infer<typeof VectorStatusInputSchema>;

export const ExtractionStatusInputSchema = z.object({});
export type ExtractionStatusInput = z.infer<typeof ExtractionStatusInputSchema>;

export const MapFreshnessInputSchema = z.object({});
export type MapFreshnessInput = z.infer<typeof MapFreshnessInputSchema>;

export const VectorSearchInputSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(50).optional(),
});
export type VectorSearchInput = z.infer<typeof VectorSearchInputSchema>;

export const ReasoningReplayInputSchema = z.object({
  task: z.string().min(1),
  limit: z.number().int().min(1).max(50).optional(),
});
export type ReasoningReplayInput = z.infer<typeof ReasoningReplayInputSchema>;

export const WhatifChangeSchema = z.object({
  kind: z.enum(["rename", "delete", "edit"]),
  file: z.string().min(1).optional(),
  symbol: z.string().min(1).optional(),
  with: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
}) satisfies z.ZodType<WhatifChange>;

export const WhatifInputSchema = z
  .object({
    changes: z.array(WhatifChangeSchema).min(1),
    limit: z.number().int().min(1).max(50).optional(),
  })
  .refine((input) => input.changes.every((c) => c.file || c.symbol || c.description), {
    message: "every change needs at least file, symbol, or description",
  });
export type WhatifInput = z.infer<typeof WhatifInputSchema>;

export const FederationInputSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(100).optional(),
  per_root_limit: z.number().int().min(1).max(100).optional(),
});
export type FederationInput = z.infer<typeof FederationInputSchema>;

export const CommunitySummarySchema = z.object({
  id: z.string(),
  short_label: z.string().nullable(),
  label_provenance: z
    .object({
      source: z.enum(["provider", "deterministic", "cached"]),
      provider: z.object({
        mode: z.string().nullable(),
        model: z.string().nullable(),
      }),
      membership_hash: z.string(),
      generated_at: z.string(),
    })
    .nullable(),
  count: z.number(),
  total_degree: z.number(),
  avg_centrality: z.number(),
  internal_edge_weight: z.number(),
  external_edge_weight: z.number(),
  cohesion_score: z.number(),
  labels: z.array(z.string()),
  titles: z.array(z.string()),
});

export const CommunityAssignmentSchema = z.object({
  rid: z.number(),
  community_id: z.string(),
  label: z.string(),
  node_type: z.string(),
  title: z.string(),
});

export const CommunityNodeAnalyticsSchema = z.object({
  rid: z.number(),
  community_id: z.string(),
  degree: z.number(),
  in_degree: z.number(),
  out_degree: z.number(),
  weighted_degree: z.number(),
  centrality: z.number(),
});

export const InterCommunityEdgeSchema = z.object({
  from_community_id: z.string(),
  to_community_id: z.string(),
  weight: z.number(),
  edge_count: z.number(),
});

export const BridgeNodeSchema = z.object({
  rid: z.number(),
  label: z.string(),
  title: z.string(),
  node_type: z.string(),
  community_id: z.string(),
  connected_community_count: z.number(),
  connected_community_ids: z.array(z.string()),
  cross_community_edge_count: z.number(),
  cross_community_weight: z.number(),
});

export const BridgeEdgeSchema = z.object({
  from_rid: z.number(),
  to_rid: z.number(),
  from_label: z.string(),
  to_label: z.string(),
  from_community_id: z.string(),
  to_community_id: z.string(),
  label: z.string(),
  weight: z.number(),
});

export const CommunitiesOutputSchema = z.object({
  schema_version: z.literal("memory.communities.v1"),
  read_only: z.literal(true),
  graph_hash: z.string(),
  cache_key: z.string(),
  cached: z.boolean(),
  generated_at: z.string(),
  communities: z.array(CommunitySummarySchema),
  assignments: z.array(CommunityAssignmentSchema),
  node_analytics: z.array(CommunityNodeAnalyticsSchema),
  inter_community_edges: z.array(InterCommunityEdgeSchema),
  bridge_nodes: z.array(BridgeNodeSchema),
  bridge_edges: z.array(BridgeEdgeSchema),
  summary: z.object({
    status: z.enum(["empty", "ready"]),
    next: z.string(),
  }),
}) satisfies z.ZodType<CommunityAnalyticsReport>;
export const CommunitiesViewerOutputSchema = objectOutputSchema<CommunitiesViewerArtifact>();

export const HubReportRowSchema = z.object({
  rid: z.number(),
  label: z.string(),
  title: z.string(),
  node_type: z.string(),
  community_id: z.string().nullable(),
  total_degree: z.number(),
  in_degree: z.number(),
  out_degree: z.number(),
  seal_mix: z.string(),
  seal_count: z.number(),
  seals: z.array(z.string()),
});
export const HubReportOutputSchema = z.object({
  schema_version: z.literal("memory.hub-report.v1"),
  read_only: z.literal(true),
  graph_hash: z.string(),
  generated_at: z.string(),
  rank_by: z.enum(["total", "in", "out"]),
  limit: z.number(),
  summary: z.object({
    nodes: z.number(),
    edges: z.number(),
    reported: z.number(),
    max_total_degree: z.number(),
    max_in_degree: z.number(),
    max_out_degree: z.number(),
    communities: z.number(),
    empty: z.boolean(),
  }),
  next: z.array(z.string()),
  hubs: z.array(HubReportRowSchema),
}) satisfies z.ZodType<HubReport>;

export const SuggestedQuestionReferenceSchema = z.object({
  kind: z.enum(["node", "edge", "community"]),
  rid: z.number().optional(),
  label: z.string().optional(),
  title: z.string().optional(),
  from_rid: z.number().optional(),
  to_rid: z.number().optional(),
  community_id: z.string().optional(),
}) satisfies z.ZodType<SuggestedQuestionReference>;
export const SuggestedQuestionSignalTypeSchema = z.enum([
  "hub",
  "bridge",
  "weak_community",
  "inferred_edge",
]) satisfies z.ZodType<SuggestedQuestionSignalType>;
export const SuggestedQuestionSignalSchema = z.object({
  signal_id: z.string(),
  signal_type: SuggestedQuestionSignalTypeSchema,
  title: z.string(),
  rationale: z.string(),
  score: z.number(),
  references: z.array(SuggestedQuestionReferenceSchema),
});
export const SuggestedQuestionSchema = z.object({
  id: z.string(),
  signal_id: z.string(),
  signal_type: SuggestedQuestionSignalTypeSchema,
  question: z.string(),
  rationale: z.string(),
  references: z.array(SuggestedQuestionReferenceSchema),
});
export const SuggestedQuestionsOutputSchema = z.object({
  schema_version: z.literal("memory.suggested-questions.v1"),
  read_only: z.literal(true),
  graph_hash: z.string(),
  generated_at: z.string(),
  provider: z.object({
    status: z.enum(["available", "unavailable"]),
    mode: z
      .union([
        z.literal("openai-compat"),
        z.literal("openai-native"),
        z.literal("anthropic-native"),
        z.literal("bedrock"),
        z.null(),
      ]),
    model: z.string().nullable(),
    egress: z.union([z.literal("local"), z.literal("external"), z.null()]),
    error: z.string().optional(),
  }),
  summary: z.object({
    status: z.enum(["empty_graph", "no_notable_signals", "provider_unavailable", "ready"]),
    nodes: z.number(),
    edges: z.number(),
    signals: z.number(),
    questions: z.number(),
    next: z.array(z.string()),
  }),
  signals: z.array(SuggestedQuestionSignalSchema),
  questions: z.array(SuggestedQuestionSchema),
}) satisfies z.ZodType<SuggestedQuestionsReport>;

export const CommunityDigestCountSchema = z.object({
  value: z.string(),
  count: z.number(),
});
export const CommunityDigestEntrySchema = z.object({
  community_id: z.string(),
  size: z.number(),
  short_label: z.string().nullable(),
  label_provenance: z
    .object({
      source: z.enum(["provider", "deterministic", "cached"]),
      provider: z.object({
        mode: z.union([
          z.literal("openai-compat"),
          z.literal("openai-native"),
          z.literal("anthropic-native"),
          z.literal("bedrock"),
          z.null(),
        ]),
        model: z.string().nullable(),
      }),
      membership_hash: z.string(),
      generated_at: z.string(),
    })
    .nullable(),
  top_label: z.string(),
  top_node_type: z.string(),
  top_engineering_code: z.string().nullable(),
  labels: z.array(CommunityDigestCountSchema),
  node_types: z.array(CommunityDigestCountSchema),
  engineering_codes: z.array(CommunityDigestCountSchema),
  narrative_summary: z.string().nullable(),
});
export const CommunityDigestProviderSchema = z.object({
  status: z.enum(["available", "unavailable"]),
  mode: z.union([
    z.literal("openai-compat"),
    z.literal("openai-native"),
    z.literal("anthropic-native"),
    z.literal("bedrock"),
    z.null(),
  ]),
  model: z.string().nullable(),
  egress: z.union([z.literal("local"), z.literal("external"), z.null()]),
  error: z.string().optional(),
}) satisfies z.ZodType<CommunityDigestProviderStatus>;
export const CommunityDigestOutputSchema = z.object({
  schema_version: z.literal("memory.community-digest.v1"),
  read_only: z.literal(true),
  graph_hash: z.string(),
  cache_key: z.string(),
  cached: z.boolean(),
  generated_at: z.string(),
  provider: CommunityDigestProviderSchema,
  community_count: z.number(),
  digests: z.array(CommunityDigestEntrySchema),
  summary: z.object({
    labeling: z.object({
      generated: z.number(),
      reused: z.number(),
      token_cost: z.object({
        prompt_tokens: z.number(),
        completion_tokens: z.number(),
        total_tokens: z.number(),
        estimated: z.literal(true),
      }),
    }),
  }),
}) satisfies z.ZodType<CommunityDigestReport>;
export const GlobalSearchEvidenceSchema = z.object({
  source: z.literal("community-digest"),
  community_id: z.string(),
  score: z.number(),
  matched_terms: z.array(z.string()),
  size: z.number(),
  short_label: z.string().nullable(),
  top_label: z.string(),
  top_node_type: z.string(),
  top_engineering_code: z.string().nullable(),
  labels: z.array(CommunityDigestCountSchema),
  node_types: z.array(CommunityDigestCountSchema),
  engineering_codes: z.array(CommunityDigestCountSchema),
  narrative_summary: z.string().nullable(),
});
export const GlobalSearchOutputSchema = z.object({
  schema_version: z.literal("memory.global-search.v1"),
  read_only: z.literal(true),
  surface: z.literal("memory.global-search"),
  query: z.string(),
  generated_from: z.object({
    operation_id: z.literal("memory.community-digest"),
    schema_version: z.literal("memory.community-digest.v1"),
    graph_hash: z.string(),
    cache_key: z.string(),
    cached: z.boolean(),
    provider: CommunityDigestProviderSchema,
  }),
  total_hits: z.number(),
  evidence: z.array(GlobalSearchEvidenceSchema),
  markdown: z.string(),
}) satisfies z.ZodType<MemoryGlobalSearchReport>;

export const AskOutputSchema = objectOutputSchema<AskResult>();
export const ReadinessOutputSchema = objectOutputSchema<MemoryReadinessEnvelope>();
export const ContextPackOutputSchema = objectOutputSchema<ContextPack>();
export const MapContextOutputSchema = objectOutputSchema<MemoryMapContextSlice>();
export const ContextPackViewerOutputSchema = objectOutputSchema<ContextPackViewerArtifact>();
export const ClaimCheckOutputSchema = objectOutputSchema<ClaimCheckResult>();
export const MapContractOutputSchema = GraphContractZ;
export const DocBriefOutputSchema = objectOutputSchema<DocBrief>();
export const DocBriefViewerOutputSchema = objectOutputSchema<DocBriefViewerArtifact>();
export const DocBundleOutputSchema = objectOutputSchema<DocBundle>();
export const DocBundleViewerOutputSchema = objectOutputSchema<DocBundleViewerArtifact>();
export const DocReadOutputSchema = objectOutputSchema<DocReadResult>();
export const DocEvidencePackOutputSchema = objectOutputSchema<DocEvidencePack>();
export const DocEvidencePackViewerOutputSchema =
  objectOutputSchema<DocEvidencePackViewerArtifact>();
export const DocBacklinksOutputSchema = objectOutputSchema<DocBacklinksReport>();
export const DocBacklinksViewerOutputSchema =
  objectOutputSchema<DocBacklinksViewerArtifact>();
export const DocRelatedOutputSchema = objectOutputSchema<DocRelatedReport>();
export const DocRelatedViewerOutputSchema = objectOutputSchema<DocRelatedViewerArtifact>();
export const DocSearchOutputSchema = objectOutputSchema<DocSearchReport>();
export const DocCoverageOutputSchema = objectOutputSchema<DocCoverageReport>();
export const RecallRankingOutputSchema = objectOutputSchema<GraphRecallResult>();
export const SmartSearchOutputSchema = objectOutputSchema<MemorySmartSearchReport>();
export const SmartSearchViewerOutputSchema =
  objectOutputSchema<MemorySmartSearchViewerArtifact>();
export const AssetInventoryOutputSchema = objectOutputSchema<MemoryAssetInventoryReport>();
export const AssetInventoryViewerOutputSchema =
  objectOutputSchema<MemoryAssetInventoryViewerArtifact>();
export const DocCoverageViewerOutputSchema = objectOutputSchema<DocCoverageViewerArtifact>();
export const DocReferenceGraphOutputSchema = objectOutputSchema<DocReferenceGraphReport>();
export const DocReferenceGraphViewerOutputSchema =
  objectOutputSchema<DocReferenceGraphViewerArtifact>();
export const DocSearchViewerOutputSchema = objectOutputSchema<DocSearchViewerArtifact>();
export const PrePrReviewOutputSchema = objectOutputSchema<PrePrMemoryReview>();
export const PrePrReviewViewerOutputSchema =
  objectOutputSchema<PrePrReviewViewerArtifact>();
export const ProvenanceOutputSchema = objectOutputSchema<ProvenanceReport>();
export const PrivacyOutputSchema = objectOutputSchema<PrivacyReport>();
export const LintOutputSchema = objectOutputSchema<LintReport>();
export const SkillRecommendationsOutputSchema = objectOutputSchema<SkillRecommendationReport>();
export const LearningDebtOutputSchema = objectOutputSchema<LearningDebtReport>();
export const LearningDebtViewerOutputSchema = objectOutputSchema<LearningDebtViewerArtifact>();
export const MemoryLayersOutputSchema = objectOutputSchema<MemoryLayersReport>();
export const MemoryLayersViewerOutputSchema = objectOutputSchema<MemoryLayersViewerArtifact>();
export const OnboardingMapOutputSchema = objectOutputSchema<OnboardingMap>();
export const OnboardingMapViewerOutputSchema = objectOutputSchema<OnboardingMapViewerArtifact>();
export const DashboardOutputSchema = objectOutputSchema<MemoryOperationalDashboardArtifact>();
export const WorkbenchOutputSchema = objectOutputSchema<MemoryWorkbenchArtifact>();
export const ReadinessViewerOutputSchema = objectOutputSchema<ReadinessViewerArtifact>();
export const RoutingGuideOutputSchema = objectOutputSchema<MemoryRoutingGuide>();
export const RoutingGuideViewerOutputSchema =
  objectOutputSchema<MemoryRoutingGuideViewerArtifact>();
export const AgentIntegrationStatusOutputSchema =
  objectOutputSchema<MemoryAgentIntegrationStatus>();
export const AgentIntegrationStatusViewerOutputSchema =
  objectOutputSchema<MemoryAgentIntegrationStatusViewerArtifact>();
export const SessionTimelineOutputSchema = objectOutputSchema<SessionTimeline>();
export const SessionTimelineViewerOutputSchema =
  objectOutputSchema<SessionTimelineViewerArtifact>();
export const PathExplainOutputSchema = objectOutputSchema<PathExplainReport>();
export const ConfidenceOutputSchema = objectOutputSchema<ConfidenceReport>();
export const PathExplainViewerOutputSchema = objectOutputSchema<PathExplainViewerArtifact>();
export const StructuralImpactOutputSchema = objectOutputSchema<StructuralImpact>();
export const StructuralImpactViewerOutputSchema =
  objectOutputSchema<StructuralImpactViewerArtifact>();
export const ExtractionStatusOutputSchema = objectOutputSchema<MemoryExtractionStatus>();
export const ExtractionStatusViewerOutputSchema =
  objectOutputSchema<MemoryExtractionStatusViewerArtifact>();
export const MapFreshnessOutputSchema = objectOutputSchema<MemoryMapFreshnessReport>();
export const VectorStatusOutputSchema = objectOutputSchema<VectorStatusReport>();
export const VectorStatusViewerOutputSchema = objectOutputSchema<VectorStatusViewerArtifact>();
export const VectorSearchOutputSchema = objectOutputSchema<VectorSearchReport>();
export const ReasoningReplayOutputSchema = objectOutputSchema<ReasoningReplayReport>();
export const FederationOutputSchema = objectOutputSchema<FederationReport>();
export const WhatifOutputSchema = objectOutputSchema<WhatifReport>();

export const HealthOutputSchema = objectOutputSchema<MemoryHealthReport>();
export const HealthViewerOutputSchema = objectOutputSchema<MemoryHealthViewerArtifact>();
export const MemoryDecayOutputSchema = objectOutputSchema<MemoryDecayReport>();
export const MemoryDecayViewerOutputSchema =
  objectOutputSchema<MemoryDecayViewerArtifact>();
export const MemoryMergePassOutputSchema = objectOutputSchema<MemoryMergePassReport>();
export const GovernanceOutputSchema = objectOutputSchema<MemoryGovernanceReport>();
export const GovernanceViewerOutputSchema =
  objectOutputSchema<MemoryGovernanceViewerArtifact>();
export const HandoffOutputSchema = objectOutputSchema<MemoryHandoffReport>();
export const HandoffViewerOutputSchema = objectOutputSchema<MemoryHandoffViewerArtifact>();
export const WorkFrontierOutputSchema = objectOutputSchema<WorkFrontierReport>();
export const WorkFrontierViewerOutputSchema =
  objectOutputSchema<WorkFrontierViewerArtifact>();
export const HookCoverageOutputSchema = objectOutputSchema<HookCoverageReport>();
export const HookCoverageViewerOutputSchema = objectOutputSchema<HookCoverageViewerArtifact>();
export const CapabilityCatalogOutputSchema = objectOutputSchema<MemoryCapabilityCatalog>();
export const ReferenceRadarOutputSchema = objectOutputSchema<MemoryReferenceRadar>();
