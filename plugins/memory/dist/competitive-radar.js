import { buildMemoryCapabilityCatalog, } from "./capability-catalog.js";
const COMPETITORS = [
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
const STATUS_SCORE = {
    ready: 1,
    available: 0.75,
    degraded: 0.35,
    "not-configured": 0.15,
};
export async function buildMemoryCompetitiveRadar(store, rootDir, opts = {}) {
    const catalog = await buildMemoryCapabilityCatalog(store, rootDir, opts);
    const competitors = COMPETITORS.map((competitor) => competitorRadar(competitor, catalog.capabilities));
    const totalRelevant = competitors.reduce((sum, competitor) => sum + competitor.relevant_capabilities, 0);
    const readyOrAvailable = competitors.reduce((sum, competitor) => sum + competitor.ready + competitor.available, 0);
    const degradedOrNotConfigured = competitors.reduce((sum, competitor) => sum + competitor.degraded + competitor.not_configured, 0);
    return {
        schema_version: "memory.competitive_radar.v1",
        read_only: true,
        root: rootDir,
        generated_at: new Date(opts.now ?? Date.now()).toISOString(),
        note: "Internal planning radar derived from the Memory capability catalog; not a public benchmark claim.",
        summary: {
            competitors: competitors.length,
            total_relevant_capabilities: totalRelevant,
            ready_or_available: readyOrAvailable,
            degraded_or_not_configured: degradedOrNotConfigured,
        },
        competitors,
        recommended_next_actions: dedupe([
            ...competitors.flatMap((competitor) => competitor.next_actions),
            ...catalog.recommended_next_actions,
        ]),
        source_catalog: {
            schema_version: catalog.schema_version,
            generated_at: catalog.generated_at,
            summary: catalog.summary,
        },
    };
}
function competitorRadar(competitor, catalogCapabilities) {
    const relevant = catalogCapabilities.filter((capability) => capability.competitor_relevance.includes(competitor.id));
    const gaps = relevant.flatMap((capability) => gapFor(capability));
    const score = relevant.length === 0
        ? 0
        : Number((relevant.reduce((sum, capability) => sum + STATUS_SCORE[capability.status], 0) /
            relevant.length).toFixed(3));
    const notConfigured = countStatus(relevant, "not-configured");
    return {
        id: competitor.id,
        name: competitor.name,
        repository: competitor.repository,
        focus: competitor.focus,
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
function gapFor(capability) {
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
function nextActionFor(capability) {
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
function countStatus(capabilities, status) {
    return capabilities.filter((capability) => capability.status === status).length;
}
function dedupe(items) {
    return [...new Set(items.filter((item) => item.trim().length > 0))];
}
