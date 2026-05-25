import { buildCommunityAnalytics, type CommunitySummary } from "./communities.js";
import type { MemoryStore, StoredNode, VectorProjectionState } from "./graph-store.js";
import { readMemoryEvents } from "./memory-events.js";
import { buildPreflightBrief, type PreflightBrief, type PreflightOptions } from "./preflight.js";
import { claimCheck, type ClaimCheckStatus } from "./claim-check.js";
import { scanPrivacyRecords, type PrivacyMemoryRecord } from "./privacy.js";
import { type CollectionName, type MemoryProvenance } from "./schema.js";
import { MEMORY_COLLECTION_VERSIONING } from "./vcs-versioned-collections.js";

export type ReadinessStatus = "ready" | "review-warnings" | "needs-evidence";

export interface ReadinessEnvelopeOptions extends Omit<PreflightOptions, "now"> {
  now?: number | Date;
}

export interface MemoryReadinessEnvelope {
  contract: {
    name: "memory.readiness";
    version: "memory.readiness.v1";
    consumer_targets: ["memory-ui", "eval:competitive:v2"];
  };
  request: {
    goal: string;
    generated_at: string;
    scope?: PreflightOptions["scope"];
  };
  status: ReadinessStatus;
  task: {
    preflight: PreflightBrief;
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
    graph_hash: string;
    communities: number;
    assignments: number;
    top: CommunitySummary[];
  };
}

export async function buildReadinessEnvelope(
  store: MemoryStore,
  goal: string,
  opts: ReadinessEnvelopeOptions = {},
): Promise<MemoryReadinessEnvelope> {
  const now = normalizeNow(opts.now);
  const preflight = await buildPreflightBrief(store, goal, {
    ...opts,
    now: now.getTime(),
  });
  const [nodes, edges, vector, communities, eventLog, vcs, claim] = await Promise.all([
    store.listNodes(),
    store.listEdges(),
    store.vectorStatus(),
    buildCommunityAnalytics(store, { cache: "read-only", now }),
    eventLogSummary(store),
    vcsStatus(store),
    claimCheck(store, goal),
  ]);
  const superseded = await store.supersededByMany(nodes.map((node) => node.rid));

  const trust = trustSummary(nodes, edges, superseded, claim);
  const status = readinessStatus(preflight.status, vector.overall, trust.contradictions.unresolved);

  return {
    contract: {
      name: "memory.readiness",
      version: "memory.readiness.v1",
      consumer_targets: ["memory-ui", "eval:competitive:v2"],
    },
    request: {
      goal,
      generated_at: now.toISOString(),
      ...(opts.scope ? { scope: opts.scope } : {}),
    },
    status,
    task: { preflight },
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
      },
    },
    trust,
    vcs,
    operations: {
      event_log: eventLog,
    },
    communities: {
      graph_hash: communities.graph_hash,
      communities: communities.communities.length,
      assignments: communities.assignments.length,
      top: communities.communities.slice(0, 5),
    },
  };
}

function normalizeNow(now: number | Date | undefined): Date {
  if (now instanceof Date) return now;
  if (typeof now === "number") return new Date(now);
  return new Date();
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
  const contradictions = edges.filter((edge) => edgeLabel(edge) === "CONTRADICTS");
  const unresolved = contradictions.filter((edge) => {
    const from = activeHead(edgeEndpoint(edge, "from"), superseded);
    const to = activeHead(edgeEndpoint(edge, "to"), superseded);
    return Number.isFinite(from) && Number.isFinite(to) && from !== to;
  });
  return { total: contradictions.length, unresolved: unresolved.length };
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
