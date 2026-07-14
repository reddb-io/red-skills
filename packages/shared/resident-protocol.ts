import { createConnection } from "node:net";

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
  | { id: string; op: "accounting-stats"; byteBudget: number }
  | { id: string; op: "telemetry-stats"; sinceDays: number }
  | { id: string; op: "telemetry-gains"; sinceDays: number }
  | { id: string; op: "mint"; original: string; meta: unknown }
  | { id: string; op: "get"; handle: string }
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
  const timeoutMs = opts.timeoutMs ?? 1_000;
  return await new Promise((resolve, reject) => {
    const socket = createConnection(opts.socketPath);
    let settled = false;
    let buffer = "";
    const timeout = setTimeout(() => {
      finish(() => reject(new Error("resident rsp server timed out")));
      socket.destroy();
    }, timeoutMs);

    function finish(fn: () => void): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      fn();
    }

    socket.on("connect", () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      finish(() => {
        try {
          resolve(JSON.parse(line) as RspResidentResponse);
        } catch (err) {
          reject(err);
        }
      });
      socket.end();
    });
    socket.on("error", (err) => finish(() => reject(err)));
    socket.on("close", () => {
      if (!settled) finish(() => reject(new Error("resident rsp server closed without response")));
    });
  });
}
