import type { MemoryStore, StoredNode } from "./graph-store.js";
import {
  buildLintRuleSuggestions,
  lintMemoryRecords,
  type LintMemoryRecord,
  type LintReport,
} from "./lint.js";
import {
  privacyReport,
  type PrivacyMemoryRecord,
  type PrivacyReport,
} from "./privacy.js";
import type { MemoryScope, Tier } from "./schema.js";
import {
  listContradictions,
  type ContradictionSummary,
} from "./supersession.js";
import {
  resolveProvider,
  type AiProviderConfig,
  type ProviderClient,
  type Egress,
  type ProviderMode,
} from "./extract-conversation.js";
import {
  buildMemoryGovernanceTidyRecommendations,
  type MemoryGovernanceTidyRecommendations,
} from "./governance-tidy.js";

export type MemoryGovernanceStatus = "ok" | "attention" | "degraded";
export type MemoryGovernanceTidyStatus = "available" | "degraded" | "unavailable";

export interface MemoryGovernanceTidyAvailability {
  status: MemoryGovernanceTidyStatus;
  configured: boolean;
  provider_mode: ProviderMode | null;
  provider_model: string | null;
  egress: Egress | null;
  reason: string | null;
  next_action: string;
}

export interface MemoryGovernanceReport {
  schema_version: "memory.governance.v1";
  read_only: true;
  generated_at: string;
  status: MemoryGovernanceStatus;
  summary: {
    total_nodes: number;
    total_edges: number;
    nodes_with_provenance: number;
    missing_provenance: number;
    privacy_findings: number;
    lint_findings: number;
    unresolved_contradictions: number;
    resolved_contradictions: number;
    superseded_nodes: number;
    audit_edges: number;
  };
  provenance: {
    coverage: number;
    by_source_kind: Array<{ source_kind: string; count: number }>;
    missing: Array<{ rid: number; label: string; node_type: string; title: string }>;
  };
  privacy: PrivacyReport;
  lint: LintReport;
  contradictions: ContradictionSummary[];
  supersession: Array<{ rid: number; active_rid: number }>;
  tidy_availability: MemoryGovernanceTidyAvailability;
  tidy_recommendations: MemoryGovernanceTidyRecommendations;
  recommended_next_actions: string[];
}

interface GovernanceEdge {
  rid: number;
  label: string;
  from: number;
  to: number;
  properties: Record<string, unknown>;
}

