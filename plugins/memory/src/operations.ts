import { z } from "zod";
import {
  buildMemoryAssetInventory,
  type MemoryAssetInventoryReport,
} from "./asset-inventory.js";
import {
  buildMemoryAssetInventoryViewerArtifact,
  type MemoryAssetInventoryViewerArtifact,
} from "./asset-inventory-viewer.js";
import {
  buildMemoryAgentIntegrationStatus,
  type MemoryAgentIntegrationStatus,
} from "./agent-integration-status.js";
import {
  buildMemoryAgentIntegrationStatusViewerArtifact,
  type MemoryAgentIntegrationStatusViewerArtifact,
} from "./agent-integration-status-viewer.js";
import {
  buildMemoryCapabilityCatalog,
  type MemoryCapabilityCatalog,
} from "./capability-catalog.js";
import { claimCheck, type ClaimCheckResult } from "./claim-check.js";
import {
  buildMemoryCompetitiveRadar,
  type MemoryCompetitiveRadar,
} from "./competitive-radar.js";
import {
  evaluateCompetitiveEvalV2,
  type CompetitiveEvalV2Report,
} from "./competitive-baseline.js";
import {
  buildCompetitiveEvalViewerArtifact,
  type CompetitiveEvalViewerArtifact,
} from "./competitive-eval-viewer.js";
import {
  buildCommunityAnalytics,
  type CommunityAnalyticsReport,
  type CommunityCacheMode,
} from "./communities.js";
import {
  buildCommunitiesViewerArtifact,
  type CommunitiesViewerArtifact,
} from "./communities-viewer.js";
import { buildContextPack, type ContextPack } from "./context-pack.js";
import {
  buildContextPackViewerArtifact,
  type ContextPackViewerArtifact,
} from "./context-pack-viewer.js";
import { buildDocBrief, type DocBrief } from "./doc-brief.js";
import {
  buildDocBriefViewerArtifact,
  type DocBriefViewerArtifact,
} from "./doc-brief-viewer.js";
import { buildDocBundle, type DocBundle } from "./doc-bundle.js";
import {
  buildDocBundleViewerArtifact,
  type DocBundleViewerArtifact,
} from "./doc-bundle-viewer.js";
import {
  buildDocCoverageReport,
  type DocCoverageReport,
} from "./doc-coverage.js";
import {
  buildDocCoverageViewerArtifact,
  type DocCoverageViewerArtifact,
} from "./doc-coverage-viewer.js";
import {
  buildDocEvidencePack,
  type DocEvidencePack,
} from "./doc-evidence-pack.js";
import {
  buildDocEvidencePackViewerArtifact,
  type DocEvidencePackViewerArtifact,
} from "./doc-evidence-pack-viewer.js";
import {
  buildDocBacklinksReport,
  type DocBacklinksReport,
} from "./doc-backlinks.js";
import {
  buildDocBacklinksViewerArtifact,
  type DocBacklinksViewerArtifact,
} from "./doc-backlinks-viewer.js";
import {
  buildDocReferenceGraphReport,
  type DocReferenceGraphReport,
} from "./doc-reference-graph.js";
import {
  buildDocReferenceGraphViewerArtifact,
  type DocReferenceGraphViewerArtifact,
} from "./doc-reference-graph-viewer.js";
import { buildDocRelatedReport, type DocRelatedReport } from "./doc-related.js";
import {
  buildDocRelatedViewerArtifact,
  type DocRelatedViewerArtifact,
} from "./doc-related-viewer.js";
import {
  readDoc,
  searchDocs,
  type DocReadResult,
  type DocSearchReport,
} from "./doc-search.js";
import {
  buildDocSearchViewerArtifact,
  type DocSearchViewerArtifact,
} from "./doc-search-viewer.js";
import { ask, type AskResult } from "./engine.js";
import {
  buildMemoryExtractionStatus,
  type MemoryExtractionStatus,
} from "./extraction-status.js";
import {
  buildMemoryExtractionStatusViewerArtifact,
  type MemoryExtractionStatusViewerArtifact,
} from "./extraction-status-viewer.js";
import type { MemoryStore, StoredNode, VectorStatusReport } from "./graph-store.js";
import { buildMemoryHandoff, type MemoryHandoffReport } from "./handoff.js";
import {
  buildMemoryHandoffViewerArtifact,
  type MemoryHandoffViewerArtifact,
} from "./handoff-viewer.js";
import {
  buildMemoryGovernanceReport,
  type MemoryGovernanceReport,
} from "./governance.js";
import {
  buildMemoryGovernanceViewerArtifact,
  type MemoryGovernanceViewerArtifact,
} from "./governance-viewer.js";
import {
  buildHookCoverageReport,
  type HookCoverageReport,
} from "./hook-coverage.js";
import {
  buildHookCoverageViewerArtifact,
  type HookCoverageViewerArtifact,
} from "./hook-coverage-viewer.js";
import { buildLearningDebtReport, type LearningDebtReport } from "./learning-debt.js";
import {
  buildLearningDebtViewerArtifact,
  type LearningDebtViewerArtifact,
} from "./learning-debt-viewer.js";
import {
  buildLintRuleSuggestions,
  lintMemoryRecords,
  type LintMemoryRecord,
  type LintReport,
} from "./lint.js";
import {
  buildMemoryHealthReport,
  type MemoryHealthReport,
} from "./memory-health.js";
import {
  buildMemoryHealthViewerArtifact,
  type MemoryHealthViewerArtifact,
} from "./memory-health-viewer.js";
import {
  buildMemoryDecayReport,
  type MemoryDecayReport,
} from "./memory-decay.js";
import {
  buildMemoryDecayViewerArtifact,
  type MemoryDecayViewerArtifact,
} from "./memory-decay-viewer.js";
import { buildMemoryLayersReport, type MemoryLayersReport } from "./memory-layers.js";
import {
  buildMemoryLayersViewerArtifact,
  type MemoryLayersViewerArtifact,
} from "./memory-layers-viewer.js";
import { buildOnboardingMap, type OnboardingMap } from "./onboarding-map.js";
import {
  buildOnboardingMapViewerArtifact,
  type OnboardingMapViewerArtifact,
} from "./onboarding-map-viewer.js";
import {
  buildMemoryOperationalDashboard,
  buildMemoryOperationalDashboardArtifact,
  type MemoryOperationalDashboardArtifact,
} from "./operational-dashboard.js";
import {
  buildConfidenceReport,
  type ConfidenceReport,
} from "./confidence.js";
import {
  buildPathExplainReport,
  type PathExplainReport,
} from "./path-explain.js";
import {
  buildPathExplainViewerArtifact,
  type PathExplainViewerArtifact,
} from "./path-explain-viewer.js";
import {
  buildPrePrMemoryReview,
  type PrePrMemoryReview,
} from "./pre-pr-review.js";
import {
  buildPrePrReviewViewerArtifact,
  type PrePrReviewViewerArtifact,
} from "./pre-pr-review-viewer.js";
import {
  privacyReport,
  type PrivacyMemoryRecord,
  type PrivacyReport,
} from "./privacy.js";
import {
  buildProvenanceReport,
  findNodeForProvenance,
  type ProvenanceReport,
} from "./provenance.js";
import { buildReadinessEnvelope, type MemoryReadinessEnvelope } from "./readiness.js";
import {
  buildReadinessViewerArtifact,
  type ReadinessViewerArtifact,
} from "./readiness-viewer.js";
import {
  buildMemoryRoutingGuide,
  type MemoryRoutingAgent,
  type MemoryRoutingGuide,
} from "./routing-guide.js";
import {
  buildMemoryRoutingGuideViewerArtifact,
  type MemoryRoutingGuideViewerArtifact,
} from "./routing-guide-viewer.js";
import {
  buildReasoningReplay,
  type ReasoningReplayReport,
} from "./reasoning/reasoning-replay.js";
import {
  buildFederationReport,
  type FederationReport,
} from "./federation.js";
import {
  buildSessionTimeline,
  type SessionTimeline,
} from "./session-timeline.js";
import {
  buildSessionTimelineViewerArtifact,
  type SessionTimelineViewerArtifact,
} from "./session-timeline-viewer.js";
import type { MemoryScope, Tier } from "./schema.js";
import {
  buildSkillRecommendations,
  type SkillRecommendationReport,
} from "./skill-recommendations.js";
import { readSkillRollups, type SkillRollup } from "./skill-events.js";
import {
  buildMemorySmartSearch,
  type MemorySmartSearchReport,
} from "./smart-search.js";
import {
  buildMemorySmartSearchViewerArtifact,
  type MemorySmartSearchViewerArtifact,
} from "./smart-search-viewer.js";
import {
  structuralImpactReader,
  type StructuralImpact,
} from "./structural-impact-reader.js";
import {
  buildWhatifReport,
  type WhatifChange,
  type WhatifReport,
} from "./whatif.js";
import {
  buildStructuralImpactViewerArtifact,
  type StructuralImpactViewerArtifact,
} from "./structural-impact-viewer.js";
import {
  buildVectorSearchReport,
  type VectorSearchReport,
} from "./vector-search.js";
import {
  buildVectorStatusViewerArtifact,
  type VectorStatusViewerArtifact,
} from "./vector-status-viewer.js";
import { buildWorkFrontier, type WorkFrontierReport } from "./work-frontier.js";
import {
  buildWorkFrontierViewerArtifact,
  type WorkFrontierViewerArtifact,
} from "./work-frontier-viewer.js";
import {
  buildMemoryWorkbench,
  buildMemoryWorkbenchArtifact,
  type MemoryWorkbenchArtifact,
} from "./workbench.js";

