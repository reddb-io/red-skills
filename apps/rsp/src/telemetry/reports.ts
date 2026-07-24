import type { RedDB } from "@reddb-io/sdk";
import { commandFamily } from "../command-classifier.js";
import { storageClassForCommand, type RspStorageClass, type RspStorageClassStats } from "../elision-store.js";
import { tokenSavingsEstimate } from "../pricing.js";
import {
  RSP_ACCOUNTING_EVENTS_COLLECTION,
  RSP_DECISIONS_COLLECTION,
  RSP_TELEMETRY_DEGRADATIONS_COLLECTION,
  RSP_TELEMETRY_INVOCATIONS_COLLECTION,
  type LatencyPercentiles,
  type RspAccountingLaneStats,
  type RspTelemetryGainsReport,
  type RspTelemetryStats,
} from "./schema.js";
import { isRecord, numeric, optionalNumeric } from "./helpers.js";

export async function readTelemetryStats(db: RedDB, sinceDays: number, now = new Date()): Promise<RspTelemetryStats> {
  const windowDays = Number.isFinite(sinceDays) && sinceDays > 0 ? sinceDays : 30;
  const sinceMs = now.getTime() - windowDays * 24 * 60 * 60 * 1000;
  const accounting = await readAccountingRecords(db, sinceMs);
  const decisions = (await readCollection(db, RSP_DECISIONS_COLLECTION))
    .filter((record) => timestampMs(record) >= sinceMs);
  const invocations = accounting.filter((record) =>
    stringField(record.event_type) !== "show" && stringField(record.degradation_reason) === ""
  );
  const showEvents = accounting.filter((record) => stringField(record.event_type) === "show");
  const degradations = accounting.filter((record) => stringField(record.degradation_reason) !== "");

  let elided = 0;
  let rawBytes = 0;
  let emittedBytes = 0;
  let tokensSaved = 0;
  let tokensEstimated = false;
  const byDay = new Map<string, number>();
  const byCommand = new Map<string, { command: string; invocations: number; bytes_saved: number; tokens_saved: number }>();
  const wrapperMs: number[] = [];
  let storeOpenCountSum = 0;
  let storeElapsedMsSum = 0;
  let storeElapsedMsCount = 0;

  for (const record of invocations) {
    if (record.elided === true) elided++;
    const raw = numeric(record.raw_bytes);
    const emitted = numeric(record.emitted_bytes);
    const bytesSaved = Math.max(0, raw - emitted);
    const rawTokens = tokenCountFromCounters(record, "raw");
    const emittedTokens = tokenCountFromCounters(record, "emitted");
    const tokenDelta = Math.max(0, rawTokens.tokens - emittedTokens.tokens);
    tokensEstimated ||= (record.estimated === true || rawTokens.estimated || emittedTokens.estimated) && tokenDelta > 0;
    rawBytes += raw;
    emittedBytes += emitted;
    tokensSaved += tokenDelta;
    const date = timestampString(record).slice(0, 10);
    if (date) byDay.set(date, (byDay.get(date) ?? 0) + tokenDelta);
    const command = stringField(record.command) || "unknown";
    const current = byCommand.get(command) ?? { command, invocations: 0, bytes_saved: 0, tokens_saved: 0 };
    current.invocations++;
    current.bytes_saved += bytesSaved;
    current.tokens_saved += tokenDelta;
    byCommand.set(command, current);
    const latency = optionalNumeric(record.wrapper_ms);
    if (latency != null) wrapperMs.push(latency);
    storeOpenCountSum += numeric(record.store_open_count);
    const storeMs = optionalNumeric(record.store_elapsed_ms);
    if (storeMs != null) {
      storeElapsedMsSum += storeMs;
      storeElapsedMsCount++;
    }
  }

  const byReason = new Map<string, number>();
  const byFamily = new Map<string, number>();
  const recentFailures: RspTelemetryStats["health"]["recent_failures"] = [];
  let mostRecent: RspTelemetryStats["health"]["most_recent"] = null;
  for (const record of degradations) {
    const reason = stringField(record.degradation_reason) || stringField(record.reason) || "unknown";
    const family = stringField(record.wrapper_family) || commandFamily(stringField(record.command));
    byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
    byFamily.set(family, (byFamily.get(family) ?? 0) + 1);
    const timestamp = timestampString(record);
    recentFailures.push({
      timestamp,
      family,
      command: stringField(record.command) || "unknown",
      reason,
      exit_code: optionalNumeric(record.wrapper_exit_code),
      stderr_head: stringField(record.stderr_head) || null,
    });
    if (!mostRecent || timestamp > mostRecent.timestamp) {
      mostRecent = {
        timestamp,
        reason,
        command: stringField(record.command) || "unknown",
      };
    }
  }

  const totalAttempts = invocations.length + degradations.length;
  const showHits = showEvents.filter((record) => record.hit === true).length;
  const savingsEstimate = tokenSavingsEstimate(tokensSaved, tokensEstimated);
  const decisionCounts = countDecisions(decisions);
  return {
    window_days: windowDays,
    empty: accounting.length === 0,
    savings: {
      invocations: invocations.length,
      elided,
      raw_bytes: rawBytes,
      emitted_bytes: emittedBytes,
      bytes_saved: Math.max(0, rawBytes - emittedBytes),
      tokens_saved: tokensSaved,
      tokens_saved_estimated: savingsEstimate.tokens_saved_estimated,
      token_estimate_range_pct: savingsEstimate.token_estimate_range_pct,
      tokens_saved_low: savingsEstimate.tokens_saved_low,
      tokens_saved_high: savingsEstimate.tokens_saved_high,
      dollars_saved_estimate_usd: savingsEstimate.dollars_saved_estimate_usd,
      dollars_saved_low_usd: savingsEstimate.dollars_saved_low_usd,
      dollars_saved_high_usd: savingsEstimate.dollars_saved_high_usd,
      pricing_model_family: savingsEstimate.pricing_model_family,
      pricing_input_usd_per_million_tokens: savingsEstimate.pricing_input_usd_per_million_tokens,
      pricing_note: savingsEstimate.pricing_note,
      daily_tokens_saved: [...byDay.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, saved]) => ({ date, tokens_saved: saved })),
      top_commands: [...byCommand.values()]
        .sort((a, b) => b.bytes_saved - a.bytes_saved || b.tokens_saved - a.tokens_saved || a.command.localeCompare(b.command)),
    },
    health: {
      degradations: degradations.length,
      degradation_rate: totalAttempts === 0 ? 0 : degradations.length / totalAttempts,
      show_total: showEvents.length,
      show_hits: showHits,
      show_misses: Math.max(0, showEvents.length - showHits),
      show_hit_rate: showEvents.length === 0 ? 0 : round(showHits / showEvents.length),
      by_reason: [...byReason.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([reason, count]) => ({ reason, count })),
      by_family: [...byFamily.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([family, count]) => ({ family, count })),
      recent_failures: recentFailures
        .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
        .slice(0, 20),
      most_recent: mostRecent,
    },
    latency: {
      wrapper_ms_p50: percentile(wrapperMs, 0.5),
      wrapper_ms_p95: percentile(wrapperMs, 0.95),
      store_open_count_sum: storeOpenCountSum,
      store_elapsed_ms_sum: round(storeElapsedMsSum),
      store_elapsed_ms_avg: storeElapsedMsCount === 0 ? null : round(storeElapsedMsSum / storeElapsedMsCount),
    },
    decisions: decisionCounts,
  };
}

