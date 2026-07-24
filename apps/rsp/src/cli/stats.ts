import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { connect } from "@reddb-io/sdk";
import { encodeSnapshotToon } from "@reddb-io/shared/toon-migration.js";
import type { JsonObject } from "@reddb-io/toon";
import type { RspRuntimeConfig } from "../config.js";
import type { RspStorageClassStats } from "../elision-store.js";
import { formatUsd } from "../pricing.js";
import type { RspAccountingLaneStats, RspTelemetryGainsReport, RspTelemetryStats } from "../telemetry.js";

export async function readStatsSnapshot(
  config: RspRuntimeConfig,
  sinceDaysValue: number,
): Promise<{ stats: RspAccountingLaneStats; telemetry: RspTelemetryStats }> {
  const empty = {
    stats: emptyAccountingStats(config.telemetryByteBudget),
    telemetry: emptyTelemetryStats(sinceDaysValue),
  };
  if (!config.storeUri.startsWith("file://")) return empty;
  const path = fileURLToPath(config.storeUri);
  if (!existsSync(path)) return empty;
  if (!path.endsWith("red-skills.rdb")) {
    const { RspElisionStore } = await import("../elision-store.js");
    const store = await RspElisionStore.open({
      uri: config.storeUri,
      ttlDays: config.ttlDays,
      ephemeralTtlHours: config.ephemeralTtlHours,
      byteBudget: config.byteBudget,
    });
    try {
      return {
        stats: await store.stats(),
        telemetry: emptyTelemetryStats(sinceDaysValue),
      };
    } finally {
      await store.close();
    }
  }

  const { ensureReddbBinaryFromWarmCache } = await import("../elision-store.js");
  await ensureReddbBinaryFromWarmCache();
  const { readAccountingLaneStats, readTelemetryStats } = await import("../telemetry.js");
  const db = await connect(config.storeUri);
  try {
    return {
      stats: await readAccountingLaneStats(db, config.telemetryByteBudget),
      telemetry: await readTelemetryStats(db, sinceDaysValue),
    };
  } finally {
    await db.close();
  }
}

export function renderStats(
  stats: { records: number; bytes: number; oldest: string | null; budget: number; storage_classes?: RspStorageClassStats },
  telemetry = emptyTelemetryStats(30),
  full = false,
): string {
  return `${encodeSnapshotToon(statsPayload(stats, telemetry, full))}\n`;
}

export function statsPayload(
  stats: { records: number; bytes: number; oldest: string | null; budget: number; storage_classes?: RspStorageClassStats },
  telemetry: RspTelemetryStats,
  full: boolean,
): JsonObject {
  const topCommands = telemetry.savings.top_commands.slice(0, full ? 10 : 3);
  const daily = full ? telemetry.savings.daily_tokens_saved : telemetry.savings.daily_tokens_saved.slice(-7);
  const storageClasses = stats.storage_classes ?? emptyStorageClassStats();
  const recentFailures = telemetry.health.recent_failures.slice(0, full ? 20 : 5);
  const topPassReasons = telemetry.decisions.top_pass_reasons.slice(0, full ? 10 : 3);
  return {
    records: stats.records,
    bytes: stats.bytes,
    oldest: stats.oldest,
    budget: stats.budget,
    storage_classes: storageClasses as unknown as JsonObject,
    savings: {
      window_days: telemetry.window_days,
      empty: telemetry.empty,
      ...telemetry.savings,
      tokens_saved_display: formatTokensSaved(telemetry.savings),
      dollars_saved_estimate_usd_display: formatDollarsSaved(telemetry.savings),
      daily_tokens_saved: daily,
      daily_tokens_saved_elided: full ? 0 : Math.max(0, telemetry.savings.daily_tokens_saved.length - daily.length),
      top_commands: topCommands,
      top_commands_elided: full ? 0 : Math.max(0, telemetry.savings.top_commands.length - topCommands.length),
    } as unknown as JsonObject,
    health: {
      ...telemetry.health,
      degradation_rate_display: formatRate(telemetry.health.degradation_rate),
      show_hit_rate_display: formatRate(telemetry.health.show_hit_rate),
      by_reason: telemetry.health.by_reason,
      by_family: telemetry.health.by_family,
      recent_failures: recentFailures,
      recent_failures_elided: full ? 0 : Math.max(0, telemetry.health.recent_failures.length - recentFailures.length),
      most_recent_degradation_at: telemetry.health.most_recent?.timestamp ?? null,
      most_recent_degradation_reason: telemetry.health.most_recent?.reason ?? null,
    } as unknown as JsonObject,
    decisions: {
      ...telemetry.decisions,
      contribution_rate_display: formatRate(telemetry.decisions.contribution_rate),
      top_pass_reasons: topPassReasons,
      top_pass_reasons_elided: full ? 0 : Math.max(0, telemetry.decisions.top_pass_reasons.length - topPassReasons.length),
      by_command_family: full
        ? telemetry.decisions.by_command_family
        : telemetry.decisions.by_command_family.slice(0, 5),
      by_command_family_elided: full
        ? 0
        : Math.max(0, telemetry.decisions.by_command_family.length - 5),
    } as unknown as JsonObject,
    latency: {
      ...telemetry.latency,
      wrapper_ms_p50_display: formatNullable(telemetry.latency.wrapper_ms_p50),
      wrapper_ms_p95_display: formatNullable(telemetry.latency.wrapper_ms_p95),
      store_elapsed_ms_avg_display: formatNullable(telemetry.latency.store_elapsed_ms_avg),
    } as unknown as JsonObject,
  };
}