export type MemoryOperationSafetyClass = "read-only" | "mutating";
export type MemoryOperationSideEffectClass = "none" | "cache-write" | "writes-memory";
export type MemoryOperationCapability = "graph-store";

export interface MemoryOperationRendererMetadata {
  cli: {
    command: string;
    supportsJson: boolean;
  };
  mcp: {
    toolName: string;
    description: string;
  };
}

export interface MemoryOperationContext {
  store: MemoryStore;
  rootDir?: string;
}

export interface MemoryOperation<Input, Output> {
  id: string;
  title: string;
  description: string;
  inputSchema: z.ZodType<Input, z.ZodTypeDef, unknown>;
  outputSchema: z.ZodType<Output, z.ZodTypeDef, unknown>;
  safetyClass: MemoryOperationSafetyClass;
  sideEffectClass: MemoryOperationSideEffectClass;
  capabilities: readonly MemoryOperationCapability[];
  renderer: MemoryOperationRendererMetadata;
  execute: (ctx: MemoryOperationContext, input: Input) => Promise<Output>;
}

export type ReadOnlyMemoryOperation<Input = unknown, Output = unknown> = MemoryOperation<
  Input,
  Output
> & {
  safetyClass: "read-only";
  sideEffectClass: "none" | "cache-write";
};

export interface ReadOnlyMemoryOperationRegistry {
  list(): ReadOnlyMemoryOperation[];
  get(id: string): ReadOnlyMemoryOperation;
  execute(id: string, ctx: MemoryOperationContext, input: unknown): Promise<unknown>;
}

const CommunityCacheSchema = z.enum(["read-write", "read-only", "off"]).default("read-only");

const MEMORY_SCOPES = [
  "user",
  "project",
  "repo",
  "branch",
  "worktree",
  "session",
  "agent-run",
] as const satisfies readonly MemoryScope[];

const ScopeInputSchema = z.object({
  scope: z.enum(MEMORY_SCOPES).optional(),
  scope_id: z.string().optional(),
  include_narrower_scopes: z.boolean().default(false),
});

const AskInputSchema = z.object({ question: z.string().min(1) });
type AskInput = z.infer<typeof AskInputSchema>;

const ReadinessInputSchema = ScopeInputSchema.extend({
  goal: z.string().min(1),
  limit: z.number().int().min(1).max(50).optional(),
  min_evidence: z.number().int().min(0).max(50).optional(),
  stale_days: z.number().int().min(1).optional(),
});
type ReadinessInput = z.infer<typeof ReadinessInputSchema>;

const ContextPackInputSchema = ScopeInputSchema.extend({
  goal: z.string().min(1),
  budget_chars: z.number().int().min(0).max(100_000).optional(),
  limit: z.number().int().min(1).max(50).optional(),
  depth: z.number().int().min(0).max(5).optional(),
});
type ContextPackInput = z.infer<typeof ContextPackInputSchema>;

const ClaimCheckInputSchema = z.object({ assertion: z.string().min(1) });
type ClaimCheckInput = z.infer<typeof ClaimCheckInputSchema>;

const DocSearchInputSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(50).optional(),
});
type DocSearchInput = z.infer<typeof DocSearchInputSchema>;
const AssetInventoryInputSchema = z.object({
  kind: z.string().min(1).optional(),
});
type AssetInventoryInput = z.infer<typeof AssetInventoryInputSchema>;
const DocBundleInputSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(10).optional(),
  max_bytes: z.number().int().min(0).max(200_000).optional(),
});
type DocBundleInput = z.infer<typeof DocBundleInputSchema>;

const DocReadInputSchema = z
  .object({
    path: z.string().min(1).optional(),
    rid: z.number().int().min(1).optional(),
    max_bytes: z.number().int().min(0).max(200_000).optional(),
  })
  .refine((input) => input.path || input.rid, {
    message: "doc read requires path or rid",
  });
type DocReadInput = z.infer<typeof DocReadInputSchema>;
const DocEvidencePackInputSchema = DocReadInputSchema;
type DocEvidencePackInput = z.infer<typeof DocEvidencePackInputSchema>;
const DocBacklinksInputSchema = z
  .object({
    rid: z.number().int().min(1).optional(),
    label: z.string().min(1).optional(),
    title: z.string().min(1).optional(),
    query: z.string().min(1).optional(),
  })
  .refine((input) => input.rid || input.label || input.title || input.query, {
    message: "doc backlinks requires rid, label, title, or query",
  });
type DocBacklinksInput = z.infer<typeof DocBacklinksInputSchema>;
const DocRelatedInputSchema = z
  .object({
    path: z.string().min(1).optional(),
    rid: z.number().int().min(1).optional(),
  })
  .refine((input) => input.path || input.rid, {
    message: "doc related requires path or rid",
  });
type DocRelatedInput = z.infer<typeof DocRelatedInputSchema>;

const DocCoverageInputSchema = z.object({});
type DocCoverageInput = z.infer<typeof DocCoverageInputSchema>;
const DocReferenceGraphInputSchema = z.object({});
type DocReferenceGraphInput = z.infer<typeof DocReferenceGraphInputSchema>;

const SmartSearchInputSchema = ScopeInputSchema.extend({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(50).optional(),
  depth: z.number().int().min(0).max(5).optional(),
  include_superseded: z.boolean().default(false),
});
type SmartSearchInput = z.infer<typeof SmartSearchInputSchema>;

const PrePrReviewInputSchema = z.object({
  changed_files: z.array(z.string().min(1)).min(1),
  comparison: z.string().optional(),
});
type PrePrReviewInput = z.infer<typeof PrePrReviewInputSchema>;

const MemoryRoutingAgentSchema = z.enum([
  "codex",
  "claude",
  "cursor",
  "gemini",
  "aider",
  "opencode",
  "generic",
]);
const RoutingGuideInputSchema = z.object({
  agent: MemoryRoutingAgentSchema.optional(),
});
type RoutingGuideInput = z.infer<typeof RoutingGuideInputSchema>;

const ProvenanceInputSchema = z.object({ target: z.string().min(1) });
type ProvenanceInput = z.infer<typeof ProvenanceInputSchema>;

const LintInputSchema = z.object({
  stale_progress_days: z.number().int().min(1).optional(),
});
type LintInput = z.infer<typeof LintInputSchema>;

const SkillRecommendationsInputSchema = ScopeInputSchema.extend({
  task: z.string().min(1),
  limit: z.number().int().min(1).max(20).optional(),
  depth: z.number().int().min(0).max(5).optional(),
});
type SkillRecommendationsInput = z.infer<typeof SkillRecommendationsInputSchema>;

const LearningDebtInputSchema = z.object({
  stale_days: z.number().int().min(1).optional(),
  min_repeated_failures: z.number().int().min(2).optional(),
});
type LearningDebtInput = z.infer<typeof LearningDebtInputSchema>;

const MemoryLayersInputSchema = z.object({});
type MemoryLayersInput = z.infer<typeof MemoryLayersInputSchema>;

const HealthInputSchema = z.object({
  stale_days: z.number().int().min(1).default(90),
});
type HealthInput = z.infer<typeof HealthInputSchema>;

const MemoryDecayInputSchema = z.object({
  stale_days: z.number().int().min(1).optional(),
  deprecate_days: z.number().int().min(1).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});
type MemoryDecayInput = z.infer<typeof MemoryDecayInputSchema>;

const GovernanceInputSchema = z.object({
  stale_progress_days: z.number().int().min(1).optional(),
});
type GovernanceInput = z.infer<typeof GovernanceInputSchema>;

const HookCoverageInputSchema = z.object({});
type HookCoverageInput = z.infer<typeof HookCoverageInputSchema>;

const CapabilityCatalogInputSchema = z.object({});
type CapabilityCatalogInput = z.infer<typeof CapabilityCatalogInputSchema>;

const CompetitiveRadarInputSchema = z.object({});
type CompetitiveRadarInput = z.infer<typeof CompetitiveRadarInputSchema>;
const CompetitiveEvalInputSchema = z.object({});
type CompetitiveEvalInput = z.infer<typeof CompetitiveEvalInputSchema>;

const HandoffInputSchema = z.object({
  focus: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});
type HandoffInput = z.infer<typeof HandoffInputSchema>;

const WorkFrontierInputSchema = z.object({
  focus: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});
type WorkFrontierInput = z.infer<typeof WorkFrontierInputSchema>;

const SessionTimelineInputSchema = z.object({
  session_id: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(500).optional(),
});
type SessionTimelineInput = z.infer<typeof SessionTimelineInputSchema>;

const PathExplainInputSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  max_depth: z.number().int().min(1).max(20).optional(),
});
type PathExplainInput = z.infer<typeof PathExplainInputSchema>;

const ConfidenceInputSchema = z.object({
  node: z.union([z.number().int(), z.string().min(1)]),
});
type ConfidenceInput = z.infer<typeof ConfidenceInputSchema>;

const CommunitiesInputSchema = z.object({
  cache: CommunityCacheSchema,
});
type CommunitiesInput = z.infer<typeof CommunitiesInputSchema>;

const OnboardingMapInputSchema = z.object({
  stale_days: z.number().int().min(1).optional(),
});
type OnboardingMapInput = z.infer<typeof OnboardingMapInputSchema>;

const DashboardInputSchema = z.object({
  stale_days: z.number().int().min(1).optional(),
});
type DashboardInput = z.infer<typeof DashboardInputSchema>;

const WorkbenchInputSchema = z.object({
  stale_days: z.number().int().min(1).optional(),
  session_id: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(500).optional(),
});
type WorkbenchInput = z.infer<typeof WorkbenchInputSchema>;

const StructuralImpactInputSchema = z
  .object({
    file: z.string().min(1).optional(),
    symbol: z.string().min(1).optional(),
  })
  .refine((input) => input.file || input.symbol, {
    message: "structural impact requires file or symbol",
  });
