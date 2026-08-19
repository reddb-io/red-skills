import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import {
  evaluateCompetitiveBaseline,
  graphifyOutSummary,
  renderBaselineJson,
  renderComparisonTable,
} from "./competitive-baseline/baseline.js";
import { evaluateCompetitiveEval, renderCompetitiveEvalHuman, renderCompetitiveEvalJson } from "./competitive-baseline/eval.js";
import {
  evaluateCompetitiveEvalV2,
  renderCompetitiveEvalV2Human,
  renderCompetitiveEvalV2Json,
} from "./competitive-baseline/eval-v2.js";
import {
  evaluateCompetitiveInteropReport,
  renderCompetitiveInteropHuman,
  renderCompetitiveInteropJson,
} from "./competitive-baseline/interop.js";
import {
  agentmemoryBaselineCommandFromEnv,
  createAgentmemoryCliBaselineAdapter,
  createNeo4jAgentMemoryCliBaselineAdapter,
  defaultCliExecutor,
  neo4jAgentMemoryBaselineCommandFromEnv,
  type LiveBaselineRunResult,
} from "./live-baseline-adapters.js";

export type {
  BaselineAssertion,
  ComparisonRow,
  CompetitiveBaselineReport,
  CompetitiveEvalContextPackCase,
  CompetitiveEvalOptions,
  CompetitiveEvalPolicyCase,
  CompetitiveEvalRecallCase,
  CompetitiveEvalReport,
  CompetitiveEvalV2Dimension,
  CompetitiveEvalV2Report,
  CompetitiveInteropArtifactReport,
  CompetitiveInteropMappingDecision,
  CompetitiveInteropOptions,
  CompetitiveInteropReport,
  CompetitorBaseline,
  FoundationEvidenceGateReport,
  FoundationGateAxis,
  GraphifyOutSummary,
} from "./competitive-baseline/types.js";

export {
  evaluateCompetitiveBaseline,
  evaluateCompetitiveEval,
  evaluateCompetitiveEvalV2,
  evaluateCompetitiveInteropReport,
  graphifyOutSummary,
  renderBaselineJson,
  renderComparisonTable,
  renderCompetitiveEvalHuman,
  renderCompetitiveEvalJson,
  renderCompetitiveEvalV2Human,
  renderCompetitiveEvalV2Json,
  renderCompetitiveInteropHuman,
  renderCompetitiveInteropJson,
};

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

if (isCompetitiveBaselineEntrypoint()) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}

function isCompetitiveBaselineEntrypoint(): boolean {
  const entrypoint = process.argv[1];
  if (!entrypoint) return false;
  const entryName = basename(entrypoint);
  if (
    entryName !== "competitive-baseline.ts" &&
    entryName !== "competitive-baseline.js" &&
    entryName !== "competitive-baseline.mjs"
  ) {
    return false;
  }
  return import.meta.url === pathToFileURL(entrypoint).href;
}
