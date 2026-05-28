import { diagnose } from "./doctor.js";
import { readMemoryEvents, } from "./memory-events.js";
import { readSkillRollups } from "./skill-events.js";
/** Default health window: last 24h of engine ops. */
const DEFAULT_ENGINE_EVENT_WINDOW_MS = 24 * 60 * 60 * 1000;
export async function buildMemoryHealthReport(store, input = {}) {
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
        state: vector.overall === "failed" || rollups.status === "unavailable"
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
        recommended_next_actions: actions.length > 0 ? actions : ["memory graph is ready for agent use"],
    };
}
export async function engineEventHealth(store, input = {}) {
    const windowMs = input.engine_events_window_ms == null
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
    }
    catch (err) {
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
function aggregateEngineEvents(events) {
    const writesByLayer = {};
    let recallTotal = 0;
    let recallHits = 0;
    let promotionCount = 0;
    let evictionCount = 0;
    let conflictCount = 0;
    let total = 0;
    for (const event of events) {
        if (event.kind !== "engine.op")
            continue;
        const payload = event.payload;
        total++;
        switch (payload.op) {
            case "store": {
                const layer = (payload.layer ?? "L3");
                writesByLayer[layer] = (writesByLayer[layer] ?? 0) + 1;
                break;
            }
            case "recall":
                recallTotal++;
                if (payload.outcome === "hit")
                    recallHits++;
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
async function vectorHealth(store) {
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
    }
    catch (err) {
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
async function skillTelemetryHealth(store) {
    try {
        return { status: "available", rollups: (await readSkillRollups(store)).length };
    }
    catch (err) {
        return {
            status: "unavailable",
            rollups: 0,
            error: err instanceof Error ? err.message : String(err),
        };
    }
}
function healthActions(vector, stale, rollups) {
    const actions = [];
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
