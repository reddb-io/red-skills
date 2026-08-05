import { sendLineRequest } from "./resident-core.js";

export interface RspResidentConfig {
  storeUri: string;
  ttlDays: number;
  ephemeralTtlHours?: number;
  byteBudget: number;
  clientVersion?: string;
  telemetryTtlDays?: number;
  telemetryByteBudget?: number;
  telemetryDrainIntervalMs?: number;
  telemetryDrainTimeoutMs?: number;
  idleMs?: number;
  serverCommand?: string;
  serverArgs?: string[];
}

export type RspResidentRequest =
  | { id: string; op: "ping" }
  | { id: string; op: "handover"; clientVersion: string }
  | { id: string; op: "stats" }
  | { id: string; op: "recovery-handles"; limit: number }
  | { id: string; op: "accounting-stats"; byteBudget: number }
  | { id: string; op: "telemetry-stats"; sinceDays: number }
  | { id: string; op: "telemetry-gains"; sinceDays: number }
  | { id: string; op: "mint"; original: string; meta: unknown }
  | { id: string; op: "get"; handle: string }
  | {
      id: string;
      op: "github-read";
      args: string[];
      path: string;
      params?: Record<string, string | number | boolean | undefined>;
      actor: string;
    }
  | { id: string; op: "memory"; action: "recall" | "ingest"; payload: unknown }
  | { id: string; op: "brain"; action: BrainResidentAction; payload?: unknown };

export type BrainResidentAction =
  | "status"
  | "capture"
  | "getArtifact"
  | "listArtifacts"
  | "search"
  | "think"
  | "link"
  | "backlinks"
  | "listConnections"
  | "eventKpis"
  | "appendOutcomeEvent"
  | "replayOutcomeEvents"
  | "loadModelTierBanditDocument"
  | "saveModelTierBanditDocument"
  | "refreshModelTierBanditDocument";

export type RspResidentResponse =
  | { id: string; ok: true; value: unknown; storeOpenCount?: number; storeElapsedMs?: number }
  | { id: string; ok: false; error: string };

export interface RspResidentClientOptions {
  socketPath: string;
  timeoutMs?: number;
}

export async function sendResidentRequest(
  opts: RspResidentClientOptions,
  request: RspResidentRequest,
): Promise<RspResidentResponse> {
  return await sendLineRequest<RspResidentRequest, RspResidentResponse>(opts, request, "resident rsp server");
}
