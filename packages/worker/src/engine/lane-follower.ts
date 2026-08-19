import { readdir } from "node:fs/promises";
import type { CastleLaneRecord } from "./contracts/index.js";
import {
  castleLanePath,
  readCastleLaneRecords,
  type CastleLaneName,
} from "./lane-writers.js";
import type { EnginePaths } from "./paths.js";

/**
 * One lane record surfaced by the follower, tagged with the lane file it came
 * from. `record` is the exact `CastleLaneRecord` the `logs` tool returns for
 * the same append — push and pull views never disagree (ADR: red.castle.lane.v1).
 */
export interface LaneEvent {
  readonly path: string;
  readonly record: CastleLaneRecord;
}

export type LaneEventListener = (event: LaneEvent) => void;

/** Enumerate lane files that carry namespaced event records right now. */
async function childDirNames(path: string): Promise<string[]> {
  try {
    return (await readdir(path, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

/**
 * Resolve the concrete lane file paths for the requested lane families. Worker
 * and supervisor lanes are the event-bearing lanes (landings, deaths, lost
 * claims, supervisor halts); `liveness`/`monitor` may be requested too. A lane
 * file that does not exist yet is still listed — the follower reads it as empty
 * until its producer appends, and picks up the first record the moment it lands.
 */
export async function listCastleLaneFiles(
  paths: EnginePaths,
  lanes: readonly CastleLaneName[] = ["worker", "supervisor"],
): Promise<string[]> {
  const files: string[] = [];
  for (const lane of lanes) {
    switch (lane) {
      case "worker":
      case "liveness": {
        for (const id of await childDirNames(paths.workersRoot)) {
          files.push(castleLanePath(paths, lane, id));
        }
        break;
      }
      case "supervisor": {
        for (const id of await childDirNames(paths.supervisorsRoot)) {
          files.push(castleLanePath(paths, "supervisor", id));
        }
        break;
      }
      case "monitor": {
        for (const id of await childDirNames(paths.monitorsRoot)) {
          files.push(castleLanePath(paths, "monitor", id));
        }
        break;
      }
    }
  }
  return files;
}

export interface LaneFollowerOptions {
  /** Source of the lane file paths to follow; re-evaluated on every poll. */
  list(): Promise<string[]>;
  /** Reader for one lane file; defaults to the shared `logs`-tool reader. */
  readRecords?(path: string): Promise<CastleLaneRecord[]>;
}

export interface LaneFollower {
  /**
   * Register a listener. Records already present in the lane files at
   * subscription time are the subscriber's baseline and are never delivered;
   * only records appended afterwards reach the listener. Returns an unsubscribe
   * handle.
   */
  subscribe(listener: LaneEventListener): Promise<() => void>;
  /** Read newly appended records once and fan them out. Returns events delivered. */
  poll(): Promise<number>;
  /** Begin interval polling; the timer is unref'd so it never holds the process open. */
  start(intervalMs?: number): void;
  /** Stop interval polling. */
  stop(): void;
}

interface Subscription {
  readonly listener: LaneEventListener;
  /** Records already fanned out to this subscriber, per lane file path. */
  readonly delivered: Map<string, number>;
}

const DEFAULT_POLL_INTERVAL_MS = 1_000;

/**
 * A tail-follower over existing castle lane files. It never writes a lane —
 * every event is a record another process appended, re-read through the same
 * reader the `logs` tool uses, so the subscription stream and the polled logs
 * are byte-identical. Feed it with a `list()` source (see `listCastleLaneFiles`).
 */
export function createLaneFollower(options: LaneFollowerOptions): LaneFollower {
  const readRecords = options.readRecords ?? readCastleLaneRecords;
  const subscriptions = new Set<Subscription>();
  let timer: NodeJS.Timeout | undefined;

  async function countsFor(files: string[]): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    for (const file of files) {
      counts.set(file, (await readRecords(file)).length);
    }
    return counts;
  }

  return {
    async subscribe(listener) {
      const files = await options.list();
      const subscription: Subscription = {
        listener,
        delivered: await countsFor(files),
      };
      subscriptions.add(subscription);
      return () => {
        subscriptions.delete(subscription);
      };
    },

    async poll() {
      if (subscriptions.size === 0) return 0;
      const files = await options.list();
      let delivered = 0;
      for (const file of files) {
        const records = await readRecords(file);
        for (const subscription of subscriptions) {
          const seen = subscription.delivered.get(file) ?? 0;
          // A truncated/rotated file (fewer records than seen) resets cleanly.
          const start = Math.min(seen, records.length);
          for (const record of records.slice(start)) {
            subscription.listener({ path: file, record });
            delivered += 1;
          }
          subscription.delivered.set(file, records.length);
        }
      }
      return delivered;
    },

    start(intervalMs = DEFAULT_POLL_INTERVAL_MS) {
      if (timer) return;
      timer = setInterval(() => {
        void this.poll();
      }, intervalMs);
      timer.unref?.();
    },

    stop() {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
    },
  };
}
