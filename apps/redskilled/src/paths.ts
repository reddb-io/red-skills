/**
 * paths — where a `redskilled` daemon lives, and which session it belongs to.
 *
 * ADR 0130 scopes the daemon to a **user session**, not to a repository. That
 * one word decides this whole module: the socket, the spawn lock and the
 * singleton lease all key off a session identifier, and the host identity is
 * carried as a *label* on the records rather than as part of the key. Keying on
 * the host would make one daemon per machine — wrong the moment an operator has
 * two logged-in sessions — and keying on the repository would reinstate exactly
 * the per-project budget the daemon exists to replace.
 *
 * Pure: every input is passed in, so the whole surface is testable without
 * touching the host's real runtime directory.
 */
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { join } from "node:path";
import { runtimeSocketDir } from "@reddb-io/shared/resident-core.js";

/** The socket file name; also the length the runtime dir must accommodate. */
export const REDSKILLED_SOCKET_FILE = "redskilled.sock";

/** Env var that pins the session scope explicitly, ahead of every derivation. */
export const REDSKILLED_SESSION_ENV = "REDSKILLED_SESSION";

export interface RedskilledPaths {
  /** The raw session scope this daemon serves — never published. */
  readonly sessionKey: string;
  /** 12-hex digest of {@link sessionKey}: the publishable session identity. */
  readonly sessionKeyHash: string;
  /** 12-hex digest of the host identity — a label on records, never a key. */
  readonly machineIdHash: string;
  readonly runtimeDir: string;
  readonly socketPath: string;
  readonly lockPath: string;
  readonly leasePath: string;
}

export interface ResolveRedskilledPathsOptions {
  env?: NodeJS.ProcessEnv;
  uid?: number | string;
  host?: string;
  /** Overrides the whole derivation — tests and an explicit operator pin. */
  runtimeDir?: string;
}

/**
 * The session scope, most explicit source first.
 *
 * `REDSKILLED_SESSION` wins so an operator (or a test) can state the scope
 * outright. `XDG_RUNTIME_DIR` is next because the OS already made it per-user
 * and per-session. The uid-derived fallback keeps a host without XDG working at
 * user granularity rather than failing to resolve at all.
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

/** The socket, lock and lease paths for one user session. PURE. */
export function resolveRedskilledPaths(options: ResolveRedskilledPathsOptions = {}): RedskilledPaths {
  const sessionKey = resolveSessionKey(options);
  const runtimeDir = options.runtimeDir ?? runtimeSocketDir({
    key: `redskilled:${sessionKey}`,
    socketFileName: REDSKILLED_SOCKET_FILE,
    env: options.env,
    uid: options.uid,
  });
  return {
    sessionKey,
    sessionKeyHash: shortDigest(sessionKey),
    machineIdHash: resolveMachineIdHash(options),
    runtimeDir,
    socketPath: join(runtimeDir, REDSKILLED_SOCKET_FILE),
    lockPath: join(runtimeDir, "redskilled.spawn.lock"),
    leasePath: join(runtimeDir, "redskilled.lease.toon"),
  };
}

function shortDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}
