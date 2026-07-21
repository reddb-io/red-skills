// fleet-name — how a named fleet is addressed on the CLI and across a spawn.
//
// One place resolves the name so `fleet`, `fleet stop`, `fleet status`, and the
// spawned `__supervise` process can never disagree about which supervisor lane
// they are operating on. Pure over its inputs.

import { DEFAULT_FLEET_NAME, resolveFleetName } from "@reddb-io/red-castle/engine";

export { DEFAULT_FLEET_NAME };

/** The env var carrying the fleet name across the detached `__supervise` spawn. */
export const FLEET_NAME_ENV = "RED_AFK_FLEET";

/**
 * Read `--fleet <name>` / `--fleet=<name>` out of an argv. Returns undefined when
 * the flag is absent so the caller can fall back to the env or the default; a
 * present-but-valueless flag throws, exactly like the other value flags.
 */
export function parseFleetFlag(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--fleet") {
      const value = args[i + 1];
      if (value === undefined) throw new Error("--fleet requires a value");
      return resolveFleetName(value);
    }
    if (arg.startsWith("--fleet=")) {
      return resolveFleetName(arg.slice("--fleet=".length));
    }
  }
  return undefined;
}

/** Resolve the fleet a process operates on: the flag wins, then the inherited
 * env (set by the spawner), then the default lane. */
export function resolveFleetFromArgs(
  args: readonly string[],
  env: Record<string, string | undefined> = process.env,
): string {
  return parseFleetFlag(args) ?? resolveFleetName(env[FLEET_NAME_ENV]);
}
