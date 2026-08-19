import { buildCommunityAnalytics, type CommunityAnalyticsReport, type CommunitySummary } from "./communities.js";
import type { MemoryStore, StoredNode, VectorProjectionState, VectorStatusReport } from "./graph-store.js";
import { buildLearningDebtReport, type LearningDebtReport } from "./learning-debt.js";
import { readMemoryEvents } from "./memory-events.js";
import {
  buildPreflightBrief,
  type PreflightBrief,
  type PreflightEvidence,
  type PreflightOptions,
  type PreflightWarning,
} from "./preflight.js";
import { claimCheck, type ClaimCheckStatus } from "./claim-check.js";
import { scanPrivacyRecords, type PrivacyMemoryRecord } from "./privacy.js";
import { type CollectionName, type MemoryProvenance } from "./schema.js";
import { MEMORY_COLLECTION_VERSIONING } from "./vcs-versioned-collections.js";
import {
  buildSkillRecommendations,
  type SkillRecommendationReport,
} from "./skill-recommendations.js";
import { readSkillRollups, type SkillRollup } from "./skill-events.js";

export type ReadinessStatus = "ready" | "review-warnings" | "needs-evidence";

export interface ReadinessEnvelopeOptions extends Omit<PreflightOptions, "now"> {
  now?: number | Date;
}

export interface MemoryReadinessEnvelope {
  contract: {
    name: "memory.readiness";
    version: "memory.readiness.v1";
    consumer_targets: ["memory-ui", "references:eval:v2"];
  };
  request: {
    goal: string;
    generated_at: string;
    scope?: PreflightOptions["scope"];
  };
  status: ReadinessStatus;
  governance: {
    scope: PreflightOptions["scope"];
    include_superseded: true;
    min_evidence: number;
    stale_days: number;
    ranking_signals: ["scope", "tier", "supersession", "confidence", "freshness"];
  };
  task: {
    preflight: PreflightBrief;
  };
  evidence: {
    active: PreflightEvidence[];
    missing: {
      missing: boolean;
      expected_minimum: number;
      active_count: number;
      messages: string[];
    };
    contradictions: PreflightWarning[];
    superseded: PreflightEvidence[];
    stale: PreflightEvidence[];
  };
  retrieval: {
    recall: {
      evidence_count: number;
      active_evidence_count: number;
      missing_evidence: boolean;
    };
    vector: {
      overall: VectorProjectionState;
      total: number;
      ready: number;
      stale: number;
      unavailable: number;
      failed: number;
      error?: string;
    };
  };
  trust: {
    provenance: {
      total_nodes: number;
      nodes_with_provenance: number;
      missing_provenance: number;
      source_kinds: Record<string, number>;
      evidence_refs: number;
    };
    supersession: {
      superseded_nodes: number;
      active_successors: number;
    };
    contradictions: {
      total: number;
      unresolved: number;
      cross_session: number;
      unresolved_pairs: Array<{
        from_rid: number;
        to_rid: number;
        kind: string | null;
        reason: string | null;
        from_session: string | null;
        to_session: string | null;
      }>;
    };
    privacy: {
      read_only: true;
      total_memories: number;
      findings: number;
      warnings: number;
      errors: number;
    };
    claim_check: {
      assertion: string;
      status: ClaimCheckStatus;
      active_evidence: number;
      superseded_evidence: number;
      conflicts: number;
    };
  };
  vcs: {
    time_travel: "available" | "partial" | "unavailable";
    collections: Array<{
      name: CollectionName;
      expected: "versioned" | "non-versioned";
      status: "versioned" | "non-versioned" | "unexpected-versioned" | "unavailable";
      error?: string;
    }>;
  };
  operations: {
    event_log: {
      status: "available" | "unavailable";
      total_events: number;
      kinds: Record<string, number>;
      recent: Array<{
        id: string;
        occurred_at: string;
        kind: string;
        subject: string | null;
      }>;
      error?: string;
    };
  };
  communities: {
    status: "available" | "unavailable";
    graph_hash: string;
    communities: number;
    assignments: number;
    top: CommunitySummary[];
    error?: string;
  };
  skills: ReadinessSkillRecommendations;
  learning_debt: ReadinessLearningDebt;
  next_actions: string[];
}

