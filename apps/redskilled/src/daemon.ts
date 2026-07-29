/**
 * daemon — the `redskilled` singleton: one per user session, behind a socket.
 *
 * Two mechanisms guard the singleton, and they answer different questions.
 * **Exclusive bind** answers "who owns the socket right now" — the kernel
 * refuses a second `listen()` on a bound path, so the start race between several
 * projects auto-spawning at once resolves without a vote. **The session lease**
 * answers "who owns the session across restarts" — a record that survives the
 * process, so a crash is reapable and a pid the OS reused cannot impersonate the
 * holder. Neither is sufficient alone: a lease without a bind lets two daemons
 * both believe they own the socket, and a bind without a lease loses the
 * ownership fact the moment the process dies.
 *
 * **Idle exit never runs while a Worker is believed alive** (ADR 0130 rule 7).
 * The rule is written into the timer rather than into a caller's discipline: on
 * every fire the daemon re-reads its own Worker set and rearms instead of
 * exiting if it is non-empty. Leaving by boredom would abandon a budget nobody
 * else is tracking.
 */
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { sendLineRequest } from "@reddb-io/shared/resident-core.js";
import { buildHostState, type RedskilledHostState, type RedskilledWorkerView } from "./host-state.js";
import type { RedskilledPaths } from "./paths.js";
import { REDSKILLED_PROTOCOL_VERSION, type RedskilledRequest, type RedskilledResponse } from "./protocol.js";
import {
  createRedskilledLeaseStore,
  currentProcessOwner,
  type RedskilledLease,
  type RedskilledLeaseOwner,
  type RedskilledLeaseStore,
} from "./session-lease.js";

/** Default idle window before a Worker-free daemon leaves. */
export const DEFAULT_REDSKILLED_IDLE_MS = 300_000;

/** Raised when another daemon already serves this user session. */
export class RedskilledAlreadyRunningError extends Error {
  constructor(
    readonly socketPath: string,
    /** The live holder's lease, when the lease was the thing that refused us. */
    readonly lease?: RedskilledLease,
  ) {
    super(`a redskilled daemon already owns ${JSON.stringify(socketPath)}`);
    this.name = "RedskilledAlreadyRunningError";
  }
}

export interface RedskilledDaemonOptions {
  readonly paths: RedskilledPaths;
  readonly daemonVersion?: string;
  readonly idleMs?: number;
  readonly owner?: RedskilledLeaseOwner;
  readonly leaseStore?: RedskilledLeaseStore;
  readonly clock?: () => string;
}

export interface RedskilledDaemon {
  readonly socketPath: string;
  readonly lease: RedskilledLease;
  readonly startedAt: string;
  /** Resolves when the daemon has stopped listening and released its lease. */
  readonly closed: Promise<void>;
  /** Record a Worker the daemon believes is alive — the idle gate reads this set. */
  trackWorker(worker: RedskilledWorkerView): void;
  /** Forget a Worker the daemon has observed dying. */
  releaseWorker(workerId: string): boolean;
  workerCount(): number;
  hostState(): RedskilledHostState;
  /** Force the idle check to run now — the timer's body, exposed for tests. */
  evaluateIdle(): "exited" | "held-by-workers";
  stop(): Promise<void>;
}

/**
 * Start the daemon, or refuse because this session already has one.
 *
 * Refusal is a typed throw rather than a `null`: ADR 0130 fails closed, and a
 * caller that cannot tell "already running" from "failed to start" would either
 * spawn a second daemon or drop the client on the floor.
 */