type StructuralImpactInput = z.infer<typeof StructuralImpactInputSchema>;

const VectorStatusInputSchema = z.object({});
type VectorStatusInput = z.infer<typeof VectorStatusInputSchema>;

const ExtractionStatusInputSchema = z.object({});
type ExtractionStatusInput = z.infer<typeof ExtractionStatusInputSchema>;

const VectorSearchInputSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(50).optional(),
});
type VectorSearchInput = z.infer<typeof VectorSearchInputSchema>;

const ReasoningReplayInputSchema = z.object({
  task: z.string().min(1),
  limit: z.number().int().min(1).max(50).optional(),
});
type ReasoningReplayInput = z.infer<typeof ReasoningReplayInputSchema>;

const WhatifChangeSchema = z.object({
  kind: z.enum(["rename", "delete", "edit"]),
  file: z.string().min(1).optional(),
  symbol: z.string().min(1).optional(),
  with: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
}) satisfies z.ZodType<WhatifChange>;

const WhatifInputSchema = z
  .object({
    changes: z.array(WhatifChangeSchema).min(1),
    limit: z.number().int().min(1).max(50).optional(),
  })
  .refine((input) => input.changes.every((c) => c.file || c.symbol || c.description), {
    message: "every change needs at least file, symbol, or description",
  });
type WhatifInput = z.infer<typeof WhatifInputSchema>;

const FederationInputSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(100).optional(),
  per_root_limit: z.number().int().min(1).max(100).optional(),
});
type FederationInput = z.infer<typeof FederationInputSchema>;

const CommunitySummarySchema = z.object({
  id: z.string(),
  count: z.number(),
  labels: z.array(z.string()),
  titles: z.array(z.string()),
});

const CommunityAssignmentSchema = z.object({
  rid: z.number(),
  community_id: z.string(),
  label: z.string(),
  node_type: z.string(),
  title: z.string(),
});

const CommunitiesOutputSchema = z.object({
  schema_version: z.literal("memory.communities.v1"),
  read_only: z.literal(true),
  graph_hash: z.string(),
  cache_key: z.string(),
  cached: z.boolean(),
  generated_at: z.string(),
  communities: z.array(CommunitySummarySchema),
  assignments: z.array(CommunityAssignmentSchema),
}) satisfies z.ZodType<CommunityAnalyticsReport>;
const CommunitiesViewerOutputSchema = objectOutputSchema<CommunitiesViewerArtifact>();

const AskOutputSchema = objectOutputSchema<AskResult>();
const ReadinessOutputSchema = objectOutputSchema<MemoryReadinessEnvelope>();
const ContextPackOutputSchema = objectOutputSchema<ContextPack>();
const ContextPackViewerOutputSchema = objectOutputSchema<ContextPackViewerArtifact>();
const ClaimCheckOutputSchema = objectOutputSchema<ClaimCheckResult>();
const DocBriefOutputSchema = objectOutputSchema<DocBrief>();
const DocBriefViewerOutputSchema = objectOutputSchema<DocBriefViewerArtifact>();
const DocBundleOutputSchema = objectOutputSchema<DocBundle>();
const DocBundleViewerOutputSchema = objectOutputSchema<DocBundleViewerArtifact>();
const DocReadOutputSchema = objectOutputSchema<DocReadResult>();
const DocEvidencePackOutputSchema = objectOutputSchema<DocEvidencePack>();
const DocEvidencePackViewerOutputSchema =
  objectOutputSchema<DocEvidencePackViewerArtifact>();
const DocBacklinksOutputSchema = objectOutputSchema<DocBacklinksReport>();
const DocBacklinksViewerOutputSchema =
  objectOutputSchema<DocBacklinksViewerArtifact>();
const DocRelatedOutputSchema = objectOutputSchema<DocRelatedReport>();
const DocRelatedViewerOutputSchema = objectOutputSchema<DocRelatedViewerArtifact>();
const DocSearchOutputSchema = objectOutputSchema<DocSearchReport>();
const DocCoverageOutputSchema = objectOutputSchema<DocCoverageReport>();
const SmartSearchOutputSchema = objectOutputSchema<MemorySmartSearchReport>();
const SmartSearchViewerOutputSchema =
  objectOutputSchema<MemorySmartSearchViewerArtifact>();
const AssetInventoryOutputSchema = objectOutputSchema<MemoryAssetInventoryReport>();
const AssetInventoryViewerOutputSchema =
  objectOutputSchema<MemoryAssetInventoryViewerArtifact>();
const CompetitiveEvalOutputSchema = objectOutputSchema<CompetitiveEvalV2Report>();
const CompetitiveEvalViewerOutputSchema =
  objectOutputSchema<CompetitiveEvalViewerArtifact>();
const DocCoverageViewerOutputSchema = objectOutputSchema<DocCoverageViewerArtifact>();
const DocReferenceGraphOutputSchema = objectOutputSchema<DocReferenceGraphReport>();
const DocReferenceGraphViewerOutputSchema =
  objectOutputSchema<DocReferenceGraphViewerArtifact>();
const DocSearchViewerOutputSchema = objectOutputSchema<DocSearchViewerArtifact>();
const PrePrReviewOutputSchema = objectOutputSchema<PrePrMemoryReview>();
const PrePrReviewViewerOutputSchema =
  objectOutputSchema<PrePrReviewViewerArtifact>();
const ProvenanceOutputSchema = objectOutputSchema<ProvenanceReport>();
const PrivacyOutputSchema = objectOutputSchema<PrivacyReport>();
const LintOutputSchema = objectOutputSchema<LintReport>();
const SkillRecommendationsOutputSchema = objectOutputSchema<SkillRecommendationReport>();
const LearningDebtOutputSchema = objectOutputSchema<LearningDebtReport>();
const LearningDebtViewerOutputSchema = objectOutputSchema<LearningDebtViewerArtifact>();
const MemoryLayersOutputSchema = objectOutputSchema<MemoryLayersReport>();
const MemoryLayersViewerOutputSchema = objectOutputSchema<MemoryLayersViewerArtifact>();
const OnboardingMapOutputSchema = objectOutputSchema<OnboardingMap>();
const OnboardingMapViewerOutputSchema = objectOutputSchema<OnboardingMapViewerArtifact>();
const DashboardOutputSchema = objectOutputSchema<MemoryOperationalDashboardArtifact>();
const WorkbenchOutputSchema = objectOutputSchema<MemoryWorkbenchArtifact>();
const ReadinessViewerOutputSchema = objectOutputSchema<ReadinessViewerArtifact>();
const RoutingGuideOutputSchema = objectOutputSchema<MemoryRoutingGuide>();
const RoutingGuideViewerOutputSchema =
  objectOutputSchema<MemoryRoutingGuideViewerArtifact>();
const AgentIntegrationStatusOutputSchema =
  objectOutputSchema<MemoryAgentIntegrationStatus>();
const AgentIntegrationStatusViewerOutputSchema =
  objectOutputSchema<MemoryAgentIntegrationStatusViewerArtifact>();
const SessionTimelineOutputSchema = objectOutputSchema<SessionTimeline>();
const SessionTimelineViewerOutputSchema =
  objectOutputSchema<SessionTimelineViewerArtifact>();
const PathExplainOutputSchema = objectOutputSchema<PathExplainReport>();
const ConfidenceOutputSchema = objectOutputSchema<ConfidenceReport>();
const PathExplainViewerOutputSchema = objectOutputSchema<PathExplainViewerArtifact>();
const StructuralImpactOutputSchema = objectOutputSchema<StructuralImpact>();
const StructuralImpactViewerOutputSchema =
  objectOutputSchema<StructuralImpactViewerArtifact>();
const ExtractionStatusOutputSchema = objectOutputSchema<MemoryExtractionStatus>();
const ExtractionStatusViewerOutputSchema =
  objectOutputSchema<MemoryExtractionStatusViewerArtifact>();
const VectorStatusOutputSchema = objectOutputSchema<VectorStatusReport>();
const VectorStatusViewerOutputSchema = objectOutputSchema<VectorStatusViewerArtifact>();
const VectorSearchOutputSchema = objectOutputSchema<VectorSearchReport>();
const ReasoningReplayOutputSchema = objectOutputSchema<ReasoningReplayReport>();
const FederationOutputSchema = objectOutputSchema<FederationReport>();
const WhatifOutputSchema = objectOutputSchema<WhatifReport>();

const HealthOutputSchema = objectOutputSchema<MemoryHealthReport>();
const HealthViewerOutputSchema = objectOutputSchema<MemoryHealthViewerArtifact>();
const MemoryDecayOutputSchema = objectOutputSchema<MemoryDecayReport>();
const MemoryDecayViewerOutputSchema =
  objectOutputSchema<MemoryDecayViewerArtifact>();
const GovernanceOutputSchema = objectOutputSchema<MemoryGovernanceReport>();
const GovernanceViewerOutputSchema =
  objectOutputSchema<MemoryGovernanceViewerArtifact>();
const HandoffOutputSchema = objectOutputSchema<MemoryHandoffReport>();
const HandoffViewerOutputSchema = objectOutputSchema<MemoryHandoffViewerArtifact>();
const WorkFrontierOutputSchema = objectOutputSchema<WorkFrontierReport>();
const WorkFrontierViewerOutputSchema =
  objectOutputSchema<WorkFrontierViewerArtifact>();
const HookCoverageOutputSchema = objectOutputSchema<HookCoverageReport>();
const HookCoverageViewerOutputSchema = objectOutputSchema<HookCoverageViewerArtifact>();
const CapabilityCatalogOutputSchema = objectOutputSchema<MemoryCapabilityCatalog>();
const CompetitiveRadarOutputSchema = objectOutputSchema<MemoryCompetitiveRadar>();

