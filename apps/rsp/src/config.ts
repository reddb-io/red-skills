import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { findUp, flatConfigValue } from "@reddb-io/shared/plugin-gate.js";
import { SHARED_STORE_REL, resolveSharedStorePath } from "@reddb-io/shared/red-paths.js";
import { resolveResidentPaths } from "@reddb-io/shared/resident-client.js";
import {
  DEFAULT_RSP_MAX_OVERHEAD_MS,
  DEFAULT_RSP_MAX_SELF_STATE_BYTES,
  DEFAULT_RSP_OVERHEAD_CONSECUTIVE_BREACHES,
  DEFAULT_RSP_OVERHEAD_COOLDOWN_MS,
  DEFAULT_RSP_OVERHEAD_NET_LOSS_FLOOR_BYTES,
  type RspOverheadCeiling,
} from "./overhead-budget.js";
import { DEFAULT_GH_ETAG_CACHE_MAX_BYTES } from "./gh-etag-cache.js";

export const DEFAULT_RSP_HEAVY_GIT_BYTE_THRESHOLD = 8 * 1024;
/** Canonical shared RedDB store location (state tier); see {@link SHARED_STORE_REL}. */
export const DEFAULT_RSP_STORE_PATH = SHARED_STORE_REL;
export const DEFAULT_RSP_TTL_DAYS = 7;
export const DEFAULT_RSP_EPHEMERAL_TTL_HOURS = 6;
export const DEFAULT_RSP_BYTE_BUDGET = 64 * 1024 * 1024;
export const DEFAULT_RSP_TELEMETRY_TTL_DAYS = 90;
export const DEFAULT_RSP_TELEMETRY_BYTE_BUDGET = 4 * 1024 * 1024;
export const DEFAULT_RSP_TELEMETRY_DRAIN_INTERVAL_MS = 30_000;
export const DEFAULT_RSP_TELEMETRY_DRAIN_TIMEOUT_MS = 2_000;
export const DEFAULT_RSP_IDLE_MS = 5 * 60_000;
export const MIN_RSP_IDLE_MS = 5_000;
export const DEFAULT_RSP_MEASUREMENT_HOLDOUT_SHARE = 0;

export interface RspRuntimeConfig {
  enabled: boolean;
  proxyEnabled: boolean;
  storeUri: string;
  ttlDays: number;
  ephemeralTtlHours: number;
  byteBudget: number;
  telemetryTtlDays: number;
  telemetryByteBudget: number;
  telemetryDrainIntervalMs: number;
  telemetryDrainTimeoutMs: number;
  idleMs: number;
  heavyGitByteThreshold: number;
  measurementHoldoutShare: number;
  /** How large the partitioned `gh` ETag cache may grow before eviction (#2745). */
  ghEtagCacheMaxBytes: number;
  /** The cost side of the ledger: what rsp may spend before it is a defect (#2746). */
  overhead: RspOverheadCeiling;
}