type ReadinessSkillRecommendations =
  | (SkillRecommendationReport & { signal_status: "available" })
  | {
      signal_status: "unavailable";
      task: string;
      status: "insufficient-evidence";
      recommendations: [];
      missingEvidence: string[];
      error: string;
    };

type ReadinessLearningDebt =
  | {
      status: "available";
      debt_status: LearningDebtReport["status"];
      summary: LearningDebtReport["summary"];
      categories: LearningDebtReport["categories"];
    }
  | {
      status: "unavailable";
      debt_status: "unknown";
      summary: null;
      categories: null;
      error: string;
    };

const DEFAULT_MIN_EVIDENCE = 2;
const DEFAULT_STALE_DAYS = 90;

type VectorReadinessSummary = Pick<
  VectorStatusReport,
  "overall" | "total" | "ready" | "stale" | "unavailable" | "failed"
> & { error?: string };

type CommunityReadinessSummary = CommunityAnalyticsReport & {
  status: "available" | "unavailable";
  error?: string;
};

type SkillRollupSummary =
  | { status: "available"; rollups: SkillRollup[] }
  | { status: "unavailable"; rollups: []; error: string };

export async function buildReadinessEnvelope(
  store: MemoryStore,
  goal: string,
  opts: ReadinessEnvelopeOptions = {},
): Promise<MemoryReadinessEnvelope> {
  const now = normalizeNow(opts.now);
  const minEvidence = opts.minEvidence ?? DEFAULT_MIN_EVIDENCE;
  const staleDays = opts.staleDays ?? DEFAULT_STALE_DAYS;
  const preflight = await buildPreflightBrief(store, goal, {
    ...opts,
    now: now.getTime(),
  });
  const [nodes, edges, vector, communities, eventLog, vcs, claim, skillRollups] = await Promise.all([
    store.listNodes(),
    store.listEdges(),
    vectorSummary(store),
    communitySummary(store, now),
    eventLogSummary(store),
    vcsStatus(store),
    claimCheck(store, goal),
    skillRollupSummary(store),
  ]);
  const superseded = await store.supersededByMany(nodes.map((node) => node.rid));
  const [skills, learningDebt] = await Promise.all([
    skillRecommendationSummary(store, goal, skillRollups, opts),
    learningDebtSummary(store, skillRollups, now.getTime(), staleDays),
  ]);

  const trust = trustSummary(nodes, edges, superseded, claim);
  const status = readinessStatus(preflight.status, vector.overall, trust.contradictions.unresolved);
  const evidence = evidenceSummary(preflight, minEvidence);
  const nextActions = nextActionsFor({
    preflight,
    evidence,
    vector,
    contradictions: trust.contradictions.unresolved,
    skills,
    learningDebt,
    communities,
    eventLog,
  });

  return {
    contract: {
      name: "memory.readiness",
      version: "memory.readiness.v1",
      consumer_targets: ["memory-ui", "references:eval:v2"],
    },
    request: {
      goal,
      generated_at: now.toISOString(),
      ...(opts.scope ? { scope: opts.scope } : {}),
    },
    status,
    governance: {
      scope: opts.scope ?? { level: "project" },
      include_superseded: true,
      min_evidence: minEvidence,
      stale_days: staleDays,
      ranking_signals: ["scope", "tier", "supersession", "confidence", "freshness"],
    },
    task: { preflight },
    evidence,
    retrieval: {
      recall: {
        evidence_count: preflight.summary.evidenceCount,
        active_evidence_count: preflight.summary.activeEvidenceCount,
        missing_evidence: preflight.summary.missingEvidence,
      },
      vector: {
        overall: vector.overall,
        total: vector.total,
        ready: vector.ready,
        stale: vector.stale,
        unavailable: vector.unavailable,
        failed: vector.failed,
        ...(vector.error ? { error: vector.error } : {}),
      },
    },
    trust,
    vcs,
    operations: {
      event_log: eventLog,
    },
    communities: {
      status: communities.status,
      graph_hash: communities.graph_hash,
      communities: communities.communities.length,
      assignments: communities.assignments.length,
      top: communities.communities.slice(0, 5),
      ...(communities.error ? { error: communities.error } : {}),
    },
    skills,
    learning_debt: learningDebt,
    next_actions: nextActions,
  };
}