const ASK_OPERATION: MemoryOperation<AskInput, AskResult> = {
  id: "memory.ask",
  title: "Evidence-backed Memory ask",
  description:
    "Grounded ASK over Memory evidence with citations, gap analysis, and provider cost metadata.",
  inputSchema: AskInputSchema,
  outputSchema: AskOutputSchema,
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
  execute: (ctx, input) => ask(ctx.store, input.question),
};

const ASSET_INVENTORY_OPERATION: MemoryOperation<
  AssetInventoryInput,
  MemoryAssetInventoryReport
> = {
  id: "memory.asset-inventory",
  title: "Memory asset inventory",
  description: "Read-only inventory of binary document and media assets indexed in RedDB.",
  inputSchema: AssetInventoryInputSchema,
  outputSchema: AssetInventoryOutputSchema,
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

const ASSET_INVENTORY_VIEWER_OPERATION: MemoryOperation<
  AssetInventoryInput,
  MemoryAssetInventoryViewerArtifact
> = {
  id: "memory.asset-inventory-viewer",
  title: "Memory asset inventory viewer",
  description: "Self-contained HTML viewer for the RedDB asset inventory.",
  inputSchema: AssetInventoryInputSchema,
  outputSchema: AssetInventoryViewerOutputSchema,
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

const READINESS_OPERATION: MemoryOperation<ReadinessInput, MemoryReadinessEnvelope> = {
  id: "memory.readiness",
  title: "Memory readiness",
  description: "Stable readiness envelope for an implementation goal.",
  inputSchema: ReadinessInputSchema,
  outputSchema: ReadinessOutputSchema,
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
      scope: scopeFromInput(input),
    }),
};

const CONTEXT_PACK_OPERATION: MemoryOperation<ContextPackInput, ContextPack> = {
  id: "memory.context-pack",
  title: "Memory context pack",
  description: "Agent-ready context pack for a goal from active Memory evidence.",
  inputSchema: ContextPackInputSchema,
  outputSchema: ContextPackOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "cache-write",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "context pack", supportsJson: true },
    mcp: {
      toolName: "memory_context_pack",
      description:
        "Read-only agent context pack for a goal. Returns grouped evidence, warnings, citations, markdown, and skill recommendations without writing graph facts.",
    },
  },
  execute: (ctx, input) =>
    buildContextPack(ctx.store, input.goal, {
      budgetChars: input.budget_chars,
      limit: input.limit,
      depth: input.depth,
      scope: scopeFromInput(input),
    }),
};

const CONTEXT_PACK_VIEWER_OPERATION: MemoryOperation<
  ContextPackInput,
  ContextPackViewerArtifact
> = {
  id: "memory.context-pack-viewer",
  title: "Memory context pack viewer",
  description: "Self-contained HTML viewer for agent-ready Memory context packs.",
  inputSchema: ContextPackInputSchema,
  outputSchema: ContextPackViewerOutputSchema,
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
  execute: async (ctx, input) =>
    buildContextPackViewerArtifact(
      await buildContextPack(ctx.store, input.goal, {
        budgetChars: input.budget_chars,
        limit: input.limit,
        depth: input.depth,
        scope: scopeFromInput(input),
      }),
    ),
};

const CLAIM_CHECK_OPERATION: MemoryOperation<ClaimCheckInput, ClaimCheckResult> = {
  id: "memory.claim-check",
  title: "Memory claim-check",
  description: "Verify an assertion against local Memory evidence.",
  inputSchema: ClaimCheckInputSchema,
  outputSchema: ClaimCheckOutputSchema,
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

const CAPABILITY_CATALOG_OPERATION: MemoryOperation<
  CapabilityCatalogInput,
  MemoryCapabilityCatalog
> = {
  id: "memory.capability-catalog",
  title: "Memory capability catalog",
  description: "Read-only catalog of Memory competitive capabilities and agent surfaces.",
  inputSchema: CapabilityCatalogInputSchema,
  outputSchema: CapabilityCatalogOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "none",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "capabilities", supportsJson: true },
    mcp: {
      toolName: "memory_capability_catalog",
      description:
        "Read-only capability catalog. Groups Memory features across retrieval, docs, vectors, UI, hooks, code graph, governance, telemetry, and interop with CLI/MCP entry points and competitive evidence IDs.",
    },
  },
  execute: (ctx) => buildMemoryCapabilityCatalog(ctx.store, ctx.rootDir ?? process.cwd()),
};

const COMPETITIVE_RADAR_OPERATION: MemoryOperation<
  CompetitiveRadarInput,
  MemoryCompetitiveRadar
> = {
  id: "memory.competitive-radar",
  title: "Memory competitive radar",
  description:
    "Read-only internal competitor posture report derived from the Memory capability catalog.",
  inputSchema: CompetitiveRadarInputSchema,
  outputSchema: CompetitiveRadarOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "none",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "competitive-radar", supportsJson: true },
    mcp: {
      toolName: "memory_competitive_radar",
      description:
        "Read-only internal competitive radar. Maps capability catalog evidence to named competitor axes, highlights degraded/not-configured gaps, and returns next actions without making public benchmark claims.",
    },
  },
  execute: (ctx) => buildMemoryCompetitiveRadar(ctx.store, ctx.rootDir ?? process.cwd()),
};

const COMPETITIVE_EVAL_OPERATION: MemoryOperation<
  CompetitiveEvalInput,
  CompetitiveEvalV2Report
> = {
  id: "memory.competitive-eval",
  title: "Memory competitive eval",
  description:
    "Read-only executable competitive eval v2 report over checked-in Memory moat fixtures.",
  inputSchema: CompetitiveEvalInputSchema,
  outputSchema: CompetitiveEvalOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "none",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "competitive-eval", supportsJson: true },
    mcp: {
      toolName: "memory_competitive_eval",
      description:
        "Read-only executable competitive eval v2 report. Returns dimensions, claim guards, checked fixture metrics, and opt-in live baseline slots without requiring live services.",
    },
  },
  execute: () => evaluateCompetitiveEvalV2({ now: Date.now() }),
};

const COMPETITIVE_EVAL_VIEWER_OPERATION: MemoryOperation<
  CompetitiveEvalInput,
  CompetitiveEvalViewerArtifact
> = {
  id: "memory.competitive-eval-viewer",
  title: "Memory competitive eval viewer",
  description: "Self-contained HTML viewer for the executable competitive eval v2 report.",
  inputSchema: CompetitiveEvalInputSchema,
  outputSchema: CompetitiveEvalViewerOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "none",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "competitive-eval-viewer", supportsJson: false },
    mcp: {
      toolName: "memory_competitive_eval_viewer",
      description:
        "Read-only self-contained HTML viewer for competitive eval v2. Returns dimensions, metrics, claim guards, embedded JSON, and HTML.",
    },
  },
  execute: async () => buildCompetitiveEvalViewerArtifact(await evaluateCompetitiveEvalV2({ now: Date.now() })),
};

const HANDOFF_OPERATION: MemoryOperation<HandoffInput, MemoryHandoffReport> = {
  id: "memory.handoff",
  title: "Memory handoff",
  description: "Read-only cross-agent handoff brief generated from recent Memory graph evidence.",
  inputSchema: HandoffInputSchema,
  outputSchema: HandoffOutputSchema,
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
    }),
};

const HANDOFF_VIEWER_OPERATION: MemoryOperation<
  HandoffInput,
  MemoryHandoffViewerArtifact
> = {
  id: "memory.handoff-viewer",
  title: "Memory handoff viewer",
  description: "Self-contained HTML viewer for cross-agent Memory handoff evidence.",
  inputSchema: HandoffInputSchema,
  outputSchema: HandoffViewerOutputSchema,
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
      }),
    ),
};

const WORK_FRONTIER_OPERATION: MemoryOperation<
  WorkFrontierInput,
  WorkFrontierReport
> = {
  id: "memory.work-frontier",
  title: "Memory work frontier",
  description: "Read-only ready/blocked work frontier derived from Memory graph evidence.",
  inputSchema: WorkFrontierInputSchema,
  outputSchema: WorkFrontierOutputSchema,
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
    }),
};

const WORK_FRONTIER_VIEWER_OPERATION: MemoryOperation<
  WorkFrontierInput,
  WorkFrontierViewerArtifact
> = {
  id: "memory.work-frontier-viewer",
  title: "Memory work frontier viewer",
  description: "Self-contained HTML viewer for the Memory work frontier.",
  inputSchema: WorkFrontierInputSchema,
  outputSchema: WorkFrontierViewerOutputSchema,
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
      }),
    ),
};

