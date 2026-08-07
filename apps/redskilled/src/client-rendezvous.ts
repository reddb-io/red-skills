/**
 * client-rendezvous — route one client to the host daemon that actually owns it.
 *
 * Socket paths are session-derived, while daemon ownership is machine-scoped.
 * The live machine claim therefore acts as a same-user rendezvous when two
 * environments disagree about XDG, and remains a hard boundary across uids.
 * Once a user unit is installed, systemd is the sole cold-start authority.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { isPidAlive } from "@reddb-io/shared/resident-core.js";
import { socketAnswers } from "./daemon.js";
import {
  createRedskilledMachineClaimStore,
  currentMachineOwner,
  REDSKILLED_MACHINE_DIR_ENV,
  RedskilledMachineHeldError,
  resolveMachineClaimPath,
} from "./machine-scope.js";
import type { RedskilledPaths } from "./paths.js";
import { redskilledUnitPath, REDSKILLED_UNIT_NAME } from "./supervision.js";

export interface RedskilledRendezvousConfig {
  readonly readyTimeoutMs?: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly supervisor?: {
    readonly installed?: () => boolean;
    readonly start?: () => Promise<void> | void;
  };
}

export interface RedskilledClientEndpoint {
  readonly paths: RedskilledPaths;
  readonly joined: boolean;
}

/** Route a same-user client through the live machine claim, when one exists. */
export async function resolveRedskilledClientEndpoint(
  paths: RedskilledPaths,
): Promise<RedskilledClientEndpoint> {
  const store = createRedskilledMachineClaimStore(paths.machineClaimPath, {
    machineIdHash: paths.machineIdHash,
    sessionKeyHash: paths.sessionKeyHash,
    socketPath: paths.socketPath,
  });
  const claim = await store.read().catch(() => undefined);
  if (
    claim == null ||
    claim.socket_path === paths.socketPath ||
    claim.uid !== currentMachineOwner().uid ||
    !isPidAlive(claim.pid)
  ) {
    return { paths, joined: false };
  }
  const runtimeDir = dirname(claim.socket_path);
  return {
    joined: true,
    paths: {
      ...paths,
      runtimeDir,
      socketPath: claim.socket_path,
      lockPath: join(runtimeDir, basename(paths.lockPath)),
      leasePath: join(runtimeDir, basename(paths.leasePath)),
    },
  };
}

/** Refuse a foreign live holder before this client spawns even for a heartbeat. */
export async function refuseWhenMachineIsHeld(paths: RedskilledPaths): Promise<void> {
  const store = createRedskilledMachineClaimStore(paths.machineClaimPath, {
    machineIdHash: paths.machineIdHash,
    sessionKeyHash: paths.sessionKeyHash,
    socketPath: paths.socketPath,
  });
  const claim = await store.read().catch(() => undefined);
  if (claim == null || claim.socket_path === paths.socketPath || !isPidAlive(claim.pid)) return;
  throw new RedskilledMachineHeldError(paths.machineClaimPath, "held", claim);
}

/** Ask an installed user unit to start, without racing it with direct spawn. */
export async function startThroughInstalledSupervisor(
  paths: RedskilledPaths,
  config: RedskilledRendezvousConfig,
  defaultReadyTimeoutMs: number,
): Promise<boolean> {
  const env = config.env ?? process.env;
  const injectedInstalled = config.supervisor?.installed?.();
  const pinnedMachineDir = env[REDSKILLED_MACHINE_DIR_ENV]?.trim();
  // Explicit secondary host models must not inherit the ambient host's unit.
  // An injected supervisor seam remains authoritative for tests and diagnostics.
  if (
    injectedInstalled == null &&
    ((pinnedMachineDir != null && pinnedMachineDir !== "") ||
      paths.machineClaimPath !== resolveMachineClaimPath({ env, machineIdHash: paths.machineIdHash }))
  ) {
    return false;
  }
  const installed = injectedInstalled ?? existsSync(redskilledUnitPath(env));
  if (!installed) return false;
  if (config.supervisor?.start != null) {
    await config.supervisor.start();
  } else {
    const started = spawnSync("systemctl", ["--user", "start", REDSKILLED_UNIT_NAME], {
      encoding: "utf8",
      env,
    });
    if (started.error != null || started.status !== 0) {
      throw new Error(
        `redskilled found the installed ${REDSKILLED_UNIT_NAME}, but systemd did not start it: ` +
          `${started.error?.message ?? (started.stderr || started.stdout || `status ${started.status}`).trim()}`,
      );
    }
  }
  await waitForSupervisedDaemon(paths, config, defaultReadyTimeoutMs);
  return true;
}

/** Follow the claim that appears only after systemd starts its configured unit. */
async function waitForSupervisedDaemon(
  paths: RedskilledPaths,
  config: RedskilledRendezvousConfig,
  defaultReadyTimeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + (config.readyTimeoutMs ?? defaultReadyTimeoutMs);
  for (;;) {
    const endpoint = await resolveRedskilledClientEndpoint(paths);
    if (await socketAnswers(endpoint.paths.socketPath)) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `the installed ${REDSKILLED_UNIT_NAME} did not expose a same-user daemon within the ready window ` +
          `(client socket ${JSON.stringify(paths.socketPath)})`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