export function renderGainsReportToon(report: RspTelemetryGainsReport): string {
  return `${encodeSnapshotToon(report as unknown as JsonObject)}\n`;
}

export function emptyTelemetryStats(windowDays: number): RspTelemetryStats {
  return {
    window_days: windowDays,
    empty: true,
    savings: {
      invocations: 0,
      elided: 0,
      raw_bytes: 0,
      emitted_bytes: 0,
      bytes_saved: 0,
      tokens_saved: 0,
      tokens_saved_estimated: false,
      token_estimate_range_pct: null,
      tokens_saved_low: null,
      tokens_saved_high: null,
      dollars_saved_estimate_usd: 0,
      dollars_saved_low_usd: null,
      dollars_saved_high_usd: null,
      pricing_model_family: "gpt-5",
      pricing_input_usd_per_million_tokens: 1.25,
      pricing_note: "estimate derived from byte-based token estimate when token counts are estimated",
      daily_tokens_saved: [],
      top_commands: [],
    },
    health: {
      degradations: 0,
      degradation_rate: 0,
      show_total: 0,
      show_hits: 0,
      show_misses: 0,
      show_hit_rate: 0,
      by_reason: [],
      by_family: [],
      recent_failures: [],
      most_recent: null,
    },
    latency: {
      wrapper_ms_p50: null,
      wrapper_ms_p95: null,
      store_open_count_sum: 0,
      store_elapsed_ms_sum: 0,
      store_elapsed_ms_avg: null,
    },
    decisions: {
      seen: 0,
      contributed: 0,
      passed: 0,
      failed_open: 0,
      quota_free_saved_units: 0,
      contribution_rate: 0,
      top_pass_reasons: [],
      by_command_family: [],
    },
  };
}

export function emptyAccountingStats(byteBudget: number): RspAccountingLaneStats {
  return {
    records: 0,
    bytes: 0,
    oldest: null,
    budget: byteBudget,
    storage_classes: emptyStorageClassStats(),
  };
}

export function emptyStorageClassStats(): RspStorageClassStats {
  return {
    derivable: { records: 0, bytes: 0, raw_bytes: 0 },
    "re-executable": { records: 0, bytes: 0, raw_bytes: 0 },
    ephemeral: { records: 0, bytes: 0, raw_bytes: 0 },
  };
}

export function renderSetupResult(result: {
  configChanged: boolean;
  storeCreated: boolean;
  legacyStoreMigrated?: boolean;
}): string {
  const storeState = result.legacyStoreMigrated ? "migrated" : result.storeCreated ? "created" : "existing";
  return [
    `config: ${result.configChanged ? "updated" : "unchanged"}`,
    `store: ${storeState}`,
    "",
  ].join("\n");
}

function formatTokensSaved(savings: RspTelemetryStats["savings"]): string {
  if (!savings.tokens_saved_estimated) return String(savings.tokens_saved);
  return `${savings.tokens_saved_low}-${savings.tokens_saved_high} (estimate_midpoint: ${savings.tokens_saved}, range_pct: ${savings.token_estimate_range_pct})`;
}

function formatDollarsSaved(savings: RspTelemetryStats["savings"]): string {
  if (savings.dollars_saved_low_usd == null || savings.dollars_saved_high_usd == null) {
    return formatUsd(savings.dollars_saved_estimate_usd);
  }
  return `${formatUsd(savings.dollars_saved_low_usd)}-${formatUsd(savings.dollars_saved_high_usd)} (estimate_midpoint: ${formatUsd(savings.dollars_saved_estimate_usd)})`;
}

function formatNullable(value: number | null): string {
  return value == null ? "none" : String(value);
}

function formatRate(value: number): string {
  return value.toFixed(4).replace(/0+$/, "").replace(/\.$/, ".0");
}
