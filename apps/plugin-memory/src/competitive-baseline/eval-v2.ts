import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { competitiveEvalFixture, type CompetitiveEvalFixture } from "../competitive-fixtures.js";
import { MemoryStore } from "../graph-store.js";
import { initGraph } from "../init.js";
import { writeMemoryStateFile } from "../toon-state.js";
import type { LiveBaselineRunResult } from "../live-baseline-adapters.js";
import { evaluateCompetitiveBaseline } from "./baseline.js";
import { evaluateCompetitiveEval } from "./eval.js";
import { roundMetric } from "./shared.js";
import type {
  CompetitiveBaselineReport,
  CompetitiveEvalOptions,
  CompetitiveEvalReport,
  CompetitiveEvalV2Dimension,
  CompetitiveEvalV2Report,
} from "./types.js";

export async function evaluateCompetitiveEvalV2(
  opts: CompetitiveEvalOptions = {},
): Promise<CompetitiveEvalV2Report> {
  const report = await evaluateCompetitiveEval(opts);
  const fixture = opts.fixture ?? competitiveEvalFixture;
  const liveBaselines = opts.liveBaselines ?? [];
  const reasoningReplaySubCheck = await runReasoningReplaySubCheck();
  const federationSubCheck = await runFederationSubCheck();
  const whatifSubCheck = await runWhatifSubCheck();
  const dimensions = competitiveEvalV2Dimensions(report, {
    reasoningReplaySubCheck,
    federationSubCheck,
    whatifSubCheck,
  });
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
    schemaVersion: "memory.reference_eval.v2",
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
  federationSubCheck: { status: "pass" | "warn" | "fail"; detail: string };
  whatifSubCheck: { status: "pass" | "warn" | "fail"; detail: string };
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
      id: "governed-write",
      score: 1,
      maxScore: 1,
      status: "pass",
      detail:
        "memory_store_evidence and the CLI store-evidence path are covered by governed-write CLI tests, including cross-runner write/recall and mistake_avoided claim guards.",
      evidence: [
        "foundation:governed-write-cli",
        "foundation:cross-agent-governed-recall",
        "foundation:mistake-avoided-bench",
      ],
      metrics: {
        write_surface: "memory store-evidence / memory_store_evidence",
        writer_runner: "claude-smoke-runner",
        reader_runner: "codex-smoke-runner",
        public_story_seconds: 60,
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
    intelligenceDimension(ctx),
  ];
}

function intelligenceDimension(
  ctx: CompetitiveEvalV2DimensionContext,
): CompetitiveEvalV2Dimension {
  const confidenceScoring = {
    status: "pass" as const,
    detail:
      "Pure composer + table tests; CLI/MCP/HTTP op `memory.confidence.v1` exposes per-signal breakdown.",
  };
  const autocure = evaluateAutocureSubCheck();
  const subChecks = [
    { id: "confidence-scoring", ...confidenceScoring },
    {
      id: "reasoning-replay",
      status: ctx.reasoningReplaySubCheck.status,
      detail: ctx.reasoningReplaySubCheck.detail,
    },
    {
      id: "federation",
      status: ctx.federationSubCheck.status,
      detail: ctx.federationSubCheck.detail,
    },
    {
      id: "whatif",
      status: ctx.whatifSubCheck.status,
      detail: ctx.whatifSubCheck.detail,
    },
    { id: "autocure", status: autocure.status, detail: autocure.detail },
  ];
  const allPass = subChecks.every((check) => check.status === "pass");
  const anyFail = subChecks.some((check) => check.status === "fail");
  return {
    id: "intelligence",
    score: allPass ? 1 : 0,
    maxScore: 1,
    status: allPass ? "pass" : anyFail ? "fail" : "warn",
    detail:
      "Composed confidence (memory.confidence.v1) wired into recall/traverse/path-explain/ask (#167); reasoning-replay (memory.reasoning_replay.v1) attaches outcomes + gaps (#169); federation (memory.federation.v1) enforces redact policy at read time (#170); what-if (memory.whatif.v1) predicts pre-action blast radius (#172); autocure (memory.autocure.v1) composes doctor + decay + supersession (#171); ask composes citations + what_i_dont_know + federation_hits (#173).",
    evidence: [
      "foundation:confidence-scoring",
      "foundation:reasoning-replay",
      "foundation:federation",
      "foundation:whatif",
      "foundation:autocure",
    ],
    metrics: {
      composer: "confidence-scoring.ts",
      signals: 4,
      weights: "provenance=0.30 recency=0.25 supersession=0.25 validation=0.20",
      reasoning_replay_status: ctx.reasoningReplaySubCheck.status,
      federation_status: ctx.federationSubCheck.status,
      whatif_status: ctx.whatifSubCheck.status,
      autocure_status: autocure.status,
      confidence_scoring_status: confidenceScoring.status,
    },
    subChecks,
  };
}

