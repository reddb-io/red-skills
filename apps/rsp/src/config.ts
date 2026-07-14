import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { findUp, flatConfigValue } from "@reddb-io/shared/plugin-gate.js";
import { resolveResidentPaths } from "@reddb-io/shared/resident-client.js";

export const DEFAULT_RSP_HEAVY_GIT_BYTE_THRESHOLD = 8 * 1024;
export const DEFAULT_RSP_STORE_PATH = ".red/tmp/red-skills.rdb";
export const DEFAULT_RSP_TTL_DAYS = 7;
export const DEFAULT_RSP_EPHEMERAL_TTL_HOURS = 6;
export const DEFAULT_RSP_BYTE_BUDGET = 64 * 1024 * 1024;
export const DEFAULT_RSP_TELEMETRY_TTL_DAYS = 90;
export const DEFAULT_RSP_TELEMETRY_BYTE_BUDGET = 4 * 1024 * 1024;
export const DEFAULT_RSP_TELEMETRY_DRAIN_INTERVAL_MS = 30_000;
export const DEFAULT_RSP_TELEMETRY_DRAIN_TIMEOUT_MS = 2_000;
export const DEFAULT_RSP_IDLE_MS = 5 * 60_000;
export const MIN_RSP_IDLE_MS = 5_000;

export interface RspRuntimeConfig {
  enabled: boolean;
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
}

export function resolveRspConfig(cwd: string, env: NodeJS.ProcessEnv, explicitStoreUri?: string): RspRuntimeConfig {
  const configPath = findUp(resolve(cwd), join(".red", "config.yaml"));
  const yaml = configPath ? readFileSync(configPath, "utf8") : "";
  const enabled = flatConfigValue(yaml, "rsp.enabled") === "true";
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
  const storeRoot = resolveResidentPaths(cwd).rootDir;
  const storeUri = explicitStoreUri ?? env.RSP_STORE_URI ?? `file://${join(resolve(storeRoot), DEFAULT_RSP_STORE_PATH)}`;

  return {
    enabled,
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

function numericEnv(value: string | undefined): number | undefined {
  if (value == null || value.trim() === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}
