import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { findUp, flatConfigValue } from "@reddb-io/shared/plugin-gate.js";

export const DEFAULT_RSP_HEAVY_GIT_BYTE_THRESHOLD = 8 * 1024;
export const DEFAULT_RSP_STORE_PATH = ".red/tmp/red-skills.rdb";
export const DEFAULT_RSP_TTL_DAYS = 7;
export const DEFAULT_RSP_BYTE_BUDGET = 64 * 1024 * 1024;
export const DEFAULT_RSP_TELEMETRY_TTL_DAYS = 90;
export const DEFAULT_RSP_TELEMETRY_BYTE_BUDGET = 4 * 1024 * 1024;
export const DEFAULT_RSP_TELEMETRY_DRAIN_INTERVAL_MS = 30_000;

export interface RspRuntimeConfig {
  enabled: boolean;
  storeUri: string;
  ttlDays: number;
  byteBudget: number;
  telemetryTtlDays: number;
  telemetryByteBudget: number;
  telemetryDrainIntervalMs: number;
  heavyGitByteThreshold: number;
}

export function resolveRspConfig(cwd: string, env: NodeJS.ProcessEnv, explicitStoreUri?: string): RspRuntimeConfig {
  const configPath = findUp(resolve(cwd), join(".red", "config.yaml"));
  const root = configPath ? dirname(dirname(configPath)) : cwd;
  const yaml = configPath ? readFileSync(configPath, "utf8") : "";
  const enabled = flatConfigValue(yaml, "rsp.enabled") === "true";
  const ttlDays = positiveNumber(readNumericYamlPath(yaml, "rsp.ttlDays"), DEFAULT_RSP_TTL_DAYS);
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
  const heavyGitByteThreshold = positiveNumber(
    numericEnv(env.RSP_HEAVY_GIT_BYTE_THRESHOLD) ?? readNumericYamlPath(yaml, "rsp.heavyGitByteThreshold"),
    DEFAULT_RSP_HEAVY_GIT_BYTE_THRESHOLD,
  );
  const storeUri = explicitStoreUri ?? env.RSP_STORE_URI ?? `file://${join(resolve(root), DEFAULT_RSP_STORE_PATH)}`;

  return {
    enabled,
    storeUri,
    ttlDays,
    byteBudget,
    telemetryTtlDays,
    telemetryByteBudget,
    telemetryDrainIntervalMs,
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

function numericEnv(value: string | undefined): number | undefined {
  if (value == null || value.trim() === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}
