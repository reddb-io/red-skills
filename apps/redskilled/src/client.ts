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
import { tryAcquireExclusiveLock } from "@reddb-io/shared/resident-core.js";
import { socketAnswers } from "./daemon.js";
import { isRedskilledHostState, type RedskilledHostState } from "./host-state.js";
import type { RedskilledPaths } from "./paths.js";
import { sendRedskilledRequest, type RedskilledRequest } from "./protocol.js";

/** How long a client waits for a daemon — its own or the race winner's — to answer. */
export const DEFAULT_REDSKILLED_READY_TIMEOUT_MS = 10_000;

export interface RedskilledClientConfig {
  /** The command that runs the daemon; defaults to this bundle's own entry. */
  readonly serverCommand?: string;
  readonly serverArgs?: readonly string[];
  readonly idleMs?: number;
  readonly readyTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly env?: NodeJS.ProcessEnv;
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

/** One request against a running daemon; auto-spawns first. Throws on refusal. */
export async function requestRedskilled(
  paths: RedskilledPaths,
  request: Omit<RedskilledRequest, "id">,
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
  return [new URL("./cli.js", import.meta.url).pathname];
}
