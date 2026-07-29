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
 *
 * **A restart costs no work, and no accounting.** Workers are init-system units,
 * so a starting daemon does not find an empty world — it replays its own
 * append-only event lane, re-attaches to every Worker the host still confirms by
 * unit name, and records the deaths of the ones that ended while nobody was
 * watching. Identity and budget come back from the lane rather than from a
 * per-Worker durable record, because the two authorities that already hold the
 * rest of a Worker's story — the tracker and git — would only be contradicted by
 * a third copy.
 */
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { sendLineRequest } from "@reddb-io/shared/resident-core.js";
import {
  evaluateWorkerAdmission,
  resolveHostCeiling,
  type RedskilledAdmissionVerdict,
  type RedskilledHostCeiling,
} from "./admission.js";
import {
  createRedskilledEventLane,
  rehydrateWorkers,
  type RedskilledEventLane,
  type RedskilledHostEvent,
} from "./event-lane.js";
import { buildHostState, type RedskilledHostState, type RedskilledWorkerView } from "./host-state.js";
import type { RedskilledPaths } from "./paths.js";
import {
  detectWorkerLiveness,
  reattachWorkers,
  stopWorker,
  type RedskilledLivenessProbe,
  type RedskilledStopProbe,
} from "./reattach.js";
import { REDSKILLED_PROTOCOL_VERSION, type RedskilledRequest, type RedskilledResponse } from "./protocol.js";
import {
  launchWorker,
  type LaunchWorkerOptions,
  type LaunchedWorker,
  type RedskilledWorkerSpec,
} from "./worker-launch.js";
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
  /** The host-wide ceiling admission is decided against; the host's own by default. */
  readonly ceiling?: RedskilledHostCeiling;
  readonly owner?: RedskilledLeaseOwner;
  readonly leaseStore?: RedskilledLeaseStore;
  readonly clock?: () => string;
  /** How a Worker is born; injected so a test can birth one without a spawn. */
  readonly launch?: (options: LaunchWorkerOptions) => LaunchedWorker;
  /** The append-only host event lane; defaults to this session's own. */
  readonly eventLane?: RedskilledEventLane;
  /** How the daemon asks whether a re-attached Worker is still running. */
  readonly liveness?: RedskilledLivenessProbe;
  /** How the daemon stops a Worker it is reclaiming a budget from. */
  readonly stopWorker?: RedskilledStopProbe;
}

export interface RedskilledDaemon {
  readonly socketPath: string;
  readonly lease: RedskilledLease;
  readonly startedAt: string;
  /** Resolves when the daemon has stopped listening and released its lease. */
  readonly closed: Promise<void>;
  /** Birth a Worker from a spec: admit, plan placement, launch, track, report. */
  startWorker(spec: RedskilledWorkerSpec): LaunchedWorker;
  /** Judge a spec against the live host without birthing anything. */
  admit(spec: RedskilledWorkerSpec): RedskilledAdmissionVerdict;
  /** The ceiling this daemon admits against. */
  ceiling(): RedskilledHostCeiling;
  /** Record a Worker the daemon believes is alive — the idle gate reads this set. */
  trackWorker(worker: RedskilledWorkerView): void;
  /** Forget a Worker the daemon has observed dying. */
  releaseWorker(workerId: string): boolean;
  workerCount(): number;
  hostState(): RedskilledHostState;
  /**
   * Reclaim a Worker's budget: stop it, record the kill, forget it.
   *
   * A budget kill is its own event rather than a death with a note, because the
   * two answer different questions — a reader counting how often the host ran
   * out of room must not have to distinguish it from a Worker that finished.
   */
  killWorkerOverBudget(workerId: string, detail: string): Promise<boolean>;
  /** Re-probe every re-attached Worker, retiring the ones the host no longer confirms. */
  sweepReattached(): Promise<readonly RedskilledWorkerView[]>;
  /** The Workers this daemon adopted at start rather than birthing itself. */
  reattached(): readonly RedskilledWorkerView[];
  /** Resolves once every event handed to the lane has reached disk. */
  flushEvents(): Promise<void>;
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
  const launch = options.launch ?? launchWorker;
  const ceiling = options.ceiling ?? resolveHostCeiling();
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
  const eventLane = options.eventLane ?? createRedskilledEventLane(paths.eventLanePath);
  const liveness = options.liveness ?? detectWorkerLiveness;
  const stopProbe = options.stopWorker ?? stopWorker;
  const workers = new Map<string, RedskilledWorkerView>();
  // Re-attached Workers have no child handle to deliver an exit, so their death
  // is discovered by asking the host rather than by being told.
  const reattached = new Set<string>();
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

  /**
   * Judge one request against the Workers this daemon is holding right now.
   *
   * The denominator is live process state across every project, which is the
   * whole point: a per-repository profile would let each checkout conclude the
   * machine affords N Workers and spend that budget alone.
   */
  function admit(spec: RedskilledWorkerSpec): RedskilledAdmissionVerdict {
    return evaluateWorkerAdmission({
      ceiling,
      workers: [...workers.values()],
      budget: spec.budget,
      projectLabel: spec.project_label,
    });
  }