export async function startRedskilledDaemon(options: RedskilledDaemonOptions): Promise<RedskilledDaemon> {
  const { paths } = options;
  const daemonVersion = options.daemonVersion ?? "0.0.0-dev";
  const idleMs = options.idleMs ?? DEFAULT_REDSKILLED_IDLE_MS;
  const clock = options.clock ?? (() => new Date().toISOString());
  const owner = options.owner ?? currentProcessOwner();
  const leaseStore = options.leaseStore ?? createRedskilledLeaseStore(paths.leasePath, {
    sessionKeyHash: paths.sessionKeyHash,
    machineIdHash: paths.machineIdHash,
    socketPath: paths.socketPath,
  }, { clock });

  await mkdir(dirname(paths.socketPath), { recursive: true, mode: 0o700 });

  const acquisition = await leaseStore.acquire(owner);
  if (!acquisition.acquired) throw new RedskilledAlreadyRunningError(paths.socketPath, acquisition.lease);

  let server: Server;
  try {
    server = await bindExclusive(paths.socketPath);
  } catch (err) {
    await leaseStore.release(owner).catch(() => undefined);
    throw err;
  }

  const startedAt = clock();
  const workers = new Map<string, RedskilledWorkerView>();
  const activeSockets = new Set<Socket>();
  let idleTimer: NodeJS.Timeout | undefined;
  let stopping = false;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  function hostState(): RedskilledHostState {
    return buildHostState({
      daemonVersion,
      machineIdHash: paths.machineIdHash,
      sessionKeyHash: paths.sessionKeyHash,
      pid: owner.pid,
      startedAt,
      workers: [...workers.values()],
    });
  }

  function armIdleTimer(): void {
    if (stopping) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      evaluateIdle();
    }, idleMs);
    idleTimer.unref();
  }

  function evaluateIdle(): "exited" | "held-by-workers" {
    // The rule that will matter once Workers exist, in place from the start: a
    // daemon that believes it holds live Workers rearms instead of exiting.
    if (workers.size > 0) {
      armIdleTimer();
      return "held-by-workers";
    }
    void stop();
    return "exited";
  }

  async function stop(): Promise<void> {
    if (stopping) return await closed;
    stopping = true;
    if (idleTimer) clearTimeout(idleTimer);
    server.close();
    for (const socket of activeSockets) socket.destroy();
    await new Promise<void>((resolve) => server.once("close", () => resolve()));
    await rm(paths.socketPath, { force: true });
    await leaseStore.release(owner).catch(() => undefined);
    resolveClosed();
    return await closed;
  }

  server.on("connection", (socket) => {
    activeSockets.add(socket);
    socket.once("close", () => activeSockets.delete(socket));
    armIdleTimer();
    handleSocket(socket, async (request) => {
      armIdleTimer();
      const response = respond(request);
      writeResponse(socket, response);
      if (request.op === "shutdown") setImmediate(() => void stop());
    });
  });

  function respond(request: RedskilledRequest): RedskilledResponse {
    try {
      if (request.op === "ping") {
        return {
          id: request.id,
          ok: true,
          value: {
            pong: true,
            protocol_version: REDSKILLED_PROTOCOL_VERSION,
            daemon_version: daemonVersion,
            pid: owner.pid,
          },
        };
      }
      if (request.op === "host-state") return { id: request.id, ok: true, value: hostState() };
      if (request.op === "shutdown") return { id: request.id, ok: true, value: { stopping: true } };
      const unknown = request as { id?: string; op?: string };
      return { id: unknown.id ?? randomUUID(), ok: false, error: `unsupported redskilled op: ${unknown.op ?? "unknown"}` };
    } catch (err) {
      return { id: (request as { id?: string }).id ?? randomUUID(), ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  armIdleTimer();

  return {
    socketPath: paths.socketPath,
    lease: acquisition.lease,
    startedAt,
    closed,
    trackWorker(worker) {
      workers.set(worker.worker_id, worker);
      armIdleTimer();
    },
    releaseWorker(workerId) {
      const removed = workers.delete(workerId);
      armIdleTimer();
      return removed;
    },
    workerCount: () => workers.size,
    hostState,
    evaluateIdle,
    stop,
  };
}

/**
 * Bind the socket, refusing to steal one another daemon is answering on.
 *
 * `EADDRINUSE` is ambiguous — a live peer and a socket file a crash left behind
 * look identical on disk — so it is resolved by *asking*: a path that answers a
 * ping has an owner, and a path that does not is debris to unlink and retry.
 */
async function bindExclusive(socketPath: string): Promise<Server> {
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
      if (await socketAnswers(socketPath)) throw new RedskilledAlreadyRunningError(socketPath);
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

function handleSocket(socket: Socket, handler: (request: RedskilledRequest) => Promise<void>): void {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("error", () => undefined);
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    const newline = buffer.indexOf("\n");
    if (newline < 0) return;
    const line = buffer.slice(0, newline);
    socket.pause();
    void (async () => {
      let request: RedskilledRequest | undefined;
      try {
        request = JSON.parse(line) as RedskilledRequest;
        await handler(request);
      } catch (err) {
        writeResponse(socket, {
          id: request?.id ?? randomUUID(),
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        socket.end();
      }
    })();
  });
}

function writeResponse(socket: Socket, response: RedskilledResponse): void {
  if (socket.destroyed || !socket.writable) return;
  try {
    socket.write(`${JSON.stringify(response)}\n`);
  } catch {}
}
