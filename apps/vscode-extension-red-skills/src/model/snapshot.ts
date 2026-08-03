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
import type { RedskilledHostState, RedskilledStatuslinePayload } from "@reddb-io/redskilled/protocol";
import {
  renderRedskilledDashboard,
  REDSKILLED_DASHBOARD_DEFAULTS,
  type RedskilledDashboard,
} from "@reddb-io/redskilled-render";
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
  /**
   * The table for this frame, drawn HERE from the payload beside it.
   *
   * **One read, one render** (ADR 0132 decisions 1 and 9): it used to be a second
   * socket call, which spent a round trip per frame to receive text this process
   * could compute from bytes it already held. It is `null` exactly when the
   * payload is — an unreachable daemon — and never because a daemon was too old
   * to lay a table out, because no daemon lays one out any more.
   */
  readonly dashboard: RedskilledDashboard | null;
  readonly lane: EventLaneRead;
  readonly error: SnapshotFailure | null;
  readonly readAt: string;
}

export interface ReadSnapshotOptions {
  readonly client: RedskilledReadClient;
  readonly eventLanePath: string;
  readonly source: string;
  readonly sessionProject?: string;
  /** The size the panel has; the render is clamped to it on this side. */
  readonly dashboardRender?: { readonly maxWidth?: number; readonly maxRows?: number };
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
      // The panel draws every published field, so this frame asks for all three
      // count-scaling extras; a reader that wanted only the totals would name
      // fewer and the daemon would serve the skeleton alone.
      options.client.statuslinePayload(options.sessionProject, { vitals: true, display: true, logs: true }),
      options.client.hostState().catch(() => null),
    ]);
    const dashboard = renderRedskilledDashboard(payload, {
      ...REDSKILLED_DASHBOARD_DEFAULTS,
      mode: options.sessionProject ? "local" : "global",
      project: options.sessionProject ?? null,
      ...(options.dashboardRender?.maxWidth == null ? {} : { maxWidth: options.dashboardRender.maxWidth }),
      ...(options.dashboardRender?.maxRows == null ? {} : { maxRows: options.dashboardRender.maxRows }),
    });
    return {
      reachable: true,
      socketPath: options.client.socketPath,
      source: options.source,
      payload,
      hostState,
      dashboard,
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
      dashboard: null,
      lane,
      error: {
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error),
      },
      readAt: now(),
    };
  }
}
