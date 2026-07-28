import { constants } from "node:fs";
import { access, copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { LEGACY_SHARED_STORE_REL } from "@reddb-io/shared/red-paths.js";
import {
  DEFAULT_RSP_BYTE_BUDGET,
  DEFAULT_RSP_EPHEMERAL_TTL_HOURS,
  DEFAULT_RSP_HEAVY_GIT_BYTE_THRESHOLD,
  DEFAULT_RSP_STORE_PATH,
  DEFAULT_RSP_TTL_DAYS,
} from "./config.js";

export const REPO_STORE_PATH = DEFAULT_RSP_STORE_PATH;
const LEGACY_STORE_PATH = LEGACY_SHARED_STORE_REL;
const LEGACY_MEMORY_STORE_PATH = ".red/memory/graph.rdb";

export interface RspProvisionOptions {
  ttlDays?: number;
  ephemeralTtlHours?: number;
  byteBudget?: number;
  heavyGitByteThreshold?: number;
}

export interface RspProvisionResult {
  configPath: string;
  storePath: string;
  configChanged: boolean;
  storeCreated: boolean;
  memoryStoreMigrated: boolean;
  legacyStoreMigrated: boolean;
}

export async function provisionRspRepoStore(rootDir: string, opts: RspProvisionOptions = {}): Promise<RspProvisionResult> {
  const root = resolve(rootDir);
  const redDir = join(root, ".red");
  const configPath = join(redDir, "config.yaml");
  const storePath = join(root, REPO_STORE_PATH);
  await mkdir(redDir, { recursive: true });
  // The store lives under .red/state/, which need not exist yet.
  await mkdir(dirname(storePath), { recursive: true });

  let existing = "";
  try {
    existing = await readFile(configPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  const next = mergeRspBlock(existing, {
    enabled: true,
    ttlDays: opts.ttlDays ?? DEFAULT_RSP_TTL_DAYS,
    ephemeralTtlHours: opts.ephemeralTtlHours ?? DEFAULT_RSP_EPHEMERAL_TTL_HOURS,
    byteBudget: opts.byteBudget ?? DEFAULT_RSP_BYTE_BUDGET,
    heavyGitByteThreshold: opts.heavyGitByteThreshold ?? DEFAULT_RSP_HEAVY_GIT_BYTE_THRESHOLD,
  });
  const configChanged = next !== existing;
  if (configChanged) await writeFile(configPath, next, "utf8");

  const storeCreated = !(await exists(storePath));
  let memoryStoreMigrated = false;
  let legacyStoreMigrated = false;
  if (storeCreated) {
    const legacyStore = join(root, LEGACY_STORE_PATH);
    const legacyMemoryStore = join(root, LEGACY_MEMORY_STORE_PATH);
    if (await exists(legacyStore)) {
      // One-time move of the pre-ADR-0098 tmp-tier store into the state tier.
      // After the move the state store exists, so a rerun is a no-op.
      await rename(legacyStore, storePath);
      legacyStoreMigrated = true;
    } else if (await exists(legacyMemoryStore)) {
      await copyFile(legacyMemoryStore, storePath);
      memoryStoreMigrated = true;
    } else {
      const { provisionElisionStore } = await import("./elision-store.js");
      // Provisioning must not leak env into the caller: the store open may
      // resolve REDDB_BIN from the warm cache, so restore whatever was there.
      const priorReddbBin = process.env.REDDB_BIN;
      try {
        await provisionElisionStore({
          uri: `file://${storePath}`,
          ttlDays: opts.ttlDays ?? DEFAULT_RSP_TTL_DAYS,
          ephemeralTtlHours: opts.ephemeralTtlHours ?? DEFAULT_RSP_EPHEMERAL_TTL_HOURS,
          byteBudget: opts.byteBudget ?? DEFAULT_RSP_BYTE_BUDGET,
        });
      } finally {
        if (priorReddbBin === undefined) delete process.env.REDDB_BIN;
        else process.env.REDDB_BIN = priorReddbBin;
      }
    }
  }
  const memoryConfig = repointMemoryStore(next, REPO_STORE_PATH);
  if (memoryConfig !== next) await writeFile(configPath, memoryConfig, "utf8");

  return {
    configPath,
    storePath,
    configChanged: configChanged || memoryConfig !== next,
    storeCreated,
    memoryStoreMigrated,
    legacyStoreMigrated,
  };
}

export interface RspConfigBlock {
  enabled: boolean;
  ttlDays: number;
  ephemeralTtlHours: number;
  byteBudget: number;
  heavyGitByteThreshold: number;
}

export function mergeRspBlock(existingText: string, block: RspConfigBlock): string {
  const rspLines = [
    "rsp:",
    `  enabled: ${block.enabled ? "true" : "false"}`,
    `  ttlDays: ${positiveNumber(block.ttlDays, DEFAULT_RSP_TTL_DAYS)}`,
    `  ephemeralTtlHours: ${positiveNumber(block.ephemeralTtlHours, DEFAULT_RSP_EPHEMERAL_TTL_HOURS)}`,
    `  byteBudget: ${positiveNumber(block.byteBudget, DEFAULT_RSP_BYTE_BUDGET)}`,
    `  heavyGitByteThreshold: ${positiveNumber(block.heavyGitByteThreshold, DEFAULT_RSP_HEAVY_GIT_BYTE_THRESHOLD)}`,
  ];
  const lines = existingText === "" ? [] : existingText.replace(/\n+$/, "").split("\n");
  const start = findTopLevelBlock(lines, "rsp");

  if (start === -1) {
    const out = [...lines];
    if (out.length > 0 && out[out.length - 1]!.trim() !== "") out.push("");
    out.push(...rspLines);
    return `${out.join("\n")}\n`;
  }

  const end = findBlockEnd(lines, start, 0);
  const out = [...lines.slice(0, start), ...rspLines, ...lines.slice(end)];
  return `${out.join("\n")}\n`;
}

function findTopLevelBlock(lines: string[], key: string): number {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (isStructural(line) && lineIndent(line) === 0 && topKey(line) === key) return i;
  }
  return -1;
}

function findBlockEnd(lines: string[], start: number, indent: number): number {
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (isStructural(lines[i]!) && lineIndent(lines[i]!) <= indent) {
      end = i;
      break;
    }
  }
  while (end - 1 > start && lines[end - 1]!.trim() === "") end--;
  return end;
}

function lineIndent(line: string): number {
  return (line.match(/^ */)?.[0] ?? "").length;
}

function isStructural(line: string): boolean {
  const t = line.trim();
  return t !== "" && !t.startsWith("#");
}

function topKey(line: string): string {
  return line.replace(/^ */, "").replace(/:.*$/, "").trim();
}

function positiveNumber(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function repointMemoryStore(existingText: string, storePath: string): string {
  const lines = existingText === "" ? [] : existingText.replace(/\n+$/, "").split("\n");
  const plugins = findTopLevelBlock(lines, "plugins");
  if (plugins === -1) return existingText;
  const pluginsEnd = findBlockEnd(lines, plugins, 0);
  const memory = findNestedBlock(lines, "memory", plugins + 1, pluginsEnd, 2);
  if (memory === -1) return existingText;
  const memoryEnd = findBlockEnd(lines, memory, 2);
  const out = [...lines];
  const existingStorePath = findNestedBlock(out, "storePath", memory + 1, memoryEnd, 4);
  if (existingStorePath !== -1) {
    out[existingStorePath] = `    storePath: ${storePath}`;
  } else {
    out.splice(memoryEnd, 0, `    storePath: ${storePath}`);
  }
  return `${out.join("\n")}\n`;
}

function findNestedBlock(lines: string[], key: string, start: number, end: number, indent: number): number {
  for (let i = start; i < end; i++) {
    const line = lines[i]!;
    if (isStructural(line) && lineIndent(line) === indent && topKey(line) === key) return i;
  }
  return -1;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
