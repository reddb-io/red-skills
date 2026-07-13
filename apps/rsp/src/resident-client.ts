import { randomUUID } from "node:crypto";
import type {
  RspElisionRecord,
  RspExpiredHandle,
  RspMintMeta,
  RspStoreStats,
} from "./elision-store.js";
import type { RspTelemetryGainsReport, RspTelemetryStats } from "./telemetry.js";
import type { RspResidentConfig, RspResidentRequest } from "./resident-protocol.js";
import { sendResidentRequest } from "./resident-protocol.js";
import {
  ensureResidentServer,
  kickResidentServer,
  pingResident,
  resolveResidentPaths,
  warmResidentServer,
  type ResidentRequestWithoutId,
  type RspResidentPaths,
} from "@reddb-io/shared/resident-client.js";

export interface ResidentResponseMetrics {
  storeOpenCount?: number;
  storeElapsedMs?: number;
}

export {
  ensureResidentServer,
  kickResidentServer,
  pingResident,
  resolveResidentPaths,
  warmResidentServer,
  type RspResidentPaths,
};

/** rsp-side adapter: the elision-store surface, served by the resident. */
export class ResidentRspElisionStore {
  private metrics?: ResidentResponseMetrics;

  constructor(
    private readonly paths: RspResidentPaths,
    private readonly config: RspResidentConfig,
  ) {}

  lastResponseMetrics(): ResidentResponseMetrics | undefined {
    return this.metrics;
  }

  async mint(original: Uint8Array | Buffer, meta: RspMintMeta): Promise<`el:${string}`> {
    const response = await this.request({
      op: "mint",
      original: Buffer.from(original).toString("base64"),
      meta,
    });
    const handle = (response as { handle?: string }).handle;
    if (!handle?.startsWith("el:")) throw new Error("resident rsp returned invalid handle");
    return handle as `el:${string}`;
  }

  async get(handle: string): Promise<RspElisionRecord | RspExpiredHandle | null> {
    const raw = await this.request({ op: "get", handle });
    if (!raw) return null;
    if (isRecord(raw) && raw.status === "expired") return raw as unknown as RspExpiredHandle;
    if (!isRecord(raw) || typeof raw.original !== "string") return null;
    return {
      ...(raw as Omit<RspElisionRecord, "original">),
      original: Buffer.from(raw.original, "base64"),
    } as RspElisionRecord;
  }

  async stats(): Promise<RspStoreStats> {
    return await this.request({ op: "stats" }) as RspStoreStats;
  }

  async telemetryStats(sinceDays: number): Promise<RspTelemetryStats> {
    return await this.request({ op: "telemetry-stats", sinceDays }) as RspTelemetryStats;
  }

  async telemetryGains(sinceDays: number): Promise<RspTelemetryGainsReport> {
    return await this.request({ op: "telemetry-gains", sinceDays }) as RspTelemetryGainsReport;
  }

  async memory(action: "recall" | "ingest", payload: unknown): Promise<unknown> {
    return await this.request({ op: "memory", action, payload });
  }

  async close(): Promise<void> {}

  private async request(request: ResidentRequestWithoutId): Promise<unknown> {
    await ensureResidentServer(this.paths, this.config);
    const response = await sendResidentRequest(this.paths, { ...request, id: randomUUID() } as RspResidentRequest);
    if (!response.ok) throw new Error(response.error);
    this.metrics = {
      storeOpenCount: response.storeOpenCount,
      storeElapsedMs: response.storeElapsedMs,
    };
    return response.value;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
