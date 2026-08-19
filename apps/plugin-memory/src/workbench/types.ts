import type { MemoryAgentIntegrationStatus } from "../agent-integration-status.js";
import type { AutoCureReport, AutoCureRunLog } from "../auto-curation.js";
import type { MemoryCapabilityCatalog } from "../capability-catalog.js";
import type { ContextPack } from "../context-pack.js";
import type { MemoryExtractionStatus } from "../extraction-status.js";
import type { FederationReport } from "../federation.js";
import type { MemoryGovernanceReport } from "../governance.js";
import type { MemoryHandoffReport } from "../handoff.js";
import type { LearningDebtReport } from "../learning-debt.js";
import type { MemoryDecayReport } from "../memory-decay.js";
import type { MemoryHealthReport } from "../memory-health.js";
import type { MemoryLayersReport } from "../memory-layers.js";
import type { MemoryOperationalDashboard } from "../operational-dashboard.js";
import type { MemoryReferenceRadar } from "../references-radar.js";
import type { ReasoningReplayReport } from "../reasoning/reasoning-replay.js";
import type { MemoryRoutingGuide } from "../routing-guide.js";
import type { SessionTimeline } from "../session-timeline.js";
import type { WhatifReport } from "../whatif.js";
import type { WorkFrontierReport } from "../work-frontier.js";

export interface MemoryWorkbench {
  schema_version: "memory.workbench.v1";
  read_only: true;
  root: string;
  generated_at: string;
  dashboard: MemoryOperationalDashboard;
  capabilities: MemoryCapabilityCatalog;
  references_radar: MemoryReferenceRadar;
  context_pack: ContextPack;
  extraction_status: MemoryExtractionStatus;
  governance: MemoryGovernanceReport;
  handoff: MemoryHandoffReport;
  work_frontier: WorkFrontierReport;
  learning_debt: LearningDebtReport;
  memory_decay: MemoryDecayReport;
  memory_health: MemoryHealthReport;
  memory_layers: MemoryLayersReport;
  routing_guide: MemoryRoutingGuide;
  agent_integration_status: MemoryAgentIntegrationStatus;
  session_timeline: SessionTimeline;
  reasoning_replay: ReasoningReplayReport;
  whatif: WhatifReport;
  federation: FederationReport;
  autocure: AutoCureReport;
  autocure_runs: AutoCureRunLog;
}

export interface MemoryWorkbenchArtifact {
  contract: {
    name: "memory.workbench.viewer";
    version: "memory.workbench.viewer.v1";
    consumes: [
      "memory.operational_dashboard.v1",
      "memory.capability_catalog.v1",
      "memory.reference_radar.v1",
      "memory.context_pack.v1",
      "memory.extraction_status.v1",
      "memory.governance.v1",
      "memory.handoff.v1",
      "memory.work_frontier.v1",
      "memory.learning_debt.v1",
      "memory.decay_plan.v1",
      "memory.health.v1",
      "memory.memory_layers.v1",
      "memory.routing_guide.v1",
      "memory.agent_integration_status.v1",
      "memory.session_timeline.v1",
      "memory.reasoning_replay.v1",
      "memory.whatif.v1",
      "memory.federation.v1",
      "memory.autocure.v1",
    ];
  };
  workbench: MemoryWorkbench;
  html: string;
}