function countDecisions(records: Array<Record<string, unknown>>): RspTelemetryStats["decisions"] {
  let contributed = 0;
  let passed = 0;
  let failedOpen = 0;
  let quotaFreeSavedUnits = 0;
  const passReasons = new Map<string, number>();
  const byFamily = new Map<string, { contributed: number; passed: number; failed_open: number }>();
  for (const record of records) {
    const decision = stringField(record.decision);
    if (decision === "contributed") contributed++;
    else if (decision === "failed-open") failedOpen++;
    else passed++;
    if (record.quota_free === true) quotaFreeSavedUnits += Math.max(1, numeric(record.saved_units));
    if (decision !== "contributed") {
      const reason = stringField(record.reason) || "unknown";
      passReasons.set(reason, (passReasons.get(reason) ?? 0) + 1);
    }
    const family = stringField(record.command_family) || "unknown";
    const row = byFamily.get(family) ?? { contributed: 0, passed: 0, failed_open: 0 };
    if (decision === "contributed") row.contributed++;
    else if (decision === "failed-open") row.failed_open++;
    else row.passed++;
    byFamily.set(family, row);
  }
  return {
    seen: records.length,
    contributed,
    passed,
    failed_open: failedOpen,
    quota_free_saved_units: quotaFreeSavedUnits,
    contribution_rate: records.length === 0 ? 0 : round(contributed / records.length),
    top_pass_reasons: [...passReasons.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([reason, count]) => ({ reason, count })),
    by_command_family: [...byFamily.entries()]
      .sort((a, b) => {
        const totalA = a[1].contributed + a[1].passed + a[1].failed_open;
        const totalB = b[1].contributed + b[1].passed + b[1].failed_open;
        return totalB - totalA || a[0].localeCompare(b[0]);
      })
      .map(([family, counts]) => {
        const total = counts.contributed + counts.passed + counts.failed_open;
        return {
          command_family: family,
          contributed: counts.contributed,
          passed: counts.passed,
          failed_open: counts.failed_open,
          contribution_rate: total === 0 ? 0 : round(counts.contributed / total),
        };
      }),
  };
}