export function resolveRspConfig(cwd: string, env: NodeJS.ProcessEnv, explicitStoreUri?: string): RspRuntimeConfig {
  const configPath = findUp(resolve(cwd), join(".red", "config.yaml"));
  const yaml = configPath ? readFileSync(configPath, "utf8") : "";
  const enabled = flatConfigValue(yaml, "rsp.enabled") === "true";
  // One opt-in, not two: enabling rsp enables proxy routing with it. The key
  // remains only as the opt-out — an explicit `rsp.proxy.enabled: false`.
  const proxyRaw = flatConfigValue(yaml, "rsp.proxy.enabled");
  const proxyEnabled = proxyRaw === undefined ? enabled : proxyRaw === "true";
  const ttlDays = positiveNumber(readNumericYamlPath(yaml, "rsp.ttlDays"), DEFAULT_RSP_TTL_DAYS);
  const ephemeralTtlHours = positiveNumber(
    numericEnv(env.RSP_EPHEMERAL_TTL_HOURS) ?? readNumericYamlPath(yaml, "rsp.ephemeralTtlHours"),
    DEFAULT_RSP_EPHEMERAL_TTL_HOURS,
  );
  const byteBudget = positiveNumber(readNumericYamlPath(yaml, "rsp.byteBudget"), DEFAULT_RSP_BYTE_BUDGET);
  const telemetryTtlDays = positiveNumber(
    readNumericYamlPath(yaml, "rsp.telemetryTtlDays"),
    DEFAULT_RSP_TELEMETRY_TTL_DAYS,
  );
  const telemetryByteBudget = positiveNumber(
    readNumericYamlPath(yaml, "rsp.telemetryByteBudget") ?? readNumericYamlPath(yaml, "rsp.byteBudget"),
    DEFAULT_RSP_TELEMETRY_BYTE_BUDGET,
  );
  const telemetryDrainIntervalMs = positiveNumber(
    numericEnv(env.RSP_TELEMETRY_DRAIN_INTERVAL_MS) ?? readNumericYamlPath(yaml, "rsp.telemetryDrainIntervalMs"),
    DEFAULT_RSP_TELEMETRY_DRAIN_INTERVAL_MS,
  );
  const telemetryDrainTimeoutMs = positiveNumber(
    numericEnv(env.RSP_TELEMETRY_DRAIN_TIMEOUT_MS) ?? readNumericYamlPath(yaml, "rsp.telemetryDrainTimeoutMs"),
    DEFAULT_RSP_TELEMETRY_DRAIN_TIMEOUT_MS,
  );
  const idleMs = minNumber(
    numericEnv(env.RSP_IDLE_MS) ?? readNumericYamlPath(yaml, "rsp.idleMs"),
    DEFAULT_RSP_IDLE_MS,
    MIN_RSP_IDLE_MS,
  );
  const heavyGitByteThreshold = positiveNumber(
    numericEnv(env.RSP_HEAVY_GIT_BYTE_THRESHOLD) ?? readNumericYamlPath(yaml, "rsp.heavyGitByteThreshold"),
    DEFAULT_RSP_HEAVY_GIT_BYTE_THRESHOLD,
  );
  const measurementHoldoutShare = shareNumber(
    numericEnv(env.RSP_MEASUREMENT_HOLDOUT_SHARE) ?? readNumericYamlPath(yaml, "rsp.measurement.holdoutShare"),
    DEFAULT_RSP_MEASUREMENT_HOLDOUT_SHARE,
  );
  const ghEtagCacheMaxBytes = positiveNumber(
    numericEnv(env.RSP_GH_ETAG_CACHE_MAX_BYTES) ?? readNumericYamlPath(yaml, "rsp.ghEtagCacheMaxBytes"),
    DEFAULT_GH_ETAG_CACHE_MAX_BYTES,
  );
  const overhead: RspOverheadCeiling = {
    maxOverheadMs: positiveNumber(
      numericEnv(env.RSP_MAX_OVERHEAD_MS) ?? readNumericYamlPath(yaml, "rsp.overhead.maxOverheadMs"),
      DEFAULT_RSP_MAX_OVERHEAD_MS,
    ),
    maxSelfStateBytes: positiveNumber(
      numericEnv(env.RSP_MAX_SELF_STATE_BYTES) ?? readNumericYamlPath(yaml, "rsp.overhead.maxSelfStateBytes"),
      DEFAULT_RSP_MAX_SELF_STATE_BYTES,
    ),
    netLossFloorBytes: positiveNumber(
      readNumericYamlPath(yaml, "rsp.overhead.netLossFloorBytes"),
      DEFAULT_RSP_OVERHEAD_NET_LOSS_FLOOR_BYTES,
    ),
    consecutiveBreaches: positiveNumber(
      numericEnv(env.RSP_OVERHEAD_CONSECUTIVE_BREACHES) ??
        readNumericYamlPath(yaml, "rsp.overhead.consecutiveBreaches"),
      DEFAULT_RSP_OVERHEAD_CONSECUTIVE_BREACHES,
    ),
    cooldownMs: positiveNumber(
      readNumericYamlPath(yaml, "rsp.overhead.cooldownMs"),
      DEFAULT_RSP_OVERHEAD_COOLDOWN_MS,
    ),
  };
  const storeRoot = resolveResidentPaths(cwd).rootDir;
  const storeUri =
    explicitStoreUri ?? env.RSP_STORE_URI ?? `file://${resolveSharedStorePath(resolve(storeRoot), existsSync)}`;

  return {
    enabled,
    proxyEnabled,
    storeUri,
    ttlDays,
    ephemeralTtlHours,
    byteBudget,
    telemetryTtlDays,
    telemetryByteBudget,
    telemetryDrainIntervalMs,
    telemetryDrainTimeoutMs,
    idleMs,
    heavyGitByteThreshold,
    measurementHoldoutShare,
    ghEtagCacheMaxBytes,
    overhead,
  };
}

function readNumericYamlPath(yaml: string, dottedPath: string): number | undefined {
  const value = flatConfigValue(yaml, dottedPath);
  if (value == null) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function positiveNumber(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function minNumber(value: number | undefined, fallback: number, min: number): number {
  const n = positiveNumber(value, fallback);
  return Math.max(n, min);
}

function shareNumber(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function numericEnv(value: string | undefined): number | undefined {
  if (value == null || value.trim() === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}
