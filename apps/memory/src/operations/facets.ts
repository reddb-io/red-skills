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

import type {
  MemoryOperationFacets,
  MemoryOperationFileSinkBinding,
  MemoryOperationOutputKind,
} from "./types.js";
import {
  firstString,
  flagField,
  hashedQueryViewerOutput,
  inputBinding,
  joinedPositionalInput,
  joinedPositionalValue,
  operationFacets,
  positionalField,
  whatifChangesFromTransport,
} from "./helpers.js";

const JSON_REPORT_OUTPUT = { kind: "report", format: "json" } as const;
const DEFAULT_VIEWER_FILE_SINK: MemoryOperationFileSinkBinding = {
  field: "out",
  sources: ["flag", "query"],
  type: "path",
};
const VIEWER_OUTPUT: MemoryOperationOutputKind = {
  kind: "viewer",
  artifact: "self-contained-html",
  fileSink: DEFAULT_VIEWER_FILE_SINK,
};
const DOC_BRIEF_VIEWER_OUTPUT: MemoryOperationOutputKind = hashedQueryViewerOutput(
  "doc-brief",
  "Derive the doc brief viewer sink from a stable hash of the query when no explicit out path is provided.",
);
const SMART_SEARCH_VIEWER_OUTPUT: MemoryOperationOutputKind = {
  kind: "viewer",
  artifact: "self-contained-html",
  fileSink: {
    ...DEFAULT_VIEWER_FILE_SINK,
    customBind: {
      id: "hashed-viewer-output-path",
      description:
        "When no explicit out path is provided, derive the smart-search viewer sink from a stable hash of the joined query.",
      bind: (input) => {
        const explicitOut = firstString(input.flags.out, input.query.out);
        if (explicitOut) return explicitOut;
        const query = joinedPositionalValue(input);
        if (!query) return undefined;
        const safeName = createHash("sha256").update(query).digest("hex").slice(0, 12);
        return join(input.rootDir ?? process.cwd(), `.red/memory/smart-search-${safeName}.html`);
      },
    },
  },
};

const NO_INPUT = inputBinding([]);
const SCOPE_INPUT_FIELDS = [
  flagField("scope", "string"),
  flagField("scope_id", "string"),
  flagField("include_narrower_scopes", "boolean"),
] as const;

