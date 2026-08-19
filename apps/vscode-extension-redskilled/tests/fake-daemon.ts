/**
 * fake-daemon — a redskilled that lies, over a real unix socket.
 *
 * The real daemon is a machine-wide singleton that owns real processes, so it is
 * the wrong thing for a suite to point at — and on a CI runner that has never run
 * one, there is nothing to point at at all. This binds a socket in a temporary
 * directory, speaks the same frozen contract (`apps/redskilled/src/protocol.ts`),
 * and **nothing it says is true**.
 *
 * It answers with `serveLineRequests`, so it inherits the wire's rule 2 — a
 * responder answers in the dialect it was addressed in — and the suite therefore
 * exercises the TOON path the extension actually writes, not a JSON stand-in.
 * Its event lane is written with the daemon's own `createRedskilledEventLane`,
 * which is what makes the canned TOONL real TOONL.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveWireSocket } from "@reddb-io/shared/resident-core.js";
import {
  createRedskilledEventLane,
  REDSKILLED_EVENT_LANE_FILE,
  type RecordEventInput,
  type RedskilledEventLane,
} from "@reddb-io/redskilled/event-lane";
import type { RedskilledRequest, RedskilledResponse } from "@reddb-io/redskilled/protocol";
import { dashboard, hostState, statuslinePayload } from "./fixtures.js";

export interface FakeDaemonOptions {
  /** What `statusline-payload` answers; re-read on every request. */
  readonly payload?: () => unknown;
  /** What `statusline-dashboard` answers; re-read on every request. */
  readonly dashboard?: () => unknown;
  /** What `host-state` answers; `null` refuses the op. */
  readonly hostState?: () => unknown | null;
  /** Ops named here are refused with the daemon's own error shape. */
  readonly refuse?: readonly string[];
}

export interface FakeDaemon {
  readonly socketPath: string;
  readonly runtimeDir: string;
  readonly eventLanePath: string;
  readonly lane: RedskilledEventLane;
  /** Append one event to the lane, exactly as the daemon would. */
  record(input: RecordEventInput): Promise<void>;
  /** How many requests it has served, by op. */
  readonly served: Map<string, number>;
  stop(): Promise<void>;
}

/** Bind a fake daemon on a fresh runtime directory. Always `stop()` it. */
export async function startFakeDaemon(options: FakeDaemonOptions = {}): Promise<FakeDaemon> {
  // A short base: the whole socket path must fit the kernel's `sun_path` budget,
  // and a nested temp directory under a long CI workspace would not.
  const runtimeDir = await mkdtemp(join(tmpdir(), "rsk-"));
  const socketPath = join(runtimeDir, "d.sock");
  const eventLanePath = join(runtimeDir, REDSKILLED_EVENT_LANE_FILE);
  const lane = createRedskilledEventLane(eventLanePath);
  const served = new Map<string, number>();

  const answer = (request: RedskilledRequest): RedskilledResponse => {
    served.set(request.op, (served.get(request.op) ?? 0) + 1);
    if (options.refuse?.includes(request.op)) {
      return { id: request.id, ok: false, error: `this fake daemon does not serve ${request.op}` };
    }
    switch (request.op) {
      case "ping":
        return {
          id: request.id,
          ok: true,
          value: { pong: true, protocol_version: 1, daemon_version: "0.4.1-fake", pid: process.pid },
        };
      case "host-state": {
        const value = options.hostState ? options.hostState() : hostState();
        if (value === null) return { id: request.id, ok: false, error: "no host state" };
        return { id: request.id, ok: true, value };
      }
      case "statusline-payload":
        return { id: request.id, ok: true, value: options.payload ? options.payload() : statuslinePayload() };
      case "statusline-dashboard":
        return { id: request.id, ok: true, value: options.dashboard ? options.dashboard() : dashboard() };
      default:
        return { id: request.id, ok: false, error: `this fake daemon does not serve ${request.op}` };
    }
  };

  const server: Server = createServer((socket) => {
    serveWireSocket<RedskilledRequest>(
      socket,
      async (request, respond) => respond(answer(request)),
      // A frame the fake could not decode is answered with a FRESH id, exactly
      // as both real daemons do: that mismatch is the proof `resident-wire` rule
      // 3 downgrades on, and a fake that echoed the id would hide it.
      (error, _request, respond) =>
        respond({
          id: `fake:unparsed:${process.pid}`,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }),
    );
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });

  return {
    socketPath,
    runtimeDir,
    eventLanePath,
    lane,
    served,
    async record(input) {
      await lane.record(input);
    },
    async stop() {
      await lane.flush();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(runtimeDir, { recursive: true, force: true });
    },
  };
}