export async function readAccountingLaneStats(
  db: RedDB,
  byteBudget: number,
  now = new Date(),
): Promise<RspAccountingLaneStats> {
  const records = await readCollection(db, RSP_ACCOUNTING_EVENTS_COLLECTION);
  const live = records.filter((record) => timestampMs(record) <= now.getTime() || timestampString(record) === "");
  return {
    records: live.length,
    bytes: live.reduce((sum, record) => sum + Buffer.byteLength(JSON.stringify(record), "utf8"), 0),
    oldest: live.reduce<string | null>((oldest, record) => {
      const ts = timestampString(record);
      if (!ts) return oldest;
      if (oldest == null) return ts;
      return ts < oldest ? ts : oldest;
    }, null),
    budget: byteBudget,
    storage_classes: accountingStorageClassStats(live),
  };
}

export async function readTelemetryGainsReport(db: RedDB, sinceDays: number, now = new Date()): Promise<RspTelemetryGainsReport> {
  const windowDays = Number.isFinite(sinceDays) && sinceDays > 0 ? sinceDays : 28;
  const until = now.toISOString();
  const since = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000).toISOString();
  const sinceMs = Date.parse(since);
  const accounting = await readAccountingRecords(db, sinceMs);
  const invocations = accounting.filter((record) =>
    stringField(record.event_type) !== "show" &&
    stringField(record.event_type) !== "control_holdout" &&
    record.control_holdout !== true &&
    stringField(record.degradation_reason) === ""
  );
  const holdouts = accounting.filter((record) => stringField(record.event_type) === "control_holdout" || record.control_holdout === true);
  const showEvents = accounting.filter((record) => stringField(record.event_type) === "show");
  const degradations = accounting.filter((record) => stringField(record.degradation_reason) !== "");
  const allTimestamps = [...invocations, ...degradations]
    .map(timestampMs)
    .filter((value) => Number.isFinite(value) && value > 0);
  const oldestMs = allTimestamps.length === 0 ? null : Math.min(...allTimestamps);
  const dataDays = oldestMs == null ? 0 : Math.max(1, Math.min(windowDays, Math.ceil((now.getTime() - oldestMs) / dayMs())));

  const globalLatencies: number[] = [];
  const latencyByFamily = new Map<string, number[]>();
  const requestsByDay = new Map<string, number>();
  const requestsByMinute = new Map<string, number>();
  const heatmap = new Map<string, number>();
  const weeklyTokens = new Map<string, number>();
  const commandTotals = new Map<string, { command_family: string; invocations: number; tokens_saved: number; bytes_saved: number }>();
  let totalTokensSaved = 0;
  let tokensEstimated = false;
  let elided = 0;
  let biggest: RspTelemetryGainsReport["savings"]["single_biggest_elision"] = null;
  let recordsWithStoreMetric = 0;
  let coldBoots = 0;

  for (const record of invocations) {
    const timestamp = timestampString(record);
    const date = timestamp.slice(0, 10);
    const minute = timestamp.slice(0, 16);
    const family = commandFamily(stringField(record.command));
    const tokensSaved = Math.max(
      0,
      tokenCountFromCounters(record, "raw").tokens - tokenCountFromCounters(record, "emitted").tokens,
    );
    totalTokensSaved += tokensSaved;
    tokensEstimated ||= record.estimated === true && tokensSaved > 0;
    const bytesSaved = Math.max(0, numeric(record.raw_bytes) - numeric(record.emitted_bytes));
    const latency = optionalNumeric(record.wrapper_ms);
    if (latency != null) {
      globalLatencies.push(latency);
      const familyLatencies = latencyByFamily.get(family) ?? [];
      familyLatencies.push(latency);
      latencyByFamily.set(family, familyLatencies);
    }
    if (date) requestsByDay.set(date, (requestsByDay.get(date) ?? 0) + 1);
    if (minute) requestsByMinute.set(minute, (requestsByMinute.get(minute) ?? 0) + 1);
    const heatmapKey = heatmapKeyFor(timestamp);
    if (heatmapKey) heatmap.set(heatmapKey, (heatmap.get(heatmapKey) ?? 0) + 1);
    const week = weekStartDate(timestamp);
    if (week) weeklyTokens.set(week, (weeklyTokens.get(week) ?? 0) + tokensSaved);
    const totals = commandTotals.get(family) ?? { command_family: family, invocations: 0, tokens_saved: 0, bytes_saved: 0 };
    totals.invocations++;
    totals.tokens_saved += tokensSaved;
    totals.bytes_saved += bytesSaved;
    commandTotals.set(family, totals);
    if (record.elided === true) elided++;
    if (record.store_open_count != null || record.store_elapsed_ms != null) {
      recordsWithStoreMetric++;
      if (numeric(record.store_open_count) > 0) coldBoots++;
    }
    if (tokensSaved > 0 && (!biggest || tokensSaved > biggest.tokens_saved || (tokensSaved === biggest.tokens_saved && bytesSaved > biggest.bytes_saved))) {
      biggest = { timestamp, command_family: family, tokens_saved: tokensSaved, bytes_saved: bytesSaved };
    }
  }

  const degradationTimeline = degradations
    .map((record) => ({
      timestamp: timestampString(record),
      command_family: commandFamily(stringField(record.command)),
      reason: stringField(record.degradation_reason) || stringField(record.reason) || "unknown",
    }))
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const byReason = new Map<string, number>();
  for (const entry of degradationTimeline) {
    byReason.set(entry.reason, (byReason.get(entry.reason) ?? 0) + 1);
  }
  const degradationClusters = degradationClusterRows(degradationTimeline);
  const recoveryUsage = recoveryUsageRows(showEvents);
  const thresholdSuggestions = thresholdTuningSuggestions([...commandTotals.values()], recoveryUsage, degradationClusters);
  const peakMinute = [...requestsByMinute.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];

  return {
    schema_version: "red.rsp.gains.v1",
    window: {
      requested_days: windowDays,
      data_days: dataDays,
      since,
      until,
      label: `window: ${windowDays}d, data: ${dataDays}d`,
      empty: invocations.length === 0 && degradations.length === 0,
      invocations: invocations.length,
      degradations: degradations.length,
    },
    latency: {
      global: latencyPercentiles(globalLatencies),
      by_command_family: [...latencyByFamily.entries()]
        .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
        .map(([command_family, values]) => ({ command_family, count: values.length, ...latencyPercentiles(values) })),
    },
    throughput: {
      requests_per_day: [...requestsByDay.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, requests]) => ({ date, requests })),
      active_minute_avg: requestsByMinute.size === 0
        ? null
        : round([...requestsByMinute.values()].reduce((sum, value) => sum + value, 0) / requestsByMinute.size),
      peak_minute: peakMinute ? { minute: peakMinute[0], requests: peakMinute[1] } : null,
      hour_weekday_heatmap: renderHeatmapRows(heatmap),
    },
    savings: {
      tokens: tokenSavingsEstimate(totalTokensSaved, tokensEstimated),
      measured_control_holdout: measuredControlHoldout(invocations, holdouts),
      weekly_tokens_saved: weeklySeries(weeklyTokens),
      elision_rate: invocations.length === 0 ? 0 : round(elided / invocations.length),
      top_commands_by_tokens_saved: [...commandTotals.values()]
        .sort((a, b) => b.tokens_saved - a.tokens_saved || b.bytes_saved - a.bytes_saved || a.command_family.localeCompare(b.command_family))
        .slice(0, 10),
      top_commands_by_invocation_count: [...commandTotals.values()]
        .sort((a, b) => b.invocations - a.invocations || b.tokens_saved - a.tokens_saved || a.command_family.localeCompare(b.command_family))
        .slice(0, 10),
      single_biggest_elision: biggest,
    },
    health: {
      degradation_timeline: degradationTimeline,
      degradations_by_reason: [...byReason.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([reason, count]) => ({ reason, count })),
      cold_boots: recordsWithStoreMetric === 0 ? null : coldBoots,
      warm_hits: recordsWithStoreMetric === 0 ? null : Math.max(0, recordsWithStoreMetric - coldBoots),
    },
    mining: {
      recovery_usage_by_family: recoveryUsage,
      degradation_clusters: degradationClusters,
      threshold_tuning_suggestions: thresholdSuggestions,
    },
  };
}

