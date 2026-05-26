import { diagnose, type DoctorReport } from "./doctor.js";
import type { MemoryStore, VectorStatusReport } from "./graph-store.js";
import {
  readMemoryEvents,
  type EngineOpPayload,
  type MemoryEvent,
} from "./memory-events.js";
import type { MemoryLayer } from "./schema.js";
import { readSkillRollups } from "./skill-events.js";

/** Default health window: last 24h of engine ops. */
const DEFAULT_ENGINE_EVENT_WINDOW_MS = 24 * 60 * 60 * 1000;

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
  /**
   * Aggregates over the `mem.events` engine-op stream within the configured
   * window. `memory health` surface for PRD #174 / issue #181 — per-layer
   * write rate, recall hit rate, promotion/eviction volume, conflict count.
   */
  engine_events: {
    status: "available" | "unavailable";
    window_ms: number;
    total: number;
    writes_by_layer: Partial<Record<MemoryLayer, number>>;
    recall_hit_rate: number;
    recall_total: number;
    recall_hits: number;
    promotion_count: number;
    eviction_count: number;
    conflict_count: number;
    error?: string;
  };
  recommended_next_actions: string[];
}

export interface MemoryHealthInput {
  stale_days?: number;
  /**
   * Window for `engine_events` aggregates, in milliseconds. Defaults to the
   * last 24 hours. Set to `0` (or a negative number) to read the full stream.
   */
  engine_events_window_ms?: number;
  /** Injectable clock for deterministic windows in tests. */
  now?: number | string | Date;
}

export async function buildMemoryHealthReport(
  store: MemoryStore,
  input: MemoryHealthInput = {},
): Promise<MemoryHealthReport> {
  const [stats, vector, stale, rollups, engineEvents] = await Promise.all([
    store.stats(),
    vectorHealth(store),
    diagnose(store, { staleDays: input.stale_days }),
    skillTelemetryHealth(store),
    engineEventHealth(store, input),
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
    engine_events: engineEvents,
    recommended_next_actions:
      actions.length > 0 ? actions : ["memory graph is ready for agent use"],
  };
}

export async function engineEventHealth(
  store: MemoryStore,
  input: MemoryHealthInput = {},
): Promise<MemoryHealthReport["engine_events"]> {
  const windowMs =
    input.engine_events_window_ms == null
      ? DEFAULT_ENGINE_EVENT_WINDOW_MS
      : input.engine_events_window_ms;
  const useWindow = Number.isFinite(windowMs) && windowMs > 0;
  try {
    const events = await readMemoryEvents(store, {
      retentionMs: useWindow ? windowMs : undefined,
      now: input.now,
    });
    return {
      status: "available",
      window_ms: useWindow ? windowMs : 0,
      ...aggregateEngineEvents(events),
    };
  } catch (err) {
    return {
      status: "unavailable",
      window_ms: useWindow ? windowMs : 0,
      total: 0,
      writes_by_layer: {},
      recall_hit_rate: 0,
      recall_total: 0,
      recall_hits: 0,
      promotion_count: 0,
      eviction_count: 0,
      conflict_count: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function aggregateEngineEvents(events: MemoryEvent[]): Omit<
  MemoryHealthReport["engine_events"],
  "status" | "window_ms" | "error"
> {
  const writesByLayer: Partial<Record<MemoryLayer, number>> = {};
  let recallTotal = 0;
  let recallHits = 0;
  let promotionCount = 0;
  let evictionCount = 0;
  let conflictCount = 0;
  let total = 0;

  for (const event of events) {
    if (event.kind !== "engine.op") continue;
    const payload = event.payload as EngineOpPayload;
    total++;
    switch (payload.op) {
      case "store": {
        const layer = (payload.layer ?? "L3") as MemoryLayer;
        writesByLayer[layer] = (writesByLayer[layer] ?? 0) + 1;
        break;
      }
      case "recall":
        recallTotal++;
        if (payload.outcome === "hit") recallHits++;
        break;
      case "promote":
        promotionCount++;
        break;
      case "evict":
        evictionCount++;
        break;
      case "conflict-detected":
        conflictCount++;
        break;
    }
  }

  return {
    total,
    writes_by_layer: writesByLayer,
    recall_hit_rate: recallTotal === 0 ? 0 : recallHits / recallTotal,
    recall_total: recallTotal,
    recall_hits: recallHits,
    promotion_count: promotionCount,
    eviction_count: evictionCount,
    conflict_count: conflictCount,
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
