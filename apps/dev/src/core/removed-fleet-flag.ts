// removed-fleet-flag — the CLI half of the Fleet's migration answer.
//
// `--fleet <name>` used to address one supervisor lane out of several. There is
// one lane now (ADR 0130), so the flag has nothing to select. Reading it back
// out of an argv is the only reason this module exists: a caller that still
// passes it must be told what replaced it, not have its name quietly ignored
// and its work run against a scope it did not ask for.

import { refuseFleetNaming } from "@reddb-io/red-castle/engine";

/**
 * Read a `--fleet <name>` / `--fleet=<name>` out of an argv, or undefined when
 * the flag is absent. A valueless `--fleet` reads as the empty string, which
 * still counts as naming a fleet: the caller meant to select one. PURE.
 */
export function parseRemovedFleetFlag(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--fleet") return args[i + 1] ?? "";
    if (arg.startsWith("--fleet=")) return arg.slice("--fleet=".length);
  }
  return undefined;
}

/** Refuse an argv that still names a fleet, stating the replacement. */
export function refuseRemovedFleetFlag(args: readonly string[]): void {
  const named = parseRemovedFleetFlag(args);
  if (named === undefined) return;
  // A valueless flag names no fleet but still asks for one; refuse it too.
  refuseFleetNaming(named === "" ? "--fleet" : named);
}
