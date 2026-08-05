/**
 * client — how a project reaches `redskilled`, including starting it.
 *
 * ADR 0130 rule 7: start is auto-spawn. The first client that needs the daemon
 * starts it, and an optional user unit only adds `Restart=always` on top —
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
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  acquireSpawnLock,
  describeSpawnLockHolder,
  isPidAlive,
  releaseSpawnLock,
  type SpawnLockHeld,
  type SpawnLockReaping,
} from "@reddb-io/shared/resident-core.js";
import {
  redskilledServeArgv,
  type RedskilledEntryLookup,
  type ResolvedRedskilledEntry,
} from "./daemon-entry.js";
import { requireRedskilledEntryWithFetch } from "./entry-fetch.js";
import { socketAnswers } from "./daemon.js";
import {
  describeRedskilledPresence,
  redskilledPresenceAdvice,
  type RedskilledPresence,
} from "./daemon-presence.js";
import { readRedskilledLeaseFile } from "./session-lease.js";
import { buildRedskilledNotRunningStop, type RedskilledDaemonStopped } from "./daemon-stop.js";
import { isRedskilledHostState, type RedskilledHostState } from "./host-state.js";
import { createRedskilledMachineClaimStore, RedskilledMachineHeldError } from "./machine-scope.js";
import type { RedskilledLaunchTemplate } from "./launch-template.js";
import type { RedskilledPaths } from "./paths.js";
import type { RedskilledProjectRegistrationRequest } from "./project-registration.js";
import {
  isRedskilledDashboard,
  isRedskilledProjectDeregistered,
  isRedskilledDaemonStopped,
  isRedskilledProjectRegistered,
  isRedskilledProjectRenewed,
  isRedskilledProjectReset,
  isRedskilledStatuslinePayload,
  isRedskilledStatuslineRender,
  isRedskilledWorkerCommandResult,
  isRedskilledWorkerHeartbeatAck,
  isRedskilledWorkerStarted,
  sendRedskilledRequest,
  type RedskilledProjectDeregistered,
  type RedskilledProjectRegistered,
  type RedskilledProjectRenewed,
  type RedskilledProjectReset,
  type RedskilledRequest,
  type RedskilledStatuslinePayload,
  type RedskilledStatuslineRender,
  type RedskilledStatuslineRenderRequest,
  type RedskilledDashboard,
  type RedskilledDashboardRenderRequest,
  type RedskilledWorkerDisplay,
  type RedskilledWorkerCommandRequest,
  type RedskilledWorkerCommandResult,
  type RedskilledWorkerHeartbeatAck,
  type RedskilledWorkerStarted,
} from "./protocol.js";
import {
  REDSKILLED_DASHBOARD_DEFAULTS,
  REDSKILLED_STATUSLINE_DEFAULTS,
  renderRedskilledDashboard,
  renderRedskilledStatusline,
  type RedskilledDashboard as RedskilledDashboardRender,
  type RedskilledDashboardOptions,
  type RedskilledStatuslineOptions,
} from "@reddb-io/redskilled-render";
import type { RedskilledStatuslineExtrasRequest } from "./statusline-payload.js";
import { clampPublishedWorkerDisplay } from "./worker-display.js";
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

// Presence travels with the reach for the same reason: the surface that catches
// an unreachable daemon is the surface that must tell an operator which of the
// three silences it was, and it should not need a second import path to read it.
export {
  describeRedskilledPresence,
  formatUptime,
  isRedskilledPresence,
  redskilledPresenceAdvice,
  type RedskilledPresence,
  type RedskilledPresenceHolder,
  type RedskilledPresenceKind,
} from "./daemon-presence.js";

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
    /**
     * Which of the three silences this was, when it could be established.
     *
     * Carried on the error rather than left to each surface to re-derive: a
     * consumer that re-probed would be asking a second time, a second later, and
     * could print an answer the failure it is reporting never had (#3092).
     */
    readonly presence?: RedskilledPresence,
  ) {
    super(
      `redskilled daemon is unreachable on ${JSON.stringify(socketPath)}, so no Worker was started: ${
        cause instanceof Error ? cause.message : String(cause)
      }${presence != null && presence.kind === "held-unresponsive" ? `. ${redskilledPresenceAdvice(presence)}` : ""}`,
    );
    this.name = "RedskilledUnreachableError";
  }
}