export const MEMORY_OPERATION_FACETS: Record<string, MemoryOperationFacets> = {
  ...operationFacets(
    [
      "memory.capability-catalog",
      "memory.references-radar",
      "memory.doc-coverage",
      "memory.doc-reference-graph",
      "memory.privacy-scan",
      "memory.layers",
      "memory.hook-coverage",
      "memory.extraction-status",
      "memory.vector-status",
    ],
    NO_INPUT,
    JSON_REPORT_OUTPUT,
  ),
  ...operationFacets(
    [
      "memory.doc-coverage-viewer",
      "memory.doc-reference-graph-viewer",
      "memory.layers-viewer",
      "memory.hook-coverage-viewer",
      "memory.extraction-status-viewer",
      "memory.vector-status-viewer",
    ],
    NO_INPUT,
    VIEWER_OUTPUT,
  ),
  ...operationFacets(
    ["memory.asset-inventory", "memory.asset-inventory-viewer"],
    inputBinding([
      flagField("kind", "string"),
      flagField("query", "string"),
      flagField("limit", "number"),
    ]),
    undefined,
    {
      "memory.asset-inventory": JSON_REPORT_OUTPUT,
      "memory.asset-inventory-viewer": VIEWER_OUTPUT,
    },
  ),
  ...operationFacets(
    ["memory.ask"],
    joinedPositionalInput("question"),
    JSON_REPORT_OUTPUT,
  ),
  ...operationFacets(
    ["memory.claim-check"],
    joinedPositionalInput("assertion"),
    JSON_REPORT_OUTPUT,
  ),
  ...operationFacets(
    ["memory.readiness", "memory.readiness-viewer"],
    joinedPositionalInput("goal", [
      flagField("limit", "number"),
      flagField("min_evidence", "number"),
      flagField("stale_days", "number"),
      ...SCOPE_INPUT_FIELDS,
    ]),
    undefined,
    {
      "memory.readiness": JSON_REPORT_OUTPUT,
      "memory.readiness-viewer": VIEWER_OUTPUT,
    },
  ),
  ...operationFacets(
    ["memory.context-pack", "memory.context-pack-viewer"],
    joinedPositionalInput("goal", [
      flagField("budget_chars", "number"),
      flagField("limit", "number"),
      flagField("depth", "number"),
      ...SCOPE_INPUT_FIELDS,
    ]),
    undefined,
    {
      "memory.context-pack": JSON_REPORT_OUTPUT,
      "memory.context-pack-viewer": VIEWER_OUTPUT,
    },
  ),
  ...operationFacets(
    ["memory.map-context"],
    joinedPositionalInput("query", [
      flagField("depth", "number"),
      flagField("mode", "string"),
      flagField("context", "string"),
      flagField("budget", "number"),
    ]),
    JSON_REPORT_OUTPUT,
  ),
  ...operationFacets(
    ["memory.doc-search", "memory.doc-search-viewer"],
    joinedPositionalInput("query", [flagField("limit", "number")]),
    undefined,
    {
      "memory.doc-search": JSON_REPORT_OUTPUT,
      "memory.doc-search-viewer": VIEWER_OUTPUT,
    },
  ),
  ...operationFacets(
    [
      "memory.doc-brief",
      "memory.doc-brief-viewer",
      "memory.doc-bundle",
      "memory.doc-bundle-viewer",
    ],
    joinedPositionalInput("query", [
      flagField("limit", "number"),
      flagField("max_bytes", "number"),
    ]),
    undefined,
    {
      "memory.doc-brief": JSON_REPORT_OUTPUT,
      "memory.doc-brief-viewer": DOC_BRIEF_VIEWER_OUTPUT,
      "memory.doc-bundle": JSON_REPORT_OUTPUT,
      "memory.doc-bundle-viewer": VIEWER_OUTPUT,
    },
  ),
  ...operationFacets(
    ["memory.doc-read", "memory.doc-evidence-pack", "memory.doc-evidence-pack-viewer"],
    inputBinding([
      positionalField("path", "path", { required: false }),
      positionalField("rid", "number", { required: false }),
      flagField("max_bytes", "number"),
    ]),
    undefined,
    {
      "memory.doc-read": JSON_REPORT_OUTPUT,
      "memory.doc-evidence-pack": JSON_REPORT_OUTPUT,
      "memory.doc-evidence-pack-viewer": VIEWER_OUTPUT,
    },
  ),
  ...operationFacets(
    ["memory.doc-backlinks", "memory.doc-backlinks-viewer"],
    inputBinding([
      positionalField("query", "string", { required: false }),
      positionalField("rid", "number", { required: false }),
      flagField("title", "string"),
      flagField("label", "string"),
    ]),
    undefined,
    {
      "memory.doc-backlinks": JSON_REPORT_OUTPUT,
      "memory.doc-backlinks-viewer": VIEWER_OUTPUT,
    },
  ),
  ...operationFacets(
    ["memory.doc-related", "memory.doc-related-viewer"],
    inputBinding([
      positionalField("path", "path", { required: false }),
      positionalField("rid", "number", { required: false }),
    ]),
    undefined,
    {
      "memory.doc-related": JSON_REPORT_OUTPUT,
      "memory.doc-related-viewer": VIEWER_OUTPUT,
    },
  ),
  ...operationFacets(
    ["memory.smart-search"],
    joinedPositionalInput("query", [
      flagField("limit", "number"),
      flagField("depth", "number"),
      flagField("include_superseded", "boolean"),
      ...SCOPE_INPUT_FIELDS,
    ]),
    JSON_REPORT_OUTPUT,
  ),
  ...operationFacets(
    ["memory.smart-search-viewer"],
    joinedPositionalInput("query", [
      flagField("limit", "number"),
      flagField("depth", "number"),
      flagField("include_superseded", "boolean"),
      ...SCOPE_INPUT_FIELDS,
    ]),
    SMART_SEARCH_VIEWER_OUTPUT,
  ),
  ...operationFacets(
    ["memory.pre-pr-review", "memory.pre-pr-review-viewer"],
    inputBinding([
      flagField("changed_files", "string-array"),
      flagField("comparison", "string"),
    ]),
    undefined,
    {
      "memory.pre-pr-review": JSON_REPORT_OUTPUT,
      "memory.pre-pr-review-viewer": VIEWER_OUTPUT,
    },
  ),
  ...operationFacets(
    ["memory.provenance"],
    joinedPositionalInput("target"),
    JSON_REPORT_OUTPUT,
  ),
  ...operationFacets(
    ["memory.map-contract"],
    inputBinding([flagField("communities", "boolean")]),
    JSON_REPORT_OUTPUT,
  ),
  ...operationFacets(
    ["memory.governance", "memory.governance-viewer"],
    inputBinding([flagField("stale_progress_days", "number")]),
    undefined,
    {
      "memory.governance": JSON_REPORT_OUTPUT,
      "memory.governance-viewer": VIEWER_OUTPUT,
    },
  ),
  ...operationFacets(
    ["memory.lint"],
    inputBinding([flagField("stale_progress_days", "number")]),
    JSON_REPORT_OUTPUT,
  ),
  ...operationFacets(
    ["memory.skill-recommendations"],
    joinedPositionalInput("task", [
      flagField("limit", "number"),
      flagField("depth", "number"),
      ...SCOPE_INPUT_FIELDS,
    ]),
    JSON_REPORT_OUTPUT,
  ),
  ...operationFacets(
    ["memory.learning-debt", "memory.learning-debt-viewer"],
    inputBinding([
      flagField("stale_days", "number"),
      flagField("min_repeated_failures", "number"),
    ]),
    undefined,
    {
      "memory.learning-debt": JSON_REPORT_OUTPUT,
      "memory.learning-debt-viewer": VIEWER_OUTPUT,
    },
  ),
  ...operationFacets(
    ["memory.health", "memory.health-viewer"],
    inputBinding([flagField("stale_days", "number")]),
    undefined,
    {
      "memory.health": JSON_REPORT_OUTPUT,
      "memory.health-viewer": VIEWER_OUTPUT,
    },
  ),
  ...operationFacets(
    ["memory.decay", "memory.decay-viewer"],
    inputBinding([
      flagField("stale_days", "number"),
      flagField("deprecate_days", "number"),
      flagField("limit", "number"),
    ]),
    undefined,
    {
      "memory.decay": JSON_REPORT_OUTPUT,
      "memory.decay-viewer": VIEWER_OUTPUT,
    },
  ),
  ...operationFacets(
    ["memory.merge-pass"],
    inputBinding([flagField("min_score", "number"), flagField("limit", "number")]),
    JSON_REPORT_OUTPUT,
  ),
  ...operationFacets(
    ["memory.communities", "memory.communities-viewer", "memory.community-digest"],
    inputBinding([flagField("cache", "string")]),
    undefined,
    {
      "memory.communities": JSON_REPORT_OUTPUT,
      "memory.communities-viewer": VIEWER_OUTPUT,
      "memory.community-digest": JSON_REPORT_OUTPUT,
    },
  ),
  ...operationFacets(
    ["memory.hub-report"],
    inputBinding([
      flagField("limit", "number"),
      flagField("rank_by", "string"),
    ]),
    JSON_REPORT_OUTPUT,
  ),
  ...operationFacets(
    ["memory.suggested-questions"],
    inputBinding([flagField("limit", "number")]),
    JSON_REPORT_OUTPUT,
  ),
  ...operationFacets(
    ["memory.global-search"],
    joinedPositionalInput("query", [
      flagField("limit", "number"),
      flagField("cache", "string"),
    ]),
    JSON_REPORT_OUTPUT,
  ),
  ...operationFacets(
    ["memory.recall-ranking"],
    joinedPositionalInput("query", [
      flagField("limit", "number"),
      flagField("include_superseded", "boolean"),
      ...SCOPE_INPUT_FIELDS,
    ]),
    JSON_REPORT_OUTPUT,
  ),
  ...operationFacets(
    ["memory.onboarding-map", "memory.onboarding-map-viewer"],
    inputBinding([flagField("stale_days", "number")]),
    undefined,
    {
      "memory.onboarding-map": JSON_REPORT_OUTPUT,
      "memory.onboarding-map-viewer": VIEWER_OUTPUT,
    },
  ),
  ...operationFacets(["memory.map-freshness"], inputBinding([]), JSON_REPORT_OUTPUT),
  ...operationFacets(
    ["memory.dashboard"],
    inputBinding([flagField("stale_days", "number")]),
    VIEWER_OUTPUT,
  ),
  ...operationFacets(
    ["memory.workbench"],
    inputBinding([
      flagField("stale_days", "number"),
      flagField("session_id", "string"),
      flagField("limit", "number"),
    ]),
    VIEWER_OUTPUT,
  ),
  ...operationFacets(
    [
      "memory.routing-guide",
      "memory.routing-guide-viewer",
      "memory.agent-integration-status",
      "memory.agent-integration-status-viewer",
    ],
    inputBinding([flagField("agent", "string")]),
    undefined,
    {
      "memory.routing-guide": JSON_REPORT_OUTPUT,
      "memory.routing-guide-viewer": VIEWER_OUTPUT,
      "memory.agent-integration-status": JSON_REPORT_OUTPUT,
      "memory.agent-integration-status-viewer": VIEWER_OUTPUT,
    },
  ),
  ...operationFacets(
    ["memory.handoff", "memory.handoff-viewer", "memory.work-frontier", "memory.work-frontier-viewer"],
    joinedPositionalInput("focus", [flagField("limit", "number")], { required: false }),
    undefined,
    {
      "memory.handoff": JSON_REPORT_OUTPUT,
      "memory.handoff-viewer": VIEWER_OUTPUT,
      "memory.work-frontier": JSON_REPORT_OUTPUT,
      "memory.work-frontier-viewer": VIEWER_OUTPUT,
    },
  ),
  ...operationFacets(
    ["memory.session-timeline", "memory.session-timeline-viewer"],
    inputBinding([flagField("session_id", "string"), flagField("limit", "number")]),
    undefined,
    {
      "memory.session-timeline": JSON_REPORT_OUTPUT,
      "memory.session-timeline-viewer": VIEWER_OUTPUT,
    },
  ),
  ...operationFacets(
    ["memory.path-explain", "memory.path-explain-viewer"],
    inputBinding([
      positionalField("from", "string", { position: 0, required: true }),
      positionalField("to", "string", { position: 1, required: true }),
      flagField("max_depth", "number"),
    ]),
    undefined,
    {
      "memory.path-explain": JSON_REPORT_OUTPUT,
      "memory.path-explain-viewer": VIEWER_OUTPUT,
    },
  ),
  ...operationFacets(
    ["memory.confidence"],
    inputBinding([flagField("node", "string", { required: true })]),
    JSON_REPORT_OUTPUT,
  ),
  ...operationFacets(
    ["memory.structural-impact"],
    inputBinding([flagField("file", "path"), flagField("symbol", "string")]),
    JSON_REPORT_OUTPUT,
  ),
  ...operationFacets(
    ["memory.structural-impact-viewer"],
    inputBinding([flagField("file", "path"), flagField("symbol", "string")]),
    VIEWER_OUTPUT,
  ),
  ...operationFacets(
    ["memory.vector-search"],
    joinedPositionalInput("query", [flagField("limit", "number")]),
    JSON_REPORT_OUTPUT,
  ),
  ...operationFacets(
    ["memory.reasoning-replay"],
    joinedPositionalInput("task", [flagField("limit", "number")]),
    JSON_REPORT_OUTPUT,
  ),
  ...operationFacets(
    ["memory.whatif"],
    inputBinding(
      [
        flagField("changes", "object-array", { required: true }),
        flagField("limit", "number"),
      ],
      {
        id: "http-whatif-changes",
        description:
          "Bind HTTP what-if changes from repeated change query parameters or a JSON body with a changes array.",
        bind: (input) => {
          const changes = whatifChangesFromTransport(input);
          return changes.length > 0 ? { changes } : {};
        },
      },
    ),
    JSON_REPORT_OUTPUT,
  ),
  ...operationFacets(
    ["memory.federation"],
    inputBinding([
      {
        field: "query",
        sources: ["positional", "flag", "query"],
        type: "string",
        required: true,
        position: 0,
        variadic: true,
      },
      flagField("limit", "number"),
      flagField("per_root_limit", "number"),
    ]),
    JSON_REPORT_OUTPUT,
  ),
};
