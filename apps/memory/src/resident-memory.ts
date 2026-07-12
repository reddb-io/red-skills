import { resolve } from "node:path";
import {
  ResidentRspClient,
  resolveResidentPaths,
} from "@reddb-io/shared/resident-client.js";
import type { MemoryConfig } from "./config.js";

const DEFAULT_RSP_STORE_PATH = ".red/tmp/red-skills.rdb";
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
  if (storePath === DEFAULT_RSP_STORE_PATH) return true;
  return resolve(rootDir, storePath).endsWith(`/${DEFAULT_RSP_STORE_PATH}`);
}

export async function residentMemoryRequest(
  rootDir: string,
  config: MemoryConfig,
  action: "recall" | "ingest",
  payload: ResidentRecallPayload | ResidentIngestPayload,
): Promise<unknown> {
  const paths = resolveResidentPaths(rootDir);
  const client = new ResidentRspClient(paths, {
    storeUri: `file://${resolve(rootDir, DEFAULT_RSP_STORE_PATH)}`,
    ttlDays: DEFAULT_RSP_TTL_DAYS,
    byteBudget: DEFAULT_RSP_BYTE_BUDGET,
    serverCommand: process.env.RSP_BIN ?? "rsp",
  });
  return await client.request({ op: "memory", action, payload });
}
