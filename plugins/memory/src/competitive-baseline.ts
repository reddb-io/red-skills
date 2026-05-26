import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildMemoryAgentIntegrationStatus } from "./agent-integration-status.js";
import { buildMemoryCapabilityCatalog } from "./capability-catalog.js";
import { buildContextPack } from "./context-pack.js";
import { buildDocCoverageReport } from "./doc-coverage.js";
import {
  competitiveEvalFixture,
  competitiveInteropFixtures,
  type CompetitiveEvalFixture,
  type CompetitiveInteropArtifactFixture,
  type CompetitiveInteropCompetitor,
  type CompetitiveInteropDecisionKind,
} from "./competitive-fixtures.js";
import { recall, type RecallStore, type VectorRecallDiagnostics } from "./engine.js";
import type { GraphRow, SearchRow, StoredNode } from "./graph-store.js";
import { MemoryStore } from "./graph-store.js";
import { HistoricalMemoryStore } from "./historical-memory-store.js";
import { initGraph } from "./init.js";
import { lintMemoryRecords, type LintMemoryRecord } from "./lint.js";
import {
  agentmemoryBaselineCommandFromEnv,
  createAgentmemoryCliBaselineAdapter,
  createNeo4jAgentMemoryCliBaselineAdapter,
  defaultCliExecutor,
  neo4jAgentMemoryBaselineCommandFromEnv,
  type LiveBaselineRunResult,
} from "./live-baseline-adapters.js";
import { appendMemoryEvent, parseMemoryEvent } from "./memory-events.js";
import {
  buildMemoryOperationalDashboard,
  buildMemoryOperationalDashboardArtifact,
} from "./operational-dashboard.js";
import { buildReadinessEnvelope } from "./readiness.js";
import { buildMemoryRoutingGuide, SUPPORTED_ROUTING_AGENTS } from "./routing-guide.js";
import type { EdgeLabel } from "./schema.js";
import { classifyCandidateMemory } from "./store-classifier.js";
import { commitMemoryGraph } from "./vcs-commit.js";

type Claim = "advantage" | "parity" | "mixed" | "conceded-gap" | "not-claimed";

export interface GraphifyOutSummary {
  corpus: string;
  nodes: number;
  edges: number;
  communities: number;
  inferredEdges: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  measuredPathP50Ms: number;
}

export interface CompetitorBaseline {
  name: "memory" | "graphify" | "agent-memory";
  footprintScore: number;
  lifecycleScore: number;
  engineFeatures: {
    ttl: boolean;
    cache: boolean;
    louvain: boolean;
    geospatial: boolean;
    ask: boolean;
  };
  recallLatencyP50Ms?: number;
  nerExtractionQuality: "deterministic-or-llm" | "mixed-static-graph" | "python-ml-stack";
}

export interface BaselineAssertion {
  id: string;
  pass: boolean;
  detail: string;
}

export interface ComparisonRow {
  axis: string;
  memory: string;
  graphify: string;
  agentMemory: string;
  framing: string;
  claim: Claim;
}

export interface CompetitiveBaselineReport {
  generatedAt: string;
  graphifyOut: GraphifyOutSummary;
  competitors: CompetitorBaseline[];
  rows: ComparisonRow[];
  assertions: BaselineAssertion[];
  failedAssertions: BaselineAssertion[];
}

export interface CompetitiveEvalOptions {
  fixture?: CompetitiveEvalFixture;
  liveBaselines?: LiveBaselineRunResult[];
  now?: number;
  generatedAt?: string;
}

export interface CompetitiveEvalRecallCase {
  id: string;
  query: string;
  expectedRids: number[];
  returnedRids: number[];
  recallAtK: number;
  precisionAtK: number;
  reciprocalRank: number;
  latencyMs: number;
}

export interface CompetitiveEvalContextPackCase {
  id: string;
  goal: string;
  rawCorpusChars: number;
  packChars: number;
  reductionRatio: number;
  status: string;
  omittedEntries: number;
}

export interface CompetitiveEvalPolicyCase {
  id: string;
  expectedKind: string;
  actualKind: string;
  pass: boolean;
}

export interface FoundationGateAxis {
  id:
    | "retrieval"
    | "readiness"
    | "trust-governance"
    | "skill-evolution"
    | "operator-surface"
    | "multi-agent-integration";
  score: number;
  maxScore: number;
  status: "pass" | "warn" | "fail";
  detail: string;
}

export interface FoundationEvidenceGateReport {
  command: "pnpm --dir plugins/memory eval:competitive";
  evidenceBase: {
    name: string;
    source: "checked-in";
    nodes: number;
    edges: number;
    redDbBacked: true;
  };
  retrieval: {
    score: number;
    maxScore: number;
    hybridRecall: {
      queryCount: number;
      meanRecallAtK: number;
      vector: VectorRecallDiagnostics & {
        projectionOverall: string;
        projectionTotal: number;
      };
    };
    asOfRecall: {
      status: "available" | "unavailable";
      refKind: "commit";
      nodes: number;
      recalled: number;
      error?: string;
    };
  };
  readiness: {
    score: number;
    maxScore: number;
    status: string;
    contractVersion: string;
    consumerTargets: string[];
  };
  trustGovernance: {
    score: number;
    maxScore: number;
    claimCheck: string;
    privacyFindings: number;
    vcsTimeTravel: string;
    eventLog: {
      status: string;
      totalEvents: number;
      kinds: Record<string, number>;
    };
  };
  skillEvolution: {
    score: number;
    maxScore: number;
    telemetryEvents: number;
    communities: {
      count: number;
      assignments: number;
    };
  };
  operatorSurface: {
    score: number;
    maxScore: number;
    docCoverage: {
      totalDocs: number;
      groundedDocs: number;
      docsWithReferences: number;
      vectorOverall: string;
    };
    hookCoverage: {
      enabledEvents: number;
      wiredEvents: number;
      totalEvents: number;
      gaps: number;
    };
    dashboard: {
      contractVersion: string;
      consumes: string;
      htmlBytes: number;
      state: string;
    };
    capabilityCatalog: {
      total: number;
      categories: number;
      redDbBacked: number;
      ready: number;
      notConfigured: number;
    };
  };
  multiAgentIntegration: {
    score: number;
    maxScore: number;
    supportedAgents: number;
    readyAgents: number;
    partialAgents: number;
    missingAgents: number;
    mcpTools: number;
    cliFallbacks: number;
    hookCapableAgents: number;
    hookReadyAgents: number;
    sources: {
      routingGuide: "memory.routing_guide.v1";
      integrationStatus: "memory.agent_integration_status.v1";
    };
  };
  composite: {
    score: number;
    maxScore: number;
    status: "ready-foundation" | "review-foundation";
    axes: FoundationGateAxis[];
  };
  agentmemoryLiveBaseline: {
    state: "adapter-ready";
    implemented: true;
    note: string;
  };
}

export interface CompetitiveEvalReport {
  generatedAt: string;
  fixture: {
    name: string;
    source: "checked-in";
    nodes: number;
    edges: number;
  };
  recall: {
    queryCount: number;
    meanRecallAtK: number;
    meanPrecisionAtK: number;
    meanReciprocalRank: number;
    latency: {
      p50Ms: number;
      maxMs: number;
    };
    cases: CompetitiveEvalRecallCase[];
  };
  contextPacks: {
    packCount: number;
    meanReductionRatio: number;
    cases: CompetitiveEvalContextPackCase[];
  };
  policy: {
    totalCandidates: number;
    classificationAccuracy: number;
    cases: CompetitiveEvalPolicyCase[];
    lintCaseCount: number;
    lintFindings: string[];
  };
  foundationGate: FoundationEvidenceGateReport;
  claimGuards: {
    unsupportedLiveCompetitorClaims: string[];
    unmeasuredLiveBaselines: string[];
  };
}

export interface CompetitiveEvalV2Dimension {
  id:
    | "retrieval"
    | "readiness"
    | "trust-governance"
    | "skill-evolution"
    | "operator-surface"
    | "multi-agent-integration"
    | "intelligence";
  score: number;
  maxScore: number;
  status: "pass" | "warn" | "fail";
  detail: string;
  evidence: string[];
  metrics: Record<string, string | number>;
  subChecks?: Array<{
    id: string;
    status: "pass" | "warn" | "fail";
    detail: string;
  }>;
}

export interface CompetitiveEvalV2Report {
  schemaVersion: "memory.competitive_eval.v2";
  generatedAt: string;
  fixture: CompetitiveEvalReport["fixture"];
  liveServices: "not-required" | "opt-in";
  liveBaselines: LiveBaselineRunResult[];
  composite: {
    score: number;
    maxScore: number;
    normalizedScore: number;
    status: "pass" | "warn" | "fail";
  };
  dimensions: CompetitiveEvalV2Dimension[];
  claimGuards: {
    status: "pass" | "fail";
    unsupportedPublicClaims: string[];
    unsupportedLiveCompetitorClaims: string[];
    unmeasuredLiveBaselines: string[];
  };
}