/**
 * Raised when the daemon IS there — a live pid holds this socket's lease — and
 * still did not answer.
 *
 * A subclass rather than a sibling, so every consumer that already fails closed
 * on {@link RedskilledUnreachableError} keeps doing so, while a surface that
 * renders operator advice can tell the two apart and stop telling an operator to
 * install a daemon that is running (#3092).
 */
export class RedskilledDaemonHeldError extends RedskilledUnreachableError {
  constructor(socketPath: string, override readonly presence: RedskilledPresence, cause: unknown) {
    super(socketPath, cause, presence);
    this.name = "RedskilledDaemonHeldError";
  }
}

/**
 * Raised when the daemon answered a request with an application-level refusal.
 *
 * This is deliberately distinct from {@link RedskilledUnreachableError}: both
 * leave the requested operation unapplied, but only the latter is transport
 * silence. Surfaces use the distinction to keep the daemon's explanation
 * instead of routing an answered refusal to installation advice (#3158).
 */
export class RedskilledRequestRefusedError extends Error {
  constructor(readonly refusal: string) {
    super(refusal);
    this.name = "RedskilledRequestRefusedError";
  }
}

/**
 * Ask what is actually on this socket: answering, held-but-silent, or absent.
 *
 * The one probe every surface shares. It reads the socket and the lease and hands
 * both to the pure classifier, so "which of the three states is this?" has one
 * answer on the machine rather than one per caller.
 */
export async function probeRedskilledPresence(
  paths: RedskilledPaths,
  options: { readonly answers?: boolean } = {},
): Promise<RedskilledPresence> {
  const answers = options.answers ?? (await socketAnswers(paths.socketPath));
  const lease = await readRedskilledLeaseFile(paths.leasePath).catch(() => undefined);
  return describeRedskilledPresence({
    socketPath: paths.socketPath,
    answers,
    lease,
    holderAlive: lease != null && isPidAlive(lease.pid),
  });
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
  /**
   * How long a spawn lock is believed before this client reaps it.
   *
   * Injected so a test can age a lock without waiting a minute; a real caller
   * passes nothing and gets `DEFAULT_SPAWN_LOCK_MAX_AGE_MS`.
   */
  readonly spawnLockMaxAgeMs?: number;
  /** Where a reaping is reported; stderr when nothing else is stated. */
  readonly onSpawnLockReaped?: (reaping: SpawnLockReaping) => void;
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
    if (err instanceof RedskilledUnreachableError) throw err;
    // The presence is read HERE, once, on the way out: a failure that carries no
    // account of what is on the socket is the failure that told an operator to
    // provision a daemon serving five hours of work (#3092).
    const presence = await probeRedskilledPresence(paths).catch(() => undefined);
    throw new RedskilledUnreachableError(paths.socketPath, err, presence);
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

  // And ask the socket's own lease before spawning too. A live pid holding THIS
  // socket is a daemon that exists, so the spawn about to happen would be refused
  // by the singleton guard — correctly — and its `exit 1` would then be reported
  // as "the daemon did not start" (#3092). Waiting is what a client owes a daemon
  // that is booting; naming the holder is what it owes one that is wedged.
  const held = await waitOutTheLeaseHolder(paths, config);
  if (held != null) return held;

  const lock = await acquireSpawnLock(paths.lockPath, {
    ...(config.spawnLockMaxAgeMs == null ? {} : { maxAgeMs: config.spawnLockMaxAgeMs }),
    onReap: config.onSpawnLockReaped ?? reportSpawnLockReaping,
  });
  if (!lock.acquired) {
    // Lost the spawn race. The winner is starting the very daemon we wanted, so
    // waiting for it is the whole job — restarting one would be the bug. What is
    // new is the gate travelling with the wait: if the winner never appears, the
    // failure names the lock rather than blaming a daemon that was never asked.
    await waitForDaemon(paths, config, undefined, lock);
    return "joined";
  }
  try {
    // Re-checked under the lock: between the first probe and the acquisition a
    // winner may already have bound, and spawning on top of it is the very
    // second daemon the lock exists to prevent.
    if (await socketAnswers(paths.socketPath)) return "already-running";
    const spawned = await spawnDaemon(paths, config);
    await waitForDaemon(paths, config, spawned);
    return "spawned";
  } finally {
    await releaseSpawnLock(lock);
  }
}

