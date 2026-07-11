import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DEFAULT_RSP_BYTE_BUDGET, DEFAULT_RSP_TTL_DAYS } from "./elision-store.js";

export const DEFAULT_RSP_HEAVY_GIT_BYTE_THRESHOLD = 8 * 1024;

export interface RspRuntimeConfig {
  enabled: boolean;
  storeUri: string;
  ttlDays: number;
  byteBudget: number;
  heavyGitByteThreshold: number;
}

export function resolveRspConfig(cwd: string, env: NodeJS.ProcessEnv, explicitStoreUri?: string): RspRuntimeConfig {
  const configPath = findUp(cwd, join(".red", "config.yaml"));
  const root = configPath ? dirname(dirname(configPath)) : cwd;
  const yaml = configPath ? readFileSync(configPath, "utf8") : "";
  const enabled = readYamlPath(yaml, "rsp.enabled") === "true";
  const ttlDays = positiveNumber(readNumericYamlPath(yaml, "rsp.ttlDays"), DEFAULT_RSP_TTL_DAYS);
  const byteBudget = positiveNumber(readNumericYamlPath(yaml, "rsp.byteBudget"), DEFAULT_RSP_BYTE_BUDGET);
  const heavyGitByteThreshold = positiveNumber(
    numericEnv(env.RSP_HEAVY_GIT_BYTE_THRESHOLD) ?? readNumericYamlPath(yaml, "rsp.heavyGitByteThreshold"),
    DEFAULT_RSP_HEAVY_GIT_BYTE_THRESHOLD,
  );
  const storeUri = explicitStoreUri ?? env.RSP_STORE_URI ?? `file://${join(resolve(root), ".red", "red.rdb")}`;

  return { enabled, storeUri, ttlDays, byteBudget, heavyGitByteThreshold };
}

function findUp(start: string, relativePath: string): string | null {
  let dir = resolve(start);
  for (let i = 0; i < 32; i++) {
    const candidate = join(dir, relativePath);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

function readNumericYamlPath(yaml: string, dottedPath: string): number | undefined {
  const value = readYamlPath(yaml, dottedPath);
  if (value == null) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function readYamlPath(yaml: string, dottedPath: string): string | undefined {
  const target = dottedPath.split(".");
  const stack: Array<{ indent: number; key: string }> = [];
  for (const rawLine of yaml.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const indent = line.length - line.trimStart().length;
    const key = line.slice(0, colon).trim();
    if (!key) continue;
    const value = stripInlineComment(line.slice(colon + 1));
    while (stack.length > 0 && stack[stack.length - 1]!.indent >= indent) stack.pop();
    stack.push({ indent, key });
    if (value !== "" && stack.map((entry) => entry.key).join(".") === target.join(".")) return value;
  }
  return undefined;
}

function stripInlineComment(value: string): string {
  const hash = value.indexOf(" #");
  return (hash >= 0 ? value.slice(0, hash) : value).trim();
}

function positiveNumber(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function numericEnv(value: string | undefined): number | undefined {
  if (value == null || value.trim() === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}
