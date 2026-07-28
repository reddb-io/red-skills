import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  SHARED_STORE_REL,
  isLegacySharedStorePath,
  legacySharedStoreError,
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
  if (isLegacySharedStorePath(rootDir, storePath)) throw legacySharedStoreError();
  if (storePath === SHARED_STORE_REL) return true;
  return resolve(rootDir, storePath) === resolve(rootDir, SHARED_STORE_REL);
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
    // No `serverCommand`: the client resolves the rsp entry explicitly (#2736).
    // A bare `rsp` on PATH was a guess that failed silently off the shim.
  });
  return await client.request({ op: "memory", action, payload });
}
