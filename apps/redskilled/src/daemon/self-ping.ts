import { randomUUID } from "node:crypto";
import type { RedskilledRequestHealth } from "../host-state.js";
import { sendRedskilledRequest } from "../protocol.js";

export const DEFAULT_REDSKILLED_SELF_PING_INTERVAL_MS = 5_000;
export const DEFAULT_REDSKILLED_SELF_PING_TIMEOUT_MS = 150;
export const DEFAULT_REDSKILLED_SELF_PING_MISS_THRESHOLD = 3;

export interface RedskilledSelfPingMonitorOptions {
  readonly probe: () => Promise<unknown>;
  readonly intervalMs: number;
  readonly timeoutMs: number;
  readonly missThreshold: number;
}

export interface RedskilledSelfPingMonitor {
  arm(): void;
  stop(): void;
  health(): RedskilledRequestHealth;
}

export interface ConfiguredRedskilledSelfPingOptions {
  readonly selfPingIntervalMs?: number;
  readonly selfPingTimeoutMs?: number;
  readonly selfPingMissThreshold?: number;
  readonly selfPing?: () => Promise<unknown>;
}

/** Production socket probe with all daemon defaults resolved in one module. */
export function createConfiguredRedskilledSelfPingMonitor(
  socketPath: string,
  options: ConfiguredRedskilledSelfPingOptions = {},
): RedskilledSelfPingMonitor {
  const timeoutMs = options.selfPingTimeoutMs ?? DEFAULT_REDSKILLED_SELF_PING_TIMEOUT_MS;
  return createRedskilledSelfPingMonitor({
    intervalMs: options.selfPingIntervalMs ?? DEFAULT_REDSKILLED_SELF_PING_INTERVAL_MS,
    timeoutMs,
    missThreshold: options.selfPingMissThreshold ?? DEFAULT_REDSKILLED_SELF_PING_MISS_THRESHOLD,
    probe: options.selfPing ?? (async () => {
      const response = await sendRedskilledRequest(
        { socketPath, timeoutMs },
        { id: randomUUID(), op: "ping", self: true },
      );
      if (!response.ok) throw new Error(response.error);
    }),
  });
}

/** Watch the daemon's real socket path without ever sharing a poller's promise. */
export function createRedskilledSelfPingMonitor(
  options: RedskilledSelfPingMonitorOptions,
): RedskilledSelfPingMonitor {
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let expectedAtMs: number | null = null;
  let consecutiveMisses = 0;
  let lastProbeAt: string | null = null;
  let lastSuccessAt: string | null = null;
  let lastFailureAt: string | null = null;
  let detail = "the daemon has not self-pinged yet";
  const threshold = Math.max(1, Math.floor(options.missThreshold));

  function miss(count: number, at: string, reason: string): void {
    consecutiveMisses += Math.max(1, count);
    lastFailureAt = at;
    detail = reason;
  }

  function schedule(): void {
    if (stopped || options.intervalMs <= 0) return;
    expectedAtMs = Date.now() + options.intervalMs;
    timer = setTimeout(() => void tick(), options.intervalMs);
    timer.unref();
  }

  async function tick(): Promise<void> {
    timer = undefined;
    const startedMs = Date.now();
    const at = new Date(startedMs).toISOString();
    lastProbeAt = at;
    const overdueIntervals = expectedAtMs == null
      ? 0
      : Math.max(0, Math.floor((startedMs - expectedAtMs) / Math.max(1, options.intervalMs)));
    if (overdueIntervals > 0) {
      miss(
        overdueIntervals,
        at,
        `the daemon event loop missed ${overdueIntervals} scheduled self-ping interval(s) before this probe ran`,
      );
    }

    let deadline: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(options.probe),
        new Promise<never>((_resolve, reject) => {
          deadline = setTimeout(
            () => reject(new Error(`self-ping exceeded ${options.timeoutMs}ms`)),
            Math.max(1, options.timeoutMs),
          );
          deadline.unref();
        }),
      ]);
      const elapsedMs = Date.now() - startedMs;
      if (elapsedMs > options.timeoutMs) throw new Error(`self-ping answered after ${elapsedMs}ms`);
      lastSuccessAt = new Date().toISOString();
      if (overdueIntervals === 0) {
        consecutiveMisses = 0;
        detail = `the daemon answered its own socket in ${elapsedMs}ms`;
      }
    } catch (error) {
      miss(1, new Date().toISOString(), error instanceof Error ? error.message : String(error));
    } finally {
      if (deadline != null) clearTimeout(deadline);
      schedule();
    }
  }

  return {
    arm() {
      if (stopped || timer != null || options.intervalMs <= 0) return;
      schedule();
    },
    stop() {
      stopped = true;
      if (timer != null) clearTimeout(timer);
      timer = undefined;
    },
    health: () => ({
      status: consecutiveMisses >= threshold ? "degraded" : "healthy",
      consecutive_misses: consecutiveMisses,
      miss_threshold: threshold,
      last_probe_at: lastProbeAt,
      last_success_at: lastSuccessAt,
      last_failure_at: lastFailureAt,
      detail,
    }),
  };
}
