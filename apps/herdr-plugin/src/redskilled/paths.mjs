/**
 * paths — where this machine's `redskilled` daemon lives.
 *
 * The derivation mirrors `apps/redskilled/src/paths.ts` and
 * `packages/shared/resident-core.ts` in reddb-io/red-skills, byte for byte. It is
 * a mirror rather than an import because a plugin is installed beside herdr, not
 * beside a checkout: it must resolve the socket on a machine that holds no copy
 * of the red-skills workspace at all.
 *
 * A mirror can drift, so it is never the only route: `REDSKILLED_SOCKET` (or
 * `socketPath` in the plugin config) states the path outright and wins over every
 * derivation, which is what keeps an operator un-stuck when the daemon moves.
 */
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** The socket file name; also the length the runtime dir must accommodate. */
export const REDSKILLED_SOCKET_FILE = "redskilled.sock";

/** The append-only host event lane the daemon rehydrates itself from. */
export const REDSKILLED_EVENT_LANE_FILE = "redskilled.events.toonl";

/** The kernel's `sockaddr_un.sun_path` budget; a longer path cannot be bound. */
export const UNIX_SOCKET_PATH_LIMIT = 108;

/** Env var that pins the socket outright, ahead of every derivation. */
export const REDSKILLED_SOCKET_ENV = "REDSKILLED_SOCKET";

/** Env var that pins the session scope, exactly as the daemon reads it. */
export const REDSKILLED_SESSION_ENV = "REDSKILLED_SESSION";

function uidOf() {
  return typeof process.getuid === "function" ? process.getuid() : "nouid";
}

/**
 * Which session scope this machine resolves to, most explicit source first.
 *
 * `REDSKILLED_SESSION` wins, then `XDG_RUNTIME_DIR` (per user on Linux, so every
 * login of one operator lands on the same daemon), then the uid.
 */
export function resolveSessionKey(env = process.env) {
  const pinned = env[REDSKILLED_SESSION_ENV]?.trim();
  if (pinned) return pinned;
  const xdg = env.XDG_RUNTIME_DIR?.trim();
  if (xdg) return xdg;
  return `uid:${uidOf()}`;
}

/**
 * The runtime directory for a scope's socket, preferring `XDG_RUNTIME_DIR`.
 *
 * The XDG candidate is used only while the resulting socket path still fits
 * `sun_path`; otherwise the shorter `tmpdir()` form wins, because a path the
 * kernel refuses to bind is not an option.
 */
export function runtimeSocketDir({ key, socketFileName, env = process.env }) {
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 20);
  const xdg = env.XDG_RUNTIME_DIR;
  if (xdg) {
    const candidate = join(xdg, "red-skills", hash);
    if (join(candidate, socketFileName).length < UNIX_SOCKET_PATH_LIMIT) return candidate;
  }
  return join(tmpdir(), `red-skills-${uidOf()}`, hash);
}

/**
 * Where the daemon lives, and how this process came to believe it.
 *
 * `source` travels with the answer so `red-skills doctor` can say which rule
 * produced the path instead of leaving an operator to guess which of three it
 * was — the question asked precisely when nothing answers.
 */
export function resolveRedskilledPaths({ env = process.env, socketPath } = {}) {
  const pinned = socketPath?.trim() || env[REDSKILLED_SOCKET_ENV]?.trim();
  const sessionKey = resolveSessionKey(env);
  const runtimeDir = runtimeSocketDir({
    key: `redskilled:${sessionKey}`,
    socketFileName: REDSKILLED_SOCKET_FILE,
    env,
  });
  const derived = join(runtimeDir, REDSKILLED_SOCKET_FILE);
  // The lane lives in the daemon's runtime directory, beside its socket — so a
  // pinned socket moves the lane with it. Deriving the lane while honouring an
  // explicit socket would send the event view to one daemon's directory and
  // every socket read to another's, and the two would disagree in silence.
  const activeRuntimeDir = pinned ? dirname(pinned) : runtimeDir;
  return {
    sessionKey,
    sessionKeyHash: createHash("sha256").update(sessionKey).digest("hex").slice(0, 12),
    runtimeDir: activeRuntimeDir,
    derivedRuntimeDir: runtimeDir,
    socketPath: pinned || derived,
    derivedSocketPath: derived,
    eventLanePath: join(activeRuntimeDir, REDSKILLED_EVENT_LANE_FILE),
    source: pinned
      ? socketPath?.trim()
        ? "config.socketPath"
        : REDSKILLED_SOCKET_ENV
      : env[REDSKILLED_SESSION_ENV]?.trim()
        ? `derived from ${REDSKILLED_SESSION_ENV}`
        : env.XDG_RUNTIME_DIR?.trim()
          ? "derived from XDG_RUNTIME_DIR"
          : "derived from uid",
  };
}
