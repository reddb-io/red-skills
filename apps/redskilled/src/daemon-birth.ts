/**
 * daemon-birth — the ONE route from "no daemon on this host" to a live one.
 *
 * **It belongs to `provision`, not to a client** (ADR 0150 §4). The daemon is an
 * always-on OS service now: the installed unit starts it, and a client that
 * cannot find one fails closed with the repair sentence rather than launching a
 * process of its own. What is left here is the provisioner's own start — the
 * moment an operator has explicitly asked this machine to acquire a daemon.
 *
 * The supervisor is tried first, and the direct spawn is the floor beneath it:
 * a host with no systemd `--user` session can still be provisioned, and asking
 * an installed unit is always better than racing it.
 */
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
// The module, not the barrel (#4064): the barrel re-exports the lifecycle.
import { socketAnswers } from "./daemon/socket.js";
import { startThroughInstalledSupervisor } from "./client-rendezvous.js";
import { redskilledServeArgv, type ResolvedRedskilledEntry } from "./daemon-entry.js";
import { requireRedskilledEntryWithFetch } from "./entry-fetch.js";
import { DEFAULT_REDSKILLED_READY_TIMEOUT_MS, type RedskilledClientConfig } from "./client.js";
import type { RedskilledPaths } from "./paths.js";

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

/**
 * Bring a daemon into being for a machine an operator is provisioning.
 *
 * Returns how it got there. `already-running` and `joined` mean this call
 * started nothing; `supervised` means systemd did; `spawned` means this process
 * did, which happens only where no user unit can be installed.
 */
export async function birthRedskilledDaemon(
  paths: RedskilledPaths,
  config: RedskilledClientConfig = {},
): Promise<"already-running" | "supervised" | "spawned"> {
  await mkdir(dirname(paths.socketPath), { recursive: true, mode: 0o700 });
  if (await socketAnswers(paths.socketPath)) return "already-running";
  if (await startThroughInstalledSupervisor(paths, config, DEFAULT_REDSKILLED_READY_TIMEOUT_MS)) {
    return "supervised";
  }
  const spawned = await spawnDaemon(paths, config);
  await waitForDaemon(paths, config, spawned);
  return "spawned";
}

async function waitForDaemon(
  paths: RedskilledPaths,
  config: RedskilledClientConfig,
  spawned: SpawnedDaemon,
): Promise<void> {
  const deadline = Date.now() + (config.readyTimeoutMs ?? DEFAULT_REDSKILLED_READY_TIMEOUT_MS);
  for (;;) {
    if (await socketAnswers(paths.socketPath)) return;
    if (spawned.failure) {
      throw new Error(
        `redskilled daemon failed to start from ${JSON.stringify(spawned.entry.entry ?? spawned.entry.command)} ` +
          `(resolved as ${spawned.entry.source}): ${spawned.failure.message}`,
      );
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `redskilled daemon did not start on ${JSON.stringify(paths.socketPath)} from ` +
          `${JSON.stringify(spawned.entry.entry ?? spawned.entry.command)} (resolved as ${spawned.entry.source})` +
          `${spawned.exit ? `, which ${spawned.exit}` : ""}`,
      );
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
  const args = [...entry.args, ...redskilledServeArgv(paths)];
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
