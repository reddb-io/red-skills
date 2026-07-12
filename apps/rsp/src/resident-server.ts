import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { dirname } from "node:path";
import type { RspExpiredHandle, RspElisionRecord } from "./elision-store.js";
import { RspElisionStore } from "./elision-store.js";
import type { RspResidentConfig, RspResidentRequest, RspResidentResponse } from "./resident-protocol.js";

export interface ResidentServerOptions extends RspResidentConfig {
  socketPath: string;
  idleMs?: number;
}

export async function runResidentServer(opts: ResidentServerOptions): Promise<void> {
  await mkdir(dirname(opts.socketPath), { recursive: true });

  const openedAt = process.hrtime.bigint();
  const store = await RspElisionStore.open({
    uri: opts.storeUri,
    ttlDays: opts.ttlDays,
    byteBudget: opts.byteBudget,
    allowResidentOpen: true,
  });
  const storeElapsedMs = Number(process.hrtime.bigint() - openedAt) / 1_000_000;
  let storeOpenCount = 1;

  const idleMs = opts.idleMs ?? 30_000;
  let idleTimer: NodeJS.Timeout | undefined;
  const server = createServer((socket) => {
    touch();
    handleSocket(socket, async (request) => {
      touch();
      const value = await handleRequest(store, request);
      const response: RspResidentResponse = { id: request.id, ok: true, value, storeOpenCount, storeElapsedMs };
      socket.write(`${JSON.stringify(response)}\n`);
    });
  });

  function touch(): void {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => server.close(), idleMs);
    idleTimer.unref();
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  touch();

  await new Promise<void>((resolve) => server.once("close", resolve));
  storeOpenCount = 0;
  if (idleTimer) clearTimeout(idleTimer);
  await store.close();
  await rm(opts.socketPath, { force: true });
}

function handleSocket(socket: Socket, handler: (request: RspResidentRequest) => Promise<void>): void {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffer += chunk;
    const newline = buffer.indexOf("\n");
    if (newline < 0) return;
    const line = buffer.slice(0, newline);
    socket.pause();
    void (async () => {
      let request: RspResidentRequest | undefined;
      try {
        request = JSON.parse(line) as RspResidentRequest;
        await handler(request);
      } catch (err) {
        const id = request?.id ?? randomUUID();
        const response: RspResidentResponse = {
          id,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
        socket.write(`${JSON.stringify(response)}\n`);
      } finally {
        socket.end();
      }
    })();
  });
}

async function handleRequest(store: RspElisionStore, request: RspResidentRequest): Promise<unknown> {
  if (request.op === "ping") return { pong: true };
  if (request.op === "stats") return await store.stats();
  if (request.op === "mint") {
    return {
      handle: await store.mint(Buffer.from(request.original, "base64"), request.meta as Parameters<RspElisionStore["mint"]>[1]),
    };
  }
  if (request.op === "get") return encodeRecord(await store.get(request.handle));
  if (request.op === "memory") return await store.memory(request.action, request.payload);
  throw new Error(`unsupported resident op: ${(request as { op?: string }).op ?? "unknown"}`);
}

function encodeRecord(record: RspElisionRecord | RspExpiredHandle | null): unknown {
  if (!record) return null;
  if ("status" in record) return record;
  return {
    ...record,
    original: record.original.toString("base64"),
    original_encoding: "base64",
  };
}
