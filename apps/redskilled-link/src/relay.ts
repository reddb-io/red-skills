import { createServer, type Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";

import { decodeRelayEnvelope, encodeRelayEnvelope } from "@reddb-io/red-skills-link-protocol/crypto";
import { isRelayEnvelope } from "@reddb-io/red-skills-link-protocol/protocol";

export interface RedskilledRelay {
  readonly server: Server;
  readonly port: number;
  close(): Promise<void>;
}

export async function startRedskilledRelay(options: {
  readonly host?: string;
  readonly port?: number;
} = {}): Promise<RedskilledRelay> {
  const server = createServer();
  const webSockets = new WebSocketServer({ server });
  const hosts = new Map<string, WebSocket>();
  const devices = new Map<string, WebSocket>();
  webSockets.on("connection", (socket) => {
    socket.on("message", (data) => {
      try {
        const envelope = decodeRelayEnvelope(data.toString());
        if (!isRelayEnvelope(envelope)) return;
        if (envelope.kind === "host-online") {
          hosts.set(envelope.host_id, socket);
          return;
        }
        if (envelope.kind === "device-request" || envelope.kind === "pair-request") {
          devices.set(envelope.device_id, socket);
          const host = hosts.get(envelope.host_id);
          if (host?.readyState === WebSocket.OPEN) host.send(encodeRelayEnvelope(envelope));
          return;
        }
        const device = devices.get(envelope.device_id);
        if (device?.readyState === WebSocket.OPEN) device.send(encodeRelayEnvelope(envelope));
      } catch {
        // Transport-only: malformed routing envelopes carry no reply authority.
      }
    });
    socket.once("close", () => {
      for (const [id, held] of hosts) if (held === socket) hosts.delete(id);
      for (const [id, held] of devices) if (held === socket) devices.delete(id);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address == null || typeof address === "string") throw new Error("relay did not bind a TCP port");
  return {
    server,
    port: address.port,
    async close() {
      for (const socket of webSockets.clients) socket.close();
      await new Promise<void>((resolve) => webSockets.close(() => server.close(() => resolve())));
    },
  };
}
