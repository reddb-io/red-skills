/**
 * served-version — the daemon's answer to "which version runs on this machine?"
 *
 * **ADR 0151 gives the daemon ownership of the version; this is where it says
 * so.** Before it, three caches decided independently and one machine came to
 * hold 3.17.1 in its plugin cache, 3.18.12 in its npx cache and 3.19.3 on main —
 * a skew that surfaces inside a hook, where nobody is watching.
 *
 * It is a FILE rather than a socket call on purpose. The launcher runs on the
 * hook path, where a fetch is what the blank-statusline class is made of, and a
 * launcher that dialled the daemon would be a launcher that hangs when the
 * daemon is the thing that is broken. A pointer the daemon writes is read in one
 * `readFileSync`, cannot block, and is absent — rather than wrong — on a machine
 * with no daemon.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { decode, encode, type JsonValue } from "@reddb-io/toon";
import { redskilledHomeDir } from "./redskilled-home.js";

/** The pointer's filename. Never spelled twice. */
export const SERVED_VERSION_FILE = "served-version.toon";

export interface ServedVersion {
  /** The version this daemon serves. */
  readonly version: string;
  /** When it last said so, ISO-8601 — a reader may age it out. */
  readonly observed_at: string;
  /** The daemon pid that wrote it, so a stale pointer is attributable. */
  readonly pid: number;
}

/** From the operator's HOME. The daemon passes its own home with `…In`. */
export function servedVersionPath(homeDir?: string): string {
  return join(redskilledHomeDir(homeDir ?? process.env["HOME"] ?? ""), SERVED_VERSION_FILE);
}

/** From the daemon's home directory itself, which the daemon already holds. */
export function servedVersionPathIn(daemonHome: string): string {
  return join(daemonHome, SERVED_VERSION_FILE);
}

/** Write the pointer. Called by the daemon on boot and after a handover. */
export function writeServedVersion(value: ServedVersion, homeDir?: string): void {
  writeServedVersionTo(servedVersionPath(homeDir), value);
}

/** Write to an explicit path — what the daemon uses, holding its own home. */
export function writeServedVersionTo(path: string, value: ServedVersion): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, encode(value as unknown as JsonValue), { mode: 0o600 });
}

/**
 * Read the pointer, or null.
 *
 * **Every failure is null, deliberately.** No daemon, no home, a truncated write,
 * a file from a future shape — each means "nobody told me", and the caller's
 * fallback (its own installed version) is exactly right for all of them. A throw
 * here would turn a missing optimisation into a broken launcher.
 */
export function readServedVersion(homeDir?: string): ServedVersion | null {
  try {
    const raw = decode(readFileSync(servedVersionPath(homeDir), "utf8")) as Partial<ServedVersion>;
    if (typeof raw?.version !== "string" || raw.version.trim() === "") return null;
    return {
      version: raw.version,
      observed_at: typeof raw.observed_at === "string" ? raw.observed_at : "",
      pid: typeof raw.pid === "number" ? raw.pid : 0,
    };
  } catch {
    return null;
  }
}