async function readAccountingRecords(db: RedDB, sinceMs: number): Promise<Array<Record<string, unknown>>> {
  const accounting = (await readCollection(db, RSP_ACCOUNTING_EVENTS_COLLECTION))
    .filter((record) => timestampMs(record) >= sinceMs);
  const accountingHasInvocationLike = accounting.some((record) =>
    stringField(record.event_type) !== "show" || stringField(record.degradation_reason) !== ""
  );
  const legacyInvocations = (await readCollection(db, RSP_TELEMETRY_INVOCATIONS_COLLECTION))
    .filter((record) => timestampMs(record) >= sinceMs)
    .filter((record) => !accountingHasInvocationLike && record.accounting_recorded !== true)
    .map((record) => ({ ...record, event_type: stringField(record.event_type) || "invocation" }));
  const legacyDegradations = (await readCollection(db, RSP_TELEMETRY_DEGRADATIONS_COLLECTION))
    .filter((record) => timestampMs(record) >= sinceMs)
    .filter((record) => !accountingHasInvocationLike && record.accounting_recorded !== true)
    .map((record) => ({
      ...record,
      event_type: "invocation",
      degradation_reason: stringField(record.reason) || "unknown",
    }));
  return [...accounting, ...legacyInvocations, ...legacyDegradations];
}

