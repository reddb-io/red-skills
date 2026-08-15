/**
 * paths — where a `redskilled` daemon lives, and what it holds while it does.
 *
 * **ADR 0130 Amendment 3 scopes the daemon to the MACHINE**, never to a
 * repository and no longer to a session. Two paths carry that between them, and
 * they are not the same kind of thing:
 *
 * - The **runtime dir** is where the daemon *lives* — socket, spawn lock and
 *   session lease. It stays derived from `XDG_RUNTIME_DIR`, which on Linux is
 *   per **user**, not per login: every terminal and every login of one operator
 *   resolves to the same `/run/user/<uid>`, so this derivation already yields one
 *   daemon for all of that user's sessions. It is a *location*, not the scope.
 * - The **machine claim** is the scope itself — one shared, world-readable record
 *   that every OS user of the machine can see, so the case the runtime dir cannot
 *   reach (two different users, two `0700` directories) ends in one daemon or in
 *   a stated refusal. See `machine-scope.ts` for why refusal is the answer.
 *
 * The host identity stays a *label* on the records rather than part of the key:
 * the key is a path on this machine, and a digest of the hostname adds nothing to
 * a path that is already local. Keying on the repository, then as now, would
 * reinstate exactly the per-project budget the daemon exists to replace.
 *
 * Pure: every input is passed in, so the whole surface is testable without
 * touching the host's real runtime directory.
 */
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { join } from "node:path";
import { runtimeSocketDir } from "@reddb-io/shared/resident-core.js";
import { redskilledHomeDir } from "@reddb-io/shared/redskilled-home.js";
import { REDSKILLED_EVENT_LANE_FILE } from "./event-lane.js";
import { resolveMachineClaimPath } from "./machine-scope.js";

/** The socket file name; also the length the runtime dir must accommodate. */
export const REDSKILLED_SOCKET_FILE = "redskilled.sock";
/** Daemon-owned ACP endpoint; the stdio command only projects this socket. */
export const REDSKILLED_ACP_SOCKET_FILE = "redskilled-acp.sock";

/** Env var that pins the session scope explicitly, ahead of every derivation. */
export const REDSKILLED_SESSION_ENV = "REDSKILLED_SESSION";

/** Durable, host-owned and bounded forensic incident lane. */
export function redskilledResourceIncidentRoot(homeDir: string): string {
  return join(redskilledHomeDir(homeDir), "state", "incidents");
}

export interface RedskilledPaths {
  /** The raw session scope this daemon serves — never published. */
  readonly sessionKey: string;
  /** 12-hex digest of {@link sessionKey}: the publishable session identity. */
  readonly sessionKeyHash: string;
  /** 12-hex digest of the host identity — a label on records, never a key. */
  readonly machineIdHash: string;
  readonly runtimeDir: string;
  readonly socketPath: string;
  readonly acpSocketPath: string;
  readonly lockPath: string;
  readonly leasePath: string;
  /** The daemon's append-only structured log, which it rehydrates from. */
  readonly eventLanePath: string;
  /** The durable project registrations a successor daemon rehydrates. */
  readonly registrationIntentPath: string;
  /** Generic host-resource leases retained across daemon handover. */
  readonly resourceLeasePath: string;
  /** Daemon-managed canonical Project workspaces, keyed below this directory by stable identity. */
  readonly projectWorkspaceRoot: string;
  /** The canonical claim path resolved for this host and resolver environment. */
  readonly machineClaimPathOfThisHost: string;
  /**
   * The machine-wide claim: the one record every OS user of this host can read.
   *
   * Deliberately NOT under {@link runtimeDir} — a record inside one user's `0700`
   * directory is invisible to the second user, which is the exact case this scope
   * exists to decide.
   */
  readonly machineClaimPath: string;
}

