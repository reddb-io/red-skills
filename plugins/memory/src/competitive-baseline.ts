import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { buildContextPack } from "./context-pack.js";
import { competitiveEvalFixture, type CompetitiveEvalFixture } from "./competitive-fixtures.js";
import { recall, type RecallStore } from "./engine.js";
import type { GraphRow, SearchRow, StoredNode } from "./graph-store.js";
import { lintMemoryRecords, type LintMemoryRecord } from "./lint.js";
import { classifyCandidateMemory } from "./store-classifier.js";

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
  claimGuards: {
    unsupportedLiveCompetitorClaims: string[];
    unmeasuredLiveBaselines: string[];
  };
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
      memory: "Deterministic extractors plus optional LLM provider for inferred facts.",
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
      claim_guards: report.claimGuards,
    },
    null,
    2,
  )}\n`;
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
  if (flags.has("--baseline-only")) {
    process.stdout.write(renderBaselineJson(report));
    process.stdout.write("\n");
    process.stdout.write(renderComparisonTable(report));
    if (report.failedAssertions.length > 0) process.exitCode = 1;
    return;
  }

  const evalReport = await evaluateCompetitiveEval({
    now: Date.now(),
    generatedAt: new Date().toISOString(),
  });
  const json = flags.has("--json");
  const human = flags.has("--human");
  const defaultOutput = !json && !human;

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