export async function buildMemoryGovernanceReport(
  store: MemoryStore,
  opts: {
    staleProgressDays?: number;
    now?: number;
    providerConfig?: AiProviderConfig;
    providerClient?: ProviderClient;
    tidyRecommendationCap?: number;
    tidyCandidateLimit?: number;
    tidyMaxRecommendationRatio?: number;
  } = {},
): Promise<MemoryGovernanceReport> {
  const [nodes, rawEdges] = await Promise.all([store.listNodes(opts.now), store.listEdges()]);
  const edges = rawEdges.map(toGovernanceEdge);
  const superseded = await store.supersededByMany(nodes.map((node) => node.rid));
  const contradictions = await listContradictions(store, { includeResolved: true });
  const privacy = privacyReport("graph", graphPrivacyRecords(nodes, edges));
  const lintFindings = lintMemoryRecords(
    nodes.map(graphNodeToLintRecord),
    { now: opts.now, staleProgressDays: opts.staleProgressDays },
  );
  const lint: LintReport = {
    status: "ok",
    mode: "graph",
    readOnly: true,
    totalMemories: nodes.length,
    findings: lintFindings,
    ruleSuggestions: buildLintRuleSuggestions(lintFindings),
    warnings: [],
  };
  const provenance = provenanceCoverage(nodes);
  const unresolved = contradictions.filter((item) => !item.resolved).length;
  const resolved = contradictions.length - unresolved;
  const auditEdges = edges.filter((edge) =>
    ["CONTRADICTS", "SUPERSEDED_BY", "TOUCHED"].includes(edge.label),
  ).length;
  const summary = {
    total_nodes: nodes.length,
    total_edges: edges.length,
    nodes_with_provenance: nodes.length - provenance.missing.length,
    missing_provenance: provenance.missing.length,
    privacy_findings: privacy.findings.length,
    lint_findings: lint.findings.length,
    unresolved_contradictions: unresolved,
    resolved_contradictions: resolved,
    superseded_nodes: superseded.size,
    audit_edges: auditEdges,
  };
  const baseTidyAvailability = governanceTidyAvailability(opts.providerConfig);
  const tidyRecommendations = await buildMemoryGovernanceTidyRecommendations(store, {
    providerConfig: opts.providerConfig,
    providerClient: opts.providerClient,
    now: opts.now,
    recommendationCap: opts.tidyRecommendationCap,
    candidateLimit: opts.tidyCandidateLimit,
    maxRecommendationRatio: opts.tidyMaxRecommendationRatio,
  });
  const tidyAvailability = tidyAvailabilityWithRecommendationStatus(
    baseTidyAvailability,
    tidyRecommendations,
  );
  return {
    schema_version: "memory.governance.v1",
    read_only: true,
    generated_at: new Date(opts.now ?? Date.now()).toISOString(),
    status: governanceStatus(summary, privacy, lint),
    summary,
    provenance,
    privacy,
    lint,
    contradictions,
    supersession: [...superseded.entries()]
      .map(([rid, activeRid]) => ({ rid, active_rid: activeRid }))
      .sort((a, b) => a.rid - b.rid),
    tidy_availability: tidyAvailability,
    tidy_recommendations: tidyRecommendations,
    recommended_next_actions: recommendations(summary, privacy, lint, tidyAvailability),
  };
}

function governanceStatus(
  summary: MemoryGovernanceReport["summary"],
  privacy: PrivacyReport,
  lint: LintReport,
): MemoryGovernanceStatus {
  if (privacy.status === "degraded" || lint.status === "degraded") return "degraded";
  if (privacy.findings.some((finding) => finding.severity === "error")) return "degraded";
  if (lint.findings.some((finding) => finding.severity === "error")) return "degraded";
  if (
    summary.unresolved_contradictions > 0 ||
    summary.privacy_findings > 0 ||
    summary.lint_findings > 0 ||
    summary.missing_provenance > 0
  ) {
    return "attention";
  }
  return "ok";
}

function recommendations(
  summary: MemoryGovernanceReport["summary"],
  privacy: PrivacyReport,
  lint: LintReport,
  tidyAvailability: MemoryGovernanceTidyAvailability,
): string[] {
  const out: string[] = [];
  if (summary.privacy_findings > 0) {
    out.push("inspect `memory privacy scan --json` before exporting or sharing Memory artifacts");
  }
  if (summary.unresolved_contradictions > 0) {
    out.push("resolve or supersede contradictory Memory evidence before relying on related guidance");
  }
  if (summary.missing_provenance > 0) {
    out.push("add provenance metadata to high-value nodes with missing writer/source evidence");
  }
  if (lint.findings.length > 0) {
    out.push("review `memory lint --json` findings before adding more durable guidance");
  }
  if (privacy.warnings.length > 0 || lint.warnings.length > 0) {
    out.push("investigate governance warnings before treating the report as complete");
  }
  if (tidyAvailability.status !== "available") {
    out.push(tidyAvailability.next_action);
  }
  return [...new Set(out)];
}