export interface ResolveRedskilledPathsOptions {
  env?: NodeJS.ProcessEnv;
  uid?: number | string;
  host?: string;
  /** Overrides the whole derivation — tests and an explicit operator pin. */
  runtimeDir?: string;
  /** Overrides the operator home used by the daemon-owned log. */
  homeDir?: string;
  /** Overrides where the machine-wide claim lives — tests and an operator pin. */
  machineClaimPath?: string;
  platform?: NodeJS.Platform;
}

/**
 * Which runtime directory this process resolves to, most explicit source first.
 *
 * `REDSKILLED_SESSION` wins so an operator (or a test) can state a location
 * outright. `XDG_RUNTIME_DIR` is next because the OS already made it **per user**
 * — every login of one operator lands on the same `/run/user/<uid>`, so this
 * yields one daemon per user, not one per terminal. The uid-derived fallback
 * keeps a host without XDG at that same granularity rather than failing to
 * resolve at all. **None of these decide the scope**: the machine claim does, and
 * a pinned value that lands two daemons on one machine is refused by it.
 */
export function resolveSessionKey(options: ResolveRedskilledPathsOptions = {}): string {
  const env = options.env ?? process.env;
  const pinned = env[REDSKILLED_SESSION_ENV]?.trim();
  if (pinned) return pinned;
  const xdg = env.XDG_RUNTIME_DIR?.trim();
  if (xdg) return xdg;
  return `uid:${options.uid ?? (typeof process.getuid === "function" ? process.getuid() : "nouid")}`;
}

/**
 * The host identity, as a 12-character lowercase hex digest.
 *
 * A digest, never the hostname: this value is written to records a bug report
 * may carry off the machine, and the daemon only ever needs to compare it.
 */
export function resolveMachineIdHash(options: ResolveRedskilledPathsOptions = {}): string {
  return shortDigest(options.host ?? hostname());
}

/** Where the daemon lives, and the machine-wide claim it must hold to live there. PURE. */
export function resolveRedskilledPaths(options: ResolveRedskilledPathsOptions = {}): RedskilledPaths {
  const sessionKey = resolveSessionKey(options);
  const runtimeDir = options.runtimeDir ?? runtimeSocketDir({
    key: `redskilled:${sessionKey}`,
    socketFileName: REDSKILLED_SOCKET_FILE,
    env: options.env,
    uid: options.uid,
  });
  const machineIdHash = resolveMachineIdHash(options);
  const machineClaimPathOfThisHost = resolveMachineClaimPath({
    env: options.env,
    machineIdHash,
    platform: options.platform,
  });
  const homeDir = options.homeDir
    ?? options.env?.HOME
    ?? (options.runtimeDir == null ? process.env.HOME : options.runtimeDir)
    ?? runtimeDir;
  return {
    sessionKey,
    sessionKeyHash: shortDigest(sessionKey),
    machineIdHash,
    runtimeDir,
    socketPath: join(runtimeDir, REDSKILLED_SOCKET_FILE),
    acpSocketPath: join(runtimeDir, REDSKILLED_ACP_SOCKET_FILE),
    lockPath: join(runtimeDir, "redskilled.spawn.lock"),
    leasePath: join(runtimeDir, "redskilled.lease.toon"),
    eventLanePath: join(redskilledHomeDir(homeDir), REDSKILLED_EVENT_LANE_FILE),
    // A registration is host intent, not a socket artifact. Keeping it beside
    // the socket stranded every drain when one process resolved XDG_RUNTIME_DIR
    // and its successor used the uid fallback (or vice versa).
    registrationIntentPath: join(redskilledHomeDir(homeDir), "redskilled.registrations.toon"),
    resourceLeasePath: join(redskilledHomeDir(homeDir), "redskilled.resources.toon"),
    projectWorkspaceRoot: join(redskilledHomeDir(homeDir), "projects"),
    machineClaimPathOfThisHost,
    machineClaimPath: options.machineClaimPath ?? machineClaimPathOfThisHost,
  };
}

function shortDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}