function normalizeNow(now: number | Date | undefined): Date {
  if (now instanceof Date) return now;
  if (typeof now === "number") return new Date(now);
  return new Date();
}

async function vectorSummary(store: MemoryStore): Promise<VectorReadinessSummary> {
  try {
    const vector = await store.vectorStatus();
    return {
      overall: vector.overall,
      total: vector.total,
      ready: vector.ready,
      stale: vector.stale,
      unavailable: vector.unavailable,
      failed: vector.failed,
    };
  } catch (err) {
    return {
      overall: "unavailable",
      total: 0,
      ready: 0,
      stale: 0,
      unavailable: 0,
      failed: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function communitySummary(
  store: MemoryStore,
  now: Date,
): Promise<CommunityReadinessSummary> {
  try {
    return {
      status: "available",
      ...(await buildCommunityAnalytics(store, { cache: "read-only", now })),
    };
  } catch (err) {
    return {
      status: "unavailable",
      schema_version: "memory.communities.v1",
      read_only: true,
      graph_hash: "",
      cache_key: "",
      cached: false,
      generated_at: now.toISOString(),
      communities: [],
      assignments: [],
      node_analytics: [],
      inter_community_edges: [],
      bridge_nodes: [],
      bridge_edges: [],
      summary: {
        status: "empty",
        next: "ingest graph evidence, then run memory communities again",
      },
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function skillRollupSummary(store: MemoryStore): Promise<SkillRollupSummary> {
  try {
    return { status: "available", rollups: await readSkillRollups(store) };
  } catch (err) {
    return {
      status: "unavailable",
      rollups: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function skillRecommendationSummary(
  store: MemoryStore,
  goal: string,
  rollups: SkillRollupSummary,
  opts: ReadinessEnvelopeOptions,
): Promise<ReadinessSkillRecommendations> {
  if (rollups.status === "unavailable") {
    return {
      signal_status: "unavailable",
      task: goal,
      status: "insufficient-evidence",
      recommendations: [],
      missingEvidence: ["Skill telemetry rollups are unavailable"],
      error: rollups.error,
    };
  }
  try {
    return {
      signal_status: "available",
      ...(await buildSkillRecommendations(store, goal, {
        limit: opts.limit,
        scope: opts.scope,
        now: opts.now instanceof Date ? opts.now.getTime() : opts.now,
        skillRollups: rollups.rollups,
      })),
    };
  } catch (err) {
    return {
      signal_status: "unavailable",
      task: goal,
      status: "insufficient-evidence",
      recommendations: [],
      missingEvidence: ["Skill recommendation evidence is unavailable"],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function learningDebtSummary(
  store: MemoryStore,
  rollups: SkillRollupSummary,
  now: number,
  staleDays: number,
): Promise<ReadinessLearningDebt> {
  try {
    const report = await buildLearningDebtReport(store, {
      now,
      staleDays,
      rollups: rollups.rollups,
      skillTelemetryEnabled: rollups.status === "available",
    });
    return {
      status: "available",
      debt_status: report.status,
      summary: report.summary,
      categories: report.categories,
    };
  } catch (err) {
    return {
      status: "unavailable",
      debt_status: "unknown",
      summary: null,
      categories: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function evidenceSummary(
  preflight: PreflightBrief,
  minEvidence: number,
): MemoryReadinessEnvelope["evidence"] {
  const missingMessages = preflight.warnings
    .filter((warning) => warning.kind === "missing-evidence")
    .map((warning) => warning.message);
  return {
    active: preflight.evidence.filter((item) => item.statuses.includes("active")),
    missing: {
      missing: preflight.summary.missingEvidence,
      expected_minimum: minEvidence,
      active_count: preflight.summary.activeEvidenceCount,
      messages: missingMessages,
    },
    contradictions: preflight.warnings.filter((warning) => warning.kind === "contradiction"),
    superseded: preflight.evidence.filter((item) => item.statuses.includes("superseded")),
    stale: preflight.evidence.filter((item) => item.statuses.includes("stale")),
  };
}

function nextActionsFor(input: {
  preflight: PreflightBrief;
  evidence: MemoryReadinessEnvelope["evidence"];
  vector: VectorReadinessSummary;
  contradictions: number;
  skills: ReadinessSkillRecommendations;
  learningDebt: ReadinessLearningDebt;
  communities: CommunityReadinessSummary;
  eventLog: MemoryReadinessEnvelope["operations"]["event_log"];
}): string[] {
  const actions: string[] = [];
  if (input.preflight.summary.missingEvidence) {
    actions.push("Capture or ingest Memory evidence for this task before implementation.");
  }
  if (input.contradictions > 0 || input.evidence.contradictions.length > 0) {
    actions.push("Resolve or supersede contradictory Memory evidence before relying on it.");
  }
  if (input.evidence.superseded.length > 0) {
    actions.push("Prefer active successor memories over superseded evidence.");
  }
  if (input.evidence.stale.length > 0) {
    actions.push("Verify stale Memory evidence before using it as implementation guidance.");
  }
  if (input.vector.overall === "stale" || input.vector.overall === "failed") {
    actions.push("Run `memory vector maintain` to refresh vector retrieval signals.");
  } else if (input.vector.overall === "unavailable") {
    actions.push("Treat vector recall as unavailable and rely on text/graph evidence.");
  }
  if (input.skills.recommendations.length > 0) {
    actions.push(`Load recommended skills: ${input.skills.recommendations.map((s) => s.name).join(", ")}.`);
  } else {
    actions.push("Proceed without ranked Skill recommendations; no matching Skill evidence was available.");
  }
  if (input.learningDebt.status === "available" && input.learningDebt.debt_status === "debt-found") {
    actions.push("Review Memory learning debt before starting implementation.");
  } else if (input.learningDebt.status === "unavailable") {
    actions.push("Treat learning debt signals as unavailable for this task.");
  }
  if (input.communities.status === "unavailable") {
    actions.push("Treat community analytics as unavailable for this task.");
  }
  if (input.eventLog.status === "unavailable") {
    actions.push("Treat Memory event-log telemetry as unavailable for this task.");
  }
  if (actions.length === 0) actions.push("Memory readiness is clean; proceed with implementation.");
  return [...new Set(actions)];
}

function readinessStatus(
  preflight: PreflightBrief["status"],
  vector: VectorProjectionState,
  unresolvedContradictions: number,
): ReadinessStatus {
  if (preflight === "needs-evidence") return "needs-evidence";
  if (preflight === "review-warnings" || vector === "failed" || unresolvedContradictions > 0) {
    return "review-warnings";
  }
  return "ready";
}

function trustSummary(
  nodes: StoredNode[],
  edges: Record<string, unknown>[],
  superseded: Map<number, number>,
  claim: Awaited<ReturnType<typeof claimCheck>>,
): MemoryReadinessEnvelope["trust"] {
  const provenance = provenanceSummary(nodes);
  const contradictions = contradictionSummary(edges, superseded);
  const privacy = scanPrivacyRecords([
    ...nodes.map(nodePrivacyRecord),
    ...edges.map(edgePrivacyRecord),
  ]);
  return {
    provenance,
    supersession: {
      superseded_nodes: superseded.size,
      active_successors: new Set(superseded.values()).size,
    },
    contradictions,
    privacy: {
      read_only: true,
      total_memories: nodes.length + edges.length,
      findings: privacy.length,
      warnings: privacy.filter((finding) => finding.severity === "warning").length,
      errors: privacy.filter((finding) => finding.severity === "error").length,
    },
    claim_check: {
      assertion: claim.assertion,
      status: claim.status,
      active_evidence: claim.evidence.active.length,
      superseded_evidence: claim.evidence.superseded.length,
      conflicts: claim.evidence.conflicting.length,
    },
  };
}

function provenanceSummary(nodes: StoredNode[]): MemoryReadinessEnvelope["trust"]["provenance"] {
  const sourceKinds: Record<string, number> = {};
  let withProvenance = 0;
  let evidenceRefs = 0;
  for (const node of nodes) {
    const provenance = node.properties.provenance;
    if (!isProvenance(provenance)) continue;
    withProvenance += 1;
    sourceKinds[provenance.source_kind] = (sourceKinds[provenance.source_kind] ?? 0) + 1;
    evidenceRefs += provenance.evidence?.length ?? 0;
  }
  return {
    total_nodes: nodes.length,
    nodes_with_provenance: withProvenance,
    missing_provenance: nodes.length - withProvenance,
    source_kinds: sourceKinds,
    evidence_refs: evidenceRefs,
  };
}

function isProvenance(value: unknown): value is MemoryProvenance {
  return (
    value != null &&
    typeof value === "object" &&
    typeof (value as { source_kind?: unknown }).source_kind === "string"
  );
}

function contradictionSummary(
  edges: Record<string, unknown>[],
  superseded: Map<number, number>,
): MemoryReadinessEnvelope["trust"]["contradictions"] {
  const seenPairs = new Set<string>();
  const contradictions = edges.filter((edge) => {
    if (edgeLabel(edge) !== "CONTRADICTS") return false;
    const from = edgeEndpoint(edge, "from");
    const to = edgeEndpoint(edge, "to");
    const key = from < to ? `${from}:${to}` : `${to}:${from}`;
    if (seenPairs.has(key)) return false;
    seenPairs.add(key);
    return true;
  });
  const unresolved = contradictions.filter((edge) => {
    const from = activeHead(edgeEndpoint(edge, "from"), superseded);
    const to = activeHead(edgeEndpoint(edge, "to"), superseded);
    return Number.isFinite(from) && Number.isFinite(to) && from !== to;
  });
  const unresolvedPairs = unresolved.map((edge) => {
    const props = edgeProperties(edge);
    const fromSession =
      typeof props.candidate_session === "string" ? props.candidate_session : null;
    const toSession =
      typeof props.existing_session === "string" ? props.existing_session : null;
    return {
      from_rid: edgeEndpoint(edge, "from"),
      to_rid: edgeEndpoint(edge, "to"),
      kind: typeof props.kind === "string" ? props.kind : null,
      reason: typeof props.reason === "string" ? props.reason : null,
      from_session: fromSession,
      to_session: toSession,
    };
  });
  const crossSession = unresolvedPairs.filter(
    (pair) => pair.from_session && pair.to_session && pair.from_session !== pair.to_session,
  ).length;
  return {
    total: contradictions.length,
    unresolved: unresolved.length,
    cross_session: crossSession,
    unresolved_pairs: unresolvedPairs,
  };
}

async function eventLogSummary(
  store: MemoryStore,
): Promise<MemoryReadinessEnvelope["operations"]["event_log"]> {
  try {
    const events = await readMemoryEvents(store);
    const kinds: Record<string, number> = {};
    for (const event of events) kinds[event.kind] = (kinds[event.kind] ?? 0) + 1;
    return {
      status: "available",
      total_events: events.length,
      kinds,
      recent: [...events]
        .sort((a, b) => Date.parse(b.occurred_at) - Date.parse(a.occurred_at))
        .slice(0, 5)
        .map((event) => ({
          id: event.id,
          occurred_at: event.occurred_at,
          kind: event.kind,
          subject: event.subject.id ?? event.subject.name ?? null,
        })),
    };
  } catch (err) {
    return {
      status: "unavailable",
      total_events: 0,
      kinds: {},
      recent: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function vcsStatus(store: MemoryStore): Promise<MemoryReadinessEnvelope["vcs"]> {
  const collections = await Promise.all(
    MEMORY_COLLECTION_VERSIONING.map(async (collection) => {
      const expected = shouldVersion(collection.tiers)
        ? ("versioned" as const)
        : ("non-versioned" as const);
      const status = await collectionVersionStatus(store, collection.name, expected);
      return { name: collection.name, expected, ...status };
    }),
  );
  const required = collections.filter((collection) => collection.expected === "versioned");
  const versioned = required.filter((collection) => collection.status === "versioned").length;
  return {
    time_travel:
      versioned === required.length
        ? "available"
        : versioned > 0
          ? "partial"
          : "unavailable",
    collections,
  };
}

async function collectionVersionStatus(
  store: MemoryStore,
  collection: CollectionName,
  expected: "versioned" | "non-versioned",
): Promise<{
  status: "versioned" | "non-versioned" | "unexpected-versioned" | "unavailable";
  error?: string;
}> {
  try {
    await store.raw.query(`SELECT * FROM ${collection} AS OF SNAPSHOT 0`);
    return { status: expected === "versioned" ? "versioned" : "unexpected-versioned" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("AS OF requires a versioned collection")) {
      return { status: "non-versioned" };
    }
    return { status: "unavailable", error: message };
  }
}

function shouldVersion(tiers: readonly string[]): boolean {
  return tiers.some((tier) => tier === "durable" || tier === "reasoning");
}

function nodePrivacyRecord(node: StoredNode): PrivacyMemoryRecord {
  return {
    id: `memory_nodes:${node.rid}`,
    location: `memory_nodes:${node.rid}`,
    fields: {
      label: node.label,
      node_type: node.node_type,
      properties: node.properties,
    },
  };
}

function edgePrivacyRecord(edge: Record<string, unknown>): PrivacyMemoryRecord {
  const rid = Number(edge.rid ?? edge.red_entity_id ?? edge.RED_ENTITY_ID ?? 0);
  return {
    id: `memory_edges:${Number.isFinite(rid) && rid > 0 ? rid : "unknown"}`,
    location: `memory_edges:${Number.isFinite(rid) && rid > 0 ? rid : "unknown"}`,
    fields: {
      label: edgeLabel(edge),
      properties: edgeProperties(edge),
    },
  };
}

function edgeLabel(edge: Record<string, unknown>): string {
  return String(edge.label ?? edge.edge_label ?? edge.LABEL ?? "");
}

function edgeEndpoint(edge: Record<string, unknown>, side: "from" | "to"): number {
  if (side === "from") {
    return Number(
      edge.from_rid ?? edge.from ?? edge.from_id ?? edge.source ?? edge.source_id ?? edge.FROM,
    );
  }
  return Number(edge.to_rid ?? edge.to ?? edge.to_id ?? edge.target ?? edge.target_id ?? edge.TO);
}

function edgeProperties(edge: Record<string, unknown>): Record<string, unknown> {
  const props = edge.properties ?? edge.PROPERTIES;
  return props && typeof props === "object" ? (props as Record<string, unknown>) : {};
}

function activeHead(rid: number, superseded: Map<number, number>): number {
  const seen = new Set<number>();
  let current = rid;
  while (!seen.has(current)) {
    seen.add(current);
    const next = superseded.get(current);
    if (next == null) return current;
    current = next;
  }
  return current;
}
