import type { MemoryStore } from "../graph-store.js";
import { readConfig } from "../config.js";
import {
  buildMemoryAgentIntegrationStatus,
  type MemoryAgentIntegrationStatus,
} from "../agent-integration-status.js";
import {
  buildMemoryCapabilityCatalog,
  type MemoryCapabilityCatalog,
} from "../capability-catalog.js";
import {
  buildMemoryReferenceRadar,
  type MemoryReferenceRadar,
} from "../references-radar.js";
import { buildContextPack, type ContextPack } from "../context-pack.js";
import {
  buildMemoryOperationalDashboard,
  type MemoryOperationalDashboard,
} from "../operational-dashboard.js";
import {
  buildMemoryExtractionStatus,
  type MemoryExtractionStatus,
} from "../extraction-status.js";
import {
  buildMemoryGovernanceReport,
  type MemoryGovernanceReport,
} from "../governance.js";
import { buildMemoryHandoff, type MemoryHandoffReport } from "../handoff.js";
import { buildWorkFrontier, type WorkFrontierReport } from "../work-frontier.js";
import {
  buildLearningDebtReport,
  type LearningDebtReport,
} from "../learning-debt.js";
import {
  buildMemoryHealthReport,
  type MemoryHealthReport,
} from "../memory-health.js";
import {
  buildMemoryDecayReport,
  type MemoryDecayReport,
} from "../memory-decay.js";
import {
  buildMemoryLayersReport,
  type MemoryLayersReport,
} from "../memory-layers.js";
import {
  buildReasoningReplay,
  type ReasoningReplayReport,
} from "../reasoning/reasoning-replay.js";
import { buildWhatifReport, type WhatifReport } from "../whatif.js";
import {
  buildFederationReport,
  type FederationReport,
} from "../federation.js";
import {
  readAutoCureRunLog,
  runAutoCure,
  type AutoCureReport,
  type AutoCureRunLog,
} from "../auto-curation.js";
import { buildMemoryRoutingGuide, type MemoryRoutingGuide } from "../routing-guide.js";
import { buildSessionTimeline, type SessionTimeline } from "../session-timeline.js";
import { readSkillRollups } from "../skill-events.js";

import type { MemoryWorkbench } from "./types.js";

export async function buildMemoryWorkbench(
  store: MemoryStore,
  rootDir: string,
  opts: { staleDays?: number; sessionId?: string; limit?: number; now?: number } = {},
): Promise<MemoryWorkbench> {
  const config = await readConfig(rootDir);
  const [
    dashboard,
    capabilities,
    referencesRadar,
    contextPack,
    extractionStatus,
    governance,
    handoff,
    workFrontier,
    learningDebt,
    memoryDecay,
    memoryHealth,
    memoryLayers,
    routingGuide,
    agentIntegrationStatus,
    sessionTimeline,
    reasoningReplay,
    whatif,
    federation,
    autocure,
    autocureRuns,
  ] = await Promise.all([
    buildMemoryOperationalDashboard(store, rootDir, {
      staleDays: opts.staleDays,
      now: opts.now,
    }),
    buildMemoryCapabilityCatalog(store, rootDir, { now: opts.now }),
    buildMemoryReferenceRadar(store, rootDir, { now: opts.now }),
    buildContextPack(store, "memory", {
      budgetChars: 2_500,
      limit: 8,
      depth: 1,
      now: opts.now,
    }),
    buildMemoryExtractionStatus(store, rootDir, { now: opts.now }),
    buildMemoryGovernanceReport(store, { now: opts.now, providerConfig: config?.provider }),
    buildMemoryHandoff(store, { limit: 12, now: opts.now }),
    buildWorkFrontier(store, { limit: 12, now: opts.now }),
    buildLearningDebtReport(store, {
      now: opts.now,
      staleDays: opts.staleDays,
      rollups: await safeSkillRollups(store),
      skillTelemetryEnabled: true,
    }),
    buildMemoryDecayReport(store, { stale_days: opts.staleDays, limit: 12, now: opts.now }),
    buildMemoryHealthReport(store, { stale_days: opts.staleDays }),
    buildMemoryLayersReport(store, { now: opts.now }),
    Promise.resolve(buildMemoryRoutingGuide({ agent: "codex" })),
    buildMemoryAgentIntegrationStatus(rootDir, { now: opts.now }),
    buildSessionTimeline(store, {
      sessionId: opts.sessionId,
      limit: opts.limit,
      now: opts.now,
    }),
    buildReasoningReplay(store, "memory", { limit: 5, now: opts.now }),
    buildWhatifReport(
      store,
      [{ kind: "edit", description: "memory workbench preview", file: rootDir }],
      { limit: 3, now: opts.now },
    ),
    buildFederationReport(rootDir, "memory", { limit: 5, now: opts.now }),
    runAutoCure(store, { apply: false, staleDays: opts.staleDays, now: opts.now }),
    readAutoCureRunLog(store),
  ]);
  return {
    schema_version: "memory.workbench.v1",
    read_only: true,
    root: rootDir,
    generated_at: new Date(opts.now ?? Date.now()).toISOString(),
    dashboard,
    capabilities,
    references_radar: referencesRadar,
    context_pack: contextPack,
    extraction_status: extractionStatus,
    governance,
    handoff,
    work_frontier: workFrontier,
    learning_debt: learningDebt,
    memory_decay: memoryDecay,
    memory_health: memoryHealth,
    memory_layers: memoryLayers,
    routing_guide: routingGuide,
    agent_integration_status: agentIntegrationStatus,
    session_timeline: sessionTimeline,
    reasoning_replay: reasoningReplay,
    whatif,
    federation,
    autocure,
    autocure_runs: autocureRuns,
  };
}

async function safeSkillRollups(store: MemoryStore) {
  try {
    return await readSkillRollups(store);
  } catch {
    return [];
  }
}
