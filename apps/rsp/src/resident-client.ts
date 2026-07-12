import type {
  RspElisionRecord,
  RspExpiredHandle,
  RspMintMeta,
  RspStoreStats,
} from "./elision-store.js";
import type { RspResidentConfig } from "./resident-protocol.js";
import {
  ResidentRspClient,
  ensureResidentServer,
  resolveResidentPaths,
  type RspResidentPaths,
} from "@reddb-io/shared/resident-client.js";

export { ensureResidentServer, resolveResidentPaths, type RspResidentPaths };

export class ResidentRspElisionStore {
  private readonly client: ResidentRspClient;

  constructor(paths: RspResidentPaths, config: RspResidentConfig) {
    this.client = new ResidentRspClient(paths, config);
  }

  async mint(original: Uint8Array | Buffer, meta: RspMintMeta): Promise<`el:${string}`> {
    const response = await this.client.request({
      op: "mint",
      original: Buffer.from(original).toString("base64"),
      meta,
    });
    const handle = (response as { handle?: string }).handle;
    if (!handle?.startsWith("el:")) throw new Error("resident rsp returned invalid handle");
    return handle as `el:${string}`;
  }

  async get(handle: string): Promise<RspElisionRecord | RspExpiredHandle | null> {
    const raw = await this.client.request({ op: "get", handle });
    if (!raw) return null;
    if (isRecord(raw) && raw.status === "expired") return raw as unknown as RspExpiredHandle;
    if (!isRecord(raw) || typeof raw.original !== "string") return null;
    return {
      ...(raw as Omit<RspElisionRecord, "original">),
      original: Buffer.from(raw.original, "base64"),
    } as RspElisionRecord;
  }

  async stats(): Promise<RspStoreStats> {
    return await this.client.request({ op: "stats" }) as RspStoreStats;
  }

  async memory(action: "recall" | "ingest", payload: unknown): Promise<unknown> {
    return await this.client.request({ op: "memory", action, payload });
  }

  async close(): Promise<void> {}
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