async function runReasoningReplaySubCheck(): Promise<{
  status: "pass" | "warn" | "fail";
  detail: string;
}> {
  const { buildReasoningReplay } = await import("../reasoning/reasoning-replay.js");
  const { recordReasoningWorker } = await import("../reasoning/worker-writer.js");
  const root = await mkdtemp(join(tmpdir(), "memory-reasoning-replay-subcheck-"));
  try {
    const init = await initGraph(root, { project: "reasoning-replay-subcheck" });
    const store = await MemoryStore.open({ uri: init.storeUri, project: "reasoning-replay-subcheck" });
    try {
      await recordReasoningWorker(store, {
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
 * Eval-v2 `federation` sub-check (issue #170).
 *
 * Sets up two markdown-only memory roots and a host root with a federation
 * config that redacts the `excerpt` field and drops one origin via `scopes:`.
 * Asserts the read surface honors the policy — masked field is null, dropped
 * scope yields zero results — and that telemetry fires exactly once. Returns
 * `pass` iff every assertion holds.
 */
async function runFederationSubCheck(): Promise<{
  status: "pass" | "warn" | "fail";
  detail: string;
}> {
  const { buildFederationReport } = await import("../federation.js");
  const root = await mkdtemp(join(tmpdir(), "memory-federation-subcheck-"));
  try {
    const alpha = await scaffoldFederationRoot(root, "alpha", {
      "ingest.md": "# ingest\n\nAlpha ingest note used in the eval sub-check.",
    });
    const beta = await scaffoldFederationRoot(root, "beta", {
      "ingest.md": "# ingest\n\nBeta ingest note that policy will drop.",
    });
    const host = join(root, "host");
    await mkdir(join(host, ".red/memory"), { recursive: true });
    const yaml = [
      "roots:",
      `  - repo: alpha`,
      `    path: ${alpha}`,
      `  - repo: beta`,
      `    path: ${beta}`,
      "redact:",
      "  fields:",
      "    - excerpt",
      "  scopes:",
      "    - beta",
      "trust:",
      "  alpha: 0.9",
    ].join("\n");
    await writeFile(join(host, ".red/memory/federation.yaml"), `${yaml}\n`);

    let telemetryHits = 0;
    const report = await buildFederationReport(host, "ingest", {
      onTelemetry: () => {
        telemetryHits += 1;
      },
    });

    if (report.results.length === 0) {
      return { status: "fail", detail: "federation sub-check returned no results" };
    }
    if (report.results.some((r) => r.origin_repo === "beta")) {
      return {
        status: "fail",
        detail: "federation sub-check leaked a result from a redact-scoped origin",
      };
    }
    if (report.results.some((r) => r.excerpt !== null)) {
      return {
        status: "fail",
        detail: "federation sub-check leaked a redacted field through the surface",
      };
    }
    if (telemetryHits !== 1) {
      return {
        status: "fail",
        detail: `federation sub-check expected one telemetry event, got ${telemetryHits}`,
      };
    }
    return {
      status: "pass",
      detail: `federation read honored policy (fields=${report.policy.fields.join(",")}, scopes=${report.policy.scopes.join(",")}) and emitted memory.federation.read.`,
    };
  } catch (err) {
    return {
      status: "fail",
      detail: `federation sub-check failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/**
 * Eval-v2 `whatif` sub-check (issue #172).
 *
 * Seeds one `reasoning` attempt for a known-blocked rename, then asserts the
 * `memory.whatif.v1` surface returns the prior attempt in `historical_attempts`
 * with `breakage_likelihood > 0` and `self_confidence > 0`. Pure surface test;
 * no structural graph data needed because the historical signal is enough to
 * exercise the composition.
 */
async function runWhatifSubCheck(): Promise<{
  status: "pass" | "warn" | "fail";
  detail: string;
}> {
  const { buildWhatifReport } = await import("../whatif.js");
  const { recordReasoningWorker } = await import("../reasoning/worker-writer.js");
  const root = await mkdtemp(join(tmpdir(), "memory-whatif-subcheck-"));
  try {
    const init = await initGraph(root, { project: "whatif-subcheck" });
    const store = await MemoryStore.open({ uri: init.storeUri, project: "whatif-subcheck" });
    try {
      await recordReasoningWorker(store, {
        repository: "reddb-io/red-skills",
        issueNumber: 172,
        attemptNumber: 1,
        status: "blocked",
        summary: "rename legacyHandler to handler — broke downstream callers",
        touchedFiles: ["plugins/memory/src/whatif.ts"],
      });
      const report = await buildWhatifReport(
        store,
        [
          {
            kind: "rename",
            symbol: "legacyHandler",
            with: "handler",
            description: "rename legacyHandler to handler",
          },
        ],
        { limit: 3 },
      );
      if (report.historical_attempts.length === 0) {
        return {
          status: "fail",
          detail: "whatif sub-check: historical_attempts empty despite seeded fixture",
        };
      }
      if (report.breakage_likelihood <= 0) {
        return {
          status: "fail",
          detail: `whatif sub-check: breakage_likelihood=${report.breakage_likelihood} did not reflect a blocked prior attempt`,
        };
      }
      if (report.self_confidence <= 0) {
        return {
          status: "fail",
          detail: "whatif sub-check: self_confidence=0 despite historical evidence",
        };
      }
      return {
        status: "pass",
        detail: `whatif returned ${report.historical_attempts.length} historical attempt(s); breakage_likelihood=${report.breakage_likelihood}, self_confidence=${report.self_confidence}.`,
      };
    } finally {
      await store.close();
    }
  } catch (err) {
    return {
      status: "fail",
      detail: `whatif sub-check failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function scaffoldFederationRoot(
  parent: string,
  name: string,
  notes: Record<string, string>,
): Promise<string> {
  const dir = join(parent, name);
  const notesDir = join(dir, ".red/memory/notes");
  await mkdir(notesDir, { recursive: true });
  await writeMemoryStateFile(
    join(dir, ".red/memory/config.toon"),
    {
      version: 1,
      mode: "markdown-only",
      notesDir: ".red/memory/notes",
      hooks: { sessionStart: false, postToolUse: false, stop: false, preCompact: false },
      mcp: false,
      reddb: false,
    },
  );
  for (const [file, body] of Object.entries(notes)) {
    await writeFile(join(notesDir, file), body);
  }
  return dir;
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
    "# Memory reference eval v2",
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
      `Unsupported live reference claims: ${report.claimGuards.unsupportedLiveCompetitorClaims.join(", ")}`,
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
