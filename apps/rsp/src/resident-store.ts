/**
 * resident-store.ts — the one door every rsp surface walks through (ADR 0126).
 *
 * The hook, the proxy, the CLI wrappers, the read commands, the dashboard, the
 * wait capture and the MCP tools are all *clients*: they describe the store they
 * want and get a `ResidentRspElisionStore` back, never an `RspElisionStore`. The
 * resident process is the sole writer of the store and of the telemetry lanes it
 * drains, so a surface that opened its own handle would be a second core.
 *
 * Keeping the config → `RspResidentConfig` mapping here also means an added
 * knob reaches every surface at once instead of drifting per call site.
 */
import { readBuildInfo } from "@reddb-io/build-info";
import type { RspRuntimeConfig } from "./config.js";
import { ResidentRspElisionStore, resolveResidentPaths, type RspResidentPaths } from "./resident-client.js";
import type { RspResidentConfig } from "./resident-protocol.js";

export interface ResidentElisionStoreOptions {
  /** Auto-spawn the resident when the socket is cold. Default true. */
  ensureResident?: boolean;
  /** Override the resolved paths; defaults to the paths for `cwd`. */
  paths?: RspResidentPaths;
}

/** The resident config this runtime config asks for — nothing surface-specific. */
export function residentConfigFor(config: RspRuntimeConfig, clientVersion?: string): RspResidentConfig {
  return {
    storeUri: config.storeUri,
    ttlDays: config.ttlDays,
    ephemeralTtlHours: config.ephemeralTtlHours,
    byteBudget: config.byteBudget,
    telemetryTtlDays: config.telemetryTtlDays,
    telemetryByteBudget: config.telemetryByteBudget,
    telemetryDrainIntervalMs: config.telemetryDrainIntervalMs,
    telemetryDrainTimeoutMs: config.telemetryDrainTimeoutMs,
    idleMs: config.idleMs,
    ...(clientVersion ? { clientVersion } : {}),
  };
}

/** A client of the resident core, for any surface, from one place. */
export function residentElisionStore(
  cwd: string,
  config: RspRuntimeConfig,
  opts: ResidentElisionStoreOptions = {},
): ResidentRspElisionStore {
  const paths = opts.paths ?? resolveResidentPaths(cwd);
  return new ResidentRspElisionStore(
    paths,
    residentConfigFor(config, readBuildInfo("rsp").version),
    { ensureResident: opts.ensureResident },
  );
}