/**
 * Say out loud that a lock was reaped — the default, overridable per client.
 *
 * A reaping that left no trace would be indistinguishable from the lock never
 * having existed, and the one moment an operator needs this line is when the
 * guess was wrong and two daemons raced.
 */
function reportSpawnLockReaping(reaping: SpawnLockReaping): void {
  process.stderr.write(
    `redskilled: reaped the spawn lock ${JSON.stringify(reaping.lockPath)} (${reaping.reason}, ` +
      `${Math.round(reaping.ageMs / 1_000)}s old, holder ${reaping.holder == null ? "unnamed" : `pid ${reaping.holder.pid}`}) ` +
      "and went on to spawn\n",
  );
}

/**
 * Wait for the daemon the lease already names, instead of spawning a rival.
 *
 * Returns `"joined"` when the holder started answering inside the ready window,
 * `null` when there is no live holder (so the ordinary spawn should proceed), and
 * THROWS {@link RedskilledDaemonHeldError} when a live pid holds this socket and
 * never answered — which is a daemon to inspect or stop, not one to install.
 *
 * A lease is written before the socket is bound, so a holder that is merely mid-
 * boot is the common case and waiting for it is exactly right; the throw is what
 * an operator gets only after the same window the spawn path would have used.
 */
async function waitOutTheLeaseHolder(
  paths: RedskilledPaths,
  config: RedskilledClientConfig,
): Promise<"joined" | null> {
  const presence = await probeRedskilledPresence(paths, { answers: false }).catch(() => undefined);
  if (presence == null || presence.kind !== "held-unresponsive") return null;

  const timeoutMs = config.readyTimeoutMs ?? DEFAULT_REDSKILLED_READY_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await socketAnswers(paths.socketPath)) return "joined";
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  // Re-read rather than reusing the opening snapshot: a holder that exited during
  // the wait leaves a stale record, and reporting a dead pid as the live owner is
  // the same class of lie in the other direction.
  const settled = await probeRedskilledPresence(paths).catch(() => undefined);
  if (settled == null || settled.kind !== "held-unresponsive") return null;
  throw new RedskilledDaemonHeldError(
    paths.socketPath,
    settled,
    new Error(
      `it did not answer a ping within ${timeoutMs}ms, and no second daemon was spawned because pid ` +
        `${settled.holder?.pid ?? "unknown"} still holds this socket`,
    ),
  );
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
    // Which of the three silences it became is read now, while it is true.
    throw new RedskilledUnreachableError(
      paths.socketPath,
      err,
      await probeRedskilledPresence(paths).catch(() => undefined),
    );
  }
  if (!response.ok) throw new RedskilledRequestRefusedError(response.error);
  return response.value;
}

/**
 * Stop the daemon on this session's socket, and report what that costs.
 *
 * **Never auto-spawns.** Every other client call starts a daemon that is not
 * there, and doing that here would mean a stop first births the very process it
 * was asked to remove — so the socket is probed directly and a silent one is a
 * success with a stated reason (#2919).
 *
 * The report is read BEFORE the daemon lets go, so it states what was being held
 * rather than what is left. The wait afterwards is what makes the answer safe to
 * act on: an operator replacing a daemon needs `stopped: true` to mean the socket
 * is free, not that the request was accepted.
 */