const CONFIDENCE_OPERATION: MemoryOperation<ConfidenceInput, ConfidenceReport> = {
  id: "memory.confidence",
  title: "Memory confidence breakdown",
  description:
    "Read-only composed confidence (0..1) plus per-signal breakdown for a Memory node (issue #167).",
  inputSchema: ConfidenceInputSchema,
  outputSchema: ConfidenceOutputSchema,
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

const PATH_EXPLAIN_OPERATION: MemoryOperation<PathExplainInput, PathExplainReport> = {
  id: "memory.path-explain",
  title: "Memory path explanation",
  description: "Read-only explained graph path between two Memory labels.",
  inputSchema: PathExplainInputSchema,
  outputSchema: PathExplainOutputSchema,
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

const PATH_EXPLAIN_VIEWER_OPERATION: MemoryOperation<
  PathExplainInput,
  PathExplainViewerArtifact
> = {
  id: "memory.path-explain-viewer",
  title: "Memory path explanation viewer",
  description: "Self-contained HTML viewer for a Memory graph path explanation.",
  inputSchema: PathExplainInputSchema,
  outputSchema: PathExplainViewerOutputSchema,
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

const DOC_SEARCH_OPERATION: MemoryOperation<DocSearchInput, DocSearchReport> = {
  id: "memory.doc-search",
  title: "Memory doc search",
  description: "Zero-token search over ingested Memory document chunks.",
  inputSchema: DocSearchInputSchema,
  outputSchema: DocSearchOutputSchema,
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

const DOC_SEARCH_VIEWER_OPERATION: MemoryOperation<
  DocSearchInput,
  DocSearchViewerArtifact
> = {
  id: "memory.doc-search-viewer",
  title: "Memory doc search viewer",
  description: "Self-contained HTML viewer for doc search results.",
  inputSchema: DocSearchInputSchema,
  outputSchema: DocSearchViewerOutputSchema,
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

const DOC_BUNDLE_OPERATION: MemoryOperation<DocBundleInput, DocBundle> = {
  id: "memory.doc-bundle",
  title: "Memory doc bundle",
  description: "Agent-ready bundle of top docs for a query with evidence packs.",
  inputSchema: DocBundleInputSchema,
  outputSchema: DocBundleOutputSchema,
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

const DOC_BRIEF_OPERATION: MemoryOperation<DocBundleInput, DocBrief> = {
  id: "memory.doc-brief",
  title: "Memory doc brief",
  description: "Citation-first docs evidence brief with gap analysis.",
  inputSchema: DocBundleInputSchema,
  outputSchema: DocBriefOutputSchema,
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

const DOC_BRIEF_VIEWER_OPERATION: MemoryOperation<
  DocBundleInput,
  DocBriefViewerArtifact
> = {
  id: "memory.doc-brief-viewer",
  title: "Memory doc brief viewer",
  description: "Self-contained HTML viewer for a citation-first docs brief.",
  inputSchema: DocBundleInputSchema,
  outputSchema: DocBriefViewerOutputSchema,
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

const DOC_BUNDLE_VIEWER_OPERATION: MemoryOperation<
  DocBundleInput,
  DocBundleViewerArtifact
> = {
  id: "memory.doc-bundle-viewer",
  title: "Memory doc bundle viewer",
  description: "Self-contained HTML viewer for a query-level document bundle.",
  inputSchema: DocBundleInputSchema,
  outputSchema: DocBundleViewerOutputSchema,
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

const DOC_READ_OPERATION: MemoryOperation<DocReadInput, DocReadResult> = {
  id: "memory.doc-read",
  title: "Memory doc read",
  description: "Read an ingested Memory document chunk by path or rid.",
  inputSchema: DocReadInputSchema,
  outputSchema: DocReadOutputSchema,
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

const DOC_EVIDENCE_PACK_OPERATION: MemoryOperation<
  DocEvidencePackInput,
  DocEvidencePack
> = {
  id: "memory.doc-evidence-pack",
  title: "Memory doc evidence pack",
  description: "Agent-ready document context pack with body, references, and related docs.",
  inputSchema: DocEvidencePackInputSchema,
  outputSchema: DocEvidencePackOutputSchema,
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

const DOC_EVIDENCE_PACK_VIEWER_OPERATION: MemoryOperation<
  DocEvidencePackInput,
  DocEvidencePackViewerArtifact
> = {
  id: "memory.doc-evidence-pack-viewer",
  title: "Memory doc evidence pack viewer",
  description: "Self-contained HTML viewer for one document evidence pack.",
  inputSchema: DocEvidencePackInputSchema,
  outputSchema: DocEvidencePackViewerOutputSchema,
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

const DOC_BACKLINKS_OPERATION: MemoryOperation<DocBacklinksInput, DocBacklinksReport> = {
  id: "memory.doc-backlinks",
  title: "Memory doc backlinks",
  description: "Find indexed docs that reference one Memory node.",
  inputSchema: DocBacklinksInputSchema,
  outputSchema: DocBacklinksOutputSchema,
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

const DOC_BACKLINKS_VIEWER_OPERATION: MemoryOperation<
  DocBacklinksInput,
  DocBacklinksViewerArtifact
> = {
  id: "memory.doc-backlinks-viewer",
  title: "Memory doc backlinks viewer",
  description: "Self-contained HTML viewer for document backlinks.",
  inputSchema: DocBacklinksInputSchema,
  outputSchema: DocBacklinksViewerOutputSchema,
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

const DOC_RELATED_OPERATION: MemoryOperation<DocRelatedInput, DocRelatedReport> = {
  id: "memory.doc-related",
  title: "Memory doc related",
  description: "Find references and related docs for one ingested Memory document.",
  inputSchema: DocRelatedInputSchema,
  outputSchema: DocRelatedOutputSchema,
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

const DOC_RELATED_VIEWER_OPERATION: MemoryOperation<
  DocRelatedInput,
  DocRelatedViewerArtifact
> = {
  id: "memory.doc-related-viewer",
  title: "Memory doc related viewer",
  description: "Self-contained HTML viewer for references and related docs.",
  inputSchema: DocRelatedInputSchema,
  outputSchema: DocRelatedViewerOutputSchema,
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

const SMART_SEARCH_OPERATION: MemoryOperation<
  SmartSearchInput,
  MemorySmartSearchReport
> = {
  id: "memory.smart-search",
  title: "Memory smart search",
  description: "Unified governed recall, document search, and vector diagnostics.",
  inputSchema: SmartSearchInputSchema,
  outputSchema: SmartSearchOutputSchema,
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
  },
  execute: (ctx, input) =>
    buildMemorySmartSearch(ctx.store, input.query, {
      limit: input.limit,
      depth: input.depth,
      recall: {
        scope: scopeFromInput(input),
        includeSuperseded: input.include_superseded,
      },
    }),
};

const SMART_SEARCH_VIEWER_OPERATION: MemoryOperation<
  SmartSearchInput,
  MemorySmartSearchViewerArtifact
> = {
  id: "memory.smart-search-viewer",
  title: "Memory smart search viewer",
  description: "Self-contained HTML viewer for fused Memory smart search results.",
  inputSchema: SmartSearchInputSchema,
  outputSchema: SmartSearchViewerOutputSchema,
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
  },
  execute: async (ctx, input) =>
    buildMemorySmartSearchViewerArtifact(
      await buildMemorySmartSearch(ctx.store, input.query, {
        limit: input.limit,
        depth: input.depth,
        recall: {
          scope: scopeFromInput(input),
          includeSuperseded: input.include_superseded,
        },
      }),
    ),
};

const DOC_COVERAGE_OPERATION: MemoryOperation<
  DocCoverageInput,
  DocCoverageReport
> = {
  id: "memory.doc-coverage",
  title: "Memory doc coverage",
  description: "Read-only coverage report for ingested docs, graph grounding, and vectors.",
  inputSchema: DocCoverageInputSchema,
  outputSchema: DocCoverageOutputSchema,
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

const DOC_COVERAGE_VIEWER_OPERATION: MemoryOperation<
  DocCoverageInput,
  DocCoverageViewerArtifact
> = {
  id: "memory.doc-coverage-viewer",
  title: "Memory doc coverage viewer",
  description: "Self-contained HTML viewer for document graph/vector coverage.",
  inputSchema: DocCoverageInputSchema,
  outputSchema: DocCoverageViewerOutputSchema,
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

const DOC_REFERENCE_GRAPH_OPERATION: MemoryOperation<
  DocReferenceGraphInput,
  DocReferenceGraphReport
> = {
  id: "memory.doc-reference-graph",
  title: "Memory doc reference graph",
  description: "Read-only graph of ingested docs and extracted REFERENCES edges.",
  inputSchema: DocReferenceGraphInputSchema,
  outputSchema: DocReferenceGraphOutputSchema,
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

const DOC_REFERENCE_GRAPH_VIEWER_OPERATION: MemoryOperation<
  DocReferenceGraphInput,
  DocReferenceGraphViewerArtifact
> = {
  id: "memory.doc-reference-graph-viewer",
  title: "Memory doc reference graph viewer",
  description: "Self-contained HTML viewer for the documentation reference graph.",
  inputSchema: DocReferenceGraphInputSchema,
  outputSchema: DocReferenceGraphViewerOutputSchema,
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

const PRE_PR_REVIEW_OPERATION: MemoryOperation<PrePrReviewInput, PrePrMemoryReview> = {
  id: "memory.pre-pr-review",
  title: "Memory pre-PR review",
  description: "Read-only pre-PR review over changed files using graph evidence.",
  inputSchema: PrePrReviewInputSchema,
  outputSchema: PrePrReviewOutputSchema,
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
  execute: (ctx, input) =>
    buildPrePrMemoryReview(ctx.store, {
      changedFiles: input.changed_files,
      comparison: input.comparison,
    }),
};

const PRE_PR_REVIEW_VIEWER_OPERATION: MemoryOperation<
  PrePrReviewInput,
  PrePrReviewViewerArtifact
> = {
  id: "memory.pre-pr-review-viewer",
  title: "Memory pre-PR review viewer",
  description: "Self-contained HTML pre-PR Memory review viewer.",
  inputSchema: PrePrReviewInputSchema,
  outputSchema: PrePrReviewViewerOutputSchema,
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
        changedFiles: input.changed_files,
        comparison: input.comparison,
      }),
    ),
};

const PROVENANCE_OPERATION: MemoryOperation<ProvenanceInput, ProvenanceReport> = {
  id: "memory.provenance",
  title: "Memory provenance",
  description: "Inspect provenance for a Memory node.",
  inputSchema: ProvenanceInputSchema,
  outputSchema: ProvenanceOutputSchema,
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

const PRIVACY_OPERATION: MemoryOperation<object, PrivacyReport> = {
  id: "memory.privacy-scan",
  title: "Memory privacy scan",
  description: "Read-only sensitive-data scan over graph Memory records.",
  inputSchema: z.object({}),
  outputSchema: PrivacyOutputSchema,
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
    const records = await graphPrivacyRecords(ctx.store);
    return privacyReport("graph", records);
  },
};

const GOVERNANCE_OPERATION: MemoryOperation<GovernanceInput, MemoryGovernanceReport> = {
  id: "memory.governance",
  title: "Memory governance",
  description:
    "Read-only governance report over provenance, privacy, lint, contradictions, and supersession.",
  inputSchema: GovernanceInputSchema,
  outputSchema: GovernanceOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "none",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "governance", supportsJson: true },
    mcp: {
      toolName: "memory_governance",
      description:
        "Read-only governance report over local Memory evidence. Returns provenance coverage, privacy findings, lint findings, contradiction/supersession counts, and recommended next actions without mutating Memory.",
    },
  },
  execute: (ctx, input) =>
    buildMemoryGovernanceReport(ctx.store, {
      staleProgressDays: input.stale_progress_days,
    }),
};

const GOVERNANCE_VIEWER_OPERATION: MemoryOperation<
  GovernanceInput,
  MemoryGovernanceViewerArtifact
> = {
  id: "memory.governance-viewer",
  title: "Memory governance viewer",
  description: "Self-contained HTML viewer for Memory governance evidence.",
  inputSchema: GovernanceInputSchema,
  outputSchema: GovernanceViewerOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "none",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "governance-viewer", supportsJson: false },
    mcp: {
      toolName: "memory_governance_viewer",
      description:
        "Read-only self-contained HTML viewer for provenance, privacy, lint, contradictions, supersession, recommended actions, and embedded governance JSON.",
    },
  },
  execute: async (ctx, input) =>
    buildMemoryGovernanceViewerArtifact(
      await buildMemoryGovernanceReport(ctx.store, {
        staleProgressDays: input.stale_progress_days,
      }),
    ),
};

const LINT_OPERATION: MemoryOperation<LintInput, LintReport> = {
  id: "memory.lint",
  title: "Memory lint",
  description: "Read-only policy hygiene lint over graph Memory records.",
  inputSchema: LintInputSchema,
  outputSchema: LintOutputSchema,
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
    const records = (await ctx.store.listNodes()).map(graphNodeToLintRecord);
    const findings = lintMemoryRecords(records, {
      staleProgressDays: input.stale_progress_days,
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

const SKILL_RECOMMENDATIONS_OPERATION: MemoryOperation<
  SkillRecommendationsInput,
  SkillRecommendationReport
> = {
  id: "memory.skill-recommendations",
  title: "Memory skill recommendations",
  description: "Recommend RedSkills from recalled Memory evidence and skill telemetry.",
  inputSchema: SkillRecommendationsInputSchema,
  outputSchema: SkillRecommendationsOutputSchema,
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
      scope: scopeFromInput(input),
      skillRollups: await safeSkillRollups(ctx.store),
    }),
};

const LEARNING_DEBT_OPERATION: MemoryOperation<LearningDebtInput, LearningDebtReport> = {
  id: "memory.learning-debt",
  title: "Memory learning debt",
  description: "Read-only report of repeated failures, stale guidance, validation gaps, and telemetry gaps.",
  inputSchema: LearningDebtInputSchema,
  outputSchema: LearningDebtOutputSchema,
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
      rollups: await safeSkillRollups(ctx.store),
      skillTelemetryEnabled: true,
    }),
};

const LEARNING_DEBT_VIEWER_OPERATION: MemoryOperation<
  LearningDebtInput,
  LearningDebtViewerArtifact
> = {
  id: "memory.learning-debt-viewer",
  title: "Memory learning debt viewer",
  description: "Self-contained HTML viewer for Memory learning debt evidence.",
  inputSchema: LearningDebtInputSchema,
  outputSchema: LearningDebtViewerOutputSchema,
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
        rollups: await safeSkillRollups(ctx.store),
        skillTelemetryEnabled: true,
      }),
    ),
};

const MEMORY_LAYERS_OPERATION: MemoryOperation<MemoryLayersInput, MemoryLayersReport> = {
  id: "memory.layers",
  title: "Memory layers",
  description:
    "Read-only layered Memory architecture report over session, durable, reasoning, docs/code, and vector evidence.",
  inputSchema: MemoryLayersInputSchema,
  outputSchema: MemoryLayersOutputSchema,
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
  execute: (ctx) => buildMemoryLayersReport(ctx.store),
};

const MEMORY_LAYERS_VIEWER_OPERATION: MemoryOperation<
  MemoryLayersInput,
  MemoryLayersViewerArtifact
> = {
  id: "memory.layers-viewer",
  title: "Memory layers viewer",
  description:
    "Self-contained HTML viewer for layered Memory architecture over RedDB evidence.",
  inputSchema: MemoryLayersInputSchema,
  outputSchema: MemoryLayersViewerOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "none",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "layers-viewer", supportsJson: false },
    mcp: {
      toolName: "memory_layers_viewer",
      description:
        "Read-only self-contained HTML viewer for Memory layers. Returns short-term, long-term, reasoning, docs/code, and vector layer readiness, competitor alignment, recommended actions, embedded JSON, and HTML.",
    },
  },
  execute: async (ctx) =>
    buildMemoryLayersViewerArtifact(await buildMemoryLayersReport(ctx.store)),
};

const HEALTH_OPERATION: MemoryOperation<HealthInput, MemoryHealthReport> = {
  id: "memory.health",
  title: "Memory health",
  description: "Read-only graph health summary for MCP agents.",
  inputSchema: HealthInputSchema,
  outputSchema: HealthOutputSchema,
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
  },
  execute: (ctx, input) => buildMemoryHealthReport(ctx.store, input),
};

const HEALTH_VIEWER_OPERATION: MemoryOperation<
  HealthInput,
  MemoryHealthViewerArtifact
> = {
  id: "memory.health-viewer",
  title: "Memory health viewer",
  description: "Self-contained HTML viewer for Memory operational health.",
  inputSchema: HealthInputSchema,
  outputSchema: HealthViewerOutputSchema,
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
  },
  execute: async (ctx, input) =>
    buildMemoryHealthViewerArtifact(await buildMemoryHealthReport(ctx.store, input)),
};

const MEMORY_DECAY_OPERATION: MemoryOperation<
  MemoryDecayInput,
  MemoryDecayReport
> = {
  id: "memory.decay",
  title: "Memory decay plan",
  description:
    "Read-only retention planner over Memory nodes, access evidence, supersession, contradictions, and TTL horizons.",
  inputSchema: MemoryDecayInputSchema,
  outputSchema: MemoryDecayOutputSchema,
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
  execute: (ctx, input) => buildMemoryDecayReport(ctx.store, input),
};

const MEMORY_DECAY_VIEWER_OPERATION: MemoryOperation<
  MemoryDecayInput,
  MemoryDecayViewerArtifact
> = {
  id: "memory.decay-viewer",
  title: "Memory decay viewer",
  description: "Self-contained HTML viewer for Memory decay planning evidence.",
  inputSchema: MemoryDecayInputSchema,
  outputSchema: MemoryDecayViewerOutputSchema,
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
    buildMemoryDecayViewerArtifact(await buildMemoryDecayReport(ctx.store, input)),
};

const HOOK_COVERAGE_OPERATION: MemoryOperation<HookCoverageInput, HookCoverageReport> = {
  id: "memory.hook-coverage",
  title: "Memory hook coverage",
  description: "Read-only hook manifest and project config coverage report.",
  inputSchema: HookCoverageInputSchema,
  outputSchema: HookCoverageOutputSchema,
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

const HOOK_COVERAGE_VIEWER_OPERATION: MemoryOperation<
  HookCoverageInput,
  HookCoverageViewerArtifact
> = {
  id: "memory.hook-coverage-viewer",
  title: "Memory hook coverage viewer",
  description: "Self-contained HTML viewer for lifecycle hook coverage.",
  inputSchema: HookCoverageInputSchema,
  outputSchema: HookCoverageViewerOutputSchema,
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

const COMMUNITIES_OPERATION: MemoryOperation<CommunitiesInput, CommunityAnalyticsReport> = {
  id: "memory.communities",
  title: "Memory communities",
  description: "Read-only Memory graph community analytics.",
  inputSchema: CommunitiesInputSchema,
  outputSchema: CommunitiesOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "cache-write",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "communities", supportsJson: true },
    mcp: {
      toolName: "memory_communities",
      description:
        "Read-only Memory graph community analytics: native Louvain assignments, community counts, top labels/titles, and graph-hash cache metadata. Does not write derived clusters into Memory graph evidence.",
    },
  },
  execute: (ctx, input) => buildCommunityAnalytics(ctx.store, { cache: input.cache }),
};

const COMMUNITIES_VIEWER_OPERATION: MemoryOperation<
  CommunitiesInput,
  CommunitiesViewerArtifact
> = {
  id: "memory.communities-viewer",
  title: "Memory communities viewer",
  description: "Self-contained HTML viewer for RedDB graph community analytics.",
  inputSchema: CommunitiesInputSchema,
  outputSchema: CommunitiesViewerOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "cache-write",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "communities-viewer", supportsJson: false },
    mcp: {
      toolName: "memory_communities_viewer",
      description:
        "Read-only self-contained HTML viewer for RedDB graph community analytics. Returns native Louvain community summaries, assignments, cache metadata, embedded JSON, and HTML without writing derived clusters into Memory evidence.",
    },
  },
  execute: async (ctx, input) =>
    buildCommunitiesViewerArtifact(
      await buildCommunityAnalytics(ctx.store, { cache: input.cache }),
    ),
};

const ONBOARDING_MAP_OPERATION: MemoryOperation<OnboardingMapInput, OnboardingMap> = {
  id: "memory.onboarding-map",
  title: "Memory onboarding map",
  description: "Read-only map-first onboarding summary from the Memory graph.",
  inputSchema: OnboardingMapInputSchema,
  outputSchema: OnboardingMapOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "none",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "onboarding-map", supportsJson: true },
    mcp: {
      toolName: "memory_onboarding_map",
      description:
        "Read-only map-first onboarding summary from Memory graph evidence. Returns concepts, workflows, decisions, risks, validations, suggested skills, warnings, and markdown.",
    },
  },
  execute: async (ctx, input) =>
    buildOnboardingMap(ctx.store, {
      staleDays: input.stale_days,
      rollups: await safeSkillRollups(ctx.store),
    }),
};