function tokenCountFromCounters(record: Record<string, unknown>, field: "raw" | "emitted"): { tokens: number; estimated: boolean } {
  const exact = optionalNumeric(record[field === "raw" ? "tokens_raw" : "tokens_emitted"]);
  if (exact != null) return { tokens: exact, estimated: false };
  const bytes = numeric(record[field === "raw" ? "raw_bytes" : "emitted_bytes"]);
  return { tokens: Math.ceil(bytes / 4), estimated: bytes > 0 };
}

function measuredControlHoldout(
  invocations: readonly Record<string, unknown>[],
  holdouts: readonly Record<string, unknown>[],
): RspTelemetryGainsReport["savings"]["measured_control_holdout"] {
  const holdoutShare = maxNumeric(holdouts.map((record) => optionalNumeric(record.holdout_share))) ?? 0;
  if (holdouts.length === 0) {
    return {
      enabled: false,
      holdout_share: holdoutShare,
      holdout_invocations: 0,
      compressed_invocations: invocations.length,
      savings_rate: null,
      confidence_interval_95: null,
      note: "control holdout disabled or no holdout samples in window",
    };
  }
  const compressedRates = invocations.map(tokenSavingsRate).filter((value): value is number => value != null);
  const holdoutRates = holdouts.map(tokenSavingsRate).filter((value): value is number => value != null);
  const rates = compressedRates.length > 0 ? compressedRates : holdoutRates;
  const mean = rates.length === 0 ? null : round(meanOf(rates));
  return {
    enabled: true,
    holdout_share: round(holdoutShare),
    holdout_invocations: holdouts.length,
    compressed_invocations: invocations.length,
    savings_rate: mean,
    confidence_interval_95: mean == null ? null : confidenceInterval95(rates, mean),
    note: "measured from opt-in uncompressed control holdout; report proposes, it does not tune automatically",
  };
}