export async function stopRedskilledDaemon(
  paths: RedskilledPaths,
  options: {
    /** The operator's words for why; recorded with the stop on the event lane. */
    readonly detail?: string;
    /** How long to wait for the socket to go quiet. */
    readonly settleTimeoutMs?: number;
  } = {},
  config: RedskilledClientConfig = {},
): Promise<RedskilledDaemonStopped> {
  if (!(await socketAnswers(paths.socketPath))) return buildRedskilledNotRunningStop(paths.socketPath);

  let response;
  try {
    response = await sendRedskilledRequest(
      { socketPath: paths.socketPath, timeoutMs: config.requestTimeoutMs ?? 2_000 },
      { id: randomUUID(), op: "shutdown", ...(options.detail == null ? {} : { detail: options.detail }) },
    );
  } catch (err) {
    // A daemon that answered a ping and then dropped the connection is a daemon
    // saying nothing, which is the one thing a stop must not report as done.
    throw new RedskilledUnreachableError(paths.socketPath, err);
  }
  if (!response.ok) throw new RedskilledRequestRefusedError(response.error);
  if (!isRedskilledDaemonStopped(response.value)) throw new Error("redskilled daemon returned a malformed stop report");
  const report = response.value;

  const settled = await waitForSilence(paths.socketPath, options.settleTimeoutMs ?? 5_000);
  return settled
    ? report
    : {
      ...report,
      stopped: false,
      detail: `${report.detail}; the daemon accepted the stop and is still answering on ` +
        `${JSON.stringify(paths.socketPath)}`,
    };
}

/** True once nothing answers on `socketPath`, within `timeoutMs`. */
async function waitForSilence(socketPath: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!(await socketAnswers(socketPath))) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
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
  /**
   * Which count-scaling extras this reader needs; every one of them when absent.
   *
   * Absent is the compatibility spelling and the honest one: a caller that says
   * nothing gets the whole document, exactly as every bundle pinned before ADR
   * 0132 decision 2 does. A caller that knows its density — a one-line statusline
   * needs no log lines — states it and pays for less.
   */
  extras?: RedskilledStatuslineExtrasRequest,
): Promise<RedskilledStatuslinePayload> {
  const value = await requestRedskilled(
    paths,
    {
      op: "statusline-payload",
      ...(config.sessionProject != null ? { session_project: config.sessionProject } : {}),
      ...(extras == null ? {} : { extras }),
    },
    config,
  );
  if (!isRedskilledStatuslinePayload(value)) throw new Error("redskilled daemon returned a malformed statusline payload");
  return value;
}

/**
 * The statusline, read from the socket and drawn HERE. PURE after the read.
 *
 * **The command-backed host keeps the socket and passes through the shared
 * render** (ADR 0132 decision 9). A `statusLine` entry is a shell command, not an
 * MCP client, so routing this tick through a server would mean a handshake per
 * tick and a blank line whenever the server is not up — the hardest failure mode
 * in this system to diagnose. What keeps this surface from drifting away from the
 * MCP one is no longer a shared string but shared code: both call
 * `renderRedskilledStatusline` on the payload the daemon composed.
 *
 * The log lines are asked for only in `verbose`, which is the one density that
 * draws them; every other read pays for the skeleton and the vitals alone.
 */
export async function readRedskilledStatuslineRender(
  paths: RedskilledPaths,
  options: RedskilledStatuslineOptions = REDSKILLED_STATUSLINE_DEFAULTS,
  config: RedskilledClientConfig = {},
): Promise<RedskilledStatuslineRender> {
  const payload = await readRedskilledStatuslinePayload(paths, config, {
    vitals: true,
    logs: options.verbose,
    // Asked for, or the line renders a UUID and an age. The daemon holds a
    // display record per Worker and hands it over only when a reader names the
    // extra — so runner, model, effort, phase, the progress bar and the issue
    // were built, published, stored, and never requested (#3144).
    display: true,
  });
  return renderRedskilledStatusline(payload, options);
}

/**
 * The host dashboard, read from the socket and drawn HERE (#3098).
 *
 * **The same payload and the same render as the statusline, at a taller
 * density.** ADR 0132 decision 1 moved layout out of the daemon precisely so
 * four surfaces could differ in height without differing in content; this is
 * the terminal one, and it is a density argument rather than a second renderer.
 *
 * Vitals and log lines are both asked for, because a dashboard is the density
 * that draws them — the statusline pays for logs only under `--verbose`, and a
 * dashboard that omitted them would be a taller statusline rather than a
 * dashboard.
 */
