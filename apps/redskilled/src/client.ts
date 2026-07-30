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
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tryAcquireExclusiveLock } from "@reddb-io/shared/resident-core.js";
import { socketAnswers } from "./daemon.js";
import { isRedskilledHostState, type RedskilledHostState } from "./host-state.js";
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
  /** The command that runs the daemon; defaults to this bundle's own entry. */
  readonly serverCommand?: string;
  readonly serverArgs?: readonly string[];
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
  await mkdir(dirname(paths.socketPath), { recursive: true, mode: 0o700 });
  if (await socketAnswers(paths.socketPath)) return "already-running";

  const lock = await tryAcquireExclusiveLock(paths.lockPath);
  if (!lock) {
    // Lost the spawn race. The winner is starting the very daemon we wanted, so
    // waiting for it is the whole job — restarting one would be the bug.
    await waitForDaemon(paths, config);
    return "joined";
  }
  try {
    if (await socketAnswers(paths.socketPath)) return "already-running";
    spawnDaemon(paths, config);
    await waitForDaemon(paths, config);
    return "spawned";
  } finally {
    await lock.close();
    await rm(paths.lockPath, { force: true });
  }
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
  const response = await sendRedskilledRequest(
    { socketPath: paths.socketPath, timeoutMs: config.requestTimeoutMs ?? 2_000 },
    { ...request, id: randomUUID() } as RedskilledRequest,
  );
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
  try {
    await ensureRedskilledDaemon(paths, config);
  } catch (err) {
    throw new RedskilledUnreachableError(paths.socketPath, err);
  }
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

async function waitForDaemon(paths: RedskilledPaths, config: RedskilledClientConfig): Promise<void> {
  const deadline = Date.now() + (config.readyTimeoutMs ?? DEFAULT_REDSKILLED_READY_TIMEOUT_MS);
  for (;;) {
    if (await socketAnswers(paths.socketPath)) return;
    if (Date.now() >= deadline) throw new Error(`redskilled daemon did not start on ${JSON.stringify(paths.socketPath)}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function spawnDaemon(paths: RedskilledPaths, config: RedskilledClientConfig): void {
  const command = config.serverCommand ?? process.execPath;
  const args = [
    ...(config.serverArgs ?? defaultServerArgs()),
    "serve",
    "--socket",
    paths.socketPath,
    "--lease",
    paths.leasePath,
    "--events",
    paths.eventLanePath,
    "--session-key-hash",
    paths.sessionKeyHash,
    "--machine-id-hash",
    paths.machineIdHash,
  ];
  if (config.idleMs != null) args.push("--idle-ms", String(config.idleMs));
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
    env: { ...(config.env ?? process.env), REDSKILLED_DAEMON: "1" },
  });
  child.unref();
}

function defaultServerArgs(): string[] {
  return [resolveRedskilledDaemonEntry()];
}

/** The shipped bundle's file name — the artifact a release carries (issue #2842). */
export const REDSKILLED_BUNDLE_ASSET = "redskilled.bundle.min.mjs";

/**
 * The file a spawn must invoke to get a daemon — named, never inferred from argv.
 *
 * A bundled release has no `cli.js`: `pnpm bundle` collapses the whole app into
 * one `redskilled.bundle.min.mjs`, so the sibling-`cli.js` guess this used to
 * make resolved to a path that never ships and the auto-spawn died on a missing
 * file. Ordering is explicit-before-inferred, for the same reason #2736 gave rsp
 * a named resolver: **this module is only the entry when it IS the bundle**,
 * because a foreign host that inlines this client (a plugin bundle importing
 * `@reddb-io/redskilled/client`) would otherwise re-exec *itself* with `serve`.
 *
 * PURE apart from the injected existence check.
 */
export function resolveRedskilledDaemonEntry(
  lookup: { readonly self?: string; readonly exists?: (path: string) => boolean } = {},
): string {
  const self = lookup.self ?? fileURLToPath(import.meta.url);
  const exists = lookup.exists ?? existsSync;
  const dir = dirname(self);
  if (basename(self) === REDSKILLED_BUNDLE_ASSET) return self;
  const sibling = join(dir, REDSKILLED_BUNDLE_ASSET);
  if (exists(sibling)) return sibling;
  return join(dir, "cli.js");
}