  /**
   * Birth one Worker.
   *
   * Admission comes first and the verdict travels into the launch, so a refusal
   * is a Worker that never existed rather than one killed after the fact.
   *
   * Tracking happens here rather than in the caller, so the idle gate and the
   * host state learn about a Worker at the same instant the process exists —
   * a launch the daemon forgot to track would be an untracked budget.
   */
  function startWorker(spec: RedskilledWorkerSpec): LaunchedWorker {
    const launched = launch({
      spec,
      admission: admit(spec),
      clock,
      onExit: (workerId, code, signal) => {
        const worker = workers.get(workerId);
        workers.delete(workerId);
        reattached.delete(workerId);
        if (worker) record("worker-death", worker, `exit code=${code ?? "null"} signal=${signal ?? "null"}`);
        armIdleTimer();
      },
    });
    workers.set(launched.worker.worker_id, launched.worker);
    record("worker-birth", launched.worker, null);
    armIdleTimer();
    return launched;
  }

  /**
   * Append one event, without making the caller wait for the disk.
   *
   * The lane serialises its own appends, so ordering survives the fire-and-
   * forget; what a failed write must not do is take down the daemon that still
   * holds the live Worker the event was about.
   */
  function record(
    event: RedskilledHostEvent["event"],
    worker: RedskilledWorkerView,
    detail: string | null,
  ): void {
    // A stopped daemon writes nothing. Its beliefs about who is alive stopped
    // being authoritative when it let go of the session, and the next daemon
    // re-derives every one of them by asking the host directly.
    if (stopping) return;
    void eventLane.record({ event, worker, ts: clock(), detail }).catch(() => undefined);
  }

  /**
   * Ask the host about every re-attached Worker, and retire the ones it no
   * longer confirms. Returns the Workers that were retired.
   */
  async function sweepReattached(): Promise<readonly RedskilledWorkerView[]> {
    const adopted = [...reattached].map((id) => workers.get(id)).filter((w): w is RedskilledWorkerView => w != null);
    if (adopted.length === 0) return [];
    const { dead } = await reattachWorkers(adopted, liveness);
    for (const worker of dead) {
      workers.delete(worker.worker_id);
      reattached.delete(worker.worker_id);
      record("worker-death", worker, "the host no longer confirms this Worker");
    }
    if (dead.length > 0) armIdleTimer();
    return dead;
  }

  async function killWorkerOverBudget(workerId: string, detail: string): Promise<boolean> {
    const worker = workers.get(workerId);
    if (!worker) return false;
    try {
      await stopProbe(worker);
    } catch {
      // The kill is recorded either way: a stop the host refused still ends the
      // daemon's claim on the budget, and a silent failure would leave the
      // accounting holding room for a Worker nobody is tracking any more.
    }
    workers.delete(workerId);
    reattached.delete(workerId);
    record("worker-budget-kill", worker, detail);
    armIdleTimer();
    return true;
  }

  function armIdleTimer(): void {
    if (stopping) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      // Sweep before deciding: a daemon that exited on a stale belief in a
      // re-attached Worker would hold this session's socket for nothing.
      void sweepReattached()
        .catch(() => undefined)
        .then(() => evaluateIdle());
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
    // Every event already handed over reaches the lane before the daemon lets go
    // of the session: a birth still in flight would leave the next daemon with a
    // Worker it holds a budget for and no record of.
    await eventLane.flush().catch(() => undefined);
    server.close();
    for (const socket of activeSockets) socket.destroy();
    await new Promise<void>((resolve) => server.once("close", () => resolve()));
    await rm(paths.socketPath, { force: true });
    await leaseStore.release(owner).catch(() => undefined);
    resolveClosed();
    return await closed;
  }

  // Rehydrate BEFORE the socket starts answering: a client that read host state
  // in the window between binding and replay would be told this session holds
  // nothing, and would then birth a second Worker for work already running.
  const replayed = rehydrateWorkers(await eventLane.read().catch(() => []));
  const reattachment = await reattachWorkers(replayed, liveness);
  for (const worker of reattachment.alive) {
    workers.set(worker.worker_id, worker);
    reattached.add(worker.worker_id);
  }
  for (const worker of reattachment.dead) {
    record("worker-death", worker, "the Worker ended while no daemon was watching");
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
      if (request.op === "worker-start") {
        const launched = startWorker(request.spec);
        return {
          id: request.id,
          ok: true,
          value: { worker: launched.worker, admission: launched.admission, warnings: launched.warnings },
        };
      }
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
    startWorker,
    admit,
    ceiling: () => ceiling,
    killWorkerOverBudget,
    sweepReattached,
    reattached: () => [...reattached].map((id) => workers.get(id)).filter((w): w is RedskilledWorkerView => w != null),
    flushEvents: () => eventLane.flush(),
    trackWorker(worker) {
      workers.set(worker.worker_id, worker);
      record("worker-birth", worker, null);
      armIdleTimer();
    },
    releaseWorker(workerId) {
      const worker = workers.get(workerId);
      const removed = workers.delete(workerId);
      reattached.delete(workerId);
      if (worker) record("worker-death", worker, "released by the daemon");
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
