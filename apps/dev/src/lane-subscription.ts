import {
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { encode, type JsonValue } from "@reddb-io/toon";
import type {
  CastleLaneRecord,
  LaneEvent,
  LaneFollower,
} from "@reddb-io/red-castle/engine";

/** The single subscribable resource that streams castle lane events. */
export const LANE_EVENTS_RESOURCE_URI = "redskilled://lanes/events";

/**
 * The subset of the low-level MCP `Server` this wiring drives. Passing the real
 * `McpServer.server` satisfies it structurally; a fake satisfies it in tests.
 */
export interface LaneSubscriptionServer {
  registerCapabilities(capabilities: {
    resources: { subscribe: true };
  }): void;
  setRequestHandler(
    schema: unknown,
    handler: (request: unknown) => unknown,
  ): void;
  sendResourceUpdated(params: { uri: string }): void | Promise<void>;
}

export interface LaneSubscriptionOptions {
  /** Poll cadence for the follower once at least one client is subscribed. */
  readonly intervalMs?: number;
  /** Cap on records buffered between reads; oldest are dropped past the cap. */
  readonly bufferLimit?: number;
}

export interface LaneSubscriptionHandle {
  /** Read newly appended lane records once and fan them out. */
  poll(): Promise<number>;
  /** Tear down the follower's polling loop. */
  stop(): void;
}

const DEFAULT_BUFFER_LIMIT = 1_000;

function toon(value: unknown): string {
  return encode(JSON.parse(JSON.stringify(value ?? null)) as JsonValue, {
    keyedMapCollapse: true,
  });
}

/**
 * Expose AFK lane events as an MCP subscription surface. A client subscribes
 * to {@link LANE_EVENTS_RESOURCE_URI}; each lane append the follower observes
 * buffers the record, notifies the client with `resources/updated`, and the
 * client re-reads the resource to drain the byte-compatible records. No new
 * write path is introduced — the follower only reads existing lane files.
 *
 * The follower runs a single shared subscription refcounted across clients:
 * the first subscribe starts polling, the last unsubscribe stops it.
 */
export function registerLaneEventSubscription(
  server: LaneSubscriptionServer,
  follower: LaneFollower,
  options: LaneSubscriptionOptions = {},
): LaneSubscriptionHandle {
  const bufferLimit = options.bufferLimit ?? DEFAULT_BUFFER_LIMIT;
  const buffer: CastleLaneRecord[] = [];
  let refcount = 0;
  let unsubscribeFollower: (() => void) | undefined;

  const onEvent = (event: LaneEvent): void => {
    buffer.push(event.record);
    if (buffer.length > bufferLimit) buffer.splice(0, buffer.length - bufferLimit);
    void server.sendResourceUpdated({ uri: LANE_EVENTS_RESOURCE_URI });
  };

  server.registerCapabilities({ resources: { subscribe: true } });

  server.setRequestHandler(ListResourcesRequestSchema, () => ({
    resources: [
      {
        uri: LANE_EVENTS_RESOURCE_URI,
        name: "Redskilled lane events",
        description:
          "Subscribe to receive AFK lane records (Worker landings, deaths, " +
          "lost claims, supervisor halts) appended after subscription. Payloads " +
          "are byte-compatible with the `logs` tool's CastleLaneRecord shape.",
        mimeType: "application/toon",
      },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, (request) => {
    const uri = resourceUri(request);
    if (uri !== LANE_EVENTS_RESOURCE_URI) {
      throw new Error(`unknown resource ${JSON.stringify(uri)}`);
    }
    const drained = buffer.splice(0, buffer.length);
    return {
      contents: [
        {
          uri: LANE_EVENTS_RESOURCE_URI,
          mimeType: "application/toon",
          text: toon({ events: drained }),
        },
      ],
    };
  });

  server.setRequestHandler(SubscribeRequestSchema, async (request) => {
    if (resourceUri(request) !== LANE_EVENTS_RESOURCE_URI) return {};
    refcount += 1;
    if (refcount === 1) {
      unsubscribeFollower = await follower.subscribe(onEvent);
      follower.start(options.intervalMs);
    }
    return {};
  });

  server.setRequestHandler(UnsubscribeRequestSchema, (request) => {
    if (resourceUri(request) !== LANE_EVENTS_RESOURCE_URI) return {};
    if (refcount > 0) refcount -= 1;
    if (refcount === 0) {
      unsubscribeFollower?.();
      unsubscribeFollower = undefined;
      follower.stop();
    }
    return {};
  });

  return {
    poll: () => follower.poll(),
    stop: () => {
      unsubscribeFollower?.();
      unsubscribeFollower = undefined;
      follower.stop();
    },
  };
}

function resourceUri(request: unknown): string {
  const params = (request as { params?: { uri?: unknown } } | undefined)
    ?.params;
  return typeof params?.uri === "string" ? params.uri : "";
}