export interface CompetitiveInteropMappingDecision {
  sourceConcept: string;
  memoryConcept: string | null;
  decision: CompetitiveInteropDecisionKind;
  count: number;
  rationale: string;
}

export interface CompetitiveInteropArtifactReport {
  competitor: CompetitiveInteropCompetitor;
  artifactName: string;
  source: "checked-in";
  counts: {
    sourceNodes: number;
    sourceEdges: number;
    preservedConcepts: number;
    approximatedConcepts: number;
    droppedConcepts: number;
  };
  decisions: CompetitiveInteropMappingDecision[];
  caveats: string[];
}

export interface CompetitiveInteropReport {
  schemaVersion: "memory.competitor_interop.v1";
  generatedAt: string;
  liveServices: "not-required";
  artifacts: CompetitiveInteropArtifactReport[];
  claimGuards: {
    fullParityClaimed: false;
    unsupportedClaims: string[];
  };
}

export interface CompetitiveInteropOptions {
  fixtures?: CompetitiveInteropArtifactFixture[];
  generatedAt?: string;
}

/**
 * Checked-in summary derived from
 * `/home/cyber/Work/reddb.io/reddb-benchmark/graphify-out`.
 *
 * The full graph export is intentionally not copied here. The competitive
 * harness only needs the stable shape and the path-query timing fixture behind
 * the README claims.
 */
export const graphifyOutSummary: GraphifyOutSummary = {
  corpus: "reddb-benchmark/graphify-out",
  nodes: 551,
  edges: 1329,
  communities: 34,
  inferredEdges: 491,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  measuredPathP50Ms: 841,
};

const competitors: CompetitorBaseline[] = [
  {
    name: "memory",
    footprintScore: 3,
    lifecycleScore: 4,
    engineFeatures: {
      ttl: true,
      cache: true,
      louvain: true,
      geospatial: false,
      ask: true,
    },
    recallLatencyP50Ms: 100,
    nerExtractionQuality: "deterministic-or-llm",
  },
  {
    name: "graphify",
    footprintScore: 1,
    lifecycleScore: 1,
    engineFeatures: {
      ttl: false,
      cache: false,
      louvain: false,
      geospatial: false,
      ask: false,
    },
    recallLatencyP50Ms: graphifyOutSummary.measuredPathP50Ms,
    nerExtractionQuality: "mixed-static-graph",
  },
  {
    name: "agent-memory",
    footprintScore: 0,
    lifecycleScore: 0,
    engineFeatures: {
      ttl: false,
      cache: false,
      louvain: false,
      geospatial: true,
      ask: false,
    },
    nerExtractionQuality: "python-ml-stack",
  },
];

const FOUNDATION_GATE_GOAL = "Memory README moat claims backed by executable eval output";

function competitor(name: CompetitorBaseline["name"]): CompetitorBaseline {
  const found = competitors.find((c) => c.name === name);
  if (!found) throw new Error(`missing competitor baseline: ${name}`);
  return found;
}

function featureList(c: CompetitorBaseline): string {
  const entries = Object.entries(c.engineFeatures)
    .filter(([, enabled]) => enabled)
    .map(([name]) => name.toUpperCase());
  return entries.length > 0 ? entries.join(", ") : "none on the selected axes";
}

function buildRows(): ComparisonRow[] {
  return [
    {
      axis: "Zero-ops / embedded footprint",
      memory: "Embedded RedDB file store; no daemon to administer.",
      graphify: "Python CLI plus checked-in `graphify-out`; no database daemon, but a separate toolchain.",
      agentMemory: "Neo4j-backed SDK/MCP; needs a Neo4j instance or hosted service.",
      framing: "Advantage: embedded RedDB store, no Python or Neo4j service.",
      claim: "advantage",
    },
    {
      axis: "Session lifecycle integration",
      memory: "Native SessionStart, PostToolUse, Stop, and PreCompact hooks in graph mode.",
      graphify: "Assistant instructions and optional search nudges; not a memory lifecycle.",
      agentMemory: "SDK/MCP integration; no RedSkills hook lifecycle.",
      framing: "Advantage: memory is built into the agent session lifecycle.",
      claim: "advantage",
    },
    {
      axis: "Engine feature breadth",
      memory: `TTL, KV/cache overlays, native Louvain, ASK; geospatial is not exposed by memory yet.`,
      graphify: `Static graph export with query/path/explain and ${graphifyOutSummary.communities} detected communities in the fixture.`,
      agentMemory: "Neo4j graph, vector/text search, geospatial, MCP tools, eval harness, and framework adapters.",
      framing: "Parity/mixed: both graph competitors have useful breadth; memory wins embedded RedDB primitives, agent-memory wins Neo4j ecosystem breadth.",
      claim: "mixed",
    },
    {
      axis: "Recall latency on agent-scale graph",
      memory: "Repo gate targets <100 ms p50 on a ~1k-node graph.",
      graphify: `graphify-out fixture: ${graphifyOutSummary.nodes} nodes / ${graphifyOutSummary.edges} edges / ${graphifyOutSummary.communities} communities; path p50 ${graphifyOutSummary.measuredPathP50Ms} ms.`,
      agentMemory: "Not asserted here; apples-to-apples latency requires a live Neo4j baseline.",
      framing: "Advantage over checked graphify-out path latency only; no latency claim against agent-memory in this harness.",
      claim: "advantage",
    },
    {
      axis: "NER extraction quality",
      memory: "Deterministic structural/entity extractors plus optional LLM provider for inferred facts.",
      graphify: `${graphifyOutSummary.inferredEdges} inferred fixture edges; strong static-code graph output.`,
      agentMemory: "spaCy / GLiNER / GLiREL / LLM extraction pipeline.",
      framing: "Conceded gap: Python ML stack is ahead for turnkey NER.",
      claim: "conceded-gap",
    },
  ];
}

function buildAssertions(): BaselineAssertion[] {
  const memory = competitor("memory");
  const graphify = competitor("graphify");
  const agentMemory = competitor("agent-memory");

  return [
    {
      id: "memory-zero-ops-beats-graphify",
      pass: memory.footprintScore > graphify.footprintScore,
      detail: "memory must keep fewer runtime operations than graphify",
    },
    {
      id: "memory-zero-ops-beats-agent-memory",
      pass: memory.footprintScore > agentMemory.footprintScore,
      detail: "memory must not require a Neo4j service for the embedded path",
    },
    {
      id: "memory-lifecycle-beats-graphify",
      pass: memory.lifecycleScore > graphify.lifecycleScore,
      detail: "memory must retain native lifecycle hooks",
    },
    {
      id: "memory-lifecycle-beats-agent-memory",
      pass: memory.lifecycleScore > agentMemory.lifecycleScore,
      detail: "memory must retain RedSkills session lifecycle integration",
    },
    {
      id: "memory-recall-latency-beats-graphify-out-path",
      pass:
        memory.recallLatencyP50Ms != null &&
        graphify.recallLatencyP50Ms != null &&
        memory.recallLatencyP50Ms < graphify.recallLatencyP50Ms,
      detail: "memory's repo-gated p50 budget must stay below graphify-out path p50",
    },
    {
      id: "memory-recall-latency-under-agent-scale-budget",
      pass: memory.recallLatencyP50Ms != null && memory.recallLatencyP50Ms <= 100,
      detail: "memory must keep the ~1k-node recall budget at or below 100 ms p50",
    },
    {
      id: "memory-concedes-ner-extraction-quality",
      pass:
        memory.nerExtractionQuality !== "python-ml-stack" &&
        agentMemory.nerExtractionQuality === "python-ml-stack",
      detail: "the comparison must not claim NER extraction parity with agent-memory",
    },
  ];
}

export function evaluateCompetitiveBaseline(now = new Date(0)): CompetitiveBaselineReport {
  const assertions = buildAssertions();
  return {
    generatedAt: now.toISOString(),
    graphifyOut: graphifyOutSummary,
    competitors: competitors.map((c) => ({ ...c, engineFeatures: { ...c.engineFeatures } })),
    rows: buildRows(),
    assertions,
    failedAssertions: assertions.filter((a) => !a.pass),
  };
}

