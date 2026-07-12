import { constants } from "node:fs";
import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { connect } from "@reddb-io/sdk";
import { DEFAULT_RSP_HEAVY_GIT_BYTE_THRESHOLD } from "./config.js";
import { DEFAULT_RSP_BYTE_BUDGET, DEFAULT_RSP_TTL_DAYS } from "./elision-store.js";

export const REPO_STORE_PATH = ".red/red.rdb";
const LEGACY_MEMORY_STORE_PATH = ".red/memory/graph.rdb";

export interface RspProvisionOptions {
  ttlDays?: number;
  byteBudget?: number;
  heavyGitByteThreshold?: number;
}

export interface RspProvisionResult {
  configPath: string;
  storePath: string;
  configChanged: boolean;
  storeCreated: boolean;
  memoryStoreMigrated: boolean;
}

export async function provisionRspRepoStore(rootDir: string, opts: RspProvisionOptions = {}): Promise<RspProvisionResult> {
  const root = resolve(rootDir);
  const redDir = join(root, ".red");
  const configPath = join(redDir, "config.yaml");
  const storePath = join(root, REPO_STORE_PATH);
  await mkdir(redDir, { recursive: true });

  let existing = "";
  try {
    existing = await readFile(configPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  let next = mergeRspBlock(existing, {
    enabled: true,
    ttlDays: opts.ttlDays ?? DEFAULT_RSP_TTL_DAYS,
    byteBudget: opts.byteBudget ?? DEFAULT_RSP_BYTE_BUDGET,
    heavyGitByteThreshold: opts.heavyGitByteThreshold ?? DEFAULT_RSP_HEAVY_GIT_BYTE_THRESHOLD,
  });
  const migration = await migrateLegacyMemoryStore(root, next);
  next = migration.configText;
  const configChanged = next !== existing;
  if (configChanged) await writeFile(configPath, next, "utf8");

  const storeCreated = !(await exists(storePath));
  if (storeCreated) {
    const db = await connect(`file://${storePath}`);
    await db.close();
  }

  return { configPath, storePath, configChanged, storeCreated, memoryStoreMigrated: migration.storeCopied };
}

export interface RspConfigBlock {
  enabled: boolean;
  ttlDays: number;
  byteBudget: number;
  heavyGitByteThreshold: number;
}

export function mergeRspBlock(existingText: string, block: RspConfigBlock): string {
  const rspLines = [
    "rsp:",
    `  enabled: ${block.enabled ? "true" : "false"}`,
    `  ttlDays: ${positiveNumber(block.ttlDays, DEFAULT_RSP_TTL_DAYS)}`,
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

async function migrateLegacyMemoryStore(root: string, configText: string): Promise<{ configText: string; storeCopied: boolean }> {
  const lines = configText.replace(/\n+$/, "").split("\n");
  const memoryStart = findPluginsMemoryBlock(lines);
  if (memoryStart === -1) return { configText, storeCopied: false };

  const memoryEnd = findBlockEnd(lines, memoryStart, lineIndent(lines[memoryStart]!));
  const memoryLines = lines.slice(memoryStart, memoryEnd);
  const mode = readNestedValue(memoryLines, "mode");
  const currentStorePath = readNestedValue(memoryLines, "storePath");
  const pointsAtLegacy = currentStorePath === LEGACY_MEMORY_STORE_PATH || (currentStorePath == null && mode === "graph");
  if (!pointsAtLegacy) return { configText, storeCopied: false };

  const targetPath = join(root, REPO_STORE_PATH);
  let storeCopied = false;
  if ((await exists(join(root, LEGACY_MEMORY_STORE_PATH))) && !(await exists(targetPath))) {
    await copyFile(join(root, LEGACY_MEMORY_STORE_PATH), targetPath);
    storeCopied = true;
  }

  const next = upsertNestedValue(lines, memoryStart, memoryEnd, "storePath", REPO_STORE_PATH);
  return { configText: `${next.join("\n")}\n`, storeCopied };
}

function findPluginsMemoryBlock(lines: string[]): number {
  const pluginsStart = findTopLevelBlock(lines, "plugins");
  if (pluginsStart === -1) return -1;
  const pluginsEnd = findBlockEnd(lines, pluginsStart, 0);
  for (let i = pluginsStart + 1; i < pluginsEnd; i++) {
    const line = lines[i]!;
    if (isStructural(line) && lineIndent(line) === 2 && topKey(line) === "memory") return i;
  }
  return -1;
}

function readNestedValue(lines: string[], key: string): string | undefined {
  for (const line of lines.slice(1)) {
    if (!isStructural(line) || lineIndent(line) !== 4 || topKey(line) !== key) continue;
    return stripInlineComment(line.replace(/^ */, "").replace(/^[^:]+:/, "")).replace(/^["']|["']$/g, "");
  }
  return undefined;
}

function upsertNestedValue(lines: string[], start: number, end: number, key: string, value: string): string[] {
  for (let i = start + 1; i < end; i++) {
    if (isStructural(lines[i]!) && lineIndent(lines[i]!) === 4 && topKey(lines[i]!) === key) {
      return [...lines.slice(0, i), `    ${key}: ${value}`, ...lines.slice(i + 1)];
    }
  }
  return [...lines.slice(0, end), `    ${key}: ${value}`, ...lines.slice(end)];
}

function stripInlineComment(value: string): string {
  const hash = value.indexOf(" #");
  return (hash >= 0 ? value.slice(0, hash) : value).trim();
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
