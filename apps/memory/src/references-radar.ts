import {
  buildMemoryCapabilityCatalog,
  type CapabilityCategory,
  type CapabilityStatus,
  type MemoryCapability,
  type MemoryCapabilityCatalog,
} from "./capability-catalog.js";
import type { MemoryStore } from "./graph-store.js";

export type MemoryReferenceId =
  | "agentmemory"
  | "neo4j-agent-memory"
  | "gbrain"
  | "graphify"
  | "ai-memory";

export interface MemoryReferenceRadar {
  schema_version: "memory.reference_radar.v1";
  read_only: true;
  root: string;
  generated_at: string;
  note: string;
  summary: {
    references: number;
    total_relevant_capabilities: number;
    ready_or_available: number;
    degraded_or_not_configured: number;
  };
  references: MemoryReferenceRadarEntry[];
  recommended_next_actions: string[];
  source_catalog: Pick<
    MemoryCapabilityCatalog,
    "schema_version" | "generated_at" | "summary"
  >;
}

export interface MemoryReferenceRadarEntry {
  id: MemoryReferenceId;
  name: string;
  repository: string;
  focus: string[];
  posture: "strong" | "watch" | "gap";
  score: number;
  relevant_capabilities: number;
  ready: number;
  available: number;
  degraded: number;
  not_configured: number;
  red_db_backed: number;
  capabilities: MemoryReferenceCapability[];
  gaps: MemoryReferenceGap[];
  next_actions: string[];
}

export interface MemoryReferenceCapability {
  id: string;
  title: string;
  category: CapabilityCategory;
  status: CapabilityStatus;
  red_db_backed: boolean;
  evidence: string[];
  cli: string[];
  mcp: string[];
  notes: string[];
}

export interface MemoryReferenceGap {
  capability_id: string;
  title: string;
  status: Extract<CapabilityStatus, "degraded" | "not-configured">;
  reason: string;
  next_action: string;
}

interface ReferenceMetadata {
  id: MemoryReferenceId;
  name: string;
  repository: string;
  focus: string[];
}

const REFERENCES: ReferenceMetadata[] = [
  {
    id: "agentmemory",
    name: "AgentMemory",
    repository: "rohitg00/agentmemory",
    focus: ["operational memory", "smart search", "lifecycle hooks", "benchmarks"],
  },
  {
    id: "neo4j-agent-memory",
    name: "Neo4j Agent Memory",
    repository: "neo4j-labs/agent-memory",
    focus: ["graph memory", "vector retrieval", "agent platform"],
  },
  {
    id: "gbrain",
    name: "Gbrain",
    repository: "garrytan/gbrain",
    focus: ["cited synthesis", "gap analysis", "operator UI"],
  },
  {
    id: "graphify",
    name: "Graphify",
    repository: "safishamsi/graphify",
    focus: ["document graph extraction", "code graph", "path queries"],
  },
  {
    id: "ai-memory",
    name: "AI Memory",
    repository: "akitaonrails/ai-memory",
    focus: ["coding-agent hooks", "MCP", "local UI", "backup governance"],
  },
];

const STATUS_SCORE: Record<CapabilityStatus, number> = {
  ready: 1,
  available: 0.75,
  degraded: 0.35,
  "not-configured": 0.15,
};

export async function buildMemoryReferenceRadar(
  store: MemoryStore,
  rootDir: string,
  opts: { now?: number } = {},
): Promise<MemoryReferenceRadar> {
  const catalog = await buildMemoryCapabilityCatalog(store, rootDir, opts);
  const references = REFERENCES.map((reference) =>
    referenceRadar(reference, catalog.capabilities),
  );
  const totalRelevant = references.reduce(
    (sum, reference) => sum + reference.relevant_capabilities,
    0,
  );
  const readyOrAvailable = references.reduce(
    (sum, reference) => sum + reference.ready + reference.available,
    0,
  );
  const degradedOrNotConfigured = references.reduce(
    (sum, reference) => sum + reference.degraded + reference.not_configured,
    0,
  );
  return {
    schema_version: "memory.reference_radar.v1",
    read_only: true,
    root: rootDir,
    generated_at: new Date(opts.now ?? Date.now()).toISOString(),
    note: "Internal planning radar derived from the Memory capability catalog; references are used for respectful comparison, not public benchmark claims.",
    summary: {
      references: references.length,
      total_relevant_capabilities: totalRelevant,
      ready_or_available: readyOrAvailable,
      degraded_or_not_configured: degradedOrNotConfigured,
    },
    references,
    recommended_next_actions: dedupe([
      ...references.flatMap((reference) => reference.next_actions),
      ...catalog.recommended_next_actions,
    ]),
    source_catalog: {
      schema_version: catalog.schema_version,
      generated_at: catalog.generated_at,
      summary: catalog.summary,
    },
  };
}

function referenceRadar(
  reference: ReferenceMetadata,
  catalogCapabilities: MemoryCapability[],
): MemoryReferenceRadarEntry {
  const relevant = catalogCapabilities.filter((capability) =>
    capability.reference_relevance.includes(reference.id),
  );
  const gaps = relevant.flatMap((capability) => gapFor(capability));
  const score =
    relevant.length === 0
      ? 0
      : Number(
          (
            relevant.reduce((sum, capability) => sum + STATUS_SCORE[capability.status], 0) /
            relevant.length
          ).toFixed(3),
        );
  const notConfigured = countStatus(relevant, "not-configured");
  return {
    id: reference.id,
    name: reference.name,
    repository: reference.repository,
    focus: reference.focus,
    posture: score >= 0.8 && notConfigured === 0 ? "strong" : score >= 0.55 ? "watch" : "gap",
    score,
    relevant_capabilities: relevant.length,
    ready: countStatus(relevant, "ready"),
    available: countStatus(relevant, "available"),
    degraded: countStatus(relevant, "degraded"),
    not_configured: notConfigured,
    red_db_backed: relevant.filter((capability) => capability.red_db_backed).length,
    capabilities: relevant.map((capability) => ({
      id: capability.id,
      title: capability.title,
      category: capability.category,
      status: capability.status,
      red_db_backed: capability.red_db_backed,
      evidence: capability.evidence,
      cli: capability.cli,
      mcp: capability.mcp,
      notes: capability.notes,
    })),
    gaps,
    next_actions: dedupe(gaps.map((gap) => gap.next_action)),
  };
}

function gapFor(capability: MemoryCapability): MemoryReferenceGap[] {
  if (capability.status !== "degraded" && capability.status !== "not-configured") {
    return [];
  }
  return [
    {
      capability_id: capability.id,
      title: capability.title,
      status: capability.status,
      reason: capability.notes[0] ?? `${capability.title} is ${capability.status}.`,
      next_action: nextActionFor(capability),
    },
  ];
}

function nextActionFor(capability: MemoryCapability): string {
  if (capability.id === "vectors") {
    return "run `memory vector maintain --local` for local-dev vectors or configure RED_MEMORY_VECTOR_PROVIDER for provider embeddings";
  }
  if (capability.id === "lifecycle-hooks") {
    return "run `memory hooks coverage` and wire missing runner hooks";
  }
  if (capability.id === "documents") {
    return "run `memory ingest . --root .` to refresh documentation grounding";
  }
  return `inspect capability catalog entry ${capability.id}`;
}

function countStatus(
  capabilities: MemoryCapability[],
  status: CapabilityStatus,
): number {
  return capabilities.filter((capability) => capability.status === status).length;
}

function dedupe(items: string[]): string[] {
  return [...new Set(items.filter((item) => item.trim().length > 0))];
}
