/**
 * self-guard — the daemon protects the machine from ITSELF.
 *
 * Two failure shapes motivated this, both observed live:
 *
 * 1. **The wedge.** A daemon can deadlock a subsystem while the process stays
 *    alive — `Restart=always` never fires, systemd reads "active (running)",
 *    and every client hangs until a human restarts it (seen 2026-08-25: the
 *    project-control path wedged after a first-bind identity migration while
 *    the read ops kept answering). The guard probes the daemon's OWN op
 *    socket with the same `ping` a client sends; a sustained miss streak is
 *    answered with a deliberate exit, and the supervisor brings back a fresh
 *    generation in about a second.
 *
 * 2. **The leak.** A daemon that grows for days takes the MACHINE down before
 *    any generous unit ceiling takes the daemon down (a host running only the
 *    daemon died after ~4 days, 2026-08-25). The guard reads its own RSS on
 *    the same cadence; past the ceiling it exits deliberately — shedding the
 *    leak is one restart, losing the machine is an outage.
 *
 * The guard lives in the daemon BINARY, not only in the unit template, so
 * every host inherits it by riding the release train — a machine with an old
 * unit file is protected the moment its daemon self-upgrades. Exits are loud:
 * one stderr line with the verdict (the journal keeps it), and a distinct
 * exit code per shape.
 */
import { randomUUID } from "node:crypto";
import { sendRedskilledRequest } from "../protocol.js";

export const REDSKILLED_SELF_GUARD_INTERVAL_MS = 15_000;
export const REDSKILLED_SELF_GUARD_PING_TIMEOUT_MS = 2_000;
/** 8 misses x 15s = two minutes of a daemon no client can reach. */
export const REDSKILLED_SELF_GUARD_MISS_LIMIT = 8;
/** Observed healthy peak is ~450MiB; 1.5GiB is leak territory, not load. */
export const REDSKILLED_SELF_GUARD_RSS_LIMIT_BYTES = 1_610_612_736;

export const REDSKILLED_SELF_GUARD_EXIT_UNRESPONSIVE = 70;
export const REDSKILLED_SELF_GUARD_EXIT_RSS = 71;

export interface RedskilledSelfGuardVerdict {
  readonly kind: "unresponsive" | "rss-ceiling";
  readonly exitCode: number;
  readonly detail: string;
}

export interface RedskilledSelfGuardOptions {
  readonly socketPath: string;
  /** Answers like a client or throws; injectable for tests. */
  readonly probe?: () => Promise<void>;
  /** This process's resident set in bytes; injectable for tests. */
  readonly rss?: () => number;
  readonly intervalMs?: number;
  readonly missLimit?: number;
  readonly rssLimitBytes?: number;
  /** Called at most once; the caller owns the actual exit. */
  readonly onFatal: (verdict: RedskilledSelfGuardVerdict) => void;
}

export interface RedskilledSelfGuard {
  arm(): void;
  stop(): void;
  /** Test seam: run one evaluation immediately. */
  tick(): Promise<void>;
}

export function createRedskilledSelfGuard(options: RedskilledSelfGuardOptions): RedskilledSelfGuard {
  const intervalMs = options.intervalMs ?? REDSKILLED_SELF_GUARD_INTERVAL_MS;
  const missLimit = Math.max(1, options.missLimit ?? REDSKILLED_SELF_GUARD_MISS_LIMIT);
  const rssLimit = options.rssLimitBytes ?? REDSKILLED_SELF_GUARD_RSS_LIMIT_BYTES;
  const rss = options.rss ?? (() => process.memoryUsage.rss());
  const probe = options.probe ?? (async () => {
    const response = await sendRedskilledRequest(
      { socketPath: options.socketPath, timeoutMs: REDSKILLED_SELF_GUARD_PING_TIMEOUT_MS },
      { id: randomUUID(), op: "ping", self: true },
    );
    if (!response.ok) throw new Error(response.error);
  });

  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let fatal = false;
  let misses = 0;

  const fail = (verdict: RedskilledSelfGuardVerdict): void => {
    if (fatal) return;
    fatal = true;
    stopped = true;
    if (timer != null) clearInterval(timer);
    options.onFatal(verdict);
  };

  async function tick(): Promise<void> {
    if (stopped) return;
    const held = rss();
    if (held > rssLimit) {
      fail({
        kind: "rss-ceiling",
        exitCode: REDSKILLED_SELF_GUARD_EXIT_RSS,
        detail:
          `redskilled self-guard: resident set ${Math.round(held / 1_048_576)}MiB exceeds the ` +
          `${Math.round(rssLimit / 1_048_576)}MiB ceiling — exiting deliberately so the supervisor ` +
          "restarts a fresh generation instead of the machine paying for the leak",
      });
      return;
    }
    try {
      await probe();
      misses = 0;
    } catch (error) {
      misses += 1;
      if (misses >= missLimit) {
        fail({
          kind: "unresponsive",
          exitCode: REDSKILLED_SELF_GUARD_EXIT_UNRESPONSIVE,
          detail:
            `redskilled self-guard: ${misses} consecutive self-pings failed (last: ${
              error instanceof Error ? error.message : String(error)
            }) — the process is alive but no client can reach it, exiting deliberately so the ` +
            "supervisor restarts a generation that answers",
        });
      }
    }
  }

  return {
    arm() {
      if (stopped || timer != null) return;
      timer = setInterval(() => void tick(), intervalMs);
      timer.unref();
    },
    stop() {
      stopped = true;
      if (timer != null) clearInterval(timer);
      timer = undefined;
    },
    tick,
  };
}