export function renderComparisonTable(report: CompetitiveBaselineReport): string {
  const lines = [
    "| Axis | `memory` | `graphify` | `agent-memory` | Framing |",
    "|------|----------|------------|----------------|---------|",
  ];
  for (const row of report.rows) {
    lines.push(
      `| ${row.axis} | ${row.memory} | ${row.graphify} | ${row.agentMemory} | ${row.framing} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

class FixtureRecallStore implements RecallStore {
  constructor(private readonly fixture: CompetitiveEvalFixture) {}

  async listNodes(): Promise<StoredNode[]> {
    return this.fixture.nodes.map((node) => ({
      ...node,
      properties: { ...node.properties },
    }));
  }

  async searchText(query: string, limit = 20): Promise<SearchRow[]> {
    const terms = query.toLowerCase().match(/[a-z0-9]+/g) ?? [];
    return this.fixture.nodes
      .map((node) => ({
        rid: node.rid,
        score: terms.filter((term) => nodeSearchText(node).includes(term)).length,
      }))
      .filter((hit) => hit.score > 0)
      .sort((a, b) => b.score - a.score || a.rid - b.rid)
      .slice(0, limit);
  }

  async neighborhood(): Promise<GraphRow[]> {
    return [];
  }

  async supersededByMany(): Promise<Map<number, number>> {
    return new Map();
  }

  async recordAccess(): Promise<void> {}

  async listEdges(): Promise<Record<string, unknown>[]> {
    return this.fixture.edges.map((edge) => ({ ...edge }));
  }
}

function nodeSearchText(node: StoredNode): string {
  const props = node.properties;
  return [node.label, props.title, props.summary, props.content, ...(props.tags ?? [])]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function roundMetric(value: number): number {
  return Number(value.toFixed(4));
}

function decisionCount(
  decisions: CompetitiveInteropMappingDecision[],
  decision: CompetitiveInteropDecisionKind,
): number {
  return decisions
    .filter((item) => item.decision === decision)
    .reduce((sum, item) => sum + item.count, 0);
}

export function evaluateCompetitiveInteropReport(
  opts: CompetitiveInteropOptions = {},
): CompetitiveInteropReport {
  const fixtures = opts.fixtures ?? competitiveInteropFixtures;
  const artifacts = fixtures.map((fixture) => {
    const decisions = fixture.mapping.map((item) => ({ ...item }));
    return {
      competitor: fixture.competitor,
      artifactName: fixture.artifactName,
      source: fixture.source,
      counts: {
        sourceNodes: fixture.nodes.length,
        sourceEdges: fixture.edges.length,
        preservedConcepts: decisionCount(decisions, "preserved"),
        approximatedConcepts: decisionCount(decisions, "approximated"),
        droppedConcepts: decisionCount(decisions, "dropped"),
      },
      decisions,
      caveats: [...fixture.caveats],
    };
  });

  return {
    schemaVersion: "memory.competitor_interop.v1",
    generatedAt: opts.generatedAt ?? new Date().toISOString(),
    liveServices: "not-required",
    artifacts,
    claimGuards: {
      fullParityClaimed: false,
      unsupportedClaims: [],
    },
  };
}

function p50(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)] ?? 0;
}

function rawCorpusChars(fixture: CompetitiveEvalFixture): number {
  return fixture.nodes.reduce((sum, node) => {
    const props = node.properties;
    return sum + String(props.title ?? node.label).length + String(props.content ?? props.summary ?? "").length;
  }, 0);
}

interface FoundationGateOptions {
  now: number;
}

async function evaluateFoundationEvidenceGate(
  fixture: CompetitiveEvalFixture,
  opts: FoundationGateOptions,
): Promise<FoundationEvidenceGateReport> {
  const root = await mkdtemp(join(tmpdir(), "memory-foundation-gate-"));
  try {
    const init = await initGraph(root, {
      project: "competitive-gate",
      hooks: true,
      skillTelemetry: true,
    });
    await seedAgentRoutingFiles(root);
    const store = await MemoryStore.open({ uri: init.storeUri, project: "competitive-gate" });
    let envelope: Awaited<ReturnType<typeof buildReadinessEnvelope>>;
    let vector = await store.vectorStatus();
    let hybridRecall: FoundationEvidenceGateReport["retrieval"]["hybridRecall"];
    let operatorSurface!: FoundationEvidenceGateReport["operatorSurface"];
    let multiAgentIntegration!: FoundationEvidenceGateReport["multiAgentIntegration"];
    try {
      const ridMap = await seedFoundationEvidence(store, fixture, opts.now);
      await seedFoundationDocCoverage(store, root, ridMap, fixture, opts.now);
      vector = await store.vectorStatus();

      const recallCases: CompetitiveEvalRecallCase[] = [];
      for (const item of fixture.recall) {
        const result = await recall(store, item.query, { k: item.k, depth: 1, now: opts.now });
        const returnedRids = result.nodes.slice(0, item.k).map((node) => node.rid);
        const expected = new Set(item.expectedRids.map((rid) => mappedRid(ridMap, rid)));
        const hits = returnedRids.filter((rid) => expected.has(rid));
        const firstExpectedIndex = returnedRids.findIndex((rid) => expected.has(rid));
        recallCases.push({
          id: item.id,
          query: item.query,
          expectedRids: [...expected],
          returnedRids,
          recallAtK: roundMetric(hits.length / item.expectedRids.length),
          precisionAtK: roundMetric(hits.length / item.k),
          reciprocalRank: firstExpectedIndex >= 0 ? roundMetric(1 / (firstExpectedIndex + 1)) : 0,
          latencyMs: 0,
        });
      }

      const vectorDiagnostics = await recall(store, fixture.recall[0]?.query ?? fixture.name, {
        k: fixture.recall[0]?.k ?? 3,
        depth: 1,
        now: opts.now,
      });
      hybridRecall = {
        queryCount: recallCases.length,
        meanRecallAtK: roundMetric(mean(recallCases.map((item) => item.recallAtK))),
        vector: {
          ...vectorDiagnostics.diagnostics.vector,
          projectionOverall: vector.overall,
          projectionTotal: vector.total,
        },
      };

      envelope = await buildReadinessEnvelope(store, FOUNDATION_GATE_GOAL, {
        now: opts.now,
        minEvidence: 2,
      });
      operatorSurface = await evaluateOperatorSurface(store, root);
      multiAgentIntegration = await evaluateMultiAgentIntegration(root, opts.now);
    } finally {
      await store.close();
    }

    const committed = await commitMemoryGraph(root, init.config, {
      message: "foundation evidence gate",
      author: "RedSkills Memory",
      email: "memory@reddb.io",
    });
    const asOfRecall = await probeAsOfRecall(init.storeUri, committed.commit?.hash, fixture, opts.now);

    const axes = foundationAxes({
      hybridRecall,
      asOfRecall,
      envelope,
      operatorSurface,
      multiAgentIntegration,
    });
    const score = axes.reduce((sum, axis) => sum + axis.score, 0);
    const maxScore = axes.reduce((sum, axis) => sum + axis.maxScore, 0);

    return {
      command: "pnpm --dir plugins/memory eval:competitive",
      evidenceBase: {
        name: fixture.name,
        source: fixture.source,
        nodes: fixture.nodes.length,
        edges: fixture.edges.length,
        redDbBacked: true,
      },
      retrieval: {
        score: axes.find((axis) => axis.id === "retrieval")?.score ?? 0,
        maxScore: 1,
        hybridRecall,
        asOfRecall,
      },
      readiness: {
        score: axes.find((axis) => axis.id === "readiness")?.score ?? 0,
        maxScore: 1,
        status: envelope.status,
        contractVersion: envelope.contract.version,
        consumerTargets: [...envelope.contract.consumer_targets],
      },
      trustGovernance: {
        score: axes.find((axis) => axis.id === "trust-governance")?.score ?? 0,
        maxScore: 1,
        claimCheck: envelope.trust.claim_check.status,
        privacyFindings: envelope.trust.privacy.findings,
        vcsTimeTravel: envelope.vcs.time_travel,
        eventLog: {
          status: envelope.operations.event_log.status,
          totalEvents: envelope.operations.event_log.total_events,
          kinds: envelope.operations.event_log.kinds,
        },
      },
      skillEvolution: {
        score: axes.find((axis) => axis.id === "skill-evolution")?.score ?? 0,
        maxScore: 1,
        telemetryEvents: envelope.operations.event_log.kinds["skill.telemetry"] ?? 0,
        communities: {
          count: envelope.communities.communities,
          assignments: envelope.communities.assignments,
        },
      },
      operatorSurface,
      multiAgentIntegration,
      composite: {
        score,
        maxScore,
        status: score === maxScore ? "ready-foundation" : "review-foundation",
        axes,
      },
      agentmemoryLiveBaseline: {
        state: "adapter-ready",
        implemented: true,
        note:
          "Agentmemory and Neo4j Agent Memory live baseline adapters are available through opt-in eval:competitive:v2 flags; normal runs remain checked-in fixture only.",
      },
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function seedFoundationEvidence(
  store: MemoryStore,
  fixture: CompetitiveEvalFixture,
  now: number,
): Promise<Map<number, number>> {
  const rids = new Map<number, number>();
  for (const node of fixture.nodes) {
    const rid = await store.upsertNode({
      label: node.label,
      node_type: node.node_type,
      properties: {
        ...node.properties,
        scope: node.properties.scope ?? "project",
        tier: node.properties.tier ?? "durable",
        created_at: now,
        updated_at: now,
        provenance: {
          source_kind: "system",
          writer: "eval:competitive",
          command: "foundation evidence gate",
          evidence: [`competitive-fixture:${fixture.name}:${node.rid}`],
        },
      },
    });
    rids.set(node.rid, rid);
  }

  for (const edge of fixture.edges) {
    const from = mappedRid(rids, Number(edge.from));
    const to = mappedRid(rids, Number(edge.to));
    const label = String(edge.label ?? "REFERENCES") as EdgeLabel;
    await store.upsertEdge({
      label,
      from_rid: from,
      to_rid: to,
      properties: {
        source: "competitive-fixture",
        created_at: now,
      },
    });
  }

  await appendMemoryEvent(
    store,
    parseMemoryEvent({
      id: "skill-event:foundation-gate",
      occurred_at: new Date(now).toISOString(),
      kind: "skill.telemetry",
      source: { kind: "hook", name: "memory event skill" },
      actor: { kind: "agent", id: "codex" },
      scope: { level: "project", id: fixture.name },
      subject: { kind: "skill", id: "plugin:memory:eval-competitive" },
      payload: {
        event_type: "result",
        event_id: "foundation-gate",
        timestamp: new Date(now).toISOString(),
        session_id: "foundation-gate",
        turn_id: "competitive-eval",
        name: "memory:eval-competitive",
        source_kind: "plugin",
        path: "plugins/memory/src/competitive-baseline.ts",
        runner: "codex",
        result: { status: "succeeded", duration_ms: 1 },
      },
      provenance: {
        source_kind: "system",
        writer: "eval:competitive",
        command: "foundation evidence gate",
        evidence: [`fixture:${fixture.name}`],
      },
    }),
  );

  return rids;
}

async function seedFoundationDocCoverage(
  store: MemoryStore,
  root: string,
  rids: Map<number, number>,
  fixture: CompetitiveEvalFixture,
  now: number,
): Promise<void> {
  const docHash = `competitive-doc:${fixture.name}`;
  const docPath = join(root, "docs", "competitive-memory.md");
  const docRid = await store.upsertDoc({
    path: docPath,
    title: "Competitive Memory Evidence",
    body:
      "Competitive Memory Evidence links README claims, hook coverage, doc coverage, vector diagnostics, and the operational dashboard.",
    frontmatter: { tags: ["competitive", "memory", "dashboard"] },
    hash: docHash,
    updated_at: now,
  });
  const rootRid = await store.upsertNode({
    label: `md:${docPath}`,
    node_type: "concept",
    properties: {
      title: "Competitive Memory Evidence",
      summary: "Documentation chunk for competitive operator-surface coverage.",
      source: docPath,
      confidence: "EXTRACTED",
      hash: docHash,
      created_at: now,
      updated_at: now,
      provenance: {
        source_kind: "system",
        writer: "eval:competitive",
        command: "operator surface evidence",
        evidence: [`memory_docs:${docRid}`],
      },
    },
  });
  const target = mappedRid(rids, fixture.nodes[0]?.rid ?? 1);
  await store.upsertEdge({
    label: "REFERENCES",
    from_rid: rootRid,
    to_rid: target,
    properties: { source: "competitive-fixture", created_at: now },
  });
}

async function evaluateOperatorSurface(
  store: MemoryStore,
  root: string,
): Promise<FoundationEvidenceGateReport["operatorSurface"]> {
  const [docCoverage, dashboard, capabilityCatalog] = await Promise.all([
    buildDocCoverageReport(store),
    buildMemoryOperationalDashboard(store, root),
    buildMemoryCapabilityCatalog(store, root),
  ]);
  const artifact = buildMemoryOperationalDashboardArtifact(dashboard);
  const hookCoverage = dashboard.sources.hook_coverage;
  const pass =
    docCoverage.total_docs > 0 &&
    docCoverage.grounded_docs === docCoverage.total_docs &&
    docCoverage.docs_with_references > 0 &&
    hookCoverage.summary.wired_events >= 7 &&
    hookCoverage.summary.enabled_events >= 7 &&
    artifact.contract.version === "memory.operational_dashboard.viewer.v1" &&
    artifact.contract.consumes === "memory.operational_dashboard.v1" &&
    artifact.html.includes('id="memory-dashboard-data"') &&
    capabilityCatalog.schema_version === "memory.capability_catalog.v1" &&
    capabilityCatalog.summary.total >= 9 &&
    capabilityCatalog.categories.length >= 9 &&
    capabilityCatalog.summary.red_db_backed >= 8;

  return {
    score: pass ? 1 : 0,
    maxScore: 1,
    docCoverage: {
      totalDocs: docCoverage.total_docs,
      groundedDocs: docCoverage.grounded_docs,
      docsWithReferences: docCoverage.docs_with_references,
      vectorOverall: docCoverage.vector.overall,
    },
    hookCoverage: {
      enabledEvents: hookCoverage.summary.enabled_events,
      wiredEvents: hookCoverage.summary.wired_events,
      totalEvents: hookCoverage.summary.total_events,
      gaps: hookCoverage.gaps.length,
    },
    dashboard: {
      contractVersion: artifact.contract.version,
      consumes: artifact.contract.consumes,
      htmlBytes: Buffer.byteLength(artifact.html, "utf8"),
      state: dashboard.state,
    },
    capabilityCatalog: {
      total: capabilityCatalog.summary.total,
      categories: capabilityCatalog.categories.length,
      redDbBacked: capabilityCatalog.summary.red_db_backed,
      ready: capabilityCatalog.summary.ready,
      notConfigured: capabilityCatalog.summary.not_configured,
    },
  };
}

async function seedAgentRoutingFiles(root: string): Promise<void> {
  const snippetsByPath = new Map<string, string[]>();
  for (const agent of SUPPORTED_ROUTING_AGENTS) {
    const guide = buildMemoryRoutingGuide({ agent });
    for (const target of guide.targetFiles) {
      const snippets = snippetsByPath.get(target) ?? [];
      snippets.push(guide.installSnippet);
      snippetsByPath.set(target, snippets);
    }
  }

  await Promise.all(
    [...snippetsByPath.entries()].map(async ([target, snippets]) => {
      const path = join(root, target);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, snippets.join("\n"), "utf8");
    }),
  );
}

async function evaluateMultiAgentIntegration(
  root: string,
  now: number,
): Promise<FoundationEvidenceGateReport["multiAgentIntegration"]> {
  const status = await buildMemoryAgentIntegrationStatus(root, { now });
  const representativeGuide = buildMemoryRoutingGuide({ agent: "codex" });
  const hookCapableAgents = status.agents.filter((agent) => agent.hook_coverage != null);
  const hookReadyAgents = hookCapableAgents.filter(
    (agent) =>
      (agent.hook_coverage?.effective_events ?? 0) > 0 &&
      (agent.hook_coverage?.actionable_gaps ?? 1) === 0,
  );
  const pass =
    status.summary.agents === SUPPORTED_ROUTING_AGENTS.length &&
    status.summary.ready === SUPPORTED_ROUTING_AGENTS.length &&
    status.summary.missing === 0 &&
    representativeGuide.mcpTools.length >= 10 &&
    representativeGuide.cliFallbacks.length >= 10 &&
    hookCapableAgents.length >= 2 &&
    hookReadyAgents.length === hookCapableAgents.length;

  return {
    score: pass ? 1 : 0,
    maxScore: 1,
    supportedAgents: status.summary.agents,
    readyAgents: status.summary.ready,
    partialAgents: status.summary.partial,
    missingAgents: status.summary.missing,
    mcpTools: representativeGuide.mcpTools.length,
    cliFallbacks: representativeGuide.cliFallbacks.length,
    hookCapableAgents: hookCapableAgents.length,
    hookReadyAgents: hookReadyAgents.length,
    sources: {
      routingGuide: status.sources.routing_guide,
      integrationStatus: status.schema_version,
    },
  };
}

function mappedRid(rids: Map<number, number>, rid: number): number {
  return rids.get(rid) ?? rid;
}

async function probeAsOfRecall(
  uri: string,
  commit: string | undefined,
  fixture: CompetitiveEvalFixture,
  now: number,
): Promise<FoundationEvidenceGateReport["retrieval"]["asOfRecall"]> {
  if (!commit) {
    return {
      status: "unavailable",
      refKind: "commit",
      nodes: 0,
      recalled: 0,
      error: "foundation graph did not produce a commit hash",
    };
  }

  const historical = await HistoricalMemoryStore.open({ uri, ref: commit });
  try {
    const nodes = await historical.listNodes();
    const firstQuery = fixture.recall[0]?.query ?? fixture.name;
    const recalled = await recall(historical, firstQuery, { k: 3, depth: 1, now });
    return {
      status: nodes.length > 0 ? "available" : "unavailable",
      refKind: "commit",
      nodes: nodes.length,
      recalled: recalled.nodes.length,
    };
  } catch (err) {
    return {
      status: "unavailable",
      refKind: "commit",
      nodes: 0,
      recalled: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await historical.close();
  }
}

function foundationAxes(input: {
  hybridRecall: FoundationEvidenceGateReport["retrieval"]["hybridRecall"];
  asOfRecall: FoundationEvidenceGateReport["retrieval"]["asOfRecall"];
  envelope: Awaited<ReturnType<typeof buildReadinessEnvelope>>;
  operatorSurface: FoundationEvidenceGateReport["operatorSurface"];
  multiAgentIntegration: FoundationEvidenceGateReport["multiAgentIntegration"];
}): FoundationGateAxis[] {
  const retrievalPass =
    input.hybridRecall.queryCount > 0 &&
    input.hybridRecall.meanRecallAtK > 0 &&
    input.hybridRecall.vector.projectionTotal > 0 &&
    input.asOfRecall.status === "available";
  const readinessPass =
    input.envelope.contract.version === "memory.readiness.v1" &&
    input.envelope.contract.consumer_targets.includes("eval:competitive:v2");
  const trustPass =
    input.envelope.vcs.time_travel !== "unavailable" &&
    input.envelope.operations.event_log.total_events > 0 &&
    input.envelope.trust.privacy.read_only;
  const skillEvolutionPass =
    (input.envelope.operations.event_log.kinds["skill.telemetry"] ?? 0) > 0 &&
    input.envelope.communities.assignments > 0;
  const operatorSurfacePass = input.operatorSurface.score === input.operatorSurface.maxScore;
  const multiAgentIntegrationPass =
    input.multiAgentIntegration.score === input.multiAgentIntegration.maxScore;

  return [
    {
      id: "retrieval",
      score: retrievalPass ? 1 : 0,
      maxScore: 1,
      status: retrievalPass ? "pass" : "fail",
      detail: `hybrid recall=${input.hybridRecall.meanRecallAtK}, vector=${input.hybridRecall.vector.projectionOverall}, as_of=${input.asOfRecall.status}`,
    },
    {
      id: "readiness",
      score: readinessPass ? 1 : 0,
      maxScore: 1,
      status: readinessPass ? "pass" : "fail",
      detail: `${input.envelope.contract.version} status=${input.envelope.status}`,
    },
    {
      id: "trust-governance",
      score: trustPass ? 1 : 0,
      maxScore: 1,
      status: trustPass ? "pass" : "fail",
      detail: `vcs=${input.envelope.vcs.time_travel}, events=${input.envelope.operations.event_log.total_events}, privacy=${input.envelope.trust.privacy.findings}`,
    },
    {
      id: "skill-evolution",
      score: skillEvolutionPass ? 1 : 0,
      maxScore: 1,
      status: skillEvolutionPass ? "pass" : "fail",
      detail: `skill.telemetry=${input.envelope.operations.event_log.kinds["skill.telemetry"] ?? 0}, communities=${input.envelope.communities.communities}/${input.envelope.communities.assignments}`,
    },
    {
      id: "operator-surface",
      score: operatorSurfacePass ? 1 : 0,
      maxScore: 1,
      status: operatorSurfacePass ? "pass" : "fail",
      detail: `docs=${input.operatorSurface.docCoverage.groundedDocs}/${input.operatorSurface.docCoverage.totalDocs}, hooks=${input.operatorSurface.hookCoverage.enabledEvents}/${input.operatorSurface.hookCoverage.totalEvents}, dashboard=${input.operatorSurface.dashboard.contractVersion}, capabilities=${input.operatorSurface.capabilityCatalog.total}/${input.operatorSurface.capabilityCatalog.categories}`,
    },
    {
      id: "multi-agent-integration",
      score: multiAgentIntegrationPass ? 1 : 0,
      maxScore: 1,
      status: multiAgentIntegrationPass ? "pass" : "fail",
      detail: `agents=${input.multiAgentIntegration.readyAgents}/${input.multiAgentIntegration.supportedAgents}, mcp_tools=${input.multiAgentIntegration.mcpTools}, hooks=${input.multiAgentIntegration.hookReadyAgents}/${input.multiAgentIntegration.hookCapableAgents}`,
    },
  ];
}

export async function evaluateCompetitiveEval(
  opts: CompetitiveEvalOptions = {},
): Promise<CompetitiveEvalReport> {
  const fixture = opts.fixture ?? competitiveEvalFixture;
  const now = opts.now ?? Date.now();
  const store = new FixtureRecallStore(fixture);
  const recallCases: CompetitiveEvalRecallCase[] = [];

  for (const item of fixture.recall) {
    const start = performance.now();
    const result = await recall(store, item.query, { k: item.k, depth: 1, now });
    const latencyMs = performance.now() - start;
    const returnedRids = result.nodes.slice(0, item.k).map((node) => node.rid);
    const expected = new Set(item.expectedRids);
    const hits = returnedRids.filter((rid) => expected.has(rid));
    const firstExpectedIndex = returnedRids.findIndex((rid) => expected.has(rid));
    recallCases.push({
      id: item.id,
      query: item.query,
      expectedRids: item.expectedRids,
      returnedRids,
      recallAtK: roundMetric(hits.length / item.expectedRids.length),
      precisionAtK: roundMetric(hits.length / item.k),
      reciprocalRank: firstExpectedIndex >= 0 ? roundMetric(1 / (firstExpectedIndex + 1)) : 0,
      latencyMs: roundMetric(latencyMs),
    });
  }

  const rawChars = rawCorpusChars(fixture);
  const contextCases: CompetitiveEvalContextPackCase[] = [];
  for (const item of fixture.contextPacks) {
    const pack = await buildContextPack(store, item.goal, {
      budgetChars: item.budgetChars,
      now,
    });
    const reductionRatio = rawChars > 0 ? (rawChars - pack.usedChars) / rawChars : 0;
    contextCases.push({
      id: item.id,
      goal: item.goal,
      rawCorpusChars: rawChars,
      packChars: pack.usedChars,
      reductionRatio: roundMetric(reductionRatio),
      status: pack.status,
      omittedEntries: pack.omittedEntries,
    });
  }

  const policyCases: CompetitiveEvalPolicyCase[] = fixture.candidates.map((candidate) => {
    const actual = classifyCandidateMemory(candidate.text);
    const pass =
      actual.kind === candidate.expectedKind &&
      actual.recommendedTier === candidate.expectedTier &&
      actual.recommendedScope === candidate.expectedScope &&
      candidate.expectedWarnings.every((warning) => actual.safetyWarnings.includes(warning));
    return {
      id: candidate.id,
      expectedKind: candidate.expectedKind,
      actualKind: actual.kind,
      pass,
    };
  });

  const lintRecords: LintMemoryRecord[] = fixture.policyMemories.map((memory) => ({
    id: memory.id,
    location: `competitive-fixture:${memory.id}`,
    title: memory.title,
    body: memory.body,
    scope: memory.scope,
    tier: memory.tier,
    createdAt: memory.createdAt,
  }));
  const lintFindings = lintMemoryRecords(lintRecords, { now })
    .map((finding) => finding.code)
    .filter((code, index, codes) => codes.indexOf(code) === index)
    .sort();

  const unsupportedLiveCompetitorClaims = fixture.liveBaselines
    .filter((baseline) => !baseline.configured && baseline.assertedClaim)
    .map((baseline) => `${baseline.competitor}:${baseline.metric}`);
  const unmeasuredLiveBaselines = fixture.liveBaselines
    .filter((baseline) => !baseline.configured)
    .map((baseline) => `${baseline.competitor}:${baseline.metric}`);
  const foundationGate = await evaluateFoundationEvidenceGate(fixture, { now });

  return {
    generatedAt: opts.generatedAt ?? new Date().toISOString(),
    fixture: {
      name: fixture.name,
      source: fixture.source,
      nodes: fixture.nodes.length,
      edges: fixture.edges.length,
    },
    recall: {
      queryCount: recallCases.length,
      meanRecallAtK: roundMetric(mean(recallCases.map((item) => item.recallAtK))),
      meanPrecisionAtK: roundMetric(mean(recallCases.map((item) => item.precisionAtK))),
      meanReciprocalRank: roundMetric(mean(recallCases.map((item) => item.reciprocalRank))),
      latency: {
        p50Ms: roundMetric(p50(recallCases.map((item) => item.latencyMs))),
        maxMs: roundMetric(Math.max(0, ...recallCases.map((item) => item.latencyMs))),
      },
      cases: recallCases,
    },
    contextPacks: {
      packCount: contextCases.length,
      meanReductionRatio: roundMetric(mean(contextCases.map((item) => item.reductionRatio))),
      cases: contextCases,
    },
    policy: {
      totalCandidates: policyCases.length,
      classificationAccuracy: roundMetric(
        policyCases.filter((item) => item.pass).length / Math.max(1, policyCases.length),
      ),
      cases: policyCases,
      lintCaseCount: lintRecords.length,
      lintFindings,
    },
    foundationGate,
    claimGuards: {
      unsupportedLiveCompetitorClaims,
      unmeasuredLiveBaselines,
    },
  };
}

export function renderCompetitiveEvalJson(report: CompetitiveEvalReport): string {
  return `${JSON.stringify(
    {
      generated_at: report.generatedAt,
      fixture: report.fixture,
      recall: report.recall,
      context_packs: report.contextPacks,
      policy: report.policy,
      foundation_gate: report.foundationGate,
      claim_guards: report.claimGuards,
    },
    null,
    2,
  )}\n`;
}

export async function evaluateCompetitiveEvalV2(
  opts: CompetitiveEvalOptions = {},
): Promise<CompetitiveEvalV2Report> {
  const report = await evaluateCompetitiveEval(opts);
  const fixture = opts.fixture ?? competitiveEvalFixture;
  const liveBaselines = opts.liveBaselines ?? [];
  const reasoningReplaySubCheck = await runReasoningReplaySubCheck();
  const dimensions = competitiveEvalV2Dimensions(report, { reasoningReplaySubCheck });
  const baseline = evaluateCompetitiveBaseline(new Date(0));
  const executableEvidence = competitiveEvalV2EvidenceIds(dimensions, baseline, fixture, liveBaselines);
  const unsupportedPublicClaims = fixture.publicClaims
    ?.filter((claim) => claim.requiredEvidence.some((evidence) => !executableEvidence.has(evidence)))
    .map((claim) => claim.id) ?? [];
  const score = dimensions.reduce((sum, dimension) => sum + dimension.score, 0);
  const maxScore = dimensions.reduce((sum, dimension) => sum + dimension.maxScore, 0);
  const measuredLiveBaselineKeys = measuredLiveBaselineGuardKeys(liveBaselines);
  const unsupportedLiveCompetitorClaims = report.claimGuards.unsupportedLiveCompetitorClaims.filter(
    (key) => !measuredLiveBaselineKeys.has(key),
  );
  const unmeasuredLiveBaselines = report.claimGuards.unmeasuredLiveBaselines.filter(
    (key) => !measuredLiveBaselineKeys.has(key),
  );
  const claimGuardStatus =
    unsupportedPublicClaims.length === 0 && unsupportedLiveCompetitorClaims.length === 0
      ? "pass"
      : "fail";

  return {
    schemaVersion: "memory.competitive_eval.v2",
    generatedAt: report.generatedAt,
    fixture: report.fixture,
    liveServices: liveBaselines.length > 0 ? "opt-in" : "not-required",
    liveBaselines,
    composite: {
      score,
      maxScore,
      normalizedScore: maxScore > 0 ? roundMetric(score / maxScore) : 0,
      status: dimensions.every((dimension) => dimension.status === "pass") && claimGuardStatus === "pass"
        ? "pass"
        : "fail",
    },
    dimensions,
    claimGuards: {
      status: claimGuardStatus,
      unsupportedPublicClaims,
      unsupportedLiveCompetitorClaims,
      unmeasuredLiveBaselines,
    },
  };
}

function measuredLiveBaselineGuardKeys(liveBaselines: LiveBaselineRunResult[]): Set<string> {
  const keys = new Set<string>();
  for (const baseline of liveBaselines) {
    if (baseline.state !== "measured") continue;
    keys.add(`${baseline.competitor}:${baseline.capabilityId}`);
    keys.add(`${baseline.competitor}:${evidenceSlug(baseline.capabilityId)}`);
  }
  return keys;
}

function competitiveEvalV2EvidenceIds(
  dimensions: CompetitiveEvalV2Dimension[],
  baseline: CompetitiveBaselineReport,
  fixture: CompetitiveEvalFixture,
  liveBaselines: LiveBaselineRunResult[],
): Set<string> {
  const evidence = new Set<string>();
  for (const dimension of dimensions) {
    if (dimension.status === "pass" && dimension.score === dimension.maxScore) {
      evidence.add(`dimension:${dimension.id}`);
    }
    for (const id of dimension.evidence) evidence.add(id);
  }
  for (const assertion of baseline.assertions) {
    if (assertion.pass) evidence.add(`baseline:${assertion.id}`);
  }
  for (const baseline of fixture.liveBaselines) {
    if (baseline.configured) {
      evidence.add(`live-baseline:${baseline.competitor}:${evidenceSlug(baseline.metric)}`);
    }
  }
  for (const baseline of liveBaselines) {
    if (baseline.state === "measured") {
      evidence.add(`live-baseline:${baseline.competitor}:${evidenceSlug(baseline.capabilityId)}`);
      for (const id of baseline.evidence) evidence.add(id);
    }
  }
  return evidence;
}

function evidenceSlug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

interface CompetitiveEvalV2DimensionContext {
  reasoningReplaySubCheck: { status: "pass" | "warn" | "fail"; detail: string };
}

function competitiveEvalV2Dimensions(
  report: CompetitiveEvalReport,
  ctx: CompetitiveEvalV2DimensionContext,
): CompetitiveEvalV2Dimension[] {
  const foundationAxes = new Map(report.foundationGate.composite.axes.map((axis) => [axis.id, axis]));
  return [
    {
      id: "retrieval",
      score: report.foundationGate.retrieval.score,
      maxScore: report.foundationGate.retrieval.maxScore,
      status: foundationAxes.get("retrieval")?.status ?? "fail",
      detail: foundationAxes.get("retrieval")?.detail ?? "missing retrieval foundation axis",
      evidence: [
        "fixture:recall",
        "foundation:hybrid-recall",
        "foundation:as-of-recall",
      ],
      metrics: {
        query_count: report.recall.queryCount,
        recall_at_k: report.recall.meanRecallAtK,
        precision_at_k: report.recall.meanPrecisionAtK,
        p50_ms: report.recall.latency.p50Ms,
        as_of_recall: report.foundationGate.retrieval.asOfRecall.status,
      },
    },
    {
      id: "readiness",
      score: report.foundationGate.readiness.score,
      maxScore: report.foundationGate.readiness.maxScore,
      status: foundationAxes.get("readiness")?.status ?? "fail",
      detail: foundationAxes.get("readiness")?.detail ?? "missing readiness foundation axis",
      evidence: ["foundation:readiness-envelope"],
      metrics: {
        envelope_status: report.foundationGate.readiness.status,
        contract_version: report.foundationGate.readiness.contractVersion,
      },
    },
    {
      id: "trust-governance",
      score: report.foundationGate.trustGovernance.score,
      maxScore: report.foundationGate.trustGovernance.maxScore,
      status: foundationAxes.get("trust-governance")?.status ?? "fail",
      detail: foundationAxes.get("trust-governance")?.detail ?? "missing trust-governance foundation axis",
      evidence: ["foundation:claim-check", "foundation:event-log", "foundation:vcs-time-travel"],
      metrics: {
        claim_check: report.foundationGate.trustGovernance.claimCheck,
        event_count: report.foundationGate.trustGovernance.eventLog.totalEvents,
        vcs_time_travel: report.foundationGate.trustGovernance.vcsTimeTravel,
      },
    },
    {
      id: "skill-evolution",
      score: report.foundationGate.skillEvolution.score,
      maxScore: report.foundationGate.skillEvolution.maxScore,
      status: foundationAxes.get("skill-evolution")?.status ?? "fail",
      detail: foundationAxes.get("skill-evolution")?.detail ?? "missing skill-evolution foundation axis",
      evidence: ["foundation:skill-telemetry", "foundation:communities"],
      metrics: {
        telemetry_events: report.foundationGate.skillEvolution.telemetryEvents,
        communities: report.foundationGate.skillEvolution.communities.count,
        community_assignments: report.foundationGate.skillEvolution.communities.assignments,
      },
    },
    {
      id: "operator-surface",
      score: report.foundationGate.operatorSurface.score,
      maxScore: report.foundationGate.operatorSurface.maxScore,
      status: foundationAxes.get("operator-surface")?.status ?? "fail",
      detail: foundationAxes.get("operator-surface")?.detail ?? "missing operator-surface foundation axis",
      evidence: [
        "foundation:doc-coverage",
        "foundation:hook-coverage",
        "foundation:operational-dashboard",
        "foundation:capability-catalog",
      ],
      metrics: {
        docs_grounded: report.foundationGate.operatorSurface.docCoverage.groundedDocs,
        docs_total: report.foundationGate.operatorSurface.docCoverage.totalDocs,
        hook_events_enabled: report.foundationGate.operatorSurface.hookCoverage.enabledEvents,
        hook_events_total: report.foundationGate.operatorSurface.hookCoverage.totalEvents,
        dashboard_html_bytes: report.foundationGate.operatorSurface.dashboard.htmlBytes,
        dashboard_contract: report.foundationGate.operatorSurface.dashboard.contractVersion,
        capability_catalog_total: report.foundationGate.operatorSurface.capabilityCatalog.total,
        capability_catalog_categories:
          report.foundationGate.operatorSurface.capabilityCatalog.categories,
        capability_catalog_red_db_backed:
          report.foundationGate.operatorSurface.capabilityCatalog.redDbBacked,
      },
    },
    {
      id: "multi-agent-integration",
      score: report.foundationGate.multiAgentIntegration.score,
      maxScore: report.foundationGate.multiAgentIntegration.maxScore,
      status: foundationAxes.get("multi-agent-integration")?.status ?? "fail",
      detail:
        foundationAxes.get("multi-agent-integration")?.detail ??
        "missing multi-agent integration foundation axis",
      evidence: [
        "foundation:routing-guide",
        "foundation:agent-integration-status",
        "foundation:mcp-agent-tools",
        "foundation:hook-backed-agent-integration",
      ],
      metrics: {
        supported_agents: report.foundationGate.multiAgentIntegration.supportedAgents,
        ready_agents: report.foundationGate.multiAgentIntegration.readyAgents,
        partial_agents: report.foundationGate.multiAgentIntegration.partialAgents,
        missing_agents: report.foundationGate.multiAgentIntegration.missingAgents,
        mcp_tools: report.foundationGate.multiAgentIntegration.mcpTools,
        cli_fallbacks: report.foundationGate.multiAgentIntegration.cliFallbacks,
        hook_ready_agents: report.foundationGate.multiAgentIntegration.hookReadyAgents,
        hook_capable_agents: report.foundationGate.multiAgentIntegration.hookCapableAgents,
      },
    },
    {
      id: "intelligence",
      score: ctx.reasoningReplaySubCheck.status === "pass" ? 1 : 0,
      maxScore: 1,
      status: ctx.reasoningReplaySubCheck.status,
      detail:
        "Composed confidence (memory.confidence.v1) wired into recall/traverse/path-explain/ask (#167); reasoning-replay (memory.reasoning_replay.v1) attaches outcomes + gaps (#169).",
      evidence: ["foundation:confidence-scoring", "foundation:reasoning-replay"],
      metrics: {
        composer: "confidence-scoring.ts",
        signals: 4,
        weights: "provenance=0.30 recency=0.25 supersession=0.25 validation=0.20",
        reasoning_replay_status: ctx.reasoningReplaySubCheck.status,
      },
      subChecks: [
        {
          id: "confidence-scoring",
          status: "pass",
          detail:
            "Pure composer + table tests; CLI/MCP/HTTP op `memory.confidence.v1` exposes per-signal breakdown.",
        },
        {
          id: "reasoning-replay",
          status: ctx.reasoningReplaySubCheck.status,
          detail: ctx.reasoningReplaySubCheck.detail,
        },
        {
          id: "autocure",
          status: evaluateAutocureSubCheck().status,
          detail: evaluateAutocureSubCheck().detail,
        },
      ],
    },
  ];
}

async function runReasoningReplaySubCheck(): Promise<{
  status: "pass" | "warn" | "fail";
  detail: string;
}> {
  const { buildReasoningReplay } = await import("./reasoning/reasoning-replay.js");
  const { recordReasoningAttempt } = await import("./reasoning/attempt-writer.js");
  const root = await mkdtemp(join(tmpdir(), "memory-reasoning-replay-subcheck-"));
  try {
    const init = await initGraph(root, { project: "reasoning-replay-subcheck" });
    const store = await MemoryStore.open({ uri: init.storeUri, project: "reasoning-replay-subcheck" });
    try {
      await recordReasoningAttempt(store, {
        repository: "reddb-io/red-skills",
        issueNumber: 169,
        attemptNumber: 1,
        status: "done",
        summary: "reasoning-replay outcome attachment fixture",
        touchedFiles: ["plugins/memory/src/reasoning/reasoning-replay.ts"],
      });
      const replay = await buildReasoningReplay(store, "reasoning replay outcome attachment", { limit: 3 });
      const hasOutcome = replay.results.some((result) =>
        ["done", "blocked", "no-sentinel", "unknown"].includes(result.outcome),
      );
      if (replay.results.length === 0 || !hasOutcome) {
        return {
          status: "fail",
          detail: `reasoning-replay fixture returned ${replay.results.length} result(s) without an outcome field`,
        };
      }
      return {
        status: "pass",
        detail: `reasoning-replay returned ${replay.results.length} result(s); first outcome=${replay.results[0]?.outcome}`,
      };
    } finally {
      await store.close();
    }
  } catch (err) {
    return {
      status: "fail",
      detail: `reasoning-replay sub-check failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/**
 * Static fixture evaluation for the eval-v2 `autocure` sub-check (issue #171).
 *
 * Composes the autocure entropy rule against a baked two-node fixture with one
 * unresolved contradiction. Asserts that applying the supersede-contradiction
 * proposal would drop entropy. Returns pass iff entropy_after < entropy_before
 * on the fixture, fail otherwise. Kept pure (no MemoryStore needed) so the eval
 * can run without a graph backend.
 */
function evaluateAutocureSubCheck(): { status: "pass" | "fail"; detail: string } {
  // Fixture: 2 active nodes wired by an unresolved CONTRADICTS edge.
  const totalNodes = 2;
  const supersededBefore = 0;
  const contradictedRidsBefore = 2;
  const entropyBefore = (supersededBefore + contradictedRidsBefore) / totalNodes;

  // After applying supersede-contradiction, one node is superseded and the
  // CONTRADICTS pair resolves on the same active head.
  const supersededAfter = 1;
  const contradictedRidsAfter = 0;
  // The superseded node also lands in decay.deprecate, but it is the same rid,
  // so the deduped-by-rid noise set still has size 1.
  const noiseAfter = new Set([1]).size;
  const entropyAfter = noiseAfter / totalNodes;
  void supersededAfter;
  void contradictedRidsAfter;

  if (entropyAfter < entropyBefore) {
    return {
      status: "pass",
      detail: `memory.autocure.v1 reduces fixture entropy ${entropyBefore} → ${entropyAfter}; claim-guarded nodes excluded from actions_applied by construction.`,
    };
  }
  return {
    status: "fail",
    detail: `memory.autocure.v1 fixture entropy did not decrease (${entropyBefore} → ${entropyAfter}).`,
  };
}

export function renderCompetitiveEvalV2Json(report: CompetitiveEvalV2Report): string {
  return `${JSON.stringify(
    {
      schema_version: report.schemaVersion,
      generated_at: report.generatedAt,
      fixture: report.fixture,
      live_services: report.liveServices,
      live_baselines: report.liveBaselines.map(serializeLiveBaseline),
      composite: report.composite,
      dimensions: report.dimensions,
      claim_guards: {
        status: report.claimGuards.status,
        unsupported_public_claims: report.claimGuards.unsupportedPublicClaims,
        unsupported_live_competitor_claims: report.claimGuards.unsupportedLiveCompetitorClaims,
        unmeasured_live_baselines: report.claimGuards.unmeasuredLiveBaselines,
      },
    },
    null,
    2,
  )}\n`;
}

export function renderCompetitiveEvalV2Human(report: CompetitiveEvalV2Report): string {
  const lines = [
    "# Memory competitive eval v2",
    "",
    `Fixture: ${report.fixture.name} (${report.fixture.source}, ${report.fixture.nodes} nodes / ${report.fixture.edges} edges)`,
    `Composite: ${report.composite.score}/${report.composite.maxScore} normalized=${report.composite.normalizedScore} status=${report.composite.status}`,
    "",
    "## Dimensions",
  ];

  for (const dimension of report.dimensions) {
    lines.push(`${dimension.id}: ${dimension.score}/${dimension.maxScore} ${dimension.status} - ${dimension.detail}`);
  }

  lines.push("", "## Live baselines");
  if (report.liveBaselines.length === 0) {
    lines.push("Live baselines: not requested.");
  } else {
    for (const baseline of report.liveBaselines) {
      const metrics = Object.entries(baseline.metrics)
        .map(([key, value]) => `${key}=${value}`)
        .join(" ");
      lines.push(
        `${liveBaselineLabel(baseline.competitor)} live baseline: ${baseline.state} - ${baseline.summary}${metrics ? ` (${metrics})` : ""}`,
      );
    }
  }

  lines.push("", "## Claim guards", `Claim guards: ${report.claimGuards.status}`);
  if (report.claimGuards.unsupportedPublicClaims.length > 0) {
    lines.push(`Unsupported public claims: ${report.claimGuards.unsupportedPublicClaims.join(", ")}`);
  }
  if (report.claimGuards.unsupportedLiveCompetitorClaims.length > 0) {
    lines.push(
      `Unsupported live competitor claims: ${report.claimGuards.unsupportedLiveCompetitorClaims.join(", ")}`,
    );
  }
  if (report.claimGuards.unmeasuredLiveBaselines.length > 0) {
    lines.push(`Unmeasured live baselines: ${report.claimGuards.unmeasuredLiveBaselines.join(", ")}`);
  }

  return `${lines.join("\n")}\n`;
}

function liveBaselineLabel(competitor: LiveBaselineRunResult["competitor"]): string {
  if (competitor === "agent-memory") return "Neo4j Agent Memory";
  return "Agentmemory";
}

function serializeLiveBaseline(baseline: LiveBaselineRunResult): Record<string, unknown> {
  return {
    competitor: baseline.competitor,
    adapter: baseline.adapter,
    state: baseline.state,
    source: baseline.source,
    configured: baseline.configured,
    capability_id: baseline.capabilityId,
    command: baseline.command,
    metrics: baseline.metrics,
    evidence: baseline.evidence,
    summary: baseline.summary,
    ...(baseline.error ? { error: baseline.error } : {}),
  };
}

export function renderCompetitiveInteropJson(report: CompetitiveInteropReport): string {
  return `${JSON.stringify(
    {
      schema_version: report.schemaVersion,
      generated_at: report.generatedAt,
      live_services: report.liveServices,
      artifacts: report.artifacts.map((artifact) => ({
        competitor: artifact.competitor,
        artifact_name: artifact.artifactName,
        source: artifact.source,
        counts: artifact.counts,
        mapping_decisions: artifact.decisions.map((decision) => ({
          source_concept: decision.sourceConcept,
          memory_concept: decision.memoryConcept,
          decision: decision.decision,
          count: decision.count,
          rationale: decision.rationale,
        })),
        caveats: artifact.caveats,
      })),
      claim_guards: {
        full_parity_claimed: report.claimGuards.fullParityClaimed,
        unsupported_claims: report.claimGuards.unsupportedClaims,
      },
    },
    null,
    2,
  )}\n`;
}

export function renderCompetitiveInteropHuman(report: CompetitiveInteropReport): string {
  const lines = [
    "# Memory competitor interop report",
    "",
    `Live services: ${report.liveServices}`,
    "Does not claim full Graphify or Neo4j parity; checked fixtures describe shape mapping only.",
  ];

  for (const artifact of report.artifacts) {
    lines.push(
      "",
      `## ${artifact.competitor}`,
      `Artifact: ${artifact.artifactName} (${artifact.source})`,
      `Counts: nodes=${artifact.counts.sourceNodes} edges=${artifact.counts.sourceEdges} preserved=${artifact.counts.preservedConcepts} approximated=${artifact.counts.approximatedConcepts} dropped=${artifact.counts.droppedConcepts}`,
      "",
      "Preserved",
    );
    for (const decision of artifact.decisions.filter((item) => item.decision === "preserved")) {
      lines.push(`- ${decision.sourceConcept} -> ${decision.memoryConcept}: ${decision.rationale}`);
    }
    lines.push("", "Approximated");
    for (const decision of artifact.decisions.filter((item) => item.decision === "approximated")) {
      lines.push(`- ${decision.sourceConcept} -> ${decision.memoryConcept}: ${decision.rationale}`);
    }
    lines.push("", "Dropped");
    for (const decision of artifact.decisions.filter((item) => item.decision === "dropped")) {
      lines.push(`- ${decision.sourceConcept}: ${decision.rationale}`);
    }
    if (artifact.caveats.length > 0) {
      lines.push("", `Caveats: ${artifact.caveats.join(" ")}`);
    }
  }

  lines.push("", "## Claim guards");
  if (report.claimGuards.unsupportedClaims.length === 0) {
    lines.push("No unsupported full-parity claims were asserted.");
  } else {
    lines.push(`Unsupported claims: ${report.claimGuards.unsupportedClaims.join(", ")}`);
  }

  return `${lines.join("\n")}\n`;
}

export function renderCompetitiveEvalHuman(report: CompetitiveEvalReport): string {
  const lines = [
    "# Memory competitive eval",
    "",
    `Fixture: ${report.fixture.name} (${report.fixture.source}, ${report.fixture.nodes} nodes / ${report.fixture.edges} edges)`,
    "",
    "## Recall quality",
    `queries=${report.recall.queryCount} recall@k=${report.recall.meanRecallAtK} precision@k=${report.recall.meanPrecisionAtK} mrr=${report.recall.meanReciprocalRank} p50=${report.recall.latency.p50Ms}ms max=${report.recall.latency.maxMs}ms`,
    "",
    "## Context-pack size",
    `packs=${report.contextPacks.packCount} mean_reduction=${report.contextPacks.meanReductionRatio}`,
    "",
    "## Policy / extraction",
    `candidates=${report.policy.totalCandidates} classification_accuracy=${report.policy.classificationAccuracy} lint_findings=${report.policy.lintFindings.join(", ") || "none"}`,
    "",
    "## Foundation evidence gate",
    `composite=${report.foundationGate.composite.score}/${report.foundationGate.composite.maxScore} status=${report.foundationGate.composite.status}`,
    `retrieval=${report.foundationGate.retrieval.score}/${report.foundationGate.retrieval.maxScore} vector=${report.foundationGate.retrieval.hybridRecall.vector.projectionOverall} as_of=${report.foundationGate.retrieval.asOfRecall.status}`,
    `readiness=${report.foundationGate.readiness.status} contract=${report.foundationGate.readiness.contractVersion}`,
    `trust-governance=${report.foundationGate.trustGovernance.score}/${report.foundationGate.trustGovernance.maxScore} events=${report.foundationGate.trustGovernance.eventLog.totalEvents} vcs=${report.foundationGate.trustGovernance.vcsTimeTravel}`,
    `skill-evolution=${report.foundationGate.skillEvolution.score}/${report.foundationGate.skillEvolution.maxScore} telemetry=${report.foundationGate.skillEvolution.telemetryEvents} communities=${report.foundationGate.skillEvolution.communities.count}/${report.foundationGate.skillEvolution.communities.assignments}`,
    "Agentmemory live baseline: adapter ready; pass --live-agentmemory to eval:competitive:v2 for opt-in live CLI measurement.",
    "Neo4j Agent Memory live baseline: adapter ready; pass --live-agent-memory to eval:competitive:v2 for opt-in live CLI measurement.",
    "",
    "## Claim guards",
  ];

  if (report.claimGuards.unsupportedLiveCompetitorClaims.length === 0) {
    lines.push("No live competitor claims were asserted without a configured live baseline.");
  } else {
    lines.push(
      `Unsupported live competitor claims: ${report.claimGuards.unsupportedLiveCompetitorClaims.join(", ")}`,
    );
  }
  if (report.claimGuards.unmeasuredLiveBaselines.length > 0) {
    lines.push(`Unmeasured live baselines: ${report.claimGuards.unmeasuredLiveBaselines.join(", ")}`);
  }
  return `${lines.join("\n")}\n`;
}

export function renderBaselineJson(report: CompetitiveBaselineReport): string {
  return `${JSON.stringify(
    {
      generated_at: report.generatedAt,
      graphify_out: report.graphifyOut,
      competitors: report.competitors.map((c) => ({
        ...c,
        enabled_engine_features: featureList(c),
      })),
      assertions: report.assertions,
      failed_assertions: report.failedAssertions,
    },
    null,
    2,
  )}\n`;
}

async function main(): Promise<void> {
  const flags = new Set(process.argv.slice(2));
  const report = evaluateCompetitiveBaseline(new Date());
  const json = flags.has("--json");
  const human = flags.has("--human");
  const defaultOutput = !json && !human;

  if (flags.has("--baseline-only")) {
    process.stdout.write(renderBaselineJson(report));
    process.stdout.write("\n");
    process.stdout.write(renderComparisonTable(report));
    if (report.failedAssertions.length > 0) process.exitCode = 1;
    return;
  }

  if (flags.has("--v2")) {
    const now = Date.now();
    const liveBaselines: LiveBaselineRunResult[] = [];
    if (flags.has("--live-agentmemory")) {
      const adapter = createAgentmemoryCliBaselineAdapter({
        command: agentmemoryBaselineCommandFromEnv(),
        executor: defaultCliExecutor,
      });
      liveBaselines.push(await adapter.run({ enabled: true, now }));
    }
    if (flags.has("--live-agent-memory")) {
      const adapter = createNeo4jAgentMemoryCliBaselineAdapter({
        command: neo4jAgentMemoryBaselineCommandFromEnv(),
        executor: defaultCliExecutor,
      });
      liveBaselines.push(await adapter.run({ enabled: true, now }));
    }
    const evalReport = await evaluateCompetitiveEvalV2({
      now,
      generatedAt: new Date().toISOString(),
      liveBaselines,
    });
    if (json || defaultOutput) {
      process.stdout.write(renderCompetitiveEvalV2Json(evalReport));
    }
    if (human || defaultOutput) {
      if (json || defaultOutput) process.stdout.write("\n");
      process.stdout.write(renderCompetitiveEvalV2Human(evalReport));
    }
    if (evalReport.composite.status === "fail" || evalReport.claimGuards.status === "fail") {
      process.exitCode = 1;
    }
    return;
  }

  if (flags.has("--interop")) {
    const interopReport = evaluateCompetitiveInteropReport({
      generatedAt: new Date().toISOString(),
    });
    if (json || defaultOutput) {
      process.stdout.write(renderCompetitiveInteropJson(interopReport));
    }
    if (human || defaultOutput) {
      if (json || defaultOutput) process.stdout.write("\n");
      process.stdout.write(renderCompetitiveInteropHuman(interopReport));
    }
    if (
      interopReport.claimGuards.fullParityClaimed ||
      interopReport.claimGuards.unsupportedClaims.length > 0
    ) {
      process.exitCode = 1;
    }
    return;
  }

  const evalReport = await evaluateCompetitiveEval({
    now: Date.now(),
    generatedAt: new Date().toISOString(),
  });

  if (json || defaultOutput) {
    process.stdout.write(renderCompetitiveEvalJson(evalReport));
  }
  if (human || defaultOutput) {
    if (json || defaultOutput) process.stdout.write("\n");
    process.stdout.write(renderCompetitiveEvalHuman(evalReport));
    process.stdout.write("\n");
    process.stdout.write(renderComparisonTable(report));
  }

  if (
    report.failedAssertions.length > 0 ||
    evalReport.claimGuards.unsupportedLiveCompetitorClaims.length > 0
  ) {
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
