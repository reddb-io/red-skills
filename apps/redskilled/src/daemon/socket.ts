import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import { isPidAlive, sendLineRequest, serveWireSocket } from "@reddb-io/shared/resident-core.js";
import type { RedskilledRequest, RedskilledResponse } from "../protocol.js";

import { RedskilledAlreadyRunningError } from "./errors.js";

/**
 * Who owns a socket path, asked of the KERNEL rather than of a clock.
 *
 * A `connect()` that SUCCEEDS proves a listener is bound to the path — that is
 * the whole of what ownership means here, and it is true whether the owner
 * replies in a millisecond, in a minute, or never.
 */
export type RedskilledSocketOwnership = "owned" | "unowned" | "unknown";

export async function probeSocketOwnership(
  socketPath: string,
  timeoutMs = 250,
): Promise<RedskilledSocketOwnership> {
  return await new Promise<RedskilledSocketOwnership>((resolve) => {
    const probe = connect(socketPath);
    let settled = false;
    const settle = (ownership: RedskilledSocketOwnership): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      probe.destroy();
      resolve(ownership);
    };
    const timer = setTimeout(() => settle("unknown"), timeoutMs);
    timer.unref?.();
    probe.once("connect", () => settle("owned"));
    probe.once("error", (error: NodeJS.ErrnoException) => {
      settle(error.code === "ECONNREFUSED" || error.code === "ENOENT" ? "unowned" : "unknown");
    });
  });
}

export async function bindExclusive(
  socketPath: string,
  ownerRecorded?: () => Promise<boolean>,
): Promise<Server> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const server = createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => {
          server.off("error", reject);
          resolve();
        });
      });
      return server;
    } catch (err) {
      server.close();
      if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") throw err;
      if ((await probeSocketOwnership(socketPath)) !== "unowned") {
        throw new RedskilledAlreadyRunningError(socketPath);
      }
      if (await ownerRecorded?.()) throw new RedskilledAlreadyRunningError(socketPath);
      await rm(socketPath, { force: true });
    }
  }
  throw new RedskilledAlreadyRunningError(socketPath);
}

/** True when something on the other end of `socketPath` answers a ping. */
export async function socketAnswers(socketPath: string, timeoutMs = 250): Promise<boolean> {
  try {
    const response = await sendLineRequest<RedskilledRequest, RedskilledResponse>(
      { socketPath, timeoutMs },
      { id: randomUUID(), op: "ping" },
      "redskilled daemon",
    );
    return response.ok === true;
  } catch {
    return false;
  }
}

export function handleSocket(
  socket: Socket,
  handler: (request: RedskilledRequest, respond: (response: RedskilledResponse) => void) => Promise<void>,
): void {
  serveWireSocket<RedskilledRequest>(
    socket,
    (request, respond) => handler(request, respond as (response: RedskilledResponse) => void),
    (err, request, respond) => {
      respond({
        id: request?.id ?? randomUUID(),
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      } satisfies RedskilledResponse);
    },
  );
}

// Re-export isPidAlive for callers that previously imported via daemon
export { isPidAlive };
