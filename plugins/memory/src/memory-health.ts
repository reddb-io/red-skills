import { diagnose, type DoctorReport } from "./doctor.js";
import type { MemoryStore, VectorStatusReport } from "./graph-store.js";
import { readSkillRollups } from "./skill-events.js";

export interface MemoryHealthReport {
  schema_version: "memory.health.v1";
  read_only: true;
  state: "ready" | "attention" | "degraded";
  stats: Awaited<ReturnType<MemoryStore["stats"]>>;
  vector: Pick<
    VectorStatusReport,
    "overall" | "total" | "ready" | "stale" | "unavailable" | "failed"
  > & { error?: string };
  stale: {
    total: number;
    stale: number;
  };
  skill_telemetry: {
    status: "available" | "unavailable";
    rollups: number;
    error?: string;
  };
  recommended_next_actions: string[];
}

export interface MemoryHealthInput {
  stale_days?: number;
}

export async function buildMemoryHealthReport(
  store: MemoryStore,
  input: MemoryHealthInput = {},
): Promise<MemoryHealthReport> {
  const [stats, vector, stale, rollups] = await Promise.all([
    store.stats(),
    vectorHealth(store),
    diagnose(store, { staleDays: input.stale_days }),
    skillTelemetryHealth(store),
  ]);
  const actions = healthActions(vector, stale, rollups);
  return {
    schema_version: "memory.health.v1",
    read_only: true,
    state:
      vector.overall === "failed" || rollups.status === "unavailable"
        ? "degraded"
        : actions.length > 0
          ? "attention"
          : "ready",
    stats,
    vector,
    stale: {
      total: stale.totalNodes,
      stale: stale.stale.length,
    },
    skill_telemetry: rollups,
    recommended_next_actions:
      actions.length > 0 ? actions : ["memory graph is ready for agent use"],
  };
}

async function vectorHealth(store: MemoryStore): Promise<MemoryHealthReport["vector"]> {
  try {
    const vector = await store.vectorStatus();
    return {
      overall: vector.overall,
      total: vector.total,
      ready: vector.ready,
      stale: vector.stale,
      unavailable: vector.unavailable,
      failed: vector.failed,
    };
  } catch (err) {
    return {
      overall: "unavailable",
      total: 0,
      ready: 0,
      stale: 0,
      unavailable: 0,
      failed: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function skillTelemetryHealth(
  store: MemoryStore,
): Promise<MemoryHealthReport["skill_telemetry"]> {
  try {
    return { status: "available", rollups: (await readSkillRollups(store)).length };
  } catch (err) {
    return {
      status: "unavailable",
      rollups: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function healthActions(
  vector: MemoryHealthReport["vector"],
  stale: DoctorReport,
  rollups: MemoryHealthReport["skill_telemetry"],
): string[] {
  const actions: string[] = [];
  if (vector.overall === "stale" || vector.stale > 0) {
    actions.push("refresh vector projections before relying on semantic recall");
  }
  if (vector.overall === "failed" || vector.failed > 0) {
    actions.push("repair failed vector projections");
  }
  if (stale.stale.length > 0) {
    actions.push("review stale Memory nodes before using old guidance");
  }
  if (rollups.status === "unavailable" || rollups.rollups === 0) {
    actions.push("collect Skill telemetry before relying on skill evolution signals");
  }
  return actions;
}
