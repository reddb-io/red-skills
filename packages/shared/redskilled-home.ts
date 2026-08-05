import { join } from "node:path";

/**
 * redskilled-home — the ONE name of the daemon's host-scoped home.
 *
 * `~/.red/redskilled/` is operator-scoped and sits outside every checkout, so it
 * is not the `.red/` ADR 0067 gave `/red-setup` sole authority over. ADR 0130
 * Amendment 2 settles the ownership the two records left between them: **the
 * home belongs to `redskilled`**. Its provisioner may create it eagerly; its
 * canonical log writer creates it lazily on first append.
 *
 * The daemon owns it because rule 7 already made the first client the thing that
 * starts a daemon: a home only setup could create would leave auto-spawn on a
 * fresh machine failing closed forever, with no path back. Setup does not lose a
 * job here — it *runs* the provisioner (`redskilled provision`), which is the
 * difference between one owner with an interactive caller and two creators.
 *
 * This module only NAMES the directory, because a name is what a caller that may
 * not create it still needs: `worker-workspace.ts` places the `host` preset under
 * it, and `/red-doctor` reports on it. Both read this constant rather than
 * spelling the path again — a second spelling is how one directory becomes two.
 */

/** The segments below the operator's home directory. Never spelled twice. */
export const REDSKILLED_HOME_SEGMENTS = [".red", "redskilled"] as const;

/**
 * Owner-only. The home carries Worker workspaces and the daemon's own state on a
 * machine whose other accounts have no business reading either.
 */
export const REDSKILLED_HOME_MODE = 0o700;

/** The daemon's host-scoped home for one operator. PURE. */
export function redskilledHomeDir(homeDir: string): string {
  return join(homeDir, ...REDSKILLED_HOME_SEGMENTS);
}
