import type { JsonObject } from "@reddb-io/toon";
import type { RspElisionStore, RspMintMeta, RspRecoveryHandle } from "../elision-store.js";
import type { ResidentResponseMetrics } from "../resident-client.js";
import type { RspOverheadHealth } from "../overhead-budget.js";
import type { RspAccountingLaneStats, RspTelemetryStats } from "../telemetry.js";

export interface ParsedArgs {
  command?: string;
  handle?: string;
  storeUri?: string;
  query?: string;
  level: "lossless" | "brief" | "terse" | "full";
  positional: string[];
}

export type ElisionStoreLike = Pick<RspElisionStore, "close"> & {
  mint(original: Uint8Array | Buffer, meta: RspMintMeta): Promise<string>;
  lastResponseMetrics?: () => ResidentResponseMetrics | undefined;
};

export type InvocationTelemetryStore = {
  lastResponseMetrics: () => ResidentResponseMetrics | undefined;
};

export interface WrappedCommandResult {
  stdout: Buffer;
  stderr: Buffer;
  status: number | null;
  signal: NodeJS.Signals | null;
  mintedHandle?: string;
  bytesElided?: number;
  rawOutput?: Buffer;
  degradation?: {
    reason: string;
    family: string;
    stderrHead: string;
  };
}

export interface DashboardSnapshot {
  stats: RspAccountingLaneStats;
  telemetry: RspTelemetryStats;
  recoveryHandles: RspRecoveryHandle[];
  waits: JsonObject[];
  overhead: RspOverheadHealth;
}
