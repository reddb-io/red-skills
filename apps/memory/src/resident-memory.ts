import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  LEGACY_SHARED_STORE_REL,
  SHARED_STORE_REL,
  resolveSharedStorePath,
} from "@reddb-io/shared/red-paths.js";
import {
  ResidentRspClient,
  resolveResidentPaths,
} from "@reddb-io/shared/resident-client.js";
import type { MemoryConfig } from "./config.js";

const DEFAULT_RSP_TTL_DAYS = 7;
const DEFAULT_RSP_BYTE_BUDGET = 64 * 1024 * 1024;

export interface ResidentRecallPayload {
  query: string;
  limit: number;
  includeSuperseded?: boolean;
  scope?: unknown;
  ranking?: unknown;
}

export interface ResidentIngestPayload {
  cwd: string;
  maxFiles?: number;
  ignore?: string[];
}

export function shouldUseResidentMemory(rootDir: string, config: MemoryConfig): boolean {
  if (config.mode !== "graph") return false;
  const storePath = config.storePath ?? "";
  // Accept both the canonical state-tier path and the legacy tmp-tier path so a
  // config pointed at either resolves to the resident during the transition.
  for (const rel of [SHARED_STORE_REL, LEGACY_SHARED_STORE_REL]) {
    if (storePath === rel) return true;
    if (resolve(rootDir, storePath).endsWith(`/${rel}`)) return true;
  }
  return false;
}

export async function residentMemoryRequest(
  rootDir: string,
  config: MemoryConfig,
  action: "recall" | "ingest",
  payload: ResidentRecallPayload | ResidentIngestPayload,
): Promise<unknown> {
  const paths = resolveResidentPaths(rootDir);
  const client = new ResidentRspClient(paths, {
    storeUri: `file://${resolveSharedStorePath(resolve(rootDir), existsSync)}`,
    ttlDays: DEFAULT_RSP_TTL_DAYS,
    byteBudget: DEFAULT_RSP_BYTE_BUDGET,
    serverCommand: process.env.RSP_BIN ?? "rsp",
  });
  return await client.request({ op: "memory", action, payload });
}