export async function readRedskilledDashboardRender(
  paths: RedskilledPaths,
  options: Partial<RedskilledDashboardOptions> = {},
  config: RedskilledClientConfig = {},
): Promise<RedskilledDashboardRender> {
  // All three extras: a dashboard is the density that draws every one of them,
  // and the display is what makes a row a Worker rather than an identifier.
  const payload = await readRedskilledStatuslinePayload(paths, config, {
    vitals: true,
    logs: true,
    display: true,
  });
  return renderRedskilledDashboard(payload, { ...REDSKILLED_DASHBOARD_DEFAULTS, ...options });
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

/**
 * The dashboard: the same read again, rendered as a table.
 *
 * A surface with a vertical dimension — a terminal pane, an editor panel — calls
 * this and PRINTS what comes back. It never re-derives a cell: the header, the
 * rows and the pipeline bars are computed once, in the one process that holds the
 * Worker set across projects, so a pane and the statusline beside it cannot
 * describe two different machines (ADR 0130 rule 10).
 */
export async function readRedskilledDashboard(
  paths: RedskilledPaths,
  options: Partial<RedskilledDashboardOptions> | undefined = undefined,
  config: RedskilledClientConfig = {},
): Promise<RedskilledDashboard> {
  const value = await requestRedskilled(
    paths,
    {
      op: "statusline-dashboard",
      ...(config.sessionProject != null ? { session_project: config.sessionProject } : {}),
      ...(options == null ? {} : { dashboard: dashboardRequest(options) }),
    },
    config,
  );
  if (!isRedskilledDashboard(value)) throw new Error("redskilled daemon returned a malformed dashboard");
  return value;
}

/** The wire shape of decided dashboard options. PURE. */
function dashboardRequest(options: Partial<RedskilledDashboardOptions>): RedskilledDashboardRenderRequest {
  return {
    ...(options.mode == null ? {} : { mode: options.mode }),
    ...(options.project === undefined ? {} : { project: options.project }),
    ...(options.maxWidth == null ? {} : { max_width: options.maxWidth }),
    ...(options.maxRows == null ? {} : { max_rows: options.maxRows }),
  };
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
  heartbeat: {
    readonly worker_id: string;
    readonly line: string;
    /** What a surface should SHOW about this Worker; omitted publishes nothing. */
    readonly display?: RedskilledWorkerDisplay;
    readonly session_project?: string;
  },
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
        ...(heartbeat.display == null ? {} : { display: clampPublishedWorkerDisplay(heartbeat.display) }),
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
 * Register this project with the daemon — what work it wants, and what to run.
 *
 * A project contributes a registration rather than a process (ADR 0130 Amendment
 * 3), and the two strings it hands over are opaque to the host: the daemon stores
 * the selector and the argv and returns them unread. **A refusal throws** — a
 * second registration for one project is a duplicate loop to surface, never a
 * record to quietly replace, and the thrown sentence names the one standing.
 */
export async function registerRedskilledProject(
  paths: RedskilledPaths,
  registration: RedskilledProjectRegistrationRequest,
  config: RedskilledClientConfig = {},
): Promise<RedskilledProjectRegistered> {
  // A client that stated no session project is registering itself, exactly as a
  // dispatch into its own label is: the registration's own project IS the session's.
  const value = await requestRedskilled(
    paths,
    {
      op: "project-register",
      registration,
      session_project: config.sessionProject ?? registration.project_label,
    },
    config,
  );
  if (!isRedskilledProjectRegistered(value)) throw new Error("redskilled daemon returned a malformed registration");
  return value;
}

/**
 * Say this project's session is still here, so its registration keeps standing.
 *
 * **The registration outlives the session, and the renewal is why it does not
 * outlive it forever.** A drain keeps being polled after the operator closes the
 * terminal, all the way to the deadline the last renewal set; a laptop that closed
 * mid-tick stops being a registered project one window later instead of polling a
 * repository for the rest of the afternoon. **A refusal throws**, including the
 * one that says the daemon holds no such registration: a client that read a lapsed
 * record as renewed would keep renewing nothing while its work sat undrained.
 */
export async function renewRedskilledProject(
  paths: RedskilledPaths,
  request: { project_label: string; renew_within_ms?: number; launch?: RedskilledLaunchTemplate },
  config: RedskilledClientConfig = {},
): Promise<RedskilledProjectRenewed> {
  const value = await requestRedskilled(
    paths,
    {
      op: "project-renew",
      project_label: request.project_label,
      ...(request.renew_within_ms == null ? {} : { renew_within_ms: request.renew_within_ms }),
      // The one field a renewal may restate: what the NEXT Worker is started
      // with. A tick that swapped the runner sends it here rather than
      // re-registering, so the project is never momentarily unheld (Amendment 5).
      ...(request.launch == null ? {} : { launch: request.launch }),
      session_project: config.sessionProject ?? request.project_label,
    },
    config,
  );
  if (!isRedskilledProjectRenewed(value)) throw new Error("redskilled daemon returned a malformed renewal");
  return value;
}

/** Clear this project's in-memory birth breaker and resume ordinary demand. */
export async function resetRedskilledProjectBirthBreaker(
  paths: RedskilledPaths,
  request: { project_label: string },
  config: RedskilledClientConfig = {},
): Promise<RedskilledProjectReset> {
  const value = await requestRedskilled(
    paths,
    {
      op: "project-reset",
      project_label: request.project_label,
      latch: "project-birth-breaker",
      session_project: config.sessionProject ?? request.project_label,
    },
    config,
  );
  if (!isRedskilledProjectReset(value)) throw new Error("redskilled daemon returned a malformed project reset");
  return value;
}

/**
 * Give this project's registration back — the project stops contributing.
 *
 * **A refusal throws; an already-released project does not.** The two are
 * different answers: a cross-project release is a client aiming at work that is
 * not its own, while releasing twice is the ordinary shape of stopping work an
 * operator and an ending session can both stop.
 */
export async function deregisterRedskilledProject(
  paths: RedskilledPaths,
  request: { project_label: string },
  config: RedskilledClientConfig = {},
): Promise<RedskilledProjectDeregistered> {
  const value = await requestRedskilled(
    paths,
    {
      op: "project-deregister",
      project_label: request.project_label,
      session_project: config.sessionProject ?? request.project_label,
    },
    config,
  );
  if (!isRedskilledProjectDeregistered(value)) throw new Error("redskilled daemon returned a malformed release");
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
  /**
   * The gate that stopped this client spawning, when one did.
   *
   * Carried into the wait rather than re-read at the timeout, because a lock
   * released a moment before the deadline would leave the failure describing a
   * gate that is no longer there — and the sentence owed is about the gate that
   * refused, not the state afterwards.
   */
  heldBy?: SpawnLockHeld,
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
      // A spawn this client never attempted must not be reported as one that
      // failed: "the daemon did not start" sends an operator to inspect a daemon
      // that is healthy, which is #3092's misattribution through another door.
      if (heldBy != null) {
        throw new Error(
          `no redskilled daemon answered on ${JSON.stringify(paths.socketPath)} within the ready window, and ` +
            `${describeSpawnLockHolder(heldBy)}`,
        );
      }
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

async function spawnDaemon(paths: RedskilledPaths, config: RedskilledClientConfig): Promise<SpawnedDaemon> {
  // Resolved before anything is launched: a missing bundle must be a named error
  // (ADR 0130 rule 6), never a process started from whatever the caller happens
  // to be running.
  const stated = config.serverCommand ?? (config.serverArgs != null ? process.execPath : undefined);
  // A host that has never cached the bundle has no local path to resolve, so the
  // fetch rung runs BEFORE the fail-closed raise. Local always wins: a checkout's
  // own entry must never lose to a published one (#2961).
  const entry = await requireRedskilledEntryWithFetch(
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
