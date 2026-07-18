import type { RspStorageClassStats } from "../elision-store.js";
import type { TokenSavingsEstimate } from "../pricing.js";

/** Durable telemetry spool filenames; they live in the rsp state lane (ADR 0098). */
export const RSP_TELEMETRY_SPOOL_FILE = "rsp-telemetry.spool.toonl";
export const RSP_TELEMETRY_LEGACY_SPOOL_FILE = "rsp-telemetry.spool.jsonl";
export const RSP_TELEMETRY_SPOOL_CORRECTIONS_FILE = "rsp-telemetry.spool.corrections.toonl";
export const RSP_ACCOUNTING_EVENTS_COLLECTION = "rsp_accounting_events_v1";
export const RSP_DECISIONS_COLLECTION = "rsp_decisions_v1";
export const RSP_TELEMETRY_INVOCATIONS_COLLECTION = "rsp_telemetry_invocations_v1";
export const RSP_TELEMETRY_DEGRADATIONS_COLLECTION = "rsp_telemetry_degradations_v1";
export const RSP_TELEMETRY_INDEX_COLLECTION = "rsp_telemetry_index_v1";

export interface RspTelemetryEvent {
  collection:
    | typeof RSP_ACCOUNTING_EVENTS_COLLECTION
    | typeof RSP_DECISIONS_COLLECTION
    | typeof RSP_TELEMETRY_INVOCATIONS_COLLECTION
    | typeof RSP_TELEMETRY_DEGRADATIONS_COLLECTION;
  id?: string;
  created_at?: string;
  bytes?: number;
  raw_text?: string;
  emitted_text?: string;
  raw_bytes?: number;
  emitted_bytes?: number;
  tokens_raw?: number;
  tokens_emitted?: number;
  estimated?: boolean;
  [key: string]: unknown;
}

export interface RspAccountingLaneStats {
  records: number;
  bytes: number;
  oldest: string | null;
  budget: number;
  storage_classes: RspStorageClassStats;
}

export interface RspTelemetryStats {
  window_days: number;
  empty: boolean;
  savings: {
    invocations: number;
    elided: number;
    raw_bytes: number;
    emitted_bytes: number;
    bytes_saved: number;
    tokens_saved: number;
    tokens_saved_estimated: boolean;
    token_estimate_range_pct: number | null;
    tokens_saved_low: number | null;
    tokens_saved_high: number | null;
    dollars_saved_estimate_usd: number;
    dollars_saved_low_usd: number | null;
    dollars_saved_high_usd: number | null;
    pricing_model_family: string;
    pricing_input_usd_per_million_tokens: number;
    pricing_note: string;
    daily_tokens_saved: Array<{ date: string; tokens_saved: number }>;
    top_commands: Array<{ command: string; invocations: number; bytes_saved: number; tokens_saved: number }>;
  };
  health: {
    degradations: number;
    degradation_rate: number;
    show_total: number;
    show_hits: number;
    show_misses: number;
    show_hit_rate: number;
    by_reason: Array<{ reason: string; count: number }>;
    by_family: Array<{ family: string; count: number }>;
    recent_failures: Array<{
      timestamp: string;
      family: string;
      command: string;
      reason: string;
      exit_code: number | null;
      stderr_head: string | null;
    }>;
    most_recent: { timestamp: string; reason: string; command: string } | null;
  };
  latency: {
    wrapper_ms_p50: number | null;
    wrapper_ms_p95: number | null;
    store_open_count_sum: number;
    store_elapsed_ms_sum: number;
    store_elapsed_ms_avg: number | null;
  };
  decisions: {
    seen: number;
    contributed: number;
    passed: number;
    failed_open: number;
    quota_free_saved_units: number;
    contribution_rate: number;
    top_pass_reasons: Array<{ reason: string; count: number }>;
  };
}

export interface RspTelemetryGainsReport {
  schema_version: "red.rsp.gains.v1";
  window: {
    requested_days: number;
    data_days: number;
    since: string;
    until: string;
    label: string;
    empty: boolean;
    invocations: number;
    degradations: number;
  };
  latency: {
    global: LatencyPercentiles;
    by_command_family: Array<{ command_family: string; count: number } & LatencyPercentiles>;
  };
  throughput: {
    requests_per_day: Array<{ date: string; requests: number }>;
    active_minute_avg: number | null;
    peak_minute: { minute: string; requests: number } | null;
    hour_weekday_heatmap: Array<{ weekday: string; hour: number; requests: number }>;
  };
  savings: {
    tokens: TokenSavingsEstimate;
    measured_control_holdout: {
      enabled: boolean;
      holdout_share: number;
      holdout_invocations: number;
      compressed_invocations: number;
      savings_rate: number | null;
      confidence_interval_95: { low: number; high: number } | null;
      note: string;
    };
    weekly_tokens_saved: Array<{ week_start: string; tokens_saved: number; wow_delta_pct: number | null }>;
    elision_rate: number;
    top_commands_by_tokens_saved: Array<{ command_family: string; invocations: number; tokens_saved: number; bytes_saved: number }>;
    top_commands_by_invocation_count: Array<{ command_family: string; invocations: number; tokens_saved: number; bytes_saved: number }>;
    single_biggest_elision: {
      timestamp: string;
      command_family: string;
      tokens_saved: number;
      bytes_saved: number;
    } | null;
  };
  health: {
    degradation_timeline: Array<{ timestamp: string; command_family: string; reason: string }>;
    degradations_by_reason: Array<{ reason: string; count: number }>;
    cold_boots: number | null;
    warm_hits: number | null;
  };
  mining: {
    recovery_usage_by_family: Array<{ command_family: string; show_total: number; show_hits: number; show_misses: number; show_hit_rate: number }>;
    degradation_clusters: Array<{ command_family: string; reason: string; count: number; suggestion: string }>;
    threshold_tuning_suggestions: Array<{ command_family: string; signal: string; suggestion: string }>;
  };
}

export interface LatencyPercentiles {
  wrapper_ms_p50: number | null;
  wrapper_ms_p90: number | null;
  wrapper_ms_p95: number | null;
  wrapper_ms_p99: number | null;
}
