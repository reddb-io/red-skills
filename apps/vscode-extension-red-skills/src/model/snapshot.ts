/**
 * snapshot — one read of everything the three views need, as a TOTAL answer.
 *
 * A failed read comes back as `reachable: false` rather than thrown, because a
 * tree that emptied itself on a daemon restart would lose the very frame an
 * operator was watching. **The absence is rendered, not raised.**
 *
 * The event lane is read beside the socket, not instead of it: the socket says
 * what is running now and the lane says how the last thing ended, and a view
 * holding only one of the two can always be asked a question it cannot answer.
 */
import type {
  RedskilledHostState,
  RedskilledStatuslinePayload,
} from "@reddb-io/redskilled/protocol";
import type { RedskilledReadClient } from "../redskilled/client.js";
import { readEventLane, type EventLaneRead } from "../redskilled/event-lane.js";

export interface SnapshotFailure {
  readonly name: string;
  readonly message: string;
}

export interface HostSnapshot {
  readonly reachable: boolean;
  readonly socketPath: string;
  /** How the socket path was decided — carried for the unreachable case. */
  readonly source: string;
  readonly payload: RedskilledStatuslinePayload | null;
  /**
   * The host document, or `null`.
   *
   * Null does NOT imply unreachable: `host-state` is read best-effort beside the
   * payload, so a daemon that serves one and refuses the other still yields a
   * usable frame instead of an outage.
   */
  readonly hostState: RedskilledHostState | null;
  readonly lane: EventLaneRead;
  readonly error: SnapshotFailure | null;
  readonly readAt: string;
}

export interface ReadSnapshotOptions {
  readonly client: RedskilledReadClient;
  readonly eventLanePath: string;
  readonly source: string;
  readonly sessionProject?: string;
  readonly now?: () => string;
}

const EMPTY_LANE = (path: string): EventLaneRead => ({
  path,
  exists: false,
  truncated: false,
  events: [],
});

/** Read the host once. Never throws — every failure lands in the returned value. */
export async function readHostSnapshot(options: ReadSnapshotOptions): Promise<HostSnapshot> {
  const now = options.now ?? (() => new Date().toISOString());
  const lane = await readEventLane(options.eventLanePath).catch(() => EMPTY_LANE(options.eventLanePath));

  try {
    const [payload, hostState] = await Promise.all([
      options.client.statuslinePayload(options.sessionProject),
      options.client.hostState().catch(() => null),
    ]);
    return {
      reachable: true,
      socketPath: options.client.socketPath,
      source: options.source,
      payload,
      hostState,
      lane,
      error: null,
      readAt: now(),
    };
  } catch (error) {
    return {
      reachable: false,
      socketPath: options.client.socketPath,
      source: options.source,
      payload: null,
      hostState: null,
      lane,
      error: {
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error),
      },
      readAt: now(),
    };
  }
}