function governanceTidyAvailability(
  providerConfig: AiProviderConfig | undefined,
): MemoryGovernanceTidyAvailability {
  if (!providerConfig) {
    return {
      status: "unavailable",
      configured: false,
      provider_mode: null,
      provider_model: null,
      egress: null,
      reason: "no AI provider configured for governance tidy",
      next_action:
        "configure `provider` to enable provider-backed governance tidy; deterministic governance remains available",
    };
  }
  try {
    const provider = resolveProvider(providerConfig);
    return {
      status: "available",
      configured: true,
      provider_mode: provider.mode,
      provider_model: provider.model,
      egress: provider.egress,
      reason: null,
      next_action:
        "governance tidy provider is available; run mutating tidy operations only when explicitly requested",
    };
  } catch (err) {
    return {
      status: "degraded",
      configured: true,
      provider_mode: providerConfig.mode,
      provider_model: providerConfig.model,
      egress: null,
      reason: err instanceof Error ? err.message : String(err),
      next_action: "fix the configured Memory AI provider before running governance tidy",
    };
  }
}

function tidyAvailabilityWithRecommendationStatus(
  availability: MemoryGovernanceTidyAvailability,
  tidyRecommendations: MemoryGovernanceTidyRecommendations,
): MemoryGovernanceTidyAvailability {
  if (availability.status !== "available" || tidyRecommendations.status !== "degraded") {
    return availability;
  }
  return {
    ...availability,
    status: "degraded",
    reason: tidyRecommendations.reason,
    next_action: "inspect provider tidy warnings; deterministic governance remains available",
  };
}

function provenanceCoverage(nodes: StoredNode[]): MemoryGovernanceReport["provenance"] {
  const byKind = new Map<string, number>();
  const missing: MemoryGovernanceReport["provenance"]["missing"] = [];
  for (const node of nodes) {
    const provenance = provenanceObject(node.properties.provenance);
    const sourceKind = stringValue(provenance?.source_kind);
    if (!provenance || !sourceKind) {
      missing.push({
        rid: node.rid,
        label: node.label,
        node_type: node.node_type,
        title: String(node.properties.title ?? node.label),
      });
      continue;
    }
    byKind.set(sourceKind, (byKind.get(sourceKind) ?? 0) + 1);
  }
  return {
    coverage: nodes.length === 0 ? 1 : (nodes.length - missing.length) / nodes.length,
    by_source_kind: [...byKind.entries()]
      .map(([source_kind, count]) => ({ source_kind, count }))
      .sort((a, b) => b.count - a.count || a.source_kind.localeCompare(b.source_kind)),
    missing: missing.slice(0, 20),
  };
}

function graphPrivacyRecords(
  nodes: StoredNode[],
  edges: GovernanceEdge[],
): PrivacyMemoryRecord[] {
  return [
    ...nodes.map((node) => ({
      id: `memory_nodes:${node.rid}`,
      location: `memory_nodes:${node.rid}`,
      fields: {
        label: node.label,
        node_type: node.node_type,
        properties: node.properties,
      },
    })),
    ...edges.map((edge) => ({
      id: `memory_edges:${edge.rid}`,
      location: `memory_edges:${edge.rid}`,
      fields: {
        label: edge.label,
        properties: edge.properties,
      },
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

function toGovernanceEdge(edge: Record<string, unknown>): GovernanceEdge {
  return {
    rid: Number(edge.rid ?? edge.red_entity_id ?? 0),
    label: String(edge.label ?? edge.edge_label ?? edge.LABEL ?? ""),
    from: Number(edge.from ?? edge.from_id ?? edge.from_rid ?? edge.source ?? edge.FROM),
    to: Number(edge.to ?? edge.to_id ?? edge.to_rid ?? edge.target ?? edge.TO),
    properties: recordValue(edge.properties ?? edge.PROPERTIES),
  };
}

function provenanceObject(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value != null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseScope(value: unknown): MemoryScope | undefined {
  return [
    "user",
    "project",
    "repo",
    "branch",
    "worktree",
    "session",
    "agent-run",
  ].includes(value as string)
    ? (value as MemoryScope)
    : undefined;
}

function parseTier(value: unknown): Tier | undefined {
  return value === "durable" || value === "ephemeral" || value === "reasoning"
    ? value
    : undefined;
}

function parseTime(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