function tokenSavingsRate(record: Record<string, unknown>): number | null {
  const raw = tokenCountFromCounters(record, "raw").tokens;
  if (raw <= 0) return null;
  const emitted = tokenCountFromCounters(record, "emitted").tokens;
  return Math.max(0, raw - emitted) / raw;
}

function confidenceInterval95(values: readonly number[], mean: number): { low: number; high: number } {
  if (values.length <= 1) return { low: round(Math.max(0, mean)), high: round(Math.min(1, mean)) };
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  const margin = 1.96 * Math.sqrt(variance / values.length);
  return {
    low: round(Math.max(0, mean - margin)),
    high: round(Math.min(1, mean + margin)),
  };
}

function recoveryUsageRows(records: readonly Record<string, unknown>[]): RspTelemetryGainsReport["mining"]["recovery_usage_by_family"] {
  const byFamily = new Map<string, { command_family: string; show_total: number; show_hits: number; show_misses: number }>();
  for (const record of records) {
    const family = commandFamily(stringField(record.recovered_command) || stringField(record.command));
    const row = byFamily.get(family) ?? { command_family: family, show_total: 0, show_hits: 0, show_misses: 0 };
    row.show_total++;
    if (record.hit === true) row.show_hits++;
    else row.show_misses++;
    byFamily.set(family, row);
  }
  return [...byFamily.values()]
    .sort((a, b) => b.show_total - a.show_total || a.command_family.localeCompare(b.command_family))
    .map((row) => ({ ...row, show_hit_rate: row.show_total === 0 ? 0 : round(row.show_hits / row.show_total) }));
}

function degradationClusterRows(
  timeline: readonly { timestamp: string; command_family: string; reason: string }[],
): RspTelemetryGainsReport["mining"]["degradation_clusters"] {
  const counts = new Map<string, { command_family: string; reason: string; count: number }>();
  for (const entry of timeline) {
    const key = `${entry.command_family}\0${entry.reason}`;
    const row = counts.get(key) ?? { command_family: entry.command_family, reason: entry.reason, count: 0 };
    row.count++;
    counts.set(key, row);
  }
  return [...counts.values()]
    .sort((a, b) => b.count - a.count || a.command_family.localeCompare(b.command_family) || a.reason.localeCompare(b.reason))
    .map((row) => ({ ...row, suggestion: degradationSuggestion(row) }));
}

function degradationSuggestion(row: { command_family: string; reason: string; count: number }): string {
  if (/unavailable|not provisioned|missing/i.test(row.reason)) {
    return `Investigate ${row.command_family} wrapper availability before changing thresholds`;
  }
  if (/timeout|large|limit/i.test(row.reason)) {
    return `Review ${row.command_family} byte thresholds and timeout caps for ${row.count} matching degradations`;
  }
  return `Investigate ${row.command_family} ${row.reason} cluster before tuning compression thresholds`;
}

function thresholdTuningSuggestions(
  commandTotals: readonly { command_family: string; invocations: number; tokens_saved: number; bytes_saved: number }[],
  recoveryUsage: readonly { command_family: string; show_total: number; show_hits: number; show_misses: number; show_hit_rate: number }[],
  degradationClusters: readonly { command_family: string; reason: string; count: number }[],
): RspTelemetryGainsReport["mining"]["threshold_tuning_suggestions"] {
  const suggestions: RspTelemetryGainsReport["mining"]["threshold_tuning_suggestions"] = [];
  for (const row of recoveryUsage.filter((entry) => entry.show_total > 0)) {
    suggestions.push({
      command_family: row.command_family,
      signal: `recovery_show_rate=${row.show_total}`,
      suggestion: row.show_hit_rate >= 0.5
        ? "Consider preserving more context or raising terse thresholds for frequently recovered outputs"
        : "Recovery misses dominate; inspect handle lifetime before threshold changes",
    });
  }
  for (const row of degradationClusters.filter((entry) => entry.count > 1)) {
    suggestions.push({
      command_family: row.command_family,
      signal: `degradation_cluster=${row.reason}:${row.count}`,
      suggestion: "Fix the repeated degradation before tightening compression",
    });
  }
  for (const row of commandTotals.filter((entry) => entry.invocations > 0 && entry.tokens_saved === 0)) {
    suggestions.push({
      command_family: row.command_family,
      signal: "zero_token_savings",
      suggestion: "Consider bypassing or raising admission thresholds for this family",
    });
  }
  return suggestions.slice(0, 10);
}

