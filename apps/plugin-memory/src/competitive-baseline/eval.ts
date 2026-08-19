import { performance } from "node:perf_hooks";
import { buildContextPack } from "../context-pack.js";
import { competitiveEvalFixture } from "../competitive-fixtures.js";
import { recall } from "../engine.js";
import { lintMemoryRecords, type LintMemoryRecord } from "../lint.js";
import { classifyCandidateMemory } from "../store-classifier.js";
import { evaluateFoundationEvidenceGate } from "./foundation-gate.js";
import { FixtureRecallStore, mean, p50, rawCorpusChars, roundMetric } from "./shared.js";
import type {
  CompetitiveEvalContextPackCase,
  CompetitiveEvalOptions,
  CompetitiveEvalPolicyCase,
  CompetitiveEvalRecallCase,
  CompetitiveEvalReport,
} from "./types.js";

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

export function renderCompetitiveEvalHuman(report: CompetitiveEvalReport): string {
  const lines = [
    "# Memory reference eval",
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
    "Agentmemory live baseline: adapter ready; pass --live-agentmemory to references:eval:v2 for opt-in live CLI measurement.",
    "Neo4j Agent Memory live baseline: adapter ready; pass --live-agent-memory to references:eval:v2 for opt-in live CLI measurement.",
    "",
    "## Claim guards",
  ];

  if (report.claimGuards.unsupportedLiveCompetitorClaims.length === 0) {
    lines.push("No live reference claims were asserted without a configured live baseline.");
  } else {
    lines.push(
      `Unsupported live reference claims: ${report.claimGuards.unsupportedLiveCompetitorClaims.join(", ")}`,
    );
  }
  if (report.claimGuards.unmeasuredLiveBaselines.length > 0) {
    lines.push(`Unmeasured live baselines: ${report.claimGuards.unmeasuredLiveBaselines.join(", ")}`);
  }
  return `${lines.join("\n")}\n`;
}