const ONBOARDING_MAP_VIEWER_OPERATION: MemoryOperation<
  OnboardingMapInput,
  OnboardingMapViewerArtifact
> = {
  id: "memory.onboarding-map-viewer",
  title: "Memory onboarding map viewer",
  description: "Self-contained HTML map-first onboarding viewer from Memory graph evidence.",
  inputSchema: OnboardingMapInputSchema,
  outputSchema: OnboardingMapViewerOutputSchema,
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
        rollups: await safeSkillRollups(ctx.store),
      }),
    ),
};

const DASHBOARD_OPERATION: MemoryOperation<
  DashboardInput,
  MemoryOperationalDashboardArtifact
> = {
  id: "memory.dashboard",
  title: "Memory operational dashboard",
  description: "Self-contained HTML dashboard over Memory operational readiness.",
  inputSchema: DashboardInputSchema,
  outputSchema: DashboardOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "none",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "dashboard", supportsJson: false },
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

const WORKBENCH_OPERATION: MemoryOperation<WorkbenchInput, MemoryWorkbenchArtifact> = {
  id: "memory.workbench",
  title: "Memory workbench",
  description: "Self-contained HTML workbench combining Memory dashboard, capabilities, and session timeline.",
  inputSchema: WorkbenchInputSchema,
  outputSchema: WorkbenchOutputSchema,
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
      }),
    ),
};

