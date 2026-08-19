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
  MemoryOperationCustomInputBind,
  MemoryOperationFacets,
  MemoryOperationFileSinkBinding,
  MemoryOperationInputBinding,
  MemoryOperationInputFieldBinding,
  MemoryOperationInputType,
  MemoryOperationOutputKind,
  MemoryOperationTransportInput,
} from "./types.js";
import { MEMORY_SCOPES, type MapContractInput } from "./schemas.js";

const execFileAsync = promisify(execFile);

const DEFAULT_VIEWER_FILE_SINK: MemoryOperationFileSinkBinding = {
  field: "out",
  sources: ["flag", "query"],
  type: "path",
};

export function objectOutputSchema<T>(): z.ZodType<T> {
  return z.custom<T>((value) => value !== null && typeof value === "object");
}

export function operationFacets(
  ids: readonly string[],
  inputBinding: MemoryOperationInputBinding,
  outputKind?: MemoryOperationOutputKind,
  outputKindsById: Readonly<Record<string, MemoryOperationOutputKind>> = {},
): Record<string, MemoryOperationFacets> {
  const facets: Record<string, MemoryOperationFacets> = {};
  for (const id of ids) {
    const resolvedOutputKind = outputKindsById[id] ?? outputKind;
    if (!resolvedOutputKind) {
      throw new Error(`Memory operation ${id} facet declaration is missing output kind`);
    }
    facets[id] = { inputBinding, outputKind: resolvedOutputKind };
  }
  return facets;
}

export function inputBinding(
  fields: readonly MemoryOperationInputFieldBinding[],
  customBind?: MemoryOperationCustomInputBind,
): MemoryOperationInputBinding {
  return customBind ? { fields, customBind } : { fields };
}

export function flagField(
  field: string,
  type: MemoryOperationInputType,
  options: Pick<MemoryOperationInputFieldBinding, "required"> = {},
): MemoryOperationInputFieldBinding {
  return {
    field,
    sources: ["flag", "query"],
    type,
    ...options,
  };
}

export function positionalField(
  field: string,
  type: MemoryOperationInputType,
  options: Pick<
    MemoryOperationInputFieldBinding,
    "position" | "required" | "variadic"
  > = {},
): MemoryOperationInputFieldBinding {
  return {
    field,
    sources: ["positional", "query"],
    type,
    position: options.position ?? 0,
    ...options,
  };
}

export function joinedPositionalInput(
  field: string,
  fields: readonly MemoryOperationInputFieldBinding[] = [],
  options: Pick<MemoryOperationInputFieldBinding, "required"> = { required: true },
): MemoryOperationInputBinding {
  return inputBinding(
    [positionalField(field, "string", { required: options.required, variadic: true }), ...fields],
    {
      id: `joined-positional-${field}`,
      description: `Bind ${field} from all positional tokens joined by spaces when the transport presents split argv-style input.`,
      bind: (input) => {
        const value = joinedPositionalValue(input);
        return value ? { [field]: value } : {};
      },
    },
  );
}

export function joinedPositionalValue(input: MemoryOperationTransportInput): string {
  return input.positional.join(" ").trim();
}

export function hashedQueryViewerOutput(fileStem: string, description: string): MemoryOperationOutputKind {
  return {
    kind: "viewer",
    artifact: "self-contained-html",
    fileSink: {
      ...DEFAULT_VIEWER_FILE_SINK,
      customBind: {
        id: `${fileStem}-viewer-output-path`,
        description,
        bind: (input) => {
          const explicitOut = firstString(input.flags.out, input.query.out);
          if (explicitOut) return explicitOut;
          const query = firstString(input.query.query, input.query.q, joinedPositionalValue(input));
          if (!query) return undefined;
          const safeName = createHash("sha256").update(query).digest("hex").slice(0, 12);
          return join(input.rootDir ?? process.cwd(), `.red/memory/${fileStem}-${safeName}.html`);
        },
      },
    },
  };
}

export function firstString(...values: readonly unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

export async function readChangedFiles(rootDir: string, comparison?: string): Promise<string[]> {
  const args = comparison
    ? ["diff", "--name-only", "--diff-filter=ACMRTUXB", comparison, "--"]
    : ["diff", "--name-only", "--diff-filter=ACMRTUXB", "HEAD", "--"];
  try {
    const { stdout } = await execFileAsync("git", args, { cwd: rootDir });
    return parseChangedFiles(stdout);
  } catch (err) {
    if (comparison) throw err;
    const { stdout } = await execFileAsync(
      "git",
      ["diff", "--name-only", "--diff-filter=ACMRTUXB", "--"],
      { cwd: rootDir },
    );
    return parseChangedFiles(stdout);
  }
}

export function parseChangedFiles(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function whatifChangesFromTransport(input: MemoryOperationTransportInput): WhatifChange[] {
  const changes: WhatifChange[] = [];
  const flagChanges = input.flags.change ?? input.flags.changes;
  for (const entry of Array.isArray(flagChanges) ? flagChanges : [flagChanges]) {
    appendWhatifChange(changes, entry);
  }
  for (const entry of input.positional) appendWhatifChange(changes, entry);
  const queryChanges = input.query.change ?? input.query.changes;
  for (const entry of Array.isArray(queryChanges) ? queryChanges : [queryChanges]) {
    appendWhatifChange(changes, entry);
  }
  if (input.body && typeof input.body === "object") {
    const bodyChanges = (input.body as { changes?: unknown }).changes;
    for (const entry of Array.isArray(bodyChanges) ? bodyChanges : [bodyChanges]) {
      appendWhatifChange(changes, entry);
    }
  }
  return changes;
}

export function appendWhatifChange(changes: WhatifChange[], value: unknown): void {
  if (typeof value === "string" && value.trim()) {
    changes.push(parseWhatifChange(value));
    return;
  }
  if (!value || typeof value !== "object") return;
  const candidate = value as Partial<WhatifChange>;
  if (candidate.kind && (candidate.file || candidate.symbol || candidate.description)) {
    changes.push({
      kind: candidate.kind,
      file: candidate.file,
      symbol: candidate.symbol,
      with: candidate.with,
      description: candidate.description,
    });
  }
}

export function scopeFromInput(input: {
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

export async function safeSkillRollups(store: MemoryStore): Promise<SkillRollup[]> {
  try {
    return await readSkillRollups(store);
  } catch {
    return [];
  }
}

export async function buildMemoryMapContract(
  store: MemoryStore,
  input: MapContractInput,
): Promise<GraphContract> {
  const [nodes, rawEdges, communities] = await Promise.all([
    store.listNodes(),
    store.listEdges(),
    input.communities ? store.communities() : Promise.resolve(new Map<number, string>()),
  ]);

  return buildGraphContract({
    nodes,
    edges: rawEdges.map((edge) => toEdge(edge as Record<string, unknown>)),
    communities,
  });
}

export async function graphPrivacyRecords(store: MemoryStore): Promise<PrivacyMemoryRecord[]> {
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

export function graphNodeToLintRecord(node: StoredNode): LintMemoryRecord {
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

export function parseScope(value: unknown): MemoryScope | undefined {
  return MEMORY_SCOPES.includes(value as MemoryScope) ? (value as MemoryScope) : undefined;
}

export function parseTier(value: unknown): Tier | undefined {
  return value === "durable" || value === "ephemeral" || value === "reasoning"
    ? value
    : undefined;
}

export function parseTime(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
