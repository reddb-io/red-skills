/**
 * paths — where this machine's `redskilled` daemon lives, as the editor sees it.
 *
 * The derivation is the daemon's own: `resolveRedskilledPaths` from
 * `@reddb-io/redskilled/paths` is imported rather than mirrored, because a copy
 * is where the extension and the daemon would silently disagree about which
 * socket is the socket. The extension only adds what a workspace surface needs on
 * top: a settings-level pin, and a sentence saying which rule produced the path.
 *
 * `source` travels with the answer because it is asked for precisely when nothing
 * answers — an operator staring at "not reachable" needs to know whether the
 * extension looked where they think it looked.
 */
import { dirname, join } from "node:path";
import {
  REDSKILLED_SESSION_ENV,
  resolveRedskilledPaths as resolveDaemonPaths,
} from "@reddb-io/redskilled/paths";
import { REDSKILLED_EVENT_LANE_FILE } from "@reddb-io/redskilled/event-lane";

/** Env var that pins the socket outright, ahead of every derivation. */
export const REDSKILLED_SOCKET_ENV = "REDSKILLED_SOCKET";

export interface ResolvedExtensionPaths {
  readonly socketPath: string;
  /** The lane lives beside whichever socket is in force, never beside another. */
  readonly eventLanePath: string;
  readonly runtimeDir: string;
  /** What the derivation alone would have produced, pin or no pin. */
  readonly derivedSocketPath: string;
  readonly sessionKeyHash: string;
  /** Which rule produced {@link socketPath}, in the operator's words. */
  readonly source: string;
}

export interface ResolveExtensionPathsOptions {
  readonly env?: NodeJS.ProcessEnv;
  /** The `redskilled.socketPath` setting; empty and blank both mean "derive it". */
  readonly settingSocketPath?: string;
}

/**
 * The socket this extension will dial, and how it came to believe in it.
 *
 * A pinned socket moves the event lane with it. Honouring the pin for the socket
 * while deriving the lane would point the two reads at two different daemons'
 * directories, and they would then disagree in silence — the live view showing
 * one host and the event view narrating another.
 */
export function resolveExtensionPaths(
  options: ResolveExtensionPathsOptions = {},
): ResolvedExtensionPaths {
  const env = options.env ?? process.env;
  const derived = resolveDaemonPaths({ env });
  const pinned = options.settingSocketPath?.trim() || env[REDSKILLED_SOCKET_ENV]?.trim() || "";
  const socketPath = pinned || derived.socketPath;
  const runtimeDir = pinned ? dirname(pinned) : derived.runtimeDir;

  return {
    socketPath,
    eventLanePath: join(runtimeDir, REDSKILLED_EVENT_LANE_FILE),
    runtimeDir,
    derivedSocketPath: derived.socketPath,
    sessionKeyHash: derived.sessionKeyHash,
    source: describeSource({ env, settingSocketPath: options.settingSocketPath }),
  };
}

function describeSource(options: Required<Pick<ResolveExtensionPathsOptions, "env">> & {
  settingSocketPath?: string;
}): string {
  if (options.settingSocketPath?.trim()) return "the redskilled.socketPath setting";
  if (options.env[REDSKILLED_SOCKET_ENV]?.trim()) return `derived from ${REDSKILLED_SOCKET_ENV}`;
  if (options.env[REDSKILLED_SESSION_ENV]?.trim()) return `derived from ${REDSKILLED_SESSION_ENV}`;
  if (options.env.XDG_RUNTIME_DIR?.trim()) return "derived from XDG_RUNTIME_DIR";
  return "derived from the uid";
}