const READINESS_VIEWER_OPERATION: MemoryOperation<
  ReadinessInput,
  ReadinessViewerArtifact
> = {
  id: "memory.readiness-viewer",
  title: "Memory readiness viewer",
  description: "Self-contained HTML readiness viewer generated from memory.readiness.v1.",
  inputSchema: ReadinessInputSchema,
  outputSchema: ReadinessViewerOutputSchema,
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
        scope: scopeFromInput(input),
      }),
    ),
};

const ROUTING_GUIDE_OPERATION: MemoryOperation<RoutingGuideInput, MemoryRoutingGuide> = {
  id: "memory.routing-guide",
  title: "Memory routing guide",
  description: "Agent-ready Memory routing instructions for AGENTS.md or CLAUDE.md.",
  inputSchema: RoutingGuideInputSchema,
  outputSchema: RoutingGuideOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "none",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "routing-guide", supportsJson: true },
    mcp: {
      toolName: "memory_routing_guide",
      description:
        "Read-only Memory routing guide for agent rule files. Returns target files, recommended MCP tools, CLI fallbacks, safety notes, and an installable AGENTS.md/CLAUDE.md snippet.",
    },
  },
  execute: async (_ctx, input) =>
    buildMemoryRoutingGuide({ agent: input.agent as MemoryRoutingAgent | undefined }),
};

const ROUTING_GUIDE_VIEWER_OPERATION: MemoryOperation<
  RoutingGuideInput,
  MemoryRoutingGuideViewerArtifact
> = {
  id: "memory.routing-guide-viewer",
  title: "Memory routing guide viewer",
  description: "Self-contained HTML viewer for multi-agent Memory routing instructions.",
  inputSchema: RoutingGuideInputSchema,
  outputSchema: RoutingGuideViewerOutputSchema,
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

const AGENT_INTEGRATION_STATUS_OPERATION: MemoryOperation<
  RoutingGuideInput,
  MemoryAgentIntegrationStatus
> = {
  id: "memory.agent-integration-status",
  title: "Memory agent integration status",
  description: "Read-only audit of agent rule files, routing snippets, and hook coverage.",
  inputSchema: RoutingGuideInputSchema,
  outputSchema: AgentIntegrationStatusOutputSchema,
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
    }),
};

const AGENT_INTEGRATION_STATUS_VIEWER_OPERATION: MemoryOperation<
  RoutingGuideInput,
  MemoryAgentIntegrationStatusViewerArtifact
> = {
  id: "memory.agent-integration-status-viewer",
  title: "Memory agent integration status viewer",
  description: "Self-contained HTML viewer for Memory agent integration status.",
  inputSchema: RoutingGuideInputSchema,
  outputSchema: AgentIntegrationStatusViewerOutputSchema,
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
      }),
    ),
};

const SESSION_TIMELINE_OPERATION: MemoryOperation<SessionTimelineInput, SessionTimeline> = {
  id: "memory.session-timeline",
  title: "Memory session timeline",
  description: "Read-only replay-style timeline over Memory hook and skill telemetry events.",
  inputSchema: SessionTimelineInputSchema,
  outputSchema: SessionTimelineOutputSchema,
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
    }),
};

const SESSION_TIMELINE_VIEWER_OPERATION: MemoryOperation<
  SessionTimelineInput,
  SessionTimelineViewerArtifact
> = {
  id: "memory.session-timeline-viewer",
  title: "Memory session timeline viewer",
  description: "Self-contained HTML replay viewer over Memory hook and skill telemetry events.",
  inputSchema: SessionTimelineInputSchema,
  outputSchema: SessionTimelineViewerOutputSchema,
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
      }),
    ),
};

const STRUCTURAL_IMPACT_OPERATION: MemoryOperation<
  StructuralImpactInput,
  StructuralImpact
> = {
  id: "memory.structural-impact",
  title: "Memory structural impact",
  description: "Read-only file/symbol impact query over ingested code graph evidence.",
  inputSchema: StructuralImpactInputSchema,
  outputSchema: StructuralImpactOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "none",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "structural-impact", supportsJson: false },
    mcp: {
      toolName: "memory_structural_impact",
      description:
        "Read-only file/symbol impact query over ingested code graph evidence. Returns imports, imported-by edges, call/called-by edges, type-use edges, symbols defined by a file, and the file defining a symbol.",
    },
  },
  execute: (ctx, input) =>
    structuralImpactReader(ctx.store)({
      file: input.file,
      symbol: input.symbol,
    }),
};

const STRUCTURAL_IMPACT_VIEWER_OPERATION: MemoryOperation<
  StructuralImpactInput,
  StructuralImpactViewerArtifact
> = {
  id: "memory.structural-impact-viewer",
  title: "Memory structural impact viewer",
  description: "Self-contained HTML structural impact viewer over code graph evidence.",
  inputSchema: StructuralImpactInputSchema,
  outputSchema: StructuralImpactViewerOutputSchema,
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

const EXTRACTION_STATUS_OPERATION: MemoryOperation<
  ExtractionStatusInput,
  MemoryExtractionStatus
> = {
  id: "memory.extraction-status",
  title: "Memory extraction status",
  description: "Read-only status for deterministic and inferred Memory extraction paths.",
  inputSchema: ExtractionStatusInputSchema,
  outputSchema: ExtractionStatusOutputSchema,
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
    buildMemoryExtractionStatus(ctx.store, ctx.rootDir ?? process.cwd()),
};

const EXTRACTION_STATUS_VIEWER_OPERATION: MemoryOperation<
  ExtractionStatusInput,
  MemoryExtractionStatusViewerArtifact
> = {
  id: "memory.extraction-status-viewer",
  title: "Memory extraction status viewer",
  description: "Self-contained HTML viewer for deterministic and inferred extraction readiness.",
  inputSchema: ExtractionStatusInputSchema,
  outputSchema: ExtractionStatusViewerOutputSchema,
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
      await buildMemoryExtractionStatus(ctx.store, ctx.rootDir ?? process.cwd()),
    ),
};

const VECTOR_STATUS_OPERATION: MemoryOperation<VectorStatusInput, VectorStatusReport> = {
  id: "memory.vector-status",
  title: "Memory vector status",
  description: "Read-only vector projection readiness for hybrid recall.",
  inputSchema: VectorStatusInputSchema,
  outputSchema: VectorStatusOutputSchema,
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

const VECTOR_STATUS_VIEWER_OPERATION: MemoryOperation<
  VectorStatusInput,
  VectorStatusViewerArtifact
> = {
  id: "memory.vector-status-viewer",
  title: "Memory vector status viewer",
  description: "Self-contained HTML viewer for RedDB vector projection readiness.",
  inputSchema: VectorStatusInputSchema,
  outputSchema: VectorStatusViewerOutputSchema,
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

const VECTOR_SEARCH_OPERATION: MemoryOperation<VectorSearchInput, VectorSearchReport> = {
  id: "memory.vector-search",
  title: "Memory vector search",
  description: "Read-only diagnostic search over grounded vector candidates.",
  inputSchema: VectorSearchInputSchema,
  outputSchema: VectorSearchOutputSchema,
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

const REASONING_REPLAY_OPERATION: MemoryOperation<
  ReasoningReplayInput,
  ReasoningReplayReport
> = {
  id: "memory.reasoning-replay",
  title: "Memory reasoning replay",
  description:
    "Read-only similarity ranking over reasoning-tier attempt nodes for a task descriptor.",
  inputSchema: ReasoningReplayInputSchema,
  outputSchema: ReasoningReplayOutputSchema,
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
    buildReasoningReplay(ctx.store, input.task, { limit: input.limit }),
};

const WHATIF_OPERATION: MemoryOperation<WhatifInput, WhatifReport> = {
  id: "memory.whatif",
  title: "Memory what-if (pre-action blast radius)",
  description:
    "Read-only pre-action blast-radius prediction. Composes structural-impact-reader and reasoning-replay to return affected files, symbols, tests, historical similar attempts, a composite breakage_likelihood, and a self_confidence score.",
  inputSchema: WhatifInputSchema,
  outputSchema: WhatifOutputSchema,
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
  },
  execute: (ctx, input) =>
    buildWhatifReport(ctx.store, input.changes, { limit: input.limit }),
};

const FEDERATION_OPERATION: MemoryOperation<FederationInput, FederationReport> = {
  id: "memory.federation",
  title: "Memory federation",
  description:
    "Read-only cross-root federation. Reads memory notes from each configured root in .red/memory/federation.yaml and returns merged hits tagged with origin_repo. No privacy policy applied in this slice.",
  inputSchema: FederationInputSchema,
  outputSchema: FederationOutputSchema,
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
    }),
};