function meanOf(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function maxNumeric(values: readonly (number | null)[]): number | null {
  const present = values.filter((value): value is number => value != null);
  return present.length === 0 ? null : Math.max(...present);
}

function accountingStorageClassStats(records: readonly Record<string, unknown>[]): RspStorageClassStats {
  const stats = emptyStorageClassStats();
  for (const record of records) {
    if (stringField(record.event_type) === "show") continue;
    if (stringField(record.degradation_reason) !== "") continue;
    if (record.elided !== true) continue;
    const storageClass = storageClassField(record.storage_class) ?? storageClassForCommand(stringField(record.command));
    stats[storageClass].records += 1;
    const rawBytes = numeric(record.raw_bytes);
    stats[storageClass].bytes += rawBytes;
    stats[storageClass].raw_bytes += rawBytes;
  }
  return stats;
}

function storageClassField(value: unknown): RspStorageClass | null {
  return value === "derivable" || value === "re-executable" || value === "ephemeral" ? value : null;
}

function emptyStorageClassStats(): RspStorageClassStats {
  return {
    derivable: { records: 0, bytes: 0, raw_bytes: 0 },
    "re-executable": { records: 0, bytes: 0, raw_bytes: 0 },
    ephemeral: { records: 0, bytes: 0, raw_bytes: 0 },
  };
}

async function readCollection(db: RedDB, collection: string): Promise<Array<Record<string, unknown>>> {
  const listed = await db.kv(collection).list({ limit: 10_000 }).catch((err: unknown) => {
    if (err instanceof Error && /\bnot found\b/i.test(err.message)) return { items: [] };
    throw err;
  });
  return listed.items
    .map((entry) => parseRecord(entry.value))
    .filter((value): value is Record<string, unknown> => isRecord(value));
}

function parseRecord(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function timestampMs(record: Record<string, unknown>): number {
  const parsed = Date.parse(timestampString(record));
  return Number.isFinite(parsed) ? parsed : 0;
}

function timestampString(record: Record<string, unknown>): string {
  return stringField(record.created_at) || stringField(record.ts) || "";
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return round(sorted[index]!);
}

function latencyPercentiles(values: number[]): LatencyPercentiles {
  return {
    wrapper_ms_p50: percentile(values, 0.5),
    wrapper_ms_p90: percentile(values, 0.9),
    wrapper_ms_p95: percentile(values, 0.95),
    wrapper_ms_p99: percentile(values, 0.99),
  };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function heatmapKeyFor(timestamp: string): string | null {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return null;
  return `${weekdayName(date.getUTCDay())}:${date.getUTCHours()}`;
}

function renderHeatmapRows(heatmap: Map<string, number>): Array<{ weekday: string; hour: number; requests: number }> {
  const rows: Array<{ weekday: string; hour: number; requests: number }> = [];
  for (const weekday of ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]) {
    for (let hour = 0; hour < 24; hour++) {
      const requests = heatmap.get(`${weekday}:${hour}`) ?? 0;
      if (requests > 0) rows.push({ weekday, hour, requests });
    }
  }
  return rows;
}

function weekdayName(day: number): string {
  return ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][day] ?? "unknown";
}

function weekStartDate(timestamp: string): string | null {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return null;
  const day = date.getUTCDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + mondayOffset));
  return start.toISOString().slice(0, 10);
}

function weeklySeries(weeklyTokens: Map<string, number>): Array<{ week_start: string; tokens_saved: number; wow_delta_pct: number | null }> {
  let previous: number | null = null;
  return [...weeklyTokens.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([week_start, tokens_saved]) => {
      const wow_delta_pct = previous == null || previous === 0 ? null : round(((tokens_saved - previous) / previous) * 100);
      previous = tokens_saved;
      return { week_start, tokens_saved, wow_delta_pct };
    });
}

function dayMs(): number {
  return 24 * 60 * 60 * 1000;
}
