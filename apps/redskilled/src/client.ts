/**
 * client — how a project reaches `redskilled`, including starting it.
 *
 * ADR 0130 rule 7: start is auto-spawn. The first client that needs the daemon
 * starts it, and an optional user unit only adds `Restart=on-failure` on top —
 * one behaviour with an optional supervisor, never two spawn paths.
 *
 * The start race is resolved twice over, and deliberately so. The spawn lock
 * keeps N simultaneous clients from launching N processes; the daemon's own
 * exclusive bind keeps the ones that slip past the lock from both believing they
 * own the socket. **The loser never fails — it waits and connects to the
 * winner**, because a client that errored out on "someone else started it" would
 * turn a healthy race into an outage.
 *
 * ADR 0130 rule 6: fail closed. A daemon that will not start is a thrown error,
 * never a quiet local fallback — for a launcher, failing open costs the machine.
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { isPidAlive, tryAcquireExclusiveLock } from "@reddb-io/shared/resident-core.js";
import {
  redskilledServeArgv,
  requireRedskilledEntry,
  type RedskilledEntryLookup,
  type ResolvedRedskilledEntry,
} from "./daemon-entry.js";
import { socketAnswers } from "./daemon.js";
import { isRedskilledHostState, type RedskilledHostState } from "./host-state.js";
import { createRedskilledMachineClaimStore, RedskilledMachineHeldError } from "./machine-scope.js";
import type { RedskilledPaths } from "./paths.js";
import {
  isRedskilledStatuslinePayload,
  isRedskilledStatuslineRender,
  isRedskilledWorkerCommandResult,
  isRedskilledWorkerHeartbeatAck,
  isRedskilledWorkerStarted,
  sendRedskilledRequest,
  type RedskilledRequest,
  type RedskilledStatuslinePayload,
  type RedskilledStatuslineRender,
  type RedskilledStatuslineRenderRequest,
  type RedskilledWorkerCommandRequest,
  type RedskilledWorkerCommandResult,
  type RedskilledWorkerHeartbeatAck,
  type RedskilledWorkerStarted,
} from "./protocol.js";
import type { RedskilledStatuslineOptions } from "./statusline-render.js";
import { clampPublishedLogLine } from "./worker-log.js";
import type { RedskilledWorkerSpec } from "./worker-launch.js";

// The entry resolver is re-exported here because reaching the daemon and
// resolving what to spawn are one story for a caller, and a second import path
// for the bundle's own name is how two names for one artifact start.
export {
  isRedskilledEntryPath,
  isResolvedRedskilledEntry,
  REDSKILLED_BIN_ENV,
  REDSKILLED_BUNDLE_ASSET,
  REDSKILLED_ENTRY_UNRESOLVED,
  RedskilledDaemonEntryError,
  requireRedskilledEntry,
  resolveRedskilledEntry,
  type RedskilledEntryResolution,
  type RedskilledEntrySource,
} from "./daemon-entry.js";

// Re-exported for the same reason: a caller that reaches the daemon is the caller
// that can be refused the machine, and it should not need a second import path to
// name the refusal it just received.
export {
  RedskilledMachineHeldError,
  type RedskilledMachineClaim,
  type RedskilledMachineRefusal,
} from "./machine-scope.js";

/** How long a client waits for a daemon — its own or the race winner's — to answer. */
export const DEFAULT_REDSKILLED_READY_TIMEOUT_MS = 10_000;

/**
 * Raised when no daemon could be reached, so nothing was born.
 *
 * A distinct type because the two refusals a caller can get mean opposite
 * things: an admission refusal is the host saying "not this Worker, not now",
 * while this one is the host saying nothing at all. Both end in no Worker — the
 * fail-closed rule (ADR 0130 rule 6) — and only one of them is a fault.
 */
