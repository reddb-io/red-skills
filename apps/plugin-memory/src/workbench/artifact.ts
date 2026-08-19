import { renderWorkbench } from "./render.js";
import type { MemoryWorkbench, MemoryWorkbenchArtifact } from "./types.js";

export function buildMemoryWorkbenchArtifact(
  workbench: MemoryWorkbench,
): MemoryWorkbenchArtifact {
  return {
    contract: {
      name: "memory.workbench.viewer",
      version: "memory.workbench.viewer.v1",
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
      ],
    },
    workbench,
    html: renderWorkbench(workbench),
  };
}
