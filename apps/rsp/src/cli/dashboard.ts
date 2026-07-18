import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { encodeSnapshotToon } from "@reddb-io/shared/toon-migration.js";
import type { JsonObject } from "@reddb-io/toon";
import type { RspRuntimeConfig } from "../config.js";
import type { RspRecoveryHandle } from "../elision-store.js";
import { withNextSteps } from "../output-levers.js";
import type { DashboardSnapshot } from "./types.js";
import { emptyStorageClassStats, readStatsSnapshot, statsPayload } from "./stats.js";

export async function readDashboardSnapshot(config: RspRuntimeConfig): Promise<DashboardSnapshot> {
  const { stats, telemetry } = await readStatsSnapshot(config, 30);
  const [recoveryHandles, waits] = await Promise.all([
    readRecoveryHandles(config),
    import("../wait.js").then((module) => module.listWaits(process.cwd()), () => [] as JsonObject[]),
  ]);
  return { stats, telemetry, recoveryHandles, waits };
}

export function renderDashboard(snapshot: DashboardSnapshot): string {
  const statsView = statsPayload(snapshot.stats, snapshot.telemetry, false);
  const payload = withNextSteps({
    executable: {
      name: "rsp",
      command: "rsp",
    },
    recovery: {
      pending: snapshot.recoveryHandles.length,
      handles: snapshot.recoveryHandles as unknown as JsonObject[],
    },
    waits: {
      active: snapshot.waits.length,
      entries: snapshot.waits,
    },
    store: {
      records: snapshot.stats.records,
      bytes: snapshot.stats.bytes,
      oldest: snapshot.stats.oldest,
      budget: snapshot.stats.budget,
      storage_classes: (snapshot.stats.storage_classes ?? emptyStorageClassStats()) as unknown as JsonObject,
    },
    savings: statsView.savings,
    health: statsView.health,
    decisions: statsView.decisions,
    latency: statsView.latency,
  }, dashboardNextSteps(snapshot));
  return `${encodeSnapshotToon(payload)}\n`;
}

async function readRecoveryHandles(config: RspRuntimeConfig): Promise<RspRecoveryHandle[]> {
  if (!config.storeUri.startsWith("file://")) return [];
  const path = fileURLToPath(config.storeUri);
  if (!existsSync(path)) return [];
  const { RspElisionStore } = await import("../elision-store.js");
  const store = await RspElisionStore.open({
    uri: config.storeUri,
    ttlDays: config.ttlDays,
    ephemeralTtlHours: config.ephemeralTtlHours,
    byteBudget: config.byteBudget,
  });
  try {
    return await store.recoveryHandles(5);
  } finally {
    await store.close();
  }
}

function dashboardNextSteps(snapshot: DashboardSnapshot): string[] {
  return [
    snapshot.recoveryHandles.length > 0 ? "rsp show <handle>" : "rsp <wrapped-command> --terse",
    snapshot.waits.length > 0 ? "rsp wait ls" : "rsp wait cmd -- \"<command>\"",
    "rsp stats --since <days>d",
  ];
}
