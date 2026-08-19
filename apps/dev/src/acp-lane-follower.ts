import type {
  CastleLaneRecord,
  LaneEventListener,
  LaneFollower,
} from "@reddb-io/worker/engine";

type AcpInvoke = (method: string, input: Record<string, unknown>) => Promise<unknown>;

interface EventsSinceResult {
  readonly cursor: string;
  readonly lane_records: CastleLaneRecord[];
}

/** Project ACP cursor updates projected as MCP resource notifications. */
export function createAcpLaneFollower(invoke: AcpInvoke): LaneFollower {
  const listeners = new Set<LaneEventListener>();
  let cursor: string | undefined;
  let timer: NodeJS.Timeout | undefined;

  const read = async (): Promise<EventsSinceResult> => {
    const value = await invoke("events_since", cursor === undefined ? {} : { cursor });
    if (!isRecord(value) || typeof value.cursor !== "string") {
      throw new Error("redskilled ACP returned an invalid events_since envelope");
    }
    const records = Array.isArray(value.lane_records)
      ? value.lane_records.filter(isRecord) as unknown as CastleLaneRecord[]
      : [];
    return { cursor: value.cursor, lane_records: records };
  };

  const follower: LaneFollower = {
    async subscribe(listener) {
      if (cursor === undefined) cursor = (await read()).cursor;
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async poll() {
      if (listeners.size === 0) return 0;
      const result = await read();
      cursor = result.cursor;
      for (const record of result.lane_records) {
        for (const listener of listeners) listener({ path: "redskilled-acp", record });
      }
      return result.lane_records.length;
    },
    start(intervalMs = 1_000) {
      if (timer !== undefined) return;
      timer = setInterval(() => void follower.poll().catch(() => undefined), intervalMs);
      timer.unref();
    },
    stop() {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      listeners.clear();
    },
  };
  return follower;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
