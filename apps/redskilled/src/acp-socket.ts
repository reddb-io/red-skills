import { rm } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import { Readable, Writable } from "node:stream";
import { ndJsonStream, type Stream } from "@agentclientprotocol/sdk";

export function socketStream(socket: Socket): Stream {
  return ndJsonStream(
    Writable.toWeb(socket) as WritableStream<Uint8Array>,
    Readable.toWeb(socket) as ReadableStream<Uint8Array>,
  );
}

export async function bindWorkerRendezvous(socketPath: string): Promise<{
  server: Server;
  connected: Promise<Socket>;
}> {
  await rm(socketPath, { force: true });
  let accept!: (socket: Socket) => void;
  const connected = new Promise<Socket>((resolve) => { accept = resolve; });
  const server = createServer((socket) => accept(socket));
  await listen(server, socketPath);
  return { server, connected };
}

export async function listen(server: Server, socketPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

export async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

export async function connectWithDeadline(socketPath: string, timeoutMs: number): Promise<Socket> {
  const deadline = Date.now() + timeoutMs;
  let cause: unknown;
  while (Date.now() < deadline) {
    try {
      return await new Promise<Socket>((resolve, reject) => {
        const socket = connect(socketPath);
        socket.once("connect", () => resolve(socket));
        socket.once("error", reject);
      });
    } catch (error) {
      cause = error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error(`redskilled ACP endpoint did not answer within ${timeoutMs}ms`, { cause });
}

export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not answer within ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer != null) clearTimeout(timer);
  }
}

export async function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

export async function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}
