import { randomUUID } from "node:crypto";
import type {
  RspElisionRecord,
  RspExpiredHandle,
  RspMintMeta,
  RspRecoveryHandle,
  RspStoreStats,
} from "./elision-store.js";
import type { RspAccountingLaneStats } from "./telemetry.js";
import type { RspTelemetryGainsReport, RspTelemetryStats } from "./telemetry.js";
import type { RspResidentGithubRead, RspResidentGithubResult } from "./resident-github.js";
import type { RspResidentConfig, RspResidentRequest } from "./resident-protocol.js";
import { sendResidentRequest } from "./resident-protocol.js";
import {
  ensureResidentServer,
  kickResidentServer,
  resolveRspEntry,
  RspResidentEntryError,
  RSP_ENTRY_UNRESOLVED,
  pingResident,
  readResidentRegistry,
  removeResidentRegistry,
  residentRegistryStatus,
  resolveResidentPaths,
  sweepResidentRegistry,
  warmResidentServer,
  writeResidentRegistry,
  type ResidentRequestWithoutId,
  type RspResidentRegistryEntry,
  type RspResidentRegistryStatus,
  type RspResidentPaths,
} from "@reddb-io/shared/resident-client.js";

export interface ResidentResponseMetrics {
  storeOpenCount?: number;
  storeElapsedMs?: number;
}

export {
  ensureResidentServer,
  kickResidentServer,
  resolveRspEntry,
  RspResidentEntryError,
  RSP_ENTRY_UNRESOLVED,
  pingResident,
  readResidentRegistry,
  removeResidentRegistry,
  residentRegistryStatus,
  resolveResidentPaths,
  sweepResidentRegistry,
  warmResidentServer,
  writeResidentRegistry,
  type RspResidentPaths,
  type RspResidentRegistryEntry,
  type RspResidentRegistryStatus,
};

/** rsp-side adapter: the elision-store surface, served by the resident. */
export class ResidentRspElisionStore {
  private metrics?: ResidentResponseMetrics;

  constructor(
    private readonly paths: RspResidentPaths,
    private readonly config: RspResidentConfig,
    private readonly opts: { ensureResident?: boolean } = {},
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

  async recoveryHandles(limit = 5): Promise<RspRecoveryHandle[]> {
    return await this.request({ op: "recovery-handles", limit }) as RspRecoveryHandle[];
  }

  async accountingStats(byteBudget: number): Promise<RspAccountingLaneStats> {
    return await this.request({ op: "accounting-stats", byteBudget }) as RspAccountingLaneStats;
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

  async githubRead(input: RspResidentGithubRead): Promise<RspResidentGithubResult> {
    return await this.request({
      op: "github-read",
      args: [...input.args],
      path: input.path,
      actor: input.actor,
      ...(input.params ? { params: { ...input.params } } : {}),
    }) as RspResidentGithubResult;
  }

  async close(): Promise<void> {}

  private async request(request: ResidentRequestWithoutId): Promise<unknown> {
    if (this.opts.ensureResident !== false) await ensureResidentServer(this.paths, this.config);
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