export class RedskilledUnreachableError extends Error {
  constructor(
    readonly socketPath: string,
    override readonly cause: unknown,
  ) {
    super(
      `redskilled daemon is unreachable on ${JSON.stringify(socketPath)}, so no Worker was started: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
    this.name = "RedskilledUnreachableError";
  }
}

export interface RedskilledClientConfig {
  /** The command that runs the daemon; defaults to the resolved published bundle. */
  readonly serverCommand?: string;
  readonly serverArgs?: readonly string[];
  /**
   * Where to look for the published bundle, when no `serverCommand` is stated.
   *
   * Injected so a test can pose as a foreign host at another version; a real
   * caller passes nothing and gets the process's own environment.
   */
  readonly entryLookup?: RedskilledEntryLookup;
  readonly idleMs?: number;
  readonly readyTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly env?: NodeJS.ProcessEnv;
  /**
   * The project this session belongs to, stated on every request.
   *
   * It costs a reader nothing — a session reads the whole host either way — and
   * it is what a write is refused against (ADR 0130 rule 9), so stating it once
   * in the config is how a client stays inside its own repository by default.
   */
  readonly sessionProject?: string;
}

/**
 * Ensure a daemon is answering on this session's socket.
 *
 * Returns how the daemon came to be there — `already-running` when one answered
 * straight away, `spawned` when this call started it, `joined` when this call
 * lost the race and connected to the winner. The distinction is diagnostic, not
 * behavioural: all three mean the socket is live.
 */
export async function ensureRedskilledDaemon(
  paths: RedskilledPaths,
  config: RedskilledClientConfig = {},
): Promise<"already-running" | "spawned" | "joined"> {
  try {
    return await reachRedskilledDaemon(paths, config);
  } catch (err) {
    // A machine already held is not "unreachable": there IS a daemon, it is not
    // this session's, and the operator's next action is to reach or stop it. Every
    // OTHER way this ends without a live socket becomes ONE named state, so a
    // caller can never read "no host answered" as "the host answered nothing".
    if (err instanceof RedskilledMachineHeldError) throw err;
    throw err instanceof RedskilledUnreachableError ? err : new RedskilledUnreachableError(paths.socketPath, err);
  }
}

async function reachRedskilledDaemon(
  paths: RedskilledPaths,
  config: RedskilledClientConfig,
): Promise<"already-running" | "spawned" | "joined"> {
  await mkdir(dirname(paths.socketPath), { recursive: true, mode: 0o700 });
  if (await socketAnswers(paths.socketPath)) return "already-running";

  // Our own socket is silent — so before spawning, ask the machine whether it
  // already has a daemon somewhere this session cannot see (ADR 0130 Amendment 3).
  // Spawning first and refusing afterwards would still have been two daemons.
  await refuseWhenMachineIsHeld(paths);

  const lock = await tryAcquireExclusiveLock(paths.lockPath);
  if (!lock) {
    // Lost the spawn race. The winner is starting the very daemon we wanted, so
    // waiting for it is the whole job — restarting one would be the bug.
    await waitForDaemon(paths, config);
    return "joined";
  }
  try {
    // Re-checked under the lock: between the first probe and the acquisition a
    // winner may already have bound, and spawning on top of it is the very
    // second daemon the lock exists to prevent.
    if (await socketAnswers(paths.socketPath)) return "already-running";
    const spawned = spawnDaemon(paths, config);
    await waitForDaemon(paths, config, spawned);
    return "spawned";
  } finally {
    await lock.close();
    await rm(paths.lockPath, { force: true });
  }
}

/**
 * Refuse a spawn the machine already has an answer for.
 *
 * The claim is only consulted to REFUSE, never to admit: a machine whose claim is
 * absent, stale or unreadable falls through to the ordinary start, where the
 * daemon's own claim, lease and exclusive bind decide. Reading it here buys one
 * thing the daemon cannot — the second daemon is never spawned at all, so a
 * foreign user gets a message instead of a process that lives for a heartbeat.
 */
async function refuseWhenMachineIsHeld(paths: RedskilledPaths): Promise<void> {
  const store = createRedskilledMachineClaimStore(paths.machineClaimPath, {
    machineIdHash: paths.machineIdHash,
    sessionKeyHash: paths.sessionKeyHash,
    socketPath: paths.socketPath,
  });
  const claim = await store.read().catch(() => undefined);
  if (claim == null) return;
  // Our own machine's daemon, on our own socket: that is the daemon this client
  // wants, and it is simply not answering yet.
  if (claim.socket_path === paths.socketPath) return;
  if (!isPidAlive(claim.pid)) return;
  throw new RedskilledMachineHeldError(paths.machineClaimPath, "held", claim);
}

/**
 * An op the daemon accepts, minus the id the client mints per call.
 *
 * Distributive on purpose: a plain `Omit<RedskilledRequest, "id">` narrows to the
 * keys every member shares, which would silently drop `worker-start`'s payload.
 */
export type RedskilledRequestBody = RedskilledRequest extends infer Member
  ? Member extends { id: string }
    ? Omit<Member, "id">
    : never
  : never;

/** One request against a running daemon; auto-spawns first. Throws on refusal. */
export async function requestRedskilled(
  paths: RedskilledPaths,
  request: RedskilledRequestBody,
  config: RedskilledClientConfig = {},
): Promise<unknown> {
  await ensureRedskilledDaemon(paths, config);
  let response;
  try {
    response = await sendRedskilledRequest(
      { socketPath: paths.socketPath, timeoutMs: config.requestTimeoutMs ?? 2_000 },
      { ...request, id: randomUUID() } as RedskilledRequest,
    );
  } catch (err) {
    // A socket that answered a ping and then died mid-request is still the host
    // saying nothing; only an `ok: false` answer is the host refusing something.
    throw new RedskilledUnreachableError(paths.socketPath, err);
  }
  if (!response.ok) throw new Error(response.error);
  return response.value;
}

/** The host-wide read. A malformed answer throws — a client never guesses the shape. */
export async function readRedskilledHostState(
  paths: RedskilledPaths,
  config: RedskilledClientConfig = {},
): Promise<RedskilledHostState> {
  const value = await requestRedskilled(paths, { op: "host-state" }, config);
  if (!isRedskilledHostState(value)) throw new Error("redskilled daemon returned a malformed host state");
  return value;
}

/**
 * The statusline payload: what this machine is doing, in one read.
 *
 * Host-wide from any project, and dated by the daemon rather than by the caller.
 * **A malformed answer throws** — there is no partial payload to patch up from a
 * local source, because a consumer holding a private source is exactly the second
 * authority this document exists to remove.
 */
export async function readRedskilledStatuslinePayload(
  paths: RedskilledPaths,
  config: RedskilledClientConfig = {},
): Promise<RedskilledStatuslinePayload> {
  const value = await requestRedskilled(
    paths,
    { op: "statusline-payload", ...(config.sessionProject != null ? { session_project: config.sessionProject } : {}) },
    config,
  );
  if (!isRedskilledStatuslinePayload(value)) throw new Error("redskilled daemon returned a malformed statusline payload");
  return value;
}

/**
 * The statusline string: the same read, already rendered.
 *
 * The caller resolves its own taste first — config then flags — and hands the
 * decided options over, because the daemon may not read a repository's config
 * (ADR 0130 rule 3). **An agent host calls this and prints what comes back.**
 * That is the whole point: a host that rendered the line itself would be the
 * second renderer whose drift from this one nobody would notice for weeks.
 */
export async function readRedskilledStatuslineString(
  paths: RedskilledPaths,
  options: RedskilledStatuslineOptions | undefined = undefined,
  config: RedskilledClientConfig = {},
): Promise<RedskilledStatuslineRender> {
  const value = await requestRedskilled(
    paths,
    {
      op: "statusline-string",
      ...(config.sessionProject != null ? { session_project: config.sessionProject } : {}),
      ...(options == null ? {} : { render: renderRequest(options) }),
    },
    config,
  );
  if (!isRedskilledStatuslineRender(value)) throw new Error("redskilled daemon returned a malformed statusline render");
  return value;
}

/** The wire shape of decided render options. PURE. */
function renderRequest(options: RedskilledStatuslineOptions): RedskilledStatuslineRenderRequest {
  return {
    mode: options.mode,
    project: options.project,
    max_workers: options.maxWorkers,
    max_projects: options.maxProjects,
    max_width: options.maxWidth,
    verbose: options.verbose,
  };
}

/**
 * Publish one Worker's last logged line — the verbose statusline's whole supply.
 *
 * The Worker's own project publishes it, on the heartbeat it already sends, and
 * the daemon stores the string without reading it. **Clamping happens here, on the
 * publisher's side**: the daemon shortening a line would be the daemon touching
 * content, and a runaway log line must not make a heartbeat expensive.
 *
 * A refusal throws, exactly as a command's does; an ack that says `accepted:
 * false` is the benign race where the daemon had already let the Worker go.
 */
export async function publishRedskilledWorkerLogLine(
  paths: RedskilledPaths,
  heartbeat: { readonly worker_id: string; readonly line: string; readonly session_project?: string },
  config: RedskilledClientConfig = {},
): Promise<RedskilledWorkerHeartbeatAck> {
  const sessionProject = heartbeat.session_project ?? config.sessionProject;
  const value = await requestRedskilled(
    paths,
    {
      op: "worker-heartbeat",
      heartbeat: {
        worker_id: heartbeat.worker_id,
        last_log_line: clampPublishedLogLine(heartbeat.line),
        ...(sessionProject == null ? {} : { session_project: sessionProject }),
      },
    },
    config,
  );
  if (!isRedskilledWorkerHeartbeatAck(value)) throw new Error("redskilled daemon returned a malformed heartbeat ack");
  return value;
}

/**
 * Command one Worker — stop, recycle or steer.
 *
 * The command names the session's own project, and the daemon refuses it into
 * any other one. **A refusal throws**: a caller that read a refusal as a quiet
 * no-op would retry it forever, and one that could tell a refusal from an unknown
 * Worker would learn another project's Worker set by asking.
 */
export async function commandRedskilledWorker(
  paths: RedskilledPaths,
  command: RedskilledWorkerCommandRequest,
  config: RedskilledClientConfig = {},
): Promise<RedskilledWorkerCommandResult> {
  const value = await requestRedskilled(
    paths,
    {
      op: "worker-command",
      command: { ...command, session_project: command.session_project ?? config.sessionProject },
    },
    config,
  );
  if (!isRedskilledWorkerCommandResult(value)) throw new Error("redskilled daemon returned a malformed command result");
  return value;
}

/**
 * Ask the daemon for a Worker.
 *
 * The caller states the argv, the placement target, the budget and its own two
 * opaque strings; it learns back the pid, the unit and any warning. **A refusal
 * throws** — fail closed (ADR 0130 rule 6): a client that fell back to spawning
 * the Worker itself would reinstate exactly the unbudgeted spawn the daemon
 * exists to prevent.
 */
export async function startRedskilledWorker(
  paths: RedskilledPaths,
  spec: RedskilledWorkerSpec,
  config: RedskilledClientConfig = {},
): Promise<RedskilledWorkerStarted> {
  // Reaching the daemon is its own step so its failure is its own error: a
  // caller must be able to tell "the host refused this Worker" from "there was
  // no host to ask", and neither may end in a Worker.
  // `ensureRedskilledDaemon` already speaks that state, so it is rethrown as-is:
  // re-wrapping it would bury the resolved-bundle diagnostic one cause deeper.
  await ensureRedskilledDaemon(paths, config);
  // A client that stated no session project is dispatching into itself: the
  // spec's own label IS the session's project, and the reach rule only ever had
  // something to refuse when a session named a DIFFERENT one.
  const value = await requestRedskilled(
    paths,
    { op: "worker-start", spec, session_project: config.sessionProject ?? spec.project_label },
    config,
  );
  if (!isRedskilledWorkerStarted(value)) throw new Error("redskilled daemon returned a malformed worker record");
  return value;
}

/**
 * A spawn in flight: what was started, and the first thing that went wrong.
 *
 * `failure` exists so a daemon that never bound is diagnosed by the reason it
 * died rather than by a bare timeout — `ENOENT` on the resolved bundle and a
 * daemon that is merely slow read identically otherwise.
 */
interface SpawnedDaemon {
  readonly entry: ResolvedRedskilledEntry;
  failure?: Error;
  exit?: string;
}

async function waitForDaemon(
  paths: RedskilledPaths,
  config: RedskilledClientConfig,
  spawned?: SpawnedDaemon,
): Promise<void> {
  const deadline = Date.now() + (config.readyTimeoutMs ?? DEFAULT_REDSKILLED_READY_TIMEOUT_MS);
  for (;;) {
    if (await socketAnswers(paths.socketPath)) return;
    if (spawned?.failure) {
      throw new Error(
        `redskilled daemon failed to start from ${JSON.stringify(spawned.entry.entry ?? spawned.entry.command)} ` +
          `(resolved as ${spawned.entry.source}): ${spawned.failure.message}`,
      );
    }
    if (Date.now() >= deadline) {
      const from = spawned
        ? ` from ${JSON.stringify(spawned.entry.entry ?? spawned.entry.command)} (resolved as ${spawned.entry.source})${
            spawned.exit ? `, which ${spawned.exit}` : ""
          }`
        : "";
      throw new Error(`redskilled daemon did not start on ${JSON.stringify(paths.socketPath)}${from}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function spawnDaemon(paths: RedskilledPaths, config: RedskilledClientConfig): SpawnedDaemon {
  // Resolved before anything is launched: a missing bundle must be a named error
  // (ADR 0130 rule 6), never a process started from whatever the caller happens
  // to be running.
  const stated = config.serverCommand ?? (config.serverArgs != null ? process.execPath : undefined);
  const entry = requireRedskilledEntry(
    { ...(stated != null ? { serverCommand: stated } : {}), serverArgs: config.serverArgs },
    config.entryLookup ?? {},
  );
  const spawned: SpawnedDaemon = { entry };
  const args = [
    ...entry.args,
    ...redskilledServeArgv(paths, config.idleMs == null ? {} : { idleMs: config.idleMs }),
  ];
  const child = spawn(entry.command, args, {
    detached: true,
    stdio: "ignore",
    env: { ...(config.env ?? process.env), REDSKILLED_DAEMON: "1" },
  });
  // A detached child still reports its own launch failure to this process, and an
  // unhandled `error` event on a child is an uncaught exception in the caller —
  // so the listener is both the diagnosis and the safety.
  child.on("error", (err: Error) => {
    spawned.failure = err;
  });
  child.on("exit", (code, signal) => {
    spawned.exit = signal ? `died on ${signal}` : `exited with code ${code ?? -1}`;
  });
  child.unref();
  return spawned;
}
