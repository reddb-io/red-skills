// HTTP long-poll transport for the bridge — the live CLI<->browser channel.
//
// The browser SDK probes /health, POSTs annotations, and the agent GETs annotations
// with a cursor (long-poll). The request *dispatch* is a pure function so it can be
// tested without opening a socket; createBridgeServer wires it to node:http.

import { createServer, type Server } from "node:http";
import {
  pollAnnotations,
  recordAnnotation,
  loadSession,
} from "./session.js";

export interface BridgeResponse {
  status: number;
  /** JSON-serialisable body, or null for an empty body. */
  body: unknown;
}

export interface DispatchContext {
  root: string;
}

const HEALTH = /^\/sessions\/([^/]+)\/health$/;
const ANNOTATIONS = /^\/sessions\/([^/]+)\/annotations$/;

/**
 * Pure request dispatcher. Maps (method, path, body) to a {@link BridgeResponse}
 * against the filesystem session store. No sockets, no long-poll hold — the holding
 * is the server's job; this resolves a single read/write.
 */
export function dispatchBridgeRequest(
  method: string,
  path: string,
  body: unknown,
  ctx: DispatchContext,
): BridgeResponse {
  const url = new URL(path, "http://bridge.local");
  const pathname = url.pathname;

  const health = HEALTH.exec(pathname);
  if (health && method === "GET") {
    const session = loadSession(ctx.root, health[1]);
    if (!session) return { status: 404, body: { error: "unknown session" } };
    return { status: 200, body: { ok: true, sessionId: session.id, status: session.status } };
  }

  const ann = ANNOTATIONS.exec(pathname);
  if (ann) {
    const sessionId = ann[1];
    if (method === "POST") {
      try {
        const annotation = recordAnnotation(ctx.root, sessionId, body);
        return { status: 201, body: annotation };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const status = message.startsWith("unknown bridge session") ? 404 : 400;
        return { status, body: { error: message } };
      }
    }
    if (method === "GET") {
      if (!loadSession(ctx.root, sessionId)) {
        return { status: 404, body: { error: "unknown session" } };
      }
      const cursor = Number(url.searchParams.get("cursor") ?? "0");
      return { status: 200, body: pollAnnotations(ctx.root, sessionId, Number.isFinite(cursor) ? cursor : 0) };
    }
  }

  return { status: 404, body: { error: "not found" } };
}

export interface BridgeServerOptions {
  root: string;
  port?: number;
  host?: string;
}

export interface BridgeServer {
  server: Server;
  port: number;
  close(): Promise<void>;
}

/**
 * Start the bridge HTTP server. CORS is wide-open on purpose: the only client is a
 * local file:// artifact, and the server binds to loopback by default.
 */
export function createBridgeServer(opts: BridgeServerOptions): Promise<BridgeServer> {
  const host = opts.host ?? "127.0.0.1";
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      let parsed: unknown = undefined;
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw) {
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = undefined;
        }
      }
      const result = dispatchBridgeRequest(req.method ?? "GET", req.url ?? "/", parsed, { root: opts.root });
      res.writeHead(result.status, {
        "content-type": "application/json",
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "content-type",
        "access-control-allow-methods": "GET,POST,OPTIONS",
      });
      res.end(result.body == null ? "" : JSON.stringify(result.body));
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, host, () => {
      const addr = server.address();
      const port = addr && typeof addr === "object" ? addr.port : (opts.port ?? 0);
      resolve({
        server,
        port,
        close: () =>
          new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res()))),
      });
    });
  });
}