const READ_ONLY_OPERATIONS = createReadOnlyMemoryOperationRegistry([
  ASK_OPERATION,
  ASSET_INVENTORY_OPERATION,
  ASSET_INVENTORY_VIEWER_OPERATION,
  AGENT_INTEGRATION_STATUS_OPERATION,
  AGENT_INTEGRATION_STATUS_VIEWER_OPERATION,
  CAPABILITY_CATALOG_OPERATION,
  CLAIM_CHECK_OPERATION,
  COMMUNITIES_OPERATION,
  COMMUNITIES_VIEWER_OPERATION,
  COMPETITIVE_EVAL_OPERATION,
  COMPETITIVE_EVAL_VIEWER_OPERATION,
  COMPETITIVE_RADAR_OPERATION,
  CONTEXT_PACK_OPERATION,
  CONTEXT_PACK_VIEWER_OPERATION,
  DASHBOARD_OPERATION,
  DOC_COVERAGE_OPERATION,
  DOC_COVERAGE_VIEWER_OPERATION,
  DOC_BACKLINKS_OPERATION,
  DOC_BACKLINKS_VIEWER_OPERATION,
  DOC_BRIEF_OPERATION,
  DOC_BRIEF_VIEWER_OPERATION,
  DOC_BUNDLE_OPERATION,
  DOC_BUNDLE_VIEWER_OPERATION,
  DOC_EVIDENCE_PACK_OPERATION,
  DOC_EVIDENCE_PACK_VIEWER_OPERATION,
  DOC_REFERENCE_GRAPH_OPERATION,
  DOC_REFERENCE_GRAPH_VIEWER_OPERATION,
  DOC_READ_OPERATION,
  DOC_RELATED_OPERATION,
  DOC_RELATED_VIEWER_OPERATION,
  DOC_SEARCH_OPERATION,
  DOC_SEARCH_VIEWER_OPERATION,
  EXTRACTION_STATUS_OPERATION,
  EXTRACTION_STATUS_VIEWER_OPERATION,
  GOVERNANCE_OPERATION,
  GOVERNANCE_VIEWER_OPERATION,
  HANDOFF_OPERATION,
  HANDOFF_VIEWER_OPERATION,
  WORK_FRONTIER_OPERATION,
  WORK_FRONTIER_VIEWER_OPERATION,
  HEALTH_OPERATION,
  HEALTH_VIEWER_OPERATION,
  MEMORY_DECAY_OPERATION,
  MEMORY_DECAY_VIEWER_OPERATION,
  HOOK_COVERAGE_OPERATION,
  HOOK_COVERAGE_VIEWER_OPERATION,
  LEARNING_DEBT_OPERATION,
  LEARNING_DEBT_VIEWER_OPERATION,
  LINT_OPERATION,
  MEMORY_LAYERS_OPERATION,
  MEMORY_LAYERS_VIEWER_OPERATION,
  ONBOARDING_MAP_OPERATION,
  ONBOARDING_MAP_VIEWER_OPERATION,
  CONFIDENCE_OPERATION,
  PATH_EXPLAIN_OPERATION,
  PATH_EXPLAIN_VIEWER_OPERATION,
  PRE_PR_REVIEW_OPERATION,
  PRE_PR_REVIEW_VIEWER_OPERATION,
  PRIVACY_OPERATION,
  PROVENANCE_OPERATION,
  REASONING_REPLAY_OPERATION,
  WHATIF_OPERATION,
  FEDERATION_OPERATION,
  READINESS_OPERATION,
  READINESS_VIEWER_OPERATION,
  ROUTING_GUIDE_OPERATION,
  ROUTING_GUIDE_VIEWER_OPERATION,
  SESSION_TIMELINE_OPERATION,
  SESSION_TIMELINE_VIEWER_OPERATION,
  SKILL_RECOMMENDATIONS_OPERATION,
  SMART_SEARCH_OPERATION,
  SMART_SEARCH_VIEWER_OPERATION,
  STRUCTURAL_IMPACT_OPERATION,
  STRUCTURAL_IMPACT_VIEWER_OPERATION,
  VECTOR_SEARCH_OPERATION,
  VECTOR_STATUS_OPERATION,
  VECTOR_STATUS_VIEWER_OPERATION,
  WORKBENCH_OPERATION,
]);

export function createReadOnlyMemoryOperationRegistry(
  operations: readonly MemoryOperation<any, any>[],
): ReadOnlyMemoryOperationRegistry {
  const byId = new Map<string, ReadOnlyMemoryOperation>();
  for (const operation of operations) {
    assertReadOnlyOperation(operation);
    if (byId.has(operation.id)) throw new Error(`duplicate Memory operation: ${operation.id}`);
    byId.set(operation.id, operation);
  }

  return {
    list: () => [...byId.values()],
    get: (id) => {
      const operation = byId.get(id);
      if (!operation) throw new Error(`unknown read-only Memory operation: ${id}`);
      return operation;
    },
    execute: async (id, ctx, input) => {
      const operation = byId.get(id);
      if (!operation) throw new Error(`unknown read-only Memory operation: ${id}`);
      const parsedInput = operation.inputSchema.parse(input);
      const output = await operation.execute(ctx, parsedInput);
      return operation.outputSchema.parse(output);
    },
  };
}

export function listReadOnlyMemoryOperations(): ReadOnlyMemoryOperation[] {
  return READ_ONLY_OPERATIONS.list();
}

export function getReadOnlyMemoryOperation(id: string): ReadOnlyMemoryOperation {
  return READ_ONLY_OPERATIONS.get(id);
}

export async function executeReadOnlyMemoryOperation(
  id: string,
  ctx: MemoryOperationContext,
  input: unknown,
): Promise<unknown> {
  return READ_ONLY_OPERATIONS.execute(id, ctx, input);
}

function assertReadOnlyOperation(
  operation: MemoryOperation<unknown, unknown>,
): asserts operation is ReadOnlyMemoryOperation {
  if (operation.safetyClass !== "read-only") {
    throw new Error(`Memory operation ${operation.id} is not read-only`);
  }
  if (operation.sideEffectClass === "writes-memory") {
    throw new Error(`Memory operation ${operation.id} writes memory and cannot be read-only`);
  }
}

function objectOutputSchema<T>(): z.ZodType<T> {
  return z.custom<T>((value) => value !== null && typeof value === "object");
}

function scopeFromInput(input: {
  scope?: MemoryScope;
  scope_id?: string;
  include_narrower_scopes?: boolean;
}):
  | {
      level: MemoryScope;
      id?: string;
      includeNarrower?: boolean;
    }
  | undefined {
  if (!input.scope) return undefined;
  return {
    level: input.scope,
    id: input.scope_id,
    includeNarrower: input.include_narrower_scopes,
  };
}

async function safeSkillRollups(store: MemoryStore): Promise<SkillRollup[]> {
  try {
    return await readSkillRollups(store);
  } catch {
    return [];
  }
}

async function graphPrivacyRecords(store: MemoryStore): Promise<PrivacyMemoryRecord[]> {
  const [nodes, edges] = await Promise.all([store.listNodes(), store.listEdges()]);
  return [
    ...nodes.map((node) => ({
      id: `memory_nodes:${node.rid}`,
      location: `memory_nodes:${node.rid}`,
      fields: {
        label: node.label,
        node_type: node.node_type,
        ...node.properties,
      },
    })),
    ...edges.map((edge) => ({
      id: `memory_edges:${String(edge.rid ?? "unknown")}`,
      location: `memory_edges:${String(edge.rid ?? "unknown")}`,
      fields: edge,
    })),
  ];
}

function graphNodeToLintRecord(node: StoredNode): LintMemoryRecord {
  const props = node.properties;
  return {
    id: `memory_nodes:${node.rid}`,
    location: `memory_nodes:${node.rid}`,
    title: String(props.title ?? node.label),
    body: String(props.content ?? props.summary ?? props.title ?? node.label),
    scope: parseScope(props.scope),
    tier: parseTier(props.tier),
    createdAt: parseTime(props.created_at),
    updatedAt: parseTime(props.updated_at),
  };
}

function parseScope(value: unknown): MemoryScope | undefined {
  return MEMORY_SCOPES.includes(value as MemoryScope) ? (value as MemoryScope) : undefined;
}

function parseTier(value: unknown): Tier | undefined {
  return value === "durable" || value === "ephemeral" || value === "reasoning"
    ? value
    : undefined;
}

function parseTime(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
